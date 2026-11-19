package protocol

import (
	"bytes"
	jsonv1 "encoding/json"
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"strings"

	v1 "github.com/oulkurt/Xtwork-v2/plugin-host/protocol/v1"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type ValidationOptions struct {
	ExpectedSender    string
	NegotiatedVersion string
}

// Codec 在构造时编译源 Schema；构造成功后只读，可跨连接复用。
type Codec struct {
	envelope *jsonschema.Schema
	messages map[string]*jsonschema.Schema
}

type offlineLoader struct{}

func (offlineLoader) Load(location string) (any, error) {
	return nil, fmt.Errorf("schema resource is not embedded: %s", location)
}

func NewCodec() (*Codec, error) {
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.UseLoader(offlineLoader{})
	var catalog map[string]any
	for _, name := range []string{"envelope", "messages"} {
		data, err := v1.Schemas.ReadFile(name + ".schema.json")
		if err != nil {
			return nil, fmt.Errorf("read %s schema: %w", name, err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("decode %s schema: %w", name, err)
		}
		if err := compiler.AddResource("urn:xtwork:protocol:v1:"+name, doc); err != nil {
			return nil, fmt.Errorf("register %s schema: %w", name, err)
		}
		if name == "messages" {
			catalog = doc.(map[string]any)["$defs"].(map[string]any)
		}
	}
	envelope, err := compiler.Compile("urn:xtwork:protocol:v1:envelope")
	if err != nil {
		return nil, fmt.Errorf("compile envelope schema: %w", err)
	}
	codec := &Codec{envelope: envelope, messages: make(map[string]*jsonschema.Schema)}
	for key := range catalog {
		if !strings.Contains(key, ".") {
			continue
		}
		schema, err := compiler.Compile("urn:xtwork:protocol:v1:messages#/$defs/" + key)
		if err != nil {
			return nil, fmt.Errorf("compile %s schema: %w", key, err)
		}
		codec.messages[key] = schema
	}
	return codec, nil
}

// CheckContext 仅比较调用方提供的连接事实，不存储握手与 sender 状态。
func CheckContext(envelope Envelope, options ValidationOptions) error {
	if options.ExpectedSender != "" && envelope.Meta.Sender != options.ExpectedSender {
		return failure(LayerEnvelope, CodeSchemaInvalid, "sender_mismatch", nil)
	}
	if options.NegotiatedVersion != "" && envelope.Version != options.NegotiatedVersion {
		return failure(LayerEnvelope, CodeVersionUnsupported, "version_mismatch", nil)
	}
	return nil
}

func schemaFailure(layer Layer, reason string, err error) *Error {
	result := failure(layer, CodeSchemaInvalid, reason, err)
	var validation *jsonschema.ValidationError
	if errors.As(err, &validation) {
		for len(validation.Causes) > 0 {
			validation = validation.Causes[0]
		}
		var pointer jsontext.Pointer
		for _, part := range validation.InstanceLocation {
			pointer += jsontext.Pointer("/" + strings.ReplaceAll(strings.ReplaceAll(part, "~", "~0"), "/", "~1"))
		}
		result.Details["pointer"] = string(pointer)
	}
	return result
}

// decodeTyped 让开放对象中的数字继续使用 json.Number。
func decodeTyped(data []byte, target any) error {
	numbers := jsonv2.UnmarshalFromFunc(func(decoder *jsontext.Decoder, value *any) error {
		raw, err := decoder.ReadValue()
		if err != nil {
			return err
		}
		input := jsonv1.NewDecoder(bytes.NewReader(raw))
		input.UseNumber()
		return input.Decode(value)
	})
	return jsonv2.Unmarshal(data, target, jsonv2.WithUnmarshalers(numbers))
}

func (c *Codec) validateEnvelope(frame []byte, options ValidationOptions) (Envelope, any, error) {
	var envelope Envelope
	if len(frame) > MaxFrameBytes {
		return envelope, nil, failure(LayerFraming, CodeFrameTooLarge, "frame_too_large", nil)
	}
	if err := validateFrame(frame); err != nil {
		return envelope, nil, err
	}
	// 语法与重复键已由 jsontext 校验。此解码只建立 Schema 的无损数字模型。
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(frame))
	if err != nil {
		return envelope, nil, failure(LayerFraming, CodeSchemaInvalid, "invalid_json", err)
	}
	if err := c.envelope.Validate(doc); err != nil {
		return envelope, nil, schemaFailure(LayerEnvelope, "envelope_schema", err)
	}
	if err := decodeTyped(frame, &envelope); err != nil {
		return envelope, nil, schemaFailure(LayerEnvelope, "envelope_decode", err)
	}
	if err := CheckContext(envelope, options); err != nil {
		return envelope, nil, err
	}
	return envelope, doc, nil
}

func (c *Codec) ValidateEnvelope(frame []byte, options ValidationOptions) (Envelope, error) {
	envelope, _, err := c.validateEnvelope(frame, options)
	return envelope, err
}

func (c *Codec) Decode(frame []byte, options ValidationOptions) (*Message, error) {
	envelope, doc, err := c.validateEnvelope(frame, options)
	if err != nil {
		return nil, err
	}
	message := &Message{Envelope: envelope, Known: true}
	if envelope.Kind == KindResponse && envelope.Error != nil {
		return message, nil
	}
	key := string(envelope.Kind) + "." + envelope.Method
	if envelope.Kind == KindEvent {
		key = "event." + envelope.Event
	}
	if envelope.Kind == KindCancel {
		message.Payload = new(CancelPayload)
	} else {
		schema, found := c.messages[key]
		if !found {
			if envelope.Kind == KindEvent {
				message.Known = false
				message.Payload = envelope.Payload.Clone()
				return message, nil
			}
			return nil, failure(LayerMessage, CodeMethodNotSupported, "unknown_method", nil)
		}
		if err := schema.Validate(doc); err != nil {
			result := schemaFailure(LayerMessage, "message_schema", err)
			if envelope.Kind == KindResponse {
				result.Recovery = "reconnect"
			}
			return nil, result
		}
		message.Payload = payloadFor(key)
	}
	if err := decodeTyped(envelope.Payload, message.Payload); err != nil {
		return nil, schemaFailure(LayerMessage, "message_decode", err)
	}
	return message, nil
}

// Encode 将 typed payload 写入 envelope，并校验完整帧；行终止符由 Writer 添加。
func (c *Codec) Encode(envelope Envelope, payload any) ([]byte, error) {
	data, err := jsonv2.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode payload: %w", err)
	}
	envelope.Payload = data
	frame, err := jsonv2.Marshal(envelope)
	if err != nil {
		return nil, fmt.Errorf("encode envelope: %w", err)
	}
	if _, err := c.Decode(frame, ValidationOptions{}); err != nil {
		return nil, err
	}
	return frame, nil
}

func payloadFor(key string) any {
	switch key {
	case "request.hello":
		return new(HelloRequest)
	case "response.hello":
		return new(HelloResponse)
	case "request.shutdown", "response.shutdown":
		return new(EmptyPayload)
	case "request.plugin.load":
		return new(PluginLoadRequest)
	case "response.plugin.load":
		return new(PluginLoadResponse)
	case "request.plugin.invoke":
		return new(PluginInvokeRequest)
	case "response.plugin.invoke":
		return new(PluginInvokeResponse)
	case "request.capability.call":
		return new(CapabilityCallRequest)
	case "response.capability.call":
		return new(CapabilityCallResponse)
	case "event.plugin.log":
		return new(PluginLogEvent)
	default:
		return nil
	}
}
