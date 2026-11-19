package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode"
	"unicode/utf8"

	"github.com/MoeForge/moejs"
	"github.com/MoeForge/moejs/engine"
	"github.com/MoeForge/moejs/eventloop"
	"github.com/oulkurt/Xtwork-v2/plugin-host/internal/protocol"
)

type result struct {
	value []byte
	err   error
}
type runtimeWorker struct {
	peer     *peer
	rt       *moejs.Runtime
	loop     *eventloop.Loop
	mod      *moejs.Module
	logTimes []time.Time
}

func (p *peer) work() {
	var w *runtimeWorker
	for req := range p.requests {
		switch req.Envelope.Method {
		case "plugin.load":
			if w != nil {
				p.respond(req, nil, wireError(protocol.CodePluginManifestInvalid))
				continue
			}
			load := req.Payload.(*protocol.PluginLoadRequest)
			if load.PluginID != p.id {
				p.respond(req, nil, wireError(protocol.CodePluginManifestInvalid))
				continue
			}
			var response protocol.PluginLoadResponse
			var err error
			w, response, err = newWorker(p, load)
			if err != nil {
				checkFatal(err)
				code := protocol.CodePluginManifestInvalid
				if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, errTimeout) {
					code = protocol.CodePluginTimeout
				}
				wire := wireError(code)
				if code == protocol.CodePluginTimeout {
					wire.Message = "Loading the worker took longer than 5 seconds."
				} else {
					wire.Message = loadErrorText(err)
				}
				p.respond(req, nil, wire)
				if code == protocol.CodePluginTimeout {
					exitFatal()
				}
				w = nil
			} else {
				p.respond(req, response, nil)
			}
		case "plugin.invoke":
			if w == nil {
				p.respond(req, nil, wireError(protocol.CodePluginManifestInvalid))
				continue
			}
			call := req.Payload.(*protocol.PluginInvokeRequest)
			out, err := w.invoke(call)
			if err != nil {
				checkFatal(err)
				wire := wireError(protocol.CodePluginError)
				var failure *protocol.Error
				if errors.As(err, &failure) {
					wire = failure
				} else if errors.Is(err, errTimeout) {
					wire = wireError(protocol.CodePluginTimeout)
				}
				p.respond(req, nil, wire)
				if errors.Is(err, errTimeout) {
					exitFatal()
				}
			} else {
				p.respond(req, protocol.PluginInvokeResponse{Output: out}, nil)
			}
		default:
			p.respond(req, nil, wireError(protocol.CodeMethodNotSupported))
		}
	}
}

var errTimeout = errors.New("plugin timeout")

// 钩子的异常在运行时线程内读取；只有能力错误码可以越过插件边界。
func pluginThrown(rt *moejs.Runtime, value moejs.Value) *protocol.Error {
	property := func(name string) (string, bool) {
		v, err := rt.Get(value, name)
		if err == nil && v.IsString() {
			return v.String(), true
		}
		return "", false
	}
	codeText, _ := property("code")
	message, _ := property("message")
	reason, _ := property("reason")
	code := protocol.Code(codeText)
	switch code {
	case protocol.CodeCapabilityDenied, protocol.CodeQuotaExceeded, protocol.CodeFolderNotSelected, protocol.CodeSchemaInvalid, protocol.CodeScopeEscape, protocol.CodePathUnresolved, protocol.CodeRequestCancelled, protocol.CodeInternalError:
		// 协议信封要求说明非空且不超过 1024 字符。
		message = cleanThrownText(message, 1024)
		if message == "" {
			message = string(code)
		}
		wire := &protocol.Error{Code: code, Message: message, Recovery: "none"}
		// 原因是给视图分支用的机器码；不合规的原因丢弃，不让插件借它传任意文本。
		if thrownReason.MatchString(reason) {
			wire.Details = map[string]any{"reason": reason}
		}
		return wire
	}
	if message == "" {
		if text, err := rt.Realm().ToString(value); err == nil {
			message = text.GoString()
		} else {
			message = value.String()
		}
	}
	message = cleanThrownText(message, 500)
	if message == "" {
		message = "Plugin error."
	}
	return &protocol.Error{Code: protocol.CodePluginError, Message: message, Recovery: "none"}
}

var thrownReason = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// cleanThrownText 去掉控制字符，最多保留 max 个字符。
func cleanThrownText(text string, max int) string {
	var clean strings.Builder
	count := 0
	for _, char := range text {
		if unicode.IsControl(char) {
			continue
		}
		if count == max {
			break
		}
		clean.WriteRune(char)
		count++
	}
	return clean.String()
}

// loadErrorText 把加载失败的原因写成说明：空白（含换行）合并为一个空格，去掉其余控制字符，最多 500 个字符；为空时给固定说明。
// 编译错误常带多行的代码位置，直接删除换行会把两行粘在一起。
func loadErrorText(err error) string {
	text := cleanThrownText(strings.Join(strings.Fields(err.Error()), " "), 500)
	if text == "" {
		return "The worker failed to load."
	}
	return text
}

func checkFatal(err error) {
	var internal *moejs.InternalError
	if errors.Is(err, moejs.ErrMemoryLimit) || errors.As(err, &internal) {
		exitFatal()
	}
}

