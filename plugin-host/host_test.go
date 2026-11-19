package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 3 && os.Args[1] == "worker" {
		if err := run(os.Args[1:]); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestTodoToolsAndViewSharePersistentStorage(t *testing.T) {
	plugins, err := filepath.Abs("../plugins")
	if err != nil {
		t.Fatal(err)
	}
	data := t.TempDir()
	openHost := func(disabled string) *host {
		t.Helper()
		h, err := newHost(plugins, data, disabled, "UTC")
		if err != nil {
			t.Fatal(err)
		}
		return h
	}
	invoke := func(h *host, method, input string) response {
		t.Helper()
		return h.dispatch(t.Context(), request{Method: method, Params: json.RawMessage(input)})
	}
	query := `{"name":"todo__list","input":{}}`
	create := `{"name":"todo__create","input":{"title":"Check the plugin"},"context":{"threadId":"thread-a"}}`
	first := openHost("")
	created := invoke(first, "tools.invoke", create)
	first.close()
	if created.Error != nil {
		t.Fatal(created.Error)
	}

	reopened := openHost("")
	defer reopened.close()
	listed := invoke(reopened, "views.call", query)
	if listed.Error != nil {
		t.Fatal(listed.Error)
	}
	var result struct {
		Total int `json:"total"`
		Items []struct {
			Title          string `json:"title"`
			SourceThreadID string `json:"sourceThreadId"`
		} `json:"items"`
	}
	if err := json.Unmarshal(listed.Result.(json.RawMessage), &result); err != nil {
		t.Fatal(err)
	}
	if result.Total != 1 || len(result.Items) != 1 || result.Items[0].Title != "Check the plugin" || result.Items[0].SourceThreadID != "thread-a" {
		t.Fatalf("view did not read the persisted tool result: %+v", result)
	}

	disabled := openHost("todo")
	defer disabled.close()
	if got := disabled.dispatch(t.Context(), request{Method: "tools.list"}); len(got.Result.([]toolDescriptor)) != 0 {
		t.Fatalf("disabled plugin was advertised: %+v", got)
	}
	for _, method := range []string{"tools.invoke", "views.call"} {
		if got := invoke(disabled, method, query); got.Error == nil || got.Error.Code != "plugin_not_enabled" {
			t.Fatalf("disabled plugin accepted %s: %+v", method, got)
		}
	}
}

func TestTodoViewCanLoadPastFirstPage(t *testing.T) {
	plugins, err := filepath.Abs("../plugins")
	if err != nil {
		t.Fatal(err)
	}
	h, err := newHost(plugins, t.TempDir(), "", "UTC")
	if err != nil {
		t.Fatal(err)
	}
	defer h.close()
	for i := 1; i <= 51; i++ {
		create := fmt.Sprintf(`{"name":"todo__create","input":{"title":"Todo %d"}}`, i)
		result := h.dispatch(t.Context(), request{Method: "tools.invoke", Params: json.RawMessage(create)})
		if result.Error != nil {
			t.Fatal(result.Error)
		}
	}
	seen := make(map[string]bool, 51)
	for i, wantCount := range []int{50, 1} {
		query := fmt.Sprintf(`{"name":"todo__list","input":{"offset":%d}}`, i*50)
		result := h.dispatch(t.Context(), request{Method: "views.call", Params: json.RawMessage(query)})
		if result.Error != nil {
			t.Fatal(result.Error)
		}
		var page struct {
			Items      []struct{ Title string } `json:"items"`
			NextOffset *int                     `json:"nextOffset"`
		}
		if err := json.Unmarshal(result.Result.(json.RawMessage), &page); err != nil {
			t.Fatal(err)
		}
		if len(page.Items) != wantCount || (i == 0 && (page.NextOffset == nil || *page.NextOffset != 50)) ||
			(i == 1 && page.NextOffset != nil) {
			t.Fatalf("unexpected page %d: %+v", i+1, page)
		}
		for _, item := range page.Items {
			if seen[item.Title] {
				t.Fatalf("duplicate item %q across pages", item.Title)
			}
			seen[item.Title] = true
		}
	}
}

func TestRepeatedThreadToolInvocationIsIdempotent(t *testing.T) {
	plugins, err := filepath.Abs("../plugins")
	if err != nil {
		t.Fatal(err)
	}
	data := t.TempDir()
	h, err := newHost(plugins, data, "", "UTC")
	if err != nil {
		t.Fatal(err)
	}

	create := func(h *host, key string) string {
		t.Helper()
		params := fmt.Sprintf(`{"name":"todo__create","input":{"title":"Same title"},"context":{"threadId":"thread-retry","operationKey":%q}}`, key)
		result := h.dispatch(t.Context(), request{Method: "tools.invoke", Params: json.RawMessage(params)})
		if result.Error != nil {
			t.Fatal(result.Error)
		}
		return string(result.Result.(json.RawMessage))
	}
	first := create(h, "request-one")
	h.close()

	h, err = newHost(plugins, data, "", "UTC")
	if err != nil {
		t.Fatal(err)
	}
	defer h.close()
	if got := create(h, "request-one"); got != first {
		t.Fatalf("retry returned a different todo: %s", got)
	}
	if got := create(h, "request-two"); got == first {
		t.Fatal("a new request reused the first todo")
	}
	result := h.dispatch(t.Context(), request{
		Method: "tools.invoke",
		Params: json.RawMessage(`{"name":"todo__list","input":{"limit":10}}`),
	})
	if result.Error != nil {
		t.Fatal(result.Error)
	}
	var listed struct {
		Total int `json:"total"`
	}
	if err := json.Unmarshal(result.Result.(json.RawMessage), &listed); err != nil {
		t.Fatal(err)
	}
	if listed.Total != 2 {
		t.Fatalf("expected two todos after three calls, got %d", listed.Total)
	}
	stored, err := os.ReadFile(filepath.Join(data, "todo", "storage.json"))
	if err != nil {
		t.Fatal(err)
	}
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(stored, &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected one storage entry per todo, got %d entries", len(entries))
	}
}

func TestPluginCanContributeToolsWithoutViews(t *testing.T) {
	plugins := t.TempDir()
	dir := filepath.Join(plugins, "test-tools")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, contents := range map[string]string{
		"plugin.json": `{
			"id": "test-tools",
			"name": "Test tools",
			"version": "1.0.0",
			"api": 1,
			"description": "Sample tool plugin",
			"icon": "plugin-addon-puzzle",
			"worker": "worker.js",
			"capabilities": ["agent.tools"],
			"contributes": {"tools": [{
				"name": "echo",
				"title": "Echo",
				"description": "Echo text.",
				"inputSchema": {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}}
			}]}
		}`,
		"worker.js": `export const tools = { echo: ({ text }, context) => ({ text, threadId: context.threadId }) };`,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	h, err := newHost(plugins, t.TempDir(), "", "UTC")
	if err != nil {
		t.Fatal(err)
	}
	defer h.close()
	catalog := h.dispatch(t.Context(), request{Method: "tools.list"}).Result.([]toolDescriptor)
	if len(catalog) != 1 || catalog[0].Name != "test_tools__echo" {
		t.Fatalf("unexpected tool catalog: %+v", catalog)
	}
	call := request{Method: "tools.invoke", Params: json.RawMessage(`{"name":"test_tools__echo","input":{"text":"hello"},"context":{"threadId":"thread-echo"}}`)}
	result := h.dispatch(t.Context(), call)
	if result.Error != nil || string(result.Result.(json.RawMessage)) != `{"text":"hello","threadId":"thread-echo"}` {
		t.Fatalf("unexpected echo response: %+v", result)
	}
	call.Method = "views.call"
	if result := h.dispatch(t.Context(), call); result.Error == nil || result.Error.Code != "plugin_not_enabled" {
		t.Fatalf("tool-only plugin accepted a view call: %+v", result)
	}
}
