package main

import (
	"encoding/json"
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
