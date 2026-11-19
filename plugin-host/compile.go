package main

import (
	"context"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/MoeForge/moejs"
	"github.com/oulkurt/Xtwork-v2/plugin-host/internal/protocol"
)

func compile(req *protocol.PluginLoadRequest) (*moejs.Module, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return compileContext(ctx, req)
}

func compileContext(ctx context.Context, req *protocol.PluginLoadRequest) (*moejs.Module, error) {
	files := make(map[string]string, len(req.Files))
	total := 0
	for _, file := range req.Files {
		name := file.Path
		if name == "" || path.Clean(name) != name || path.IsAbs(name) || strings.HasPrefix(name, "../") || strings.HasPrefix(name, "ui/") || strings.Contains(name, "\\") || !(strings.HasSuffix(name, ".js") || strings.HasSuffix(name, ".mjs") || strings.HasSuffix(name, ".ts")) {
			return nil, errors.New("invalid path")
		}
		if _, ok := files[name]; ok {
			return nil, errors.New("duplicate path")
		}
		total += len(file.Text)
		if total > 4*1024*1024 {
			return nil, errors.New("source too large")
		}
		files[name] = file.Text
	}
	modules := map[string]*moejs.Module{}
	var load func(string) (*moejs.Module, error)
	load = func(name string) (*moejs.Module, error) {
		if m := modules[name]; m != nil {
			return m, nil
		}
		text, ok := files[name]
		if !ok {
			return nil, fmt.Errorf("module %s is not among the plugin's worker files (files under ui/ are not sent to the worker)", name)
		}
		m, err := moejs.CompileWith(name, text, moejs.CompileOptions{TypeScript: strings.HasSuffix(name, ".ts"), Context: ctx})
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		modules[name] = m
		return m, nil
	}
	entry, err := load(req.Entry)
	if err != nil {
		return nil, err
	}
	return moejs.Link(entry, func(ref moejs.Referrer, spec string) (*moejs.Module, error) {
		if !strings.HasPrefix(spec, "./") && !strings.HasPrefix(spec, "../") {
			return nil, fmt.Errorf("%s imports %q: only relative imports of plugin files are allowed", ref.Name(), spec)
		}
		name := path.Clean(path.Join(path.Dir(ref.Name()), spec))
		if strings.HasPrefix(name, "../") || path.IsAbs(name) {
			return nil, fmt.Errorf("%s imports %q, which leaves the plugin directory", ref.Name(), spec)
		}
		return load(name)
	})
}
