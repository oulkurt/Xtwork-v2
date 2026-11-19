package protocol

import (
	"bytes"
	"context"
	"encoding/json/jsontext"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

const MaxFrameBytes = 8_388_608

// Reader 由连接的唯一 reader 调用。取消阻塞的底层 Read 由 owner 关闭 pipe。
type Reader struct {
	input   io.Reader
	frame   []byte
	scanned int
	readErr error
	fatal   error
}

func NewReader(input io.Reader) *Reader {
	return &Reader{input: input}
}

// ReadFrame 返回不含行终止符的独立正文。EOF 紧跟 LF 时返回 io.EOF。
func (r *Reader) ReadFrame(ctx context.Context) ([]byte, error) {
	if r.fatal != nil {
		return nil, r.fatal
	}
	emptyReads := 0
	for {
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("read frame: %w", err)
		}
		if index := bytes.IndexByte(r.frame[r.scanned:], '\n'); index >= 0 {
			index += r.scanned
			frame := r.frame[:index:index]
			r.frame = r.frame[index+1:]
			r.scanned = 0
			if len(frame) != 0 && frame[len(frame)-1] == '\r' {
				frame = frame[: len(frame)-1 : len(frame)-1]
			}
			if err := validateFrame(frame); err != nil {
				r.fatal = err
				return nil, err
			}
			return frame, nil
		}
		r.scanned = len(r.frame)
		if len(r.frame) == MaxFrameBytes+1 && r.frame[MaxFrameBytes] != '\r' {
			r.fatal = failure(LayerFraming, CodeFrameTooLarge, "frame_too_large", nil)
			r.frame = nil
			return nil, r.fatal
		}
		if r.readErr != nil {
			if errors.Is(r.readErr, io.EOF) && len(r.frame) != 0 {
				r.fatal = failure(LayerFraming, CodeEOFPartialFrame, "eof_partial_frame", r.readErr)
			} else {
				r.fatal = fmt.Errorf("read frame: %w", r.readErr)
			}
			r.frame = nil
			return nil, r.fatal
		}
		// 上限后的 CR 只需再读一个 LF。正文缓冲不容纳该终止符。
		if len(r.frame) == MaxFrameBytes+1 {
			var terminator [1]byte
			n, err := r.input.Read(terminator[:])
			r.readErr = err
			if n == 1 {
				if terminator[0] != '\n' {
					r.fatal = failure(LayerFraming, CodeFrameTooLarge, "frame_too_large", nil)
					r.frame = nil
					return nil, r.fatal
				}
				frame := r.frame[:MaxFrameBytes:MaxFrameBytes]
				r.frame, r.scanned = nil, 0
				if err := validateFrame(frame); err != nil {
					r.fatal = err
					return nil, err
				}
				return frame, nil
			}
			emptyReads++
		} else {
			if len(r.frame) == cap(r.frame) {
				size := max(4096, cap(r.frame)*2)
				size = min(size, MaxFrameBytes+1)
				next := make([]byte, len(r.frame), size)
				copy(next, r.frame)
				r.frame = next
			}
			used := len(r.frame)
			n, err := r.input.Read(r.frame[used:cap(r.frame)])
			r.frame = r.frame[:used+n]
			r.readErr = err
			if n == 0 {
				emptyReads++
			} else {
				emptyReads = 0
			}
		}
		if emptyReads >= 100 && r.readErr == nil {
			r.readErr = io.ErrNoProgress
		}
	}
}

func validateFrame(frame []byte) error {
	if !utf8.Valid(frame) {
		return failure(LayerFraming, CodeSchemaInvalid, "invalid_utf8", nil)
	}
	if len(frame) == 0 {
		return failure(LayerFraming, CodeSchemaInvalid, "empty_line", nil)
	}
	if bytes.IndexByte(frame, '\r') >= 0 || bytes.IndexByte(frame, '\n') >= 0 {
		return failure(LayerFraming, CodeSchemaInvalid, "invalid_json", nil)
	}
	decoder := jsontext.NewDecoder(bytes.NewReader(frame))
	value, err := decoder.ReadValue()
	if err != nil {
		reason := "invalid_json"
		if errors.Is(err, jsontext.ErrDuplicateName) {
			reason = "duplicate_key"
		}
		return failure(LayerFraming, CodeSchemaInvalid, reason, err)
	}
	kind := value.Kind()
	if _, err := decoder.ReadValue(); !errors.Is(err, io.EOF) {
		return failure(LayerFraming, CodeSchemaInvalid, "invalid_json", err)
	}
	if kind != '{' {
		return failure(LayerFraming, CodeSchemaInvalid, "not_object", nil)
	}
	return nil
}

// Writer 使用有界互斥令牌串行写帧，不创建 goroutine，不拥有底层 pipe。
type Writer struct {
	output io.Writer
	gate   chan struct{}
	fatal  error
}

func NewWriter(output io.Writer) *Writer {
	return &Writer{output: output, gate: make(chan struct{}, 1)}
}

// WriteFrame 接受 JSON object，紧凑编码后一次 Write 完整写出正文与 LF。
// 底层 Write 的中止由连接 owner 负责关闭 pipe 或设置 deadline。
func (w *Writer) WriteFrame(ctx context.Context, frame []byte) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("write frame: %w", err)
	}
	select {
	case w.gate <- struct{}{}:
		defer func() { <-w.gate }()
	case <-ctx.Done():
		return fmt.Errorf("wait writer: %w", ctx.Err())
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("write frame: %w", err)
	}
	if w.fatal != nil {
		return w.fatal
	}
	// Writer 接受缩进文档，但只输出紧凑 JSON。Compact 同时拒绝重复键。
	if !utf8.Valid(frame) {
		return failure(LayerFraming, CodeSchemaInvalid, "invalid_utf8", nil)
	}
	value := jsontext.Value(bytes.Clone(frame))
	if err := value.Compact(); err != nil {
		reason := "invalid_json"
		if errors.Is(err, jsontext.ErrDuplicateName) {
			reason = "duplicate_key"
		}
		return failure(LayerFraming, CodeSchemaInvalid, reason, err)
	}
	if err := validateFrame(value); err != nil {
		return err
	}
	if len(value) > MaxFrameBytes {
		return failure(LayerFraming, CodeFrameTooLarge, "frame_too_large", nil)
	}
	wire := append(value, '\n')
	n, err := w.output.Write(wire)
	if err == nil && n != len(wire) {
		err = io.ErrShortWrite
	}
	if err != nil {
		w.fatal = fmt.Errorf("write frame: %w", err)
		return w.fatal
	}
	return nil
}
