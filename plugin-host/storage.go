package main

import (
	"bytes"
	"encoding/json"
	"encoding/json/jsontext"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"github.com/oulkurt/Xtwork-v2/plugin-host/internal/protocol"
)

const storageQuota = 16 << 20

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)

type pluginStorage struct {
	filename string
	values   map[string]json.RawMessage
}

func (s *pluginStorage) load() error {
	if s.values != nil {
		return nil
	}
	data, err := os.ReadFile(s.filename)
	if errors.Is(err, os.ErrNotExist) {
		s.values = make(map[string]json.RawMessage)
		return nil
	}
	if err != nil {
		return err
	}
	var values map[string]json.RawMessage
	if len(data) > storageQuota*2 || json.Unmarshal(data, &values) != nil || values == nil {
		return errors.New("invalid plugin storage file")
	}
	total := 0
	for key, value := range values {
		total += len(key) + len(value)
		if !validKey(key) || len(value) > 256<<10 || total > storageQuota {
			return errors.New("invalid plugin storage entry")
		}
	}
	s.values = values
	return nil
}

func failure(code protocol.Code, reason string) *protocol.Error {
	err := wireError(code)
	if reason != "" {
		err.Details = map[string]any{"reason": reason}
	}
	return err
}

func resultJSON(value any) (jsontext.Value, *protocol.Error) {
	data, err := json.Marshal(value)
	if err != nil || len(data) > protocol.PluginPayloadLimit {
		return nil, wireError(protocol.CodeQuotaExceeded)
	}
	return data, nil
}

func arguments(data jsontext.Value, minCount, maxCount int) ([]json.RawMessage, bool) {
	var args []json.RawMessage
	valid := len(data) > 0 && data[0] == '[' && json.Unmarshal(data, &args) == nil
	return args, valid && len(args) >= minCount && len(args) <= maxCount
}

func stringArg(data json.RawMessage) (string, bool) {
	var value string
	valid := len(data) > 0 && data[0] == '"' && json.Unmarshal(data, &value) == nil
	return value, valid
}

func validKey(s string) bool { return len(s) > 0 && len(s) <= 200 && keyPattern.MatchString(s) }
func (s *pluginStorage) call(method string, params jsontext.Value) (jsontext.Value, *protocol.Error) {
	min, max := 1, 1
	if method == "set" {
		min, max = 2, 2
	}
	if method == "list" {
		min, max = 0, 1
	}
	args, ok := arguments(params, min, max)
	if !ok {
		return nil, failure(protocol.CodeSchemaInvalid, "")
	}
	key := ""
	var keys []string
	if method == "getMany" {
		var rawKeys []json.RawMessage
		if len(args[0]) == 0 || args[0][0] != '[' || json.Unmarshal(args[0], &rawKeys) != nil || len(rawKeys) > 1000 {
			return nil, failure(protocol.CodeSchemaInvalid, "")
		}
		for _, raw := range rawKeys {
			k, valid := stringArg(raw)
			if !valid || !validKey(k) {
				return nil, failure(protocol.CodeSchemaInvalid, "")
			}
			keys = append(keys, k)
		}
	} else if len(args) > 0 {
		key, ok = stringArg(args[0])
		if !ok || (method != "list" && !validKey(key)) || (method == "list" && key != "" && !validKey(key)) {
			return nil, failure(protocol.CodeSchemaInvalid, "")
		}
	}
	if method != "getMany" && method != "get" && method != "set" && method != "delete" && method != "list" {
		return nil, failure(protocol.CodeSchemaInvalid, "")
	}
	if method == "set" && len(args[1]) > 256<<10 {
		return nil, failure(protocol.CodeSchemaInvalid, "")
	}
	if err := s.load(); err != nil {
		return nil, failure(protocol.CodeInternalError, "plugin_storage_unavailable")
	}
	switch method {
	case "get":
		if v, exists := s.values[key]; exists {
			return jsontext.Value(append([]byte(nil), v...)), nil
		}
		return resultJSON(nil)
	case "getMany":
		// 只回答 keys 的一个前缀：编码后的整个数组（含方括号与逗号）不超过 PluginPayloadLimit。
		// 单个值最多 256 KiB，所以 keys 非空时至少回答一项；插件进程用剩余的键继续请求。
		var page bytes.Buffer
		page.WriteByte('[')
		for i, k := range keys {
			v, exists := s.values[k]
			if !exists {
				v = json.RawMessage("null")
			}
			separator := 0
			if i > 0 {
				separator = 1
			}
			if page.Len()+separator+len(v)+1 > protocol.PluginPayloadLimit {
				break
			}
			if separator != 0 {
				page.WriteByte(',')
			}
			page.Write(v)
		}
		page.WriteByte(']')
		return jsontext.Value(page.Bytes()), nil
	case "list":
		keys := make([]string, 0)
		for k := range s.values {
			if len(k) >= len(key) && k[:len(key)] == key {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		if len(keys) > 1000 {
			keys = keys[:1000]
		}
		return resultJSON(keys)
	}
	next := make(map[string]json.RawMessage, len(s.values)+1)
	total := 0
	for name, value := range s.values {
		if name != key {
			next[name] = value
			total += len(name) + len(value)
		}
	}
	if method == "set" {
		next[key] = args[1]
		total += len(key) + len(args[1])
	}
	if total > storageQuota {
		return nil, wireError(protocol.CodeQuotaExceeded)
	}
	if err := writeStorage(s.filename, next); err != nil {
		return nil, failure(protocol.CodeInternalError, "plugin_storage_unavailable")
	}
	s.values = next
	return resultJSON(nil)
}

func writeStorage(filename string, values map[string]json.RawMessage) error {
	dir := filepath.Dir(filename)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".storage-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	encoder := json.NewEncoder(file)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(values); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), filename)
}
