package main

import (
	"context"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/oulkurt/Xtwork-v2/plugin-host/internal/protocol"
)

const fatalExit = protocol.PluginFatalExit

// 低于宿主 bridge 的 MaxPendingRequests（64），为其他请求与回应留出余量。
const maxCapabilityCalls = 32

var errVersionUnsupported = errors.New("unsupported protocol version")

type peer struct {
	id              string
	codec           *protocol.Codec
	reader          *protocol.Reader
	writer          *protocol.Writer
	mu              sync.Mutex
	writeMu         sync.Mutex
	seq             protocol.Sequence
	next            uint64
	pending         map[string]chan *protocol.Message
	requests        chan *protocol.Message
	done            chan struct{}
	capabilitySlots chan struct{}
}

func newPeer(id string, codec *protocol.Codec, input io.Reader, output io.Writer) *peer {
	return &peer{id: id, codec: codec, reader: protocol.NewReader(input), writer: protocol.NewWriter(output), pending: make(map[string]chan *protocol.Message), requests: make(chan *protocol.Message, 32), done: make(chan struct{}), capabilitySlots: make(chan struct{}, maxCapabilityCalls)}
}

func serve(id string, input io.Reader, output io.Writer) error {
	codec, err := protocol.NewCodec()
	if err != nil {
		return err
	}
	p := newPeer(id, codec, input, output)
	defer close(p.done)
	ctx := context.Background()
	frame, err := p.reader.ReadFrame(ctx)
	if err != nil {
		return err
	}
	msg, err := codec.Decode(frame, protocol.ValidationOptions{ExpectedSender: "host"})
	if err != nil {
		return err
	}
	if msg.Envelope.Seq != 0 || msg.Envelope.Kind != protocol.KindRequest || msg.Envelope.Method != "hello" {
		return io.ErrUnexpectedEOF
	}
	hello := msg.Payload.(*protocol.HelloRequest)
	found := false
	for _, v := range hello.SupportedVersions {
		if v == protocol.PluginVersion {
			found = true
		}
	}
	if !found {
		_ = p.send(protocol.Envelope{Kind: protocol.KindResponse, ID: msg.Envelope.ID, Method: "hello", Error: wireError(protocol.CodeVersionUnsupported)}, nil, msg.Envelope.Version)
		return errVersionUnsupported
	}
	if err := p.send(protocol.Envelope{Kind: protocol.KindResponse, ID: msg.Envelope.ID, Method: "hello"}, protocol.HelloResponse{Role: "plugin", SelectedVersion: protocol.PluginVersion, Methods: []string{"plugin.load", "plugin.invoke", "shutdown"}, Runtime: "xtwork/moejs"}, protocol.PluginVersion); err != nil {
		return err
	}
	go p.work()
	var seq protocol.Sequence = 1
	for {
		frame, err := p.reader.ReadFrame(ctx)
		if err != nil {
			return err
		}
		msg, err := codec.Decode(frame, protocol.ValidationOptions{ExpectedSender: "host", NegotiatedVersion: protocol.PluginVersion})
		if err != nil {
			return err
		}
		if msg.Envelope.Seq != seq {
			return io.ErrUnexpectedEOF
		}
		seq++
		switch msg.Envelope.Kind {
		case protocol.KindResponse:
			if !p.receiveResponse(msg) {
				return io.ErrUnexpectedEOF
			}
		case protocol.KindRequest:
			if msg.Envelope.Method == "shutdown" {
				p.respond(msg, protocol.EmptyPayload{}, nil)
				return nil
			}
			select {
			case p.requests <- msg:
			case <-p.done:
				return nil
			}
		case protocol.KindCancel:
		default:
			return io.ErrUnexpectedEOF
		}
	}
}

func (p *peer) receiveResponse(msg *protocol.Message) bool {
	if msg.Envelope.Method != "capability.call" {
		return false
	}
	p.mu.Lock()
	ch := p.pending[msg.Envelope.ID]
	delete(p.pending, msg.Envelope.ID)
	p.mu.Unlock()
	if ch == nil {
		return p.issued(msg.Envelope.ID)
	}
	ch <- msg
	return true
}

func (p *peer) issued(id string) bool {
	prefix, ok := strings.CutPrefix(id, "p-r")
	if !ok {
		return false
	}
	n, err := strconv.ParseUint(prefix, 10, 64)
	p.mu.Lock()
	next := p.next
	p.mu.Unlock()
	return err == nil && n > 0 && n <= next && strconv.FormatUint(n, 10) == prefix
}

func (p *peer) send(e protocol.Envelope, payload any, version string) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	e.Protocol, e.Version, e.Seq = protocol.Name, version, p.seq
	e.Meta.Sender, e.Meta.SentAt = "plugin:"+p.id, time.Now().UTC().Format(time.RFC3339Nano)
	frame, err := p.codec.Encode(e, payload)
	if err != nil {
		return err
	}
	if err = p.writer.WriteFrame(context.Background(), frame); err == nil {
		p.seq++
	}
	return err
}

func (p *peer) respond(req *protocol.Message, payload any, err *protocol.Error) {
	_ = p.send(protocol.Envelope{Kind: protocol.KindResponse, ID: req.Envelope.ID, Method: req.Envelope.Method, Error: err}, payload, protocol.PluginVersion)
}

func wireError(code protocol.Code) *protocol.Error {
	return &protocol.Error{Code: code, Message: string(code), Recovery: "none", Retryable: false}
}

func (p *peer) capability(capability, method string, params []byte) (*protocol.Message, error) {
	return p.capabilityWait(capability, method, params, 30*time.Second)
}

func (p *peer) capabilityWait(capability, method string, params []byte, timeout time.Duration) (*protocol.Message, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	select {
	case <-p.done:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, context.DeadlineExceeded
	case p.capabilitySlots <- struct{}{}:
	}
	defer func() { <-p.capabilitySlots }()
	select {
	case <-p.done:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, context.DeadlineExceeded
	default:
	}
	p.mu.Lock()
	p.next++
	id := "p-r" + strconv.FormatUint(p.next, 10)
	ch := make(chan *protocol.Message, 1)
	p.pending[id] = ch
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.pending, id); p.mu.Unlock() }()
	err := p.send(protocol.Envelope{Kind: protocol.KindRequest, ID: id, Method: "capability.call"}, protocol.CapabilityCallRequest{Capability: capability, Method: method, Params: params}, protocol.PluginVersion)
	if err != nil {
		return nil, err
	}
	select {
	case result := <-ch:
		return result, nil
	case <-p.done:
		return nil, io.EOF
	case <-ctx.Done():
		_ = p.send(protocol.Envelope{Kind: protocol.KindCancel, ID: "p-c" + id}, protocol.CancelPayload{TargetRequestID: id, Reason: "timeout"}, protocol.PluginVersion)
		return nil, context.DeadlineExceeded
	}
}
