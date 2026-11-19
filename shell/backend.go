package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const readinessPath = "/.well-known/t3/environment"

type desktopBootstrap struct {
	Mode                  string `json:"mode"`
	NoBrowser             bool   `json:"noBrowser"`
	Port                  int    `json:"port"`
	Home                  string `json:"t3Home"`
	Host                  string `json:"host"`
	Token                 string `json:"desktopBootstrapToken"`
	Secret                string `json:"desktopBootstrapSecret"`
	TailscaleServeEnabled bool   `json:"tailscaleServeEnabled"`
	TailscaleServePort    int    `json:"tailscaleServePort"`
}

type backend struct {
	origin string
	secret string
	name   string
	cancel context.CancelFunc
	done   <-chan struct{}

	authMu    sync.Mutex
	token     string
	expiresAt time.Time
}

func startBackend(parent context.Context, cfg config) (*backend, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("select local backend port: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	origin := fmt.Sprintf("http://127.0.0.1:%d", port)
	secret := hex.EncodeToString(randBytes(32))
	if err := os.MkdirAll(cfg.dataDir, 0700); err != nil {
		return nil, err
	}
	logPath := filepath.Join(cfg.dataDir, "backend.log")
	log, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	ready := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer log.Close()
		bootstrap := desktopBootstrap{
			Mode: "desktop", NoBrowser: true, Port: port, Home: cfg.dataDir, Host: "127.0.0.1",
			Secret: secret, TailscaleServePort: 443,
		}
		superviseBackend(ctx, cfg, bootstrap, origin, log, ready)
	}()
	select {
	case err := <-ready:
		if err == nil {
			return &backend{origin: origin, secret: secret, name: cfg.brand.DisplayName, cancel: cancel, done: done}, nil
		}
		cancel()
		<-done
		return nil, fmt.Errorf("start local server: %w (log: %s)", err, logPath)
	case <-ctx.Done():
		cancel()
		<-done
		return nil, ctx.Err()
	}
}

func superviseBackend(ctx context.Context, cfg config, bootstrap desktopBootstrap, origin string, log io.Writer, ready chan<- error) {
	var started bool
	backoff := 500 * time.Millisecond
	for ctx.Err() == nil {
		bootstrap.Token = bootstrapToken(bootstrap.Secret, time.Now())
		var data bytes.Buffer
		if err := json.NewEncoder(&data).Encode(bootstrap); err != nil {
			ready <- err
			return
		}
		cmd := exec.Command(cfg.node, cfg.serverEntry, "--bootstrap-fd", "0")
		cmd.Dir = filepath.Dir(cfg.serverEntry)
		cmd.Stdin = &data
		cmd.Stdout, cmd.Stderr = log, log
		cmd.Env = cfg.backendEnvironment()
		err := runBackend(ctx, cmd, origin, func() {
			if !started {
				started = true
				ready <- nil
			}
			backoff = 500 * time.Millisecond
		})
		if !started {
			ready <- err
			return
		}
		if ctx.Err() != nil {
			return
		}
		fmt.Fprintf(log, "Xtwork backend stopped: %v\n", err)
		var exit *exec.ExitError
		if errors.As(err, &exit) && (exit.ExitCode() == 77 || exit.ExitCode() == 78) {
			return // T3 refused to run under managed policy or another state-directory owner.
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
			backoff = min(2*backoff, 10*time.Second)
		}
	}
}

func runBackend(ctx context.Context, cmd *exec.Cmd, origin string, signalReady func()) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	exit := make(chan error, 1)
	go func() { exit <- cmd.Wait() }()
	startup, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	poll := time.NewTicker(100 * time.Millisecond)
	defer poll.Stop()
	for {
		select {
		case err := <-exit:
			if err == nil {
				return errors.New("server quit before it became ready")
			}
			return err
		case <-startup.Done():
			stopProcess(cmd.Process, exit)
			return fmt.Errorf("wait for server readiness: %w", startup.Err())
		case <-poll.C:
			if probeBackend(startup, origin) {
				signalReady()
				cancel()
				poll.Stop()
				select {
				case err := <-exit:
					return err
				case <-ctx.Done():
					stopProcess(cmd.Process, exit)
					return ctx.Err()
				}
			}
		}
	}
}

func stopProcess(process *os.Process, exit <-chan error) {
	if err := process.Signal(syscall.SIGTERM); err == nil {
		select {
		case <-exit:
			return
		case <-time.After(10 * time.Second):
		}
	}
	_ = process.Kill()
	<-exit
}

func (b *backend) stop() {
	b.cancel()
	<-b.done
}

var backendHTTP = &http.Client{
	Timeout:       10 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func probeBackend(ctx context.Context, origin string) bool {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+readinessPath, nil)
	if err != nil {
		return false
	}
	res, err := backendHTTP.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var descriptor struct {
		EnvironmentID string `json:"environmentId"`
	}
	return res.StatusCode == http.StatusOK && json.NewDecoder(res.Body).Decode(&descriptor) == nil && descriptor.EnvironmentID != ""
}

func (b *backend) bearerToken(ctx context.Context) (string, error) {
	b.authMu.Lock()
	defer b.authMu.Unlock()
	if b.token != "" && time.Now().Before(b.expiresAt) {
		return b.token, nil
	}
	const accessToken = "urn:ietf:params:oauth:token-type:access_token"
	form := url.Values{
		"grant_type":           {"urn:ietf:params:oauth:grant-type:token-exchange"},
		"subject_token":        {bootstrapToken(b.secret, time.Now())},
		"subject_token_type":   {"urn:t3:params:oauth:token-type:environment-bootstrap"},
		"requested_token_type": {accessToken},
		"client_label":         {b.name},
		"client_device_type":   {"desktop"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.origin+"/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := backendHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("local server authentication returned HTTP %d", res.StatusCode)
	}
	var session struct {
		Token     string `json:"access_token"`
		ExpiresIn int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(res.Body).Decode(&session); err != nil {
		return "", err
	}
	if session.Token == "" {
		return "", errors.New("local server did not return a session token")
	}
	b.token = session.Token
	b.expiresAt = time.Now().Add(time.Duration(session.ExpiresIn-60) * time.Second)
	return session.Token, nil
}

func bootstrapToken(secret string, now time.Time) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "t3-desktop-bootstrap:%d", now.Unix()/(12*60*60))
	return hex.EncodeToString(mac.Sum(nil))
}

func randBytes(size int) []byte {
	data := make([]byte, size)
	_, _ = rand.Read(data)
	return data
}
