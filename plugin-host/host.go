package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/oulkurt/Xtwork-v2/plugin-host/internal/plugins"
	"github.com/oulkurt/Xtwork-v2/plugin-host/internal/protocol"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type host struct {
	executable  string
	codec       *protocol.Codec
	catalog     []toolDescriptor
	tools       map[string]toolEntry
	plugins     []*pluginEntry
	appearances []appearanceEntry
}

type pluginEntry struct {
	snapshot pluginSnapshot
	load     protocol.PluginLoadRequest
	storage  *pluginStorage
	worker   *workerClient
}

type appearanceEntry struct {
	snapshot pluginSnapshot
}

type pluginSnapshot struct {
	PluginID     string         `json:"pluginId"`
	Name         string         `json:"name"`
	Version      string         `json:"version"`
	Kind         string         `json:"kind"`
	State        string         `json:"state"`
	Capabilities []string       `json:"capabilities"`
	Tools        []string       `json:"tools"`
	View         bool           `json:"view"`
	Theme        *plugins.Theme `json:"theme,omitempty"`
}

type toolDescriptor struct {
	Name        string          `json:"name"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Confirm     bool            `json:"confirm,omitempty"`
}

type toolEntry struct {
	plugin     *pluginEntry
	workerName string
	schema     *jsonschema.Schema
	confirm    bool
}

type request struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type response struct {
	ID     int64           `json:"id"`
	Result any             `json:"result,omitempty"`
	Error  *protocol.Error `json:"error,omitempty"`
}

type toolInvocation struct {
	Name     string          `json:"name"`
	Input    json.RawMessage `json:"input"`
	Context  json.RawMessage `json:"context"`
	Approved bool            `json:"approved"`
}

// Each installation supplies its own built-ins. Manifests define the tool catalog.
func newHost(pluginsDir, dataDir, disabled, zone string) (*host, error) {
	if !filepath.IsAbs(pluginsDir) || !filepath.IsAbs(dataDir) {
		return nil, errors.New("plugin and data directories must be absolute")
	}
	if !protocol.ValidPluginTimeZone(zone) {
		return nil, errors.New("invalid plugin time zone")
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	codec, err := protocol.NewCodec()
	if err != nil {
		return nil, err
	}
	dirs, err := os.ReadDir(pluginsDir)
	if err != nil {
		return nil, fmt.Errorf("read built-in plugins: %w", err)
	}
	h := &host{executable: exe, codec: codec, catalog: []toolDescriptor{}, tools: map[string]toolEntry{}, appearances: []appearanceEntry{}}
	disabledIDs := strings.Split(disabled, ",")
	for _, dir := range dirs {
		if !dir.IsDir() || strings.HasPrefix(dir.Name(), ".") || slices.Contains(disabledIDs, dir.Name()) {
			continue
		}
		files := os.DirFS(filepath.Join(pluginsDir, dir.Name()))
		if err := h.loadPlugin(files, dir.Name(), dataDir, zone); err != nil {
			return nil, fmt.Errorf("load plugin %q: %w", dir.Name(), err)
		}
	}
	return h, nil
}

func (h *host) loadPlugin(files fs.FS, id, dataDir, zone string) error {
	manifest, err := plugins.Validate(files)
	if err != nil {
		return err
	}
	if manifest.ID != id {
		return errors.New("directory must match plugin id")
	}
	if manifest.Kind == "appearance" {
		h.appearances = append(h.appearances, appearanceEntry{snapshot: pluginSnapshot{
			PluginID: id,
			Name:     manifest.Name,
			Version:  manifest.Version,
			Kind:     manifest.Kind,
			State:    "ready",
			Theme:    manifest.Contributes.Theme,
		}})
		return nil
	}
	for _, capability := range manifest.Capabilities {
		if capability != "storage" && capability != "agent.tools" {
			return fmt.Errorf("unsupported capability %q", capability)
		}
	}
	plugin := &pluginEntry{snapshot: pluginSnapshot{
		PluginID:     id,
		Name:         manifest.Name,
		Version:      manifest.Version,
		Kind:         manifest.Kind,
		State:        "stopped",
		Capabilities: append([]string(nil), manifest.Capabilities...),
		View:         len(manifest.Contributes.Views) > 0,
	}, load: protocol.PluginLoadRequest{
		PluginID: id, API: manifest.API, Entry: manifest.Worker,
		Capabilities: manifest.Capabilities, TimeZone: zone, View: len(manifest.Contributes.Views) > 0,
		Files: []protocol.PluginFile{}, Tools: []string{},
	}}
	if slices.Contains(manifest.Capabilities, "storage") {
		plugin.storage = &pluginStorage{filename: filepath.Join(dataDir, id, "storage.json")}
	}
	var size int
	if err := fs.WalkDir(files, ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || strings.HasPrefix(name, "ui/") || !slices.Contains([]string{".js", ".mjs", ".ts"}, path.Ext(name)) {
			return nil
		}
		data, err := fs.ReadFile(files, name)
		if err != nil {
			return err
		}
		size += len(data)
		if len(plugin.load.Files) >= 256 || size > 4<<20 {
			return errors.New("worker sources exceed 256 files or 4 MiB")
		}
		plugin.load.Files = append(plugin.load.Files, protocol.PluginFile{Path: name, Text: string(data)})
		return nil
	}); err != nil {
		return err
	}
	for _, tool := range manifest.Contributes.Tools {
		if len(h.catalog) >= 128 {
			return errors.New("plugin tool limit exceeded")
		}
		name := strings.ReplaceAll(id, "-", "_") + "__" + tool.Name
		schema, err := compileInputSchema(name, tool.InputSchema)
		if err != nil {
			return fmt.Errorf("compile %s input schema: %w", name, err)
		}
		plugin.load.Tools = append(plugin.load.Tools, tool.Name)
		plugin.snapshot.Tools = append(plugin.snapshot.Tools, name)
		h.catalog = append(h.catalog, toolDescriptor{name, tool.Title, tool.Description, tool.InputSchema, tool.Confirm})
		h.tools[name] = toolEntry{plugin, tool.Name, schema, tool.Confirm}
	}
	h.plugins = append(h.plugins, plugin)
	return nil
}

type offlineSchemaLoader struct{}

func (offlineSchemaLoader) Load(ref string) (any, error) {
	return nil, fmt.Errorf("external schema reference %q is unsupported", ref)
}

func compileInputSchema(name string, raw json.RawMessage) (*jsonschema.Schema, error) {
	schema, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.UseLoader(offlineSchemaLoader{})
	uri := "urn:xtwork:plugin-tool:" + name
	if err := compiler.AddResource(uri, schema); err != nil {
		return nil, err
	}
	return compiler.Compile(uri)
}

func (h *host) close() {
	for _, plugin := range h.plugins {
		if plugin.worker != nil {
			plugin.worker.close()
		}
	}
}

func (h *host) serve(ctx context.Context, input io.Reader, output io.Writer) error {
	reader, writer := protocol.NewReader(input), protocol.NewWriter(output)
	for {
		line, err := reader.ReadFrame(ctx)
		if errors.Is(err, io.EOF) || ctx.Err() != nil {
			return nil
		}
		if err != nil {
			return err
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			return err
		}
		resp := h.dispatch(ctx, req)
		data, err := json.Marshal(resp)
		if err != nil {
			return err
		}
		if err := writer.WriteFrame(ctx, data); err != nil {
			return err
		}
	}
}

func (h *host) dispatch(ctx context.Context, req request) response {
	resp := response{ID: req.ID}
	switch req.Method {
	case "plugins.list":
		result := make([]pluginSnapshot, 0, len(h.plugins)+len(h.appearances))
		for _, plugin := range h.plugins {
			result = append(result, plugin.snapshot)
		}
		for _, appearance := range h.appearances {
			result = append(result, appearance.snapshot)
		}
		resp.Result = result
	case "tools.list":
		resp.Result = h.catalog
	case "tools.invoke", "views.call":
		var call toolInvocation
		if len(req.Params) > protocol.PluginPayloadLimit || json.Unmarshal(req.Params, &call) != nil {
			resp.Error = wireError(protocol.CodeSchemaInvalid)
			return resp
		}
		tool, ok := h.tools[call.Name]
		if !ok || req.Method == "views.call" && !tool.plugin.load.View {
			resp.Error = wireError(protocol.CodePluginNotEnabled)
			return resp
		}
		if tool.confirm && !call.Approved {
			resp.Error = wireError(protocol.CodePluginNotEnabled)
			return resp
		}
		input, err := jsonschema.UnmarshalJSON(bytes.NewReader(call.Input))
		if err != nil || tool.schema.Validate(input) != nil {
			resp.Error = wireError(protocol.CodeSchemaInvalid)
			return resp
		}
		kind := "tool"
		if req.Method == "views.call" {
			kind = "view"
		}
		resp.Result, resp.Error = h.invoke(ctx, tool, call, kind)
	default:
		resp.Error = wireError(protocol.CodeMethodNotSupported)
	}
	return resp
}

func (h *host) invoke(ctx context.Context, tool toolEntry, call toolInvocation, kind string) (any, *protocol.Error) {
	plugin := tool.plugin
	if plugin.worker == nil {
		worker, err := startWorker(ctx, h.executable, h.codec, plugin)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return nil, wireError(protocol.CodePluginFailed)
		}
		plugin.worker = worker
	}
	output, err := plugin.worker.invoke(ctx, protocol.PluginInvokeRequest{
		Kind: kind, Name: tool.workerName, Input: call.Input, Context: call.Context,
	})
	if err != nil {
		var failure *protocol.Error
		if errors.As(err, &failure) && failure.Code != protocol.CodePluginTimeout {
			return nil, failure
		}
		plugin.worker.close()
		plugin.worker = nil
		if failure != nil {
			return nil, failure
		}
		fmt.Fprintln(os.Stderr, err)
		return nil, wireError(protocol.CodePluginFailed)
	}
	return output, nil
}
