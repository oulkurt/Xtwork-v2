package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"time"

	"github.com/oulkurt/Xtwork-v2/plugin-host/internal/protocol"
)

// The host processes one request at a time. While a worker handles a request,
// it can call back for its own storage capabilities over the same connection.
type workerClient struct {
	cmd       *exec.Cmd
	input     io.WriteCloser
	workDir   string
	codec     *protocol.Codec
	reader    *protocol.Reader
	writer    *protocol.Writer
	plugin    *pluginEntry
	outSeq    protocol.Sequence
	inSeq     protocol.Sequence
	requestID uint64
}

func startWorker(ctx context.Context, executable string, codec *protocol.Codec, plugin *pluginEntry) (_ *workerClient, resultErr error) {
	dir, err := os.MkdirTemp("", "xtwork-plugin-")
	if err != nil {
		return nil, err
	}
	defer func() {
		if resultErr != nil {
			_ = os.RemoveAll(dir)
		}
	}()
	cmd := exec.CommandContext(ctx, executable, "worker", plugin.load.PluginID)
	cmd.Dir = dir
	cmd.Env = []string{}
	cmd.Stderr = os.Stderr
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		_ = input.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = input.Close()
		_ = output.Close()
		return nil, err
	}
	worker := &workerClient{
		cmd: cmd, input: input, workDir: dir,
		codec: codec, plugin: plugin,
		reader: protocol.NewReader(output), writer: protocol.NewWriter(input),
	}
	defer func() {
		if resultErr != nil {
			worker.close()
		}
	}()
	hello, err := worker.request(ctx, 10*time.Second, "hello", protocol.HelloRequest{
		Role: "host", SupportedVersions: []string{protocol.PluginVersion},
		Methods: []string{"capability.call"}, Runtime: "xtwork/plugin-host",
	})
	if err != nil {
		return nil, fmt.Errorf("worker handshake: %w", err)
	}
	ready := hello.(*protocol.HelloResponse)
	if ready.Role != "plugin" || ready.SelectedVersion != protocol.PluginVersion {
		return nil, errors.New("worker selected an unsupported protocol")
	}
	if _, err := worker.request(ctx, 10*time.Second, "plugin.load", plugin.load); err != nil {
		return nil, fmt.Errorf("load worker: %w", err)
	}
	return worker, nil
}

func (w *workerClient) close() {
	_ = w.input.Close()
	_ = w.cmd.Process.Kill()
	_ = w.cmd.Wait()
	_ = os.RemoveAll(w.workDir)
}

func (w *workerClient) invoke(ctx context.Context, req protocol.PluginInvokeRequest) (json.RawMessage, error) {
	value, err := w.request(ctx, 35*time.Second, "plugin.invoke", req)
	if err != nil {
		return nil, err
	}
	output := value.(*protocol.PluginInvokeResponse).Output
	if len(output) > 256<<10 {
		return nil, wireError(protocol.CodeQuotaExceeded)
	}
	return json.RawMessage(output), nil
}

func (w *workerClient) request(ctx context.Context, timeout time.Duration, method string, payload any) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { _ = w.cmd.Process.Kill() })
	defer stop()
	w.requestID++
	id := "h-r" + strconv.FormatUint(w.requestID, 10)
	if err := w.send(ctx, protocol.Envelope{Kind: protocol.KindRequest, ID: id, Method: method}, payload); err != nil {
		return nil, err
	}
	for {
		frame, err := w.reader.ReadFrame(ctx)
		if err != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil, wireError(protocol.CodePluginTimeout)
			}
			return nil, err
		}
		message, err := w.codec.Decode(frame, protocol.ValidationOptions{
			ExpectedSender: "plugin:" + w.plugin.load.PluginID, NegotiatedVersion: protocol.PluginVersion,
		})
		if err != nil {
			return nil, err
		}
		envelope := message.Envelope
		if envelope.Seq != w.inSeq {
			return nil, errors.New("worker returned an invalid sequence")
		}
		w.inSeq++
		switch envelope.Kind {
		case protocol.KindResponse:
			if envelope.ID != id || envelope.Method != method {
				return nil, errors.New("worker response did not match request")
			}
			if envelope.Error != nil {
				return nil, envelope.Error
			}
			return message.Payload, nil
		case protocol.KindRequest:
			if envelope.Method != "capability.call" {
				return nil, errors.New("worker requested an unsupported method")
			}
			if err := w.capability(ctx, message); err != nil {
				return nil, err
			}
		case protocol.KindEvent, protocol.KindCancel:
			// Worker diagnostics and canceled capability calls need no response.
		}
	}
}

func (w *workerClient) send(ctx context.Context, envelope protocol.Envelope, payload any) error {
	envelope.Protocol, envelope.Version, envelope.Seq = protocol.Name, protocol.PluginVersion, w.outSeq
	envelope.Meta = protocol.Meta{Sender: "host", SentAt: time.Now().UTC().Format(time.RFC3339Nano)}
	frame, err := w.codec.Encode(envelope, payload)
	if err != nil {
		return err
	}
	w.outSeq++
	return w.writer.WriteFrame(ctx, frame)
}

func (w *workerClient) capability(ctx context.Context, message *protocol.Message) error {
	call := message.Payload.(*protocol.CapabilityCallRequest)
	envelope := protocol.Envelope{Kind: protocol.KindResponse, ID: message.Envelope.ID, Method: "capability.call"}
	if call.Capability != "storage" || w.plugin.storage == nil {
		envelope.Error = wireError(protocol.CodeCapabilityDenied)
		return w.send(ctx, envelope, nil)
	}
	value, failure := w.plugin.storage.call(call.Method, call.Params)
	if failure != nil {
		envelope.Error = failure
		return w.send(ctx, envelope, nil)
	}
	return w.send(ctx, envelope, protocol.CapabilityCallResponse{Result: value})
}
