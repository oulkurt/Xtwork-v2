package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestDesktopBackendBootstrapAndRestart(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is needed for the desktop backend integration test")
	}
	dataDir := t.TempDir()
	entry := filepath.Join(dataDir, "server.mjs")
	if err := os.WriteFile(entry, []byte(testBackendJS), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("T3CODE_TELEMETRY_ENABLED", "true")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	b, err := startBackend(ctx, config{
		brand: branding{DisplayName: "Desktop Test"}, node: node, serverEntry: entry, dataDir: dataDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.stop)
	firstToken, err := b.bearerToken(ctx)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.Get(b.origin + "/crash")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	res.Body.Close()
	poll := time.NewTicker(50 * time.Millisecond)
	defer poll.Stop()
	var secondToken string
	for secondToken == "" || secondToken == firstToken {
		select {
		case <-ctx.Done():
			t.Fatal("server did not restart at the same origin")
		case <-poll.C:
			secondToken, _ = b.bearerToken(ctx)
		}
	}
	b.stop()
	if probeBackend(context.Background(), b.origin) {
		t.Fatal("server still accepts requests after desktop quit")
	}
}

const testBackendJS = `
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
const bootstrap = JSON.parse(readFileSync(0, "utf8"));
const expected = createHmac("sha256", bootstrap.desktopBootstrapSecret)
  .update("t3-desktop-bootstrap:" + Math.floor(Date.now() / (12 * 60 * 60 * 1000))).digest("hex");
if (process.argv.slice(2).join(" ") !== "--bootstrap-fd 0" ||
    process.env.T3CODE_TELEMETRY_ENABLED !== "false" || bootstrap.mode !== "desktop" ||
    bootstrap.host !== "127.0.0.1" || !bootstrap.noBrowser ||
    bootstrap.desktopBootstrapToken !== expected || bootstrap.t3Home !== process.env.XTWORK_DATA_DIR) {
  throw new Error("invalid desktop bootstrap");
}
createServer(async (req, res) => {
  if (req.url === "/.well-known/t3/environment") return res.end(JSON.stringify({ environmentId: "test" }));
  if (req.url === "/crash") return res.end("", () => process.exit(9));
  if (req.url === "/oauth/token" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const fields = new URLSearchParams(Buffer.concat(chunks).toString());
    if (fields.get("subject_token") === expected && fields.get("client_device_type") === "desktop") {
      return res.end(JSON.stringify({ access_token: "test-session-" + process.pid }));
    }
  }
  res.writeHead(404).end();
}).listen(bootstrap.port, bootstrap.host);
`
