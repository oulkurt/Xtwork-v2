package protocol

import "fmt"

type Code string

const (
	CodeSchemaInvalid         Code = "schema_invalid"
	CodeFrameTooLarge         Code = "frame_too_large"
	CodeEOFPartialFrame       Code = "protocol_eof_partial_frame"
	CodeVersionUnsupported    Code = "protocol_version_unsupported"
	CodeMethodNotSupported    Code = "method_not_supported"
	CodeRequestCancelled      Code = "request_cancelled"
	CodeInternalError         Code = "internal_error"
	CodeScopeEscape           Code = "scope_escape"
	CodePathUnresolved        Code = "path_unresolved"
	CodePluginNotEnabled      Code = "plugin_not_enabled"
	CodePluginManifestInvalid Code = "plugin_manifest_invalid"
	CodePluginTimeout         Code = "plugin_timeout"
	CodePluginFailed          Code = "plugin_failed"
	CodeCapabilityDenied      Code = "capability_denied"
	CodeQuotaExceeded         Code = "quota_exceeded"
	CodeFolderNotSelected     Code = "folder_not_selected"
	CodePluginError           Code = "plugin_error"
)

type Layer string

const (
	LayerFraming  Layer = "framing"
	LayerEnvelope Layer = "envelope"
	LayerMessage  Layer = "message"
)

// Error 同时承载线上错误对象与本地校验失败。Layer 与底层原因不上线。
type Error struct {
	Code      Code           `json:"code"`
	Message   string         `json:"message"`
	Recovery  string         `json:"recovery"`
	Retryable bool           `json:"retryable"`
	Details   map[string]any `json:"details,omitzero"`
	Layer     Layer          `json:"-"`
	cause     error
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.cause }

func failure(layer Layer, code Code, reason string, cause error) *Error {
	recovery := "reconnect"
	if layer == LayerMessage {
		recovery = "none"
	}
	if code == CodeMethodNotSupported || code == CodeVersionUnsupported {
		recovery = "upgrade"
	}
	return &Error{
		Code: code, Message: "protocol validation failed", Recovery: recovery,
		Retryable: code == CodeEOFPartialFrame,
		Details:   map[string]any{"reason": reason}, Layer: layer, cause: cause,
	}
}
