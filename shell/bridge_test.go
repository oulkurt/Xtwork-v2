package main

import (
	"encoding/json/v2"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo"
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

func TestWindowOptionsDarwin(t *testing.T) {
	brand := branding{Name: "小瞳 Work", DisplayName: "小瞳 Work v2", StageLabel: "Alpha"}
	opts := windowOptions(brand, "darwin")
	if opts.Title != brand.DisplayName {
		t.Fatalf("unexpected Title: got %q, want %q", opts.Title, brand.DisplayName)
	}
	if opts.Width != 1200 || opts.Height != 800 {
		t.Fatalf("unexpected size: got %dx%d, want 1200x800", opts.Width, opts.Height)
	}
	if opts.MinWidth != 768 || opts.MinHeight != 500 {
		t.Fatalf("unexpected min size: got %dx%d, want 768x500", opts.MinWidth, opts.MinHeight)
	}
	if opts.TitleBarStyle != mygo.TitleBarHiddenInset {
		t.Fatalf("unexpected TitleBarStyle: got %q, want %q", opts.TitleBarStyle, mygo.TitleBarHiddenInset)
	}
	if opts.TitleBarHeight != 52 {
		t.Fatalf("unexpected TitleBarHeight: got %d, want 52", opts.TitleBarHeight)
	}
	if opts.TrafficLightPosition == nil || opts.TrafficLightPosition.X != 18 || opts.TrafficLightPosition.Y != 19 {
		t.Fatalf("unexpected TrafficLightPosition: got %+v, want {X:18 Y:19}", opts.TrafficLightPosition)
	}
}

func TestWindowOptionsLinux(t *testing.T) {
	brand := branding{Name: "小瞳 Work", DisplayName: "小瞳 Work v2", StageLabel: "Alpha"}
	opts := windowOptions(brand, "linux")
	if opts.Title != brand.DisplayName {
		t.Fatalf("unexpected Title: got %q, want %q", opts.Title, brand.DisplayName)
	}
	if opts.Width != 1200 || opts.Height != 800 {
		t.Fatalf("unexpected size: got %dx%d, want 1200x800", opts.Width, opts.Height)
	}
	if opts.MinWidth != 768 || opts.MinHeight != 500 {
		t.Fatalf("unexpected min size: got %dx%d, want 768x500", opts.MinWidth, opts.MinHeight)
	}
	if opts.TitleBarStyle != mygo.TitleBarHiddenInset {
		t.Fatalf("unexpected TitleBarStyle: got %q, want %q", opts.TitleBarStyle, mygo.TitleBarHiddenInset)
	}
	if opts.TitleBarHeight != 52 {
		t.Fatalf("unexpected TitleBarHeight: got %d, want 52", opts.TitleBarHeight)
	}
	if opts.TrafficLightPosition != nil {
		t.Fatalf("expected nil TrafficLightPosition on linux, got %+v", opts.TrafficLightPosition)
	}
}

func TestPreloadDragRegionAndCornerRadiusHooks(t *testing.T) {
	required := []string{
		`.drag-region { --app-region: drag; }`,
		`.drag-region :is(button, input, textarea, select, a), [class~="[-webkit-app-region:no-drag]"] { --app-region: no-drag; }`,
		`syncWindowCornerRadius`,
		`native.on("xtwork:fullscreen", (value) => { fullscreen = value; syncWindowCornerRadius(); });`,
		`document.documentElement.style.setProperty("--xtwork-window-radius", "0px")`,
		"document.documentElement.style.setProperty(\"--xtwork-window-radius\", `${radius}px`)",
		`document.documentElement.style.removeProperty("--xtwork-window-radius")`,
		`call("GetWindowCornerRadius")`,
		`.catch(() => {})`,
	}
	for _, needle := range required {
		if !strings.Contains(preload, needle) {
			t.Fatalf("preload.js missing expected snippet: %s", needle)
		}
	}
	if strings.Contains(preload, "::before") {
		t.Fatalf("preload.js must not rely on pseudo-element drag regions")
	}
	if strings.Contains(preload, "titlebar.insertRule") {
		t.Fatalf("preload.js must not accumulate titlebar.insertRule calls")
	}
	if nodePath, err := exec.LookPath("node"); err == nil {
		cmd := exec.Command(nodePath, "-e", `const fs = require("fs"); const vm = require("vm"); new vm.Script("(" + fs.readFileSync(0, "utf8") + ");");`)
		cmd.Stdin = strings.NewReader(preload)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("preload.js syntax check failed: %v: %s", err, string(out))
		}
	}
}
