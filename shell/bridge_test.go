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
		`native.on("xtwork:window-state", () => { syncWindowCornerRadius(); });`,
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
	nodePath, err := exec.LookPath("node")
	if err != nil {
		return
	}
	script := `
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const source = fs.readFileSync(0, "utf8");

(async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const props = new Map();
  const nativeHandlers = new Map();
  const windowHandlers = new Map();
  const radiusResponses = [
    () => Promise.resolve(8),
    () => Promise.resolve(0),
    () => Promise.resolve(8),
  ];
  let deferredResolve = null;
  radiusResponses.push(() => new Promise((resolve) => { deferredResolve = resolve; }));
  radiusResponses.push(() => Promise.resolve(20));
  radiusResponses.push(() => Promise.resolve(-1));
  radiusResponses.push(() => Promise.resolve(null));
  radiusResponses.push(() => Promise.resolve(0));

  const documentElement = {
    style: {
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k),
      getPropertyValue: (k) => props.get(k) ?? "",
    },
  };
  const win = {
    addEventListener: (name, fn) => {
      const list = windowHandlers.get(name) ?? [];
      list.push(fn);
      windowHandlers.set(name, list);
    },
    mygo: {
      call: (method) => {
        if (method === "Desktop.GetWindowCornerRadius") {
          const next = radiusResponses.shift();
          return next ? next() : Promise.resolve(0);
        }
        return Promise.resolve(null);
      },
      on: (name, fn) => {
        const list = nativeHandlers.get(name) ?? [];
        list.push(fn);
        nativeHandlers.set(name, list);
        return () => {};
      },
    },
  };
  win.top = win;

  class FakeCSSStyleSheet {
    replaceSync(text) { this.text = text; }
  }

  const sandbox = {
    window: win,
    location: { origin: "http://127.0.0.1:43123" },
    navigator: { language: "zh-CN" },
    document: { documentElement, adoptedStyleSheets: [] },
    CSSStyleSheet: FakeCSSStyleSheet,
    Object,
    Number,
    setTimeout,
    clearTimeout,
  };
  const fn = vm.runInNewContext("(" + source + ")", sandbox);
  fn({
    origin: "http://127.0.0.1:43123",
    wsOrigin: "ws://127.0.0.1:43123",
    bootstrapToken: "tok",
    platform: "windows",
    preferredLanguages: ["zh-CN"],
    backendLogPath: "/tmp/backend.log",
    branding: { baseName: "小瞳 Work", displayName: "小瞳 Work", stageLabel: "" },
  });

  await flush();
  assert.strictEqual(props.get("--xtwork-window-radius"), "8px");

  for (const h of nativeHandlers.get("xtwork:window-state") ?? []) h("maximize");
  await flush();
  assert.strictEqual(props.get("--xtwork-window-radius"), "0px");

  for (const h of nativeHandlers.get("xtwork:window-state") ?? []) h("unmaximize");
  await flush();
  assert.strictEqual(props.get("--xtwork-window-radius"), "8px");

  for (const h of nativeHandlers.get("xtwork:window-state") ?? []) h("unmaximize");
  for (const h of nativeHandlers.get("xtwork:fullscreen") ?? []) h(true);
  assert.strictEqual(props.get("--xtwork-window-radius"), "0px");
  deferredResolve(16);
  await flush();
  assert.strictEqual(props.get("--xtwork-window-radius"), "0px");

  for (const h of nativeHandlers.get("xtwork:fullscreen") ?? []) h(false);
  await flush();
  assert.strictEqual(props.get("--xtwork-window-radius"), "20px");

  for (const h of nativeHandlers.get("xtwork:window-state") ?? []) h("unmaximize");
  await flush();
  assert.strictEqual(props.has("--xtwork-window-radius"), false);

  props.set("--xtwork-window-radius", "12px");
  for (const h of nativeHandlers.get("xtwork:window-state") ?? []) h("unmaximize");
  await flush();
  assert.strictEqual(props.has("--xtwork-window-radius"), false);

  for (const h of windowHandlers.get("resize") ?? []) h();
  await new Promise((resolve) => setTimeout(resolve, 90));
  await flush();
  assert.strictEqual(props.get("--xtwork-window-radius"), "0px");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`
	cmd := exec.Command(nodePath, "-e", script)
	cmd.Stdin = strings.NewReader(preload)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("preload.js runtime verification failed: %v: %s", err, string(out))
	}
}