func newWorker(p *peer, req *protocol.PluginLoadRequest) (*runtimeWorker, protocol.PluginLoadResponse, error) {
	var response protocol.PluginLoadResponse
	mod, err := compile(req)
	if err != nil {
		return nil, response, err
	}
	rt := moejs.NewRuntime(moejs.Options{MemoryLimit: 64 * 1024 * 1024, DisableDynamicCode: true, TimeZone: pluginTimeZone(req.TimeZone)})
	loop, err := eventloop.New(rt, eventloop.Options{OnError: func(err error) { checkFatal(err) }})
	if err != nil {
		return nil, response, err
	}
	w := &runtimeWorker{peer: p, rt: rt, loop: loop, mod: mod}
	if err = w.install(req.Capabilities); err != nil {
		return nil, response, err
	}
	ready := make(chan struct{})
	go func() {
		err := loop.Run(func(*moejs.Runtime) error { loop.Hold(); close(ready); return nil })
		if err != nil {
			checkFatal(err)
		}
	}()
	<-ready
	done := make(chan error, 1)
	loop.RunOnLoop(func(rt *moejs.Runtime) {
		fired := make(chan struct{})
		timer := time.AfterFunc(5*time.Second, func() { rt.Interrupt(errTimeout); close(fired) })
		err := rt.Load(mod)
		if err == nil {
			response, err = w.describe(req)
		}
		if !timer.Stop() {
			<-fired
			if err == nil {
				err = errTimeout
			}
		}
		done <- err
	})
	select {
	case err = <-done:
		if err != nil {
			loop.Terminate()
			return nil, response, err
		}
		return w, response, nil
	case <-time.After(6 * time.Second):
		loop.Interrupt(errTimeout)
		return nil, response, errTimeout
	}
}

func pluginTimeZone(name string) *time.Location {
	code := "plugin_timezone_invalid"
	if name == "" {
		code = "plugin_timezone_default"
	}
	// supervisor 提供空环境，因此 ZONEINFO 不影响系统数据库来源。
	if name != "" && name != "Local" && protocol.ValidPluginTimeZone(name) {
		if location, err := time.LoadLocation(name); err == nil {
			return location
		}
	}
	// 移除时间字段，避免格式化诊断时读取本地时区配置。
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{ReplaceAttr: func(_ []string, attr slog.Attr) slog.Attr {
		if attr.Key == slog.TimeKey {
			return slog.Attr{}
		}
		return attr
	}}))
	logger.Info("plugin timezone fallback", "code", code)
	return time.UTC
}

func (w *runtimeWorker) describe(req *protocol.PluginLoadRequest) (protocol.PluginLoadResponse, error) {
	response := protocol.PluginLoadResponse{Tools: []string{}}
	if tools, ok := w.rt.Export("tools"); ok && !tools.IsUndefined() {
		value, err := w.rt.ToGo(tools)
		if err != nil {
			return response, err
		}
		entries, ok := value.(map[string]any)
		if !ok {
			return response, errors.New(`export "tools" must be an object whose values are functions`)
		}
		for name := range entries {
			value, err := w.rt.Get(tools, name)
			if err != nil || !engine.IsCallable(value) {
				return response, fmt.Errorf("tools.%s is not a function", name)
			}
			response.Tools = append(response.Tools, name)
		}
	}
	for _, entry := range []struct {
		name   string
		target *bool
	}{{"onView", &response.View}, {"onSchedule", &response.Schedule}} {
		v, ok := w.rt.Export(entry.name)
		if ok && !v.IsUndefined() {
			if !engine.IsCallable(v) {
				return response, fmt.Errorf("export %q must be a function", entry.name)
			}
			*entry.target = true
		}
	}
	slices.Sort(response.Tools)
	declared := slices.Clone(req.Tools)
	slices.Sort(declared)
	if !slices.Equal(response.Tools, declared) {
		return response, fmt.Errorf("worker exports tools [%s] but plugin.json declares [%s]", strings.Join(response.Tools, ", "), strings.Join(declared, ", "))
	}
	if response.View != req.View {
		if response.View {
			return response, errors.New("worker exports onView but plugin.json declares no views")
		}
		return response, errors.New("plugin.json declares views but the worker does not export onView")
	}
	if response.Schedule != req.Schedule {
		if response.Schedule {
			return response, errors.New("worker exports onSchedule but plugin.json does not declare the schedule capability")
		}
		return response, errors.New("plugin.json declares the schedule capability but the worker does not export onSchedule")
	}
	return response, nil
}

