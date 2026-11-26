package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/egoist/mygo"
)

//go:embed preload.js
var preload string

var (
	fullscreenEvent = mygo.NewEvent[bool]("xtwork:fullscreen")
	updateEvent     = mygo.NewEvent[updateState]("xtwork:update")
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	mygo.App.SetName(cfg.brand.DisplayName)
	mygo.App.SetVersion(cfg.brand.Version)
	if !mygo.App.RequestSingleInstanceLock() {
		return nil
	}
	shutdown, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server, err := startBackend(shutdown, cfg)
	if err != nil {
		return err
	}
	defer server.stop()
	desktop := &Desktop{server: server, dataDir: cfg.dataDir}
	desktop.updates = initialUpdateState(cfg.brand.Version)
	mygo.Bind(desktop)
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { server.stop() })
	mygo.App.OnSecondInstance(func([]string, string) { desktop.RevealWindow() })
	mygo.App.OnActivate(func(bool) { desktop.RevealWindow() })

	mygo.App.WhenReady(func() {
		desktop.openWindow(cfg.brand)
		go func() {
			<-shutdown.Done()
			mygo.App.Quit()
		}()
	})
	return mygo.App.Run()
}

func (d *Desktop) preloadInit(brand branding, lang []string) map[string]any {
	if lang == nil {
		lang = []string{}
	}
	return map[string]any{
		"origin":             d.server.origin,
		"wsOrigin":           "ws" + d.server.origin[len("http"):],
		"bootstrapToken":     bootstrapToken(d.server.secret, time.Now()),
		"platform":           runtime.GOOS,
		"preferredLanguages": lang,
		"backendLogPath":     backendLogPath(d.dataDir),
		"branding": map[string]string{
			"baseName": brand.Name, "displayName": brand.DisplayName, "stageLabel": brand.StageLabel,
		},
	}
}

func windowOptions(brand branding, goos string) mygo.WindowOptions {
	opts := mygo.WindowOptions{
		Title:          brand.DisplayName,
		Width:          1200,
		Height:         800,
		MinWidth:       768,
		MinHeight:      500,
		TitleBarStyle:  mygo.TitleBarHiddenInset,
		TitleBarHeight: 52,
	}
	if goos == "darwin" {
		opts.TrafficLightPosition = &mygo.Point{X: 18, Y: 19}
	}
	return opts
}

func (d *Desktop) openWindow(brand branding) {
	init, err := json.Marshal(d.preloadInit(brand, mygo.App.PreferredLanguages()))
	if err != nil {
		panic(err) // All values above are JSON strings or string arrays.
	}
	opts := windowOptions(brand, runtime.GOOS)
	opts.Page = mygo.PageOptions{
		TrustedOrigins: []string{d.server.origin},
		PreloadScript:  "(" + preload + ")(" + string(init) + ");",
	}
	win := mygo.NewWindow(opts)
	d.window = win
	page := win.Page()
	page.OnWillNavigate(func(e *mygo.NavigateEvent) {
		if isSameOrigin(e.URL, d.server.origin) {
			return
		}
		e.PreventDefault()
		if e.UserInitiated {
			d.OpenExternal(e.URL)
		}
	})
	page.SetWindowOpenHandler(func(req mygo.WindowOpenRequest) *mygo.WindowOptions {
		if req.UserInitiated {
			if isSameOrigin(req.URL, d.server.origin) {
				page.LoadURL(req.URL)
			} else {
				d.OpenExternal(req.URL)
			}
		}
		return nil
	})
	win.OnEnterFullScreen(func() { _ = fullscreenEvent.Emit(win, true) })
	win.OnLeaveFullScreen(func() { _ = fullscreenEvent.Emit(win, false) })
	page.LoadURL(d.server.origin + "/")
}

func isSameOrigin(rawURL, origin string) bool {
	parsed, err := url.Parse(rawURL)
	return err == nil && parsed.Scheme+"://"+parsed.Host == origin
}

func externalURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	switch parsed.Scheme {
	case "https", "http":
		if parsed.Host != "" {
			return nil
		}
	case "mailto":
		if parsed.Opaque != "" {
			return nil
		}
	}
	return fmt.Errorf("unsupported external URL scheme %q", parsed.Scheme)
}
