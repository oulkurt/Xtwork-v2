package protocol

import (
	"encoding/json"
	"encoding/json/jsontext"
	"fmt"
	"math/big"
)

const (
	Name        = "xtwork"
	MaxSequence = 9_007_199_254_740_991
)

type Kind string

const (
	KindRequest  Kind = "request"
	KindResponse Kind = "response"
	KindEvent    Kind = "event"
	KindCancel   Kind = "cancel"
)

// Sequence 保留 JSON integer 的精度，也接受 1.0 和 1e0 这类整数写法。
type Sequence uint64

func (s *Sequence) UnmarshalJSON(data []byte) error {
	var number json.Number
	if err := json.Unmarshal(data, &number); err != nil {
		return fmt.Errorf("decode sequence: %w", err)
	}
	n, ok := new(big.Rat).SetString(number.String())
	if !ok || !n.IsInt() || n.Sign() < 0 || !n.Num().IsUint64() || n.Num().Uint64() > MaxSequence {
		return fmt.Errorf("sequence outside v1 integer range")
	}
	*s = Sequence(n.Num().Uint64())
	return nil
}

type Envelope struct {
	Protocol  string         `json:"protocol"`
	Version   string         `json:"version"`
	Kind      Kind           `json:"kind"`
	ID        string         `json:"id"`
	Seq       Sequence       `json:"seq"`
	SessionID *string        `json:"sessionId"`
	Method    string         `json:"method,omitzero"`
	Event     string         `json:"event,omitzero"`
	Payload   jsontext.Value `json:"payload"`
	Error     *Error         `json:"error"`
	Meta      Meta           `json:"meta"`
}

type Meta struct {
	Sender    string         `json:"sender"`
	SentAt    string         `json:"sentAt"`
	RequestID string         `json:"requestId,omitzero"`
	Trace     map[string]any `json:"trace,omitzero"`
}

// Message 的 Payload 是目录中的 Go 类型。未知 event 保留原始 payload，Known 为 false。
type Message struct {
	Envelope Envelope
	Payload  any
	Known    bool
}

type HelloRequest struct {
	Role              string   `json:"role"`
	SupportedVersions []string `json:"supportedVersions"`
	Methods           []string `json:"methods"`
	Runtime           string   `json:"runtime"`
}

type HelloResponse struct {
	Role            string   `json:"role"`
	SelectedVersion string   `json:"selectedVersion"`
	Methods         []string `json:"methods"`
	Runtime         string   `json:"runtime"`
}

type EmptyPayload struct{}

type CancelPayload struct {
	TargetRequestID string `json:"targetRequestId"`
	Reason          string `json:"reason"`
}