func (w *runtimeWorker) invoke(req *protocol.PluginInvokeRequest) ([]byte, error) {
	duration := 30 * time.Second
	if req.Kind == "view" {
		duration = 10 * time.Second
	}
	done := make(chan result, 1)
	w.loop.RunOnLoop(func(rt *moejs.Runtime) {
		hookName := "onView"
		if req.Kind == "schedule" {
			hookName = "onSchedule"
		}
		if req.Kind == "tool" {
			hookName = "tools"
		}
		v, ok := rt.Export(hookName)
		if !ok {
			done <- result{err: errors.New("missing export")}
			return
		}
		var err error
		if req.Kind == "tool" {
			v, err = rt.Get(v, req.Name)
			if err != nil {
				done <- result{err: err}
				return
			}
		}
		input, err := rt.ParseJSON(req.Input)
		if err != nil {
			done <- result{err: err}
			return
		}
		args := []moejs.Value{moejs.String(req.Name), input}
		if req.Kind == "tool" {
			context := moejs.Undefined()
			if len(req.Context) > 0 {
				context, err = rt.ParseJSON(req.Context)
				if err != nil {
					done <- result{err: err}
					return
				}
			}
			args = []moejs.Value{input, context}
		}
		value, err := rt.CallFunction(v, moejs.Undefined(), args...)
		if err != nil {
			checkFatal(err)
			var exception *moejs.Exception
			if errors.As(err, &exception) {
				err = pluginThrown(rt, exception.Value)
			}
			done <- result{err: err}
			return
		}
		settle := func(value moejs.Value, rejected bool) {
			if rejected {
				select {
				case done <- result{err: pluginThrown(rt, value)}:
				default:
				}
				return
			}
			data, err := rt.AppendJSON(nil, value)
			if len(data) > 1024*1024 {
				err = &protocol.Error{Code: protocol.CodePluginError, Message: "Plugin output exceeds the limit.", Recovery: "none", Details: map[string]any{"reason": "output_too_large"}}
			}
			select {
			case done <- result{value: data, err: err}:
			default:
			}
		}
		state, val, isPromise := moejs.PromiseResult(value)
		if !isPromise {
			settle(value, false)
			return
		}
		if state != moejs.PromisePending {
			settle(val, state == moejs.PromiseRejected)
			return
		}
		then, err := rt.Get(value, "then")
		if err != nil {
			done <- result{err: err}
			return
		}
		okFn := rt.Function("resolve", 1, func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
			settle(moejs.Arg(args, 0), false)
			return moejs.Undefined(), nil
		})
		badFn := rt.Function("reject", 1, func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
			settle(moejs.Arg(args, 0), true)
			return moejs.Undefined(), nil
		})
		_, err = rt.CallFunction(then, value, okFn, badFn)
		if err != nil {
			done <- result{err: err}
		}
	})
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case result := <-done:
		return result.value, result.err
	case <-timer.C:
		w.loop.Interrupt(errTimeout)
		return nil, errTimeout
	case <-w.peer.done:
		return nil, errors.New("peer closed")
	}
}

func (w *runtimeWorker) install(capabilities []string) error {
	granted := map[string]bool{}
	for _, c := range capabilities {
		granted[c] = true
	}
	api := map[string]any{}
	for _, spec := range []struct {
		capability, member string
		methods            []string
	}{
		{"storage", "storage", []string{"get", "getMany", "set", "delete", "list"}}, {"schedule", "schedule", []string{"set", "cancel", "list"}}, {"usage.read", "usage", []string{"query"}}, {"fs.folder", "folder", []string{"status", "list", "read", "search", "write"}}, {"", "views", []string{"notify"}},
	} {
		if spec.capability != "" && !granted[spec.capability] {
			continue
		}
		methods := map[string]any{}
		for _, method := range spec.methods {
			if spec.capability == "storage" && method == "getMany" {
				methods[method] = w.storageGetManyFunc()
			} else {
				methods[method] = w.capabilityFunc(spec.capability, method)
			}
		}
		api[spec.member] = methods
	}
	if granted["notify"] {
		api["notify"] = w.capabilityFunc("notify", "notify")
	}
	if err := w.rt.SetGlobal("xtwork", api); err != nil {
		return err
	}
	console := map[string]any{}
	for _, level := range []string{"debug", "info", "warn", "error", "log"} {
		l := level
		if l == "log" {
			l = "info"
		}
		console[level] = moejs.NativeFunc(func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
			now := time.Now()
			kept := w.logTimes[:0]
			for _, at := range w.logTimes {
				if now.Sub(at) < time.Minute {
					kept = append(kept, at)
				}
			}
			w.logTimes = kept
			if len(w.logTimes) >= 60 {
				return moejs.Undefined(), nil
			}
			w.logTimes = append(w.logTimes, now)
			var text strings.Builder
			remaining := 2000
			for i, v := range args {
				if remaining == 0 {
					break
				}
				if i > 0 {
					text.WriteByte(' ')
					remaining--
				}
				if remaining == 0 {
					break
				}
				value := v.String()
				if utf8.RuneCountInString(value) > remaining {
					value = string([]rune(value)[:remaining])
				}
				text.WriteString(value)
				remaining -= utf8.RuneCountInString(value)
			}
			_ = w.peer.send(protocol.Envelope{Kind: protocol.KindEvent, ID: fmt.Sprintf("p-e%d", now.UnixNano()), Event: "plugin.log"}, protocol.PluginLogEvent{Level: l, Text: text.String()}, protocol.PluginVersion)
			return moejs.Undefined(), nil
		})
	}
	if err := w.rt.SetGlobal("console", console); err != nil {
		return err
	}
	return w.installTimers()
}
