package main

import (
	"encoding/json/v2"
	"path/filepath"
	"testing"
)

func TestContextMenuPointDecodesWebCoordinates(t *testing.T) {
	var point *contextMenuPoint
	if err := json.Unmarshal([]byte(`{"x":68.5,"y":214.25}`), &point); err != nil {
		t.Fatal(err)
	}
	if point == nil || point.X != 68.5 || point.Y != 214.25 {
		t.Fatalf("unexpected popup coordinates: %+v", point)
	}
}

func TestPreloadInitIncludesBackendLogPath(t *testing.T) {
	desktop := &Desktop{
		server:  &backend{origin: "http://127.0.0.1:43123", secret: "test-secret"},
		dataDir: "/tmp/xtwork-isolated-profile",
	}
	init := desktop.preloadInit(branding{Name: "小瞳 Work", DisplayName: "小瞳 Work v2", StageLabel: "Alpha"}, nil)
	want := filepath.Join("/tmp/xtwork-isolated-profile", "backend.log")
	if got := init["backendLogPath"]; got != want {
		t.Fatalf("unexpected backendLogPath: got %v, want %q", got, want)
	}
}
