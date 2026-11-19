package main

import (
	"bytes"
	"encoding/json"
	"time"

	"github.com/MoeForge/moejs"
	"github.com/MoeForge/moejs/engine"
	"github.com/oulkurt/Xtwork-v2/plugin-host/internal/protocol"
)

func capabilityException(rt *moejs.Runtime, code protocol.Code, message, reason string) error {
	r := rt.Realm()
	value := r.NewErrorValue(engine.KindError, engine.FromGoString(message))
	object := value.AsObject()
	_ = object.SetProp(r, r.KeyFromGoString("code"), engine.StringValue(engine.FromGoString(string(code))))
	if reason != "" {
		_ = object.SetProp(r, r.KeyFromGoString("reason"), engine.StringValue(engine.FromGoString(reason)))
	}
	return r.Throw(value)
}

// capabilityCallError 把一次能力调用的失败换成 JS 异常；调用成功时返回 nil。
// schema_invalid 只表示插件自己的参数有误；连接断开、超时与宿主结果异常都是 internal_error，
// 否则按错误码分支的 worker 会把宿主的故障当成自己的输入错误。
func capabilityCallError(rt *moejs.Runtime, response *protocol.Message, err error) error {
	if err != nil {
		return capabilityException(rt, protocol.CodeInternalError, "Capability call failed.", "")
	}
	if failure := response.Envelope.Error; failure != nil {
		reason, _ := failure.Details["reason"].(string)
		return capabilityException(rt, failure.Code, failure.Message, reason)
	}
	return nil
}

func (w *runtimeWorker) capabilityFunc(capability, method string) moejs.NativeFunc {
	if capability == "" {
		capability = "views"
	}
	return func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
		promise, settle := w.loop.NewPromise()
		reject := func(message string) {
			settle(func(rt *moejs.Runtime) (moejs.Value, error) {
				return moejs.Undefined(), capabilityException(rt, protocol.CodeSchemaInvalid, message, "")
			})
		}
		data, message := w.encodeCapabilityArgs(args)
		if message != "" {
			reject(message)
			return promise, nil
		}
		go func() {
			response, err := w.peer.capability(capability, method, data)
			settle(func(rt *moejs.Runtime) (moejs.Value, error) {
				if failure := capabilityCallError(rt, response, err); failure != nil {
					return moejs.Undefined(), failure
				}
				result := response.Payload.(*protocol.CapabilityCallResponse)
				if len(result.Result) > protocol.PluginPayloadLimit {
					return moejs.Undefined(), capabilityException(rt, protocol.CodeInternalError, "Capability result exceeds the limit.", "")
				}
				value, err := rt.ParseJSON(result.Result)
				if err != nil {
					return moejs.Undefined(), capabilityException(rt, protocol.CodeInternalError, "Invalid capability result.", "")
				}
				return value, nil
			})
		}()
		return promise, nil
	}
}

func (w *runtimeWorker) encodeCapabilityArgs(args []moejs.Value) ([]byte, string) {
	var data bytes.Buffer
	data.WriteByte('[')
	for i, arg := range args {
		if i > 0 {
			data.WriteByte(',')
		}
		encoded, err := w.rt.AppendJSON(nil, arg)
		if err != nil {
			return nil, "Invalid capability parameters."
		}
		data.Write(encoded)
		if data.Len()+1 > protocol.PluginPayloadLimit {
			return nil, "Capability parameters exceed the limit."
		}
	}
	data.WriteByte(']')
	return data.Bytes(), ""
}

