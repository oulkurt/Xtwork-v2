package protocol

import (
	"encoding/json/jsontext"
	"regexp"
)

const PluginPayloadLimit = 1 << 20

const PluginVersion = "1.3"
const PluginFatalExit = 70

var pluginTimeZonePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$`)

// ValidPluginTimeZone 校验可选时区名称的路径格式。
func ValidPluginTimeZone(name string) bool {
	return name == "" || len(name) <= 64 && pluginTimeZonePattern.MatchString(name)
}

type PluginFile struct {
	Path string `json:"path"`
	Text string `json:"text"`
}

type PluginLoadRequest struct {
	PluginID     string       `json:"pluginId"`
	API          int          `json:"api"`
	Entry        string       `json:"entry"`
	Files        []PluginFile `json:"files"`
	Capabilities []string     `json:"capabilities"`
	Tools        []string     `json:"tools"`
	View         bool         `json:"view"`
	Schedule     bool         `json:"schedule"`
	TimeZone     string       `json:"timeZone,omitzero"`
}

type PluginLoadResponse struct {
	Tools    []string `json:"tools"`
	View     bool     `json:"view"`
	Schedule bool     `json:"schedule"`
}

type PluginInvokeRequest struct {
	Kind    string         `json:"kind"`
	Name    string         `json:"name"`
	Input   jsontext.Value `json:"input"`
	Context jsontext.Value `json:"context,omitzero"`
}

type PluginInvokeResponse struct {
	Output jsontext.Value `json:"output"`
}

type CapabilityCallRequest struct {
	Capability string         `json:"capability"`
	Method     string         `json:"method"`
	Params     jsontext.Value `json:"params"`
}

type CapabilityCallResponse struct {
	Result jsontext.Value `json:"result"`
}

type PluginLogEvent struct {
	Level string `json:"level"`
	Text  string `json:"text"`
}