// storageGetManyFunc 实现 storage.getMany（FX-getmany）。宿主每次只回答 keys 的一个前缀（编码后不超过 1 MiB），
// 这里用剩余的键继续请求，拼成一个数组交给 JS。页不是数组、还有剩余的键却没有进展、或多于剩余的键时拒绝，
// 宿主的错误回答因此不会让这里无限循环。重复的键可以让结果远大于 16 MiB 的配额，所以拼好的结果另限 17 MiB。
func (w *runtimeWorker) storageGetManyFunc() moejs.NativeFunc {
	return func(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
		promise, settle := w.loop.NewPromise()
		data, message := w.encodeCapabilityArgs(args)
		if message != "" {
			settle(func(rt *moejs.Runtime) (moejs.Value, error) {
				return moejs.Undefined(), capabilityException(rt, protocol.CodeSchemaInvalid, message, "")
			})
			return promise, nil
		}
		go func() {
			var params []json.RawMessage
			var keys []json.RawMessage
			validArray := json.Unmarshal(data, &params) == nil && len(params) == 1 && len(params[0]) > 0 && params[0][0] == '[' && json.Unmarshal(params[0], &keys) == nil
			var joined bytes.Buffer
			joined.WriteByte('[')
			count := 0
			for {
				response, err := w.peer.capability("storage", "getMany", data)
				if err != nil || response.Envelope.Error != nil {
					settle(func(rt *moejs.Runtime) (moejs.Value, error) {
						return moejs.Undefined(), capabilityCallError(rt, response, err)
					})
					return
				}
				result := response.Payload.(*protocol.CapabilityCallResponse)
				var page []json.RawMessage
				invalid := len(result.Result) > protocol.PluginPayloadLimit || !validArray || len(result.Result) == 0 || result.Result[0] != '[' || json.Unmarshal(result.Result, &page) != nil || len(page) > len(keys)-count || (len(page) == 0 && count < len(keys))
				if !invalid {
					for _, value := range page {
						if count > 0 {
							joined.WriteByte(',')
						}
						joined.Write(value)
						count++
					}
					invalid = joined.Len()+1 > 17<<20
				}
				if invalid {
					settle(func(rt *moejs.Runtime) (moejs.Value, error) {
						return moejs.Undefined(), capabilityException(rt, protocol.CodeInternalError, "Invalid capability result.", "")
					})
					return
				}
				if count == len(keys) {
					break
				}
				remaining, _ := json.Marshal(keys[count:])
				data = append(append([]byte{'['}, remaining...), ']')
			}
			joined.WriteByte(']')
			settle(func(rt *moejs.Runtime) (moejs.Value, error) {
				value, err := rt.ParseJSON(joined.Bytes())
				if err != nil {
					return moejs.Undefined(), capabilityException(rt, protocol.CodeInternalError, "Invalid capability result.", "")
				}
				return value, nil
			})
		}()
		return promise, nil
	}
}

func (w *runtimeWorker) installTimers() error {
	var timer *time.Timer
	start := moejs.NativeFunc(func(_ *moejs.Realm, _ moejs.Value, _ []moejs.Value) (moejs.Value, error) {
		timer = time.AfterFunc(5*time.Second, func() { w.rt.Interrupt(errTimeout); time.AfterFunc(time.Second, exitFatal) })
		return moejs.Undefined(), nil
	})
	stop := moejs.NativeFunc(func(_ *moejs.Realm, _ moejs.Value, _ []moejs.Value) (moejs.Value, error) {
		if timer != nil {
			timer.Stop()
			timer = nil
		}
		return moejs.Undefined(), nil
	})
	if err := w.rt.SetGlobal("__xt_timer_start", start); err != nil {
		return err
	}
	if err := w.rt.SetGlobal("__xt_timer_stop", stop); err != nil {
		return err
	}
	script, err := moejs.CompileScript("timers.js", `(() => {
		const originalTimeout = setTimeout, originalInterval = setInterval;
		const originalClearTimeout = clearTimeout, originalClearInterval = clearInterval;
		const start = __xt_timer_start, stop = __xt_timer_stop;
		delete globalThis.__xt_timer_start; delete globalThis.__xt_timer_stop;
		const active = new Map(); let next = 1;
		function schedule(repeat, fn, delay, args) {
			if (typeof fn !== 'function') throw new TypeError('callback required');
			if (active.size >= 64) throw new RangeError('timer limit');
			const id = next++; delay = Number(delay);
			if (!Number.isFinite(delay) || delay > 2147483647) delay = 10;
			delay = Math.max(10, delay || 0);
			const callback = () => { if (!repeat) active.delete(id); start(); try { fn(...args); } finally { stop(); } };
			const handle = (repeat ? originalInterval : originalTimeout)(callback, delay);
			active.set(id, {handle, repeat}); return id;
		}
		function clear(id) { const item = active.get(id); if (!item) return; active.delete(id); (item.repeat ? originalClearInterval : originalClearTimeout)(item.handle); }
		globalThis.setTimeout = (fn, delay, ...args) => schedule(false, fn, delay, args);
		globalThis.setInterval = (fn, delay, ...args) => schedule(true, fn, delay, args);
		globalThis.clearTimeout = clear; globalThis.clearInterval = clear;
		globalThis.setImmediate = undefined; globalThis.clearImmediate = undefined;
	})()`)
	if err != nil {
		return err
	}
	_, err = w.rt.RunScript(script)
	return err
}
