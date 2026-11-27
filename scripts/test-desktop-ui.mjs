import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertNoLeakedUserVisibleBrand } from "./brandCatalog.mjs";
import { brand, build, root, t3 } from "./project.mjs";

const { chromium } = await import(
  join(t3, "apps", "web", "node_modules", "playwright", "index.mjs")
);
const resources = join(
  build,
  "desktop-dist",
  "darwin-arm64",
  `${brand.displayName}.app`,
  "Contents",
  "Resources",
);
assertNoLeakedUserVisibleBrand(join(resources, "server", "dist"));
const state = await mkdtemp(join(tmpdir(), "xtwork-desktop-ui-"));
const data = join(state, "data");
const folder = join(state, "Test folder");
const serverLog = join(state, "server.log");
const testOutput = join(build, "desktop-ui");
await mkdir(testOutput, { recursive: true });
await mkdir(join(data, "workspace"), { recursive: true });
await mkdir(folder);
execFileSync("git", ["init", "-q", folder]);
await writeFile(join(folder, "evidence.txt"), "Desktop diff verification\n");

for (const candidate of [
  join(homedir(), "Library", "Application Support", "Xtwork-v2", "tools", "chrome-headless-shell"),
  join(homedir(), ".t3", "tools", "chrome-headless-shell"),
]) {
  if (existsSync(candidate)) {
    await mkdir(join(data, "tools"), { recursive: true });
    await cp(candidate, join(data, "tools", "chrome-headless-shell"), { recursive: true });
    break;
  }
}

const previewFixtureHtml = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>小瞳浏览器验证页</title></head>
<body style="margin:0;padding:32px;font-family:sans-serif;background:#0f172a;color:#f8fafc;">
  <h1>Xtwork Browser Verification</h1>
  <p>ServerBrowser rendered inside ordinary desktop mode.</p>
</body>
</html>`;
const previewFixtureServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(previewFixtureHtml);
});
previewFixtureServer.listen(0, "127.0.0.1");
await once(previewFixtureServer, "listening");
const previewFixtureUrl = `http://127.0.0.1:${previewFixtureServer.address().port}/`;

const modelReply = "Assistant reply from the local test model.";
let modelRequests = 0;
const model = createServer((request, response) => {
  assert.equal(request.url, "/v1/chat/completions");
  request.resume();
  request.on("end", () => {
    modelRequests += 1;
    const chunk = (delta, finish_reason = null) => ({
      id: "chatcmpl-ui-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta, finish_reason }],
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of [chunk({ role: "assistant", content: modelReply }), chunk({}, "stop")]) {
      response.write(`data: ${JSON.stringify(item)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
});
model.listen(0, "127.0.0.1");
await once(model, "listening");

const reservation = createServer().listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const secret = randomBytes(32).toString("hex");
const bootstrapToken = createHmac("sha256", secret)
  .update(`t3-desktop-bootstrap:${Math.floor(Date.now() / (12 * 60 * 60 * 1000))}`)
  .digest("hex");
const server = spawn(
  join(resources, "node", "bin", "node"),
  [join(resources, "server", "dist", "bin.mjs"), "--bootstrap-fd", "0"],
  {
    env: {
      ...process.env,
      HOME: state,
      PATH: "/usr/bin:/bin",
      T3CODE_TELEMETRY_ENABLED: "false",
      SHELL: "/bin/sh",
      XTWORK_BUNDLED_NODE_BIN: join(resources, "node", "bin"),
      XTWORK_DATA_DIR: data,
      XTWORK_BRAND_CONFIG: join(resources, "brand.json"),
      XTWORK_PI_BINARY: join(resources, "runtime", "pi", "pi"),
      XTWORK_PLUGIN_HOST_BIN: join(resources, "plugin-host", "xtwork-plugin-host"),
      XTWORK_PLUGINS_DIR: join(resources, "plugins"),
      XTWORK_MODEL_UPSTREAM_URL: `http://127.0.0.1:${model.address().port}/v1`,
      XTWORK_MODEL_UPSTREAM_MODEL: "test-model",
      XTWORK_MODEL_UPSTREAM_KEY_FILE: "",
      XTWORK_PLUGINS_DISABLED: "",
    },
    cwd: join(data, "workspace"),
    stdio: ["pipe", "pipe", "pipe"],
  },
);
let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk;
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk;
});
server.stdin.end(
  JSON.stringify({
    mode: "desktop",
    noBrowser: true,
    port,
    t3Home: data,
    host: "127.0.0.1",
    desktopBootstrapToken: bootstrapToken,
    desktopBootstrapSecret: secret,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
);

let browser;
let page;
let succeeded = false;
try {
  let ready = false;
  for (let attempt = 0; attempt < 240 && server.exitCode === null; attempt += 1) {
    const response = await fetch(`${origin}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(500),
    }).catch(() => null);
    if (response?.ok) {
      ready = true;
      break;
    }
    await delay(200);
  }
  assert.ok(ready, `Server did not start. See ${serverLog}`);
  const auth = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrapToken,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: brand.displayName,
      client_device_type: "desktop",
    }),
  });
  assert.ok(auth.ok, `Desktop bootstrap returned HTTP ${auth.status}`);
  const { access_token: bearer } = await auth.json();
  assert.ok(bearer);

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20_000);
  const preload = await readFile(join(root, "shell", "preload.js"), "utf8");
  const init = {
    origin,
    wsOrigin: origin.replace(/^http/, "ws"),
    bootstrapToken,
    platform: "darwin",
    preferredLanguages: ["en"],
    branding: {
      baseName: brand.name,
      displayName: brand.displayName,
      stageLabel: brand.stageLabel,
    },
  };
  await page.addInitScript({
    content: `window.mygo = {
      on: () => () => {},
      call: async (method, ...args) => {
        switch (method) {
          case "Desktop.GetLocalEnvironmentBearerToken": return ${JSON.stringify(bearer)};
          case "Desktop.ReadClientState": return localStorage.getItem("test-desktop:" + args[0]);
          case "Desktop.WriteClientState": localStorage.setItem("test-desktop:" + args[0], args[1]); return;
          case "Desktop.PickFolder": return ${JSON.stringify(folder)};
          case "Desktop.GetWindowCornerRadius": return 8;
          case "Desktop.GetUpdateState": return null;
          default: return null;
        }
      },
    }; (${preload})(${JSON.stringify(init)});`,
  });

  const button = (name) => page.getByRole("button", { name, exact: true });
  const absent = async (...names) => {
    for (const name of names) assert.equal(await button(name).count(), 0, name);
  };
  const editor = page.locator(".composer-tiptap[contenteditable]");
  const modelPicker = page.locator(".group\\/model-trigger");
  const terminal = page.getByRole("button", { name: /toggle terminal/i });
  const developerToggle = page.getByRole("switch", { name: "Show developer features" });
  const settingsNav = (path) => page.locator(`[data-settings-section="/settings/${path}"]`);
  const go = async (path) => page.goto(`${origin}/#${path}`);
  const developerNav = ["source-control", "worktrees"];
  const unavailableNav = ["snap-shot", "connections", "access", "devices"];
  async function checkSettings(enabled) {
    await developerToggle.waitFor({ state: "visible" });
    await developerToggle.and(page.locator(`[aria-checked="${enabled}"]`)).waitFor();
    for (const path of developerNav) {
      await settingsNav(path).waitFor({ state: enabled ? "visible" : "hidden" });
    }
    for (const path of unavailableNav) assert.equal(await settingsNav(path).count(), 0, path);
    await settingsNav("providers").waitFor({ state: "visible" });
    await settingsNav("diffs").waitFor({ state: "visible" });
    await settingsNav("browser").waitFor({ state: "visible" });
    await settingsNav("remote-connections").waitFor({ state: "visible" });
    assert.equal(await page.locator("#remote-im").count(), 0);
    if (enabled) {
      await button("Open pull requests").waitFor({ state: "visible" });
      await button("Open issues").waitFor({ state: "visible" });
    } else {
      await absent("Open pull requests", "Open issues");
    }
    assert.doesNotMatch(await page.locator("body").innerText(), /T3 Code/);
  }
  async function checkCloneSources(enabled) {
    await button("Add project").click();
    await page.getByText("Local folder", { exact: true }).waitFor();
    await page.getByText("Git URL", { exact: true }).waitFor({
      state: enabled ? "visible" : "hidden",
    });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "hidden" });
  }
  async function checkPalette(enabled) {
    await page.keyboard.press("Meta+k");
    const input = page.locator('input[data-slot="autocomplete-input"]');
    await input.waitFor({ state: "visible" });
    for (const title of [
      "Open pull requests",
      "Open issues",
      "Toggle terminal",
      "Open in editor",
      "Choose a Git branch",
      "Choose local folder or worktree",
    ]) {
      await input.fill(title);
      const match = page.getByText(title, { exact: true });
      if (enabled) await match.waitFor({ state: "visible" });
      else assert.equal(await match.count(), 0, title);
    }
    await input.fill("Open usage");
    await page.getByText("Open usage", { exact: true }).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await input.waitFor({ state: "hidden" });
  }

  await go("/");
  await page.locator("[data-chat-composer-form]").waitFor({ state: "visible" });
  assert.match(new URL(page.url()).hash.slice(1), /draft/);
  const draftPath = new URL(page.url()).hash.slice(1);
  assert.equal(await modelPicker.count(), 0);
  assert.equal(await terminal.count(), 0);
  const initialChineseHome = await page.locator("body").innerText();
  const initialHeaderText = await page.locator("[data-chat-header]").innerText();
  assert.match(initialChineseHome, /领航员/);
  assert.match(initialChineseHome, /对话/);
  assert.match(initialChineseHome, /文件夹/);
  assert.doesNotMatch(initialHeaderText, /无文件夹|Unknown Subject/i);
  assert.doesNotMatch(initialChineseHome, /Unknown Subject|T3 Code|会话|线程|Try asking|Example tasks/i);
  await page.locator('[data-testid="leader-sidebar-slot"]').waitFor({ state: "visible" });
  await page.locator('[data-testid="sidebar-navigators-heading"]').waitFor({ state: "visible" });
  await page.locator('[data-testid="sidebar-threads-heading"]').waitFor({ state: "visible" });
  await page.locator('[data-testid="leader-slot-leader-default"]').waitFor({ state: "visible" });
  const navRect = await page.locator('[data-testid="sidebar-navigators-heading"]').boundingBox();
  const threadsRect = await page.locator('[data-testid="sidebar-threads-heading"]').boundingBox();
  assert.ok(navRect && threadsRect && navRect.y < threadsRect.y, "Navigators section must sit above Threads section");
  const centerY = (box) => box.y + box.height / 2;
  const sidebarBrandBox = await page.locator("[data-app-sidebar] a").first().boundingBox();
  const homeHeaderTitleBox = await page.locator("[data-chat-header] h2").first().boundingBox();
  const homeRightToggleBox = await page.locator("[data-workspace-titlebar-controls] button").last().boundingBox();
  assert.ok(sidebarBrandBox && homeHeaderTitleBox && homeRightToggleBox, "Expected topbar bounding boxes on home");
  assert.ok(
    Math.abs(centerY(sidebarBrandBox) - centerY(homeHeaderTitleBox)) <= 1.5,
    `Sidebar brand (${centerY(sidebarBrandBox)}) and chat header (${centerY(homeHeaderTitleBox)}) must align`,
  );
  assert.ok(
    Math.abs(centerY(sidebarBrandBox) - centerY(homeRightToggleBox)) <= 1.5,
    `Sidebar brand (${centerY(sidebarBrandBox)}) and right controls (${centerY(homeRightToggleBox)}) must align`,
  );
  await page.screenshot({ path: join(testOutput, "ordinary-home-zh.png") });
  await page.locator('[data-testid="leader-slot-leader-default"]').click();
  await page.locator('[data-navigator-header="true"]').waitFor({ state: "visible" });
  await page.locator('[data-testid="leader-supervisory-bar"]').waitFor({ state: "visible" });
  const headerBg = await page.locator("[data-chat-header]").evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(headerBg, "rgba(0, 0, 0, 0)", "Chat header should stay transparent to blend with canvas");
  const navIdBefore = await page.locator('[data-testid="leader-header-identity"]').boundingBox();
  const navManageBefore = await page.getByRole("button", { name: "管理", exact: true }).boundingBox();
  const navRightBefore = await page.locator("[data-workspace-titlebar-controls] button").last().boundingBox();
  assert.ok(navIdBefore && navManageBefore && navRightBefore, "Expected Navigator topbar bounding boxes");
  assert.ok(
    Math.abs(centerY(sidebarBrandBox) - 26) <= 3 &&
      Math.abs(centerY(sidebarBrandBox) - centerY(navIdBefore)) <= 1.5 &&
      Math.abs(centerY(navIdBefore) - centerY(navManageBefore)) <= 1.5 &&
      Math.abs(centerY(navManageBefore) - centerY(navRightBefore)) <= 1.5,
    `Navigator topbar must align horizontally near y=26: brand=${centerY(sidebarBrandBox)}, id=${centerY(navIdBefore)}, manage=${centerY(navManageBefore)}, right=${centerY(navRightBefore)}`,
  );
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.locator('[data-testid="leader-config-panel"]').waitFor({ state: "visible" });
  await page.locator('[data-testid="leader-im-policy-section"]').waitFor({ state: "visible" });
  const navIdAfter = await page.locator('[data-testid="leader-header-identity"]').boundingBox();
  const navManageAfter = await page.getByRole("button", { name: "管理", exact: true }).boundingBox();
  assert.ok(
    navIdAfter &&
      navManageAfter &&
      Math.abs(centerY(navIdAfter) - centerY(navIdBefore)) <= 0.5 &&
      Math.abs(centerY(navManageAfter) - centerY(navManageBefore)) <= 0.5,
    "Opening Navigator config drawer must not shift the topbar vertically",
  );
  const drawerGeometry = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="leader-config-panel"]');
    const grid = document.querySelector('[data-testid="leader-avatar-shape-grid"]');
    const composer =
      document.querySelector('[data-chat-composer-stack="true"]') ??
      document.querySelector('[data-chat-composer-overlay="true"]');
    if (!panel || !grid) return null;
    const panelRect = panel.getBoundingClientRect();
    const buttons = Array.from(grid.querySelectorAll("button"));
    const svgBoxes = buttons.map((btn) => {
      const svg = btn.querySelector("svg");
      const r = svg?.getBoundingClientRect();
      return r ? { w: r.width, h: r.height } : null;
    });
    let maxOverlap = 0;
    for (let i = 0; i < buttons.length; i += 1) {
      for (let j = i + 1; j < buttons.length; j += 1) {
        const a = buttons[i].getBoundingClientRect();
        const b = buttons[j].getBoundingClientRect();
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 0 && overlapY > 0) {
          maxOverlap = Math.max(maxOverlap, Math.min(overlapX, overlapY));
        }
      }
    }
    const selects = Array.from(panel.querySelectorAll("select"));
    const maxSelectOverflow = selects.reduce(
      (max, el) => Math.max(max, el.getBoundingClientRect().right - panelRect.right),
      0,
    );
    const composerOverlap = composer ? panelRect.bottom - composer.getBoundingClientRect().top : 0;
    return {
      buttonCount: buttons.length,
      svgBoxes,
      maxOverlap,
      horizontalOverflow: panel.scrollWidth - panel.clientWidth,
      maxSelectOverflow,
      composerOverlap,
    };
  });
  assert.ok(drawerGeometry && drawerGeometry.buttonCount === 23, "Expected 23 bot shape buttons in Manage drawer");
  assert.ok(
    drawerGeometry.svgBoxes.every((box) => box && box.w > 0 && box.w <= 26 && box.h > 0 && box.h <= 26),
    `Every static avatar SVG must stay within 26x26: ${JSON.stringify(drawerGeometry.svgBoxes)}`,
  );
  assert.ok(drawerGeometry.maxOverlap <= 0.5, `Shape buttons must not overlap (got ${drawerGeometry.maxOverlap}px)`);
  assert.ok(
    drawerGeometry.horizontalOverflow <= 1,
    `Manage drawer must not overflow horizontally (got ${drawerGeometry.horizontalOverflow}px)`,
  );
  assert.ok(
    drawerGeometry.maxSelectOverflow <= 1,
    `IM policy selects must stay inside Manage drawer (got ${drawerGeometry.maxSelectOverflow}px)`,
  );
  assert.ok(
    drawerGeometry.composerOverlap <= 0.5,
    `Manage drawer must not overlap chat composer (got ${drawerGeometry.composerOverlap}px)`,
  );
  const leaderViewText = await page.locator("body").innerText();
  assert.doesNotMatch(leaderViewText, /无文件夹|Unknown Subject|T3 Code|会话|线程/);
  await page.screenshot({ path: join(testOutput, "leader-desktop-zh.png") });
  await go(draftPath);
  await page.locator("[data-chat-composer-form]").waitFor({ state: "visible" });
  console.log("Passed first-run default Chinese UI, Navigator/Threads split sidebar, immersive header, and Slice 2 config drawer.");

  await go("/settings/general");
  await page.getByRole("switch", { name: "显示开发者功能" }).waitFor({ state: "visible" });
  await settingsNav("browser").waitFor({ state: "visible" });
  const zhLanguagePicker = page.getByRole("combobox", { name: "语言", exact: true });
  await zhLanguagePicker.waitFor({ state: "visible" });
  assert.match(await zhLanguagePicker.innerText(), /中文（简体）/);
  await zhLanguagePicker.click();
  await page.getByRole("option", { name: "English", exact: true }).waitFor({ state: "visible" });
  const languageOptions = await page.getByRole("option").allInnerTexts();
  assert.deepEqual(
    languageOptions.map((item) => item.trim()),
    ["中文（简体）", "English"],
  );
  await page.getByRole("option", { name: "English", exact: true }).click();
  await developerToggle.waitFor({ state: "visible" });
  await page.reload();
  await developerToggle.waitFor({ state: "visible" });
  console.log("Passed two-language selector (zh/en) and persisted switch to English.");

  await go(draftPath);
  await page.locator("[data-chat-composer-form]").waitFor({ state: "visible" });
  assert.equal(await modelPicker.count(), 0);
  assert.equal(await terminal.count(), 0);
  await page.locator('[data-testid="sidebar-navigators-heading"]').waitFor({ state: "visible" });
  assert.equal((await page.locator('[data-testid="sidebar-navigators-heading"]').innerText()).trim(), "Navigators");
  assert.equal((await page.locator('[data-testid="sidebar-threads-heading"]').innerText()).trim(), "Threads");
  assert.doesNotMatch(await page.locator("body").innerText(), /T3 Code|Try asking|Example tasks/i);
  await absent("Pull requests", "Issues");
  await checkPalette(false);
  await checkCloneSources(false);
  await page.keyboard.press("Meta+j");
  assert.equal(await page.locator('[data-terminal-open="true"]').count(), 0);
  await page.screenshot({ path: join(testOutput, "ordinary-home.png") });
  console.log("Passed clean first-run draft and ordinary command visibility.");

  await button("Toggle right panel").click();
  await page.getByRole("button", { name: /^Browser/ }).click();
  const browserUrlInput = page.locator("[data-preview-url-input]");
  await browserUrlInput.waitFor({ state: "visible" });
  await page.waitForFunction(
    () => {
      const input = document.querySelector("[data-preview-url-input]");
      return input instanceof HTMLInputElement && !input.disabled;
    },
    undefined,
    { timeout: 60_000 },
  );
  await browserUrlInput.click();
  await browserUrlInput.fill(previewFixtureUrl);
  await browserUrlInput.press("Enter");
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector("[data-server-browser-surface] canvas");
      if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0 || canvas.height === 0) {
        return false;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      const [r, g, b, a] = ctx.getImageData(
        Math.floor(canvas.width * 0.75),
        Math.floor(canvas.height * 0.75),
        1,
        1,
      ).data;
      // Fixture body background is #0f172a (15, 23, 42); allow JPEG compression tolerance.
      return a === 255 && r < 40 && g < 50 && b > 25 && b < 70;
    },
    undefined,
    { timeout: 60_000 },
  );
  await page.getByText("小瞳浏览器验证页", { exact: true }).waitFor({ timeout: 30_000 });
  await browserUrlInput.click();
  await page.keyboard.press("Meta+f");
  await delay(300);
  assert.equal(await page.getByText("Find on page isn't available for this page").count(), 0);
  await page.screenshot({ path: join(testOutput, "ordinary-browser.png") });
  await button("Toggle right panel").click();
  console.log("Passed ordinary-mode integrated ServerBrowser open and live page render on draft.");

  await go("/settings/browser");
  await page.getByRole("switch", { name: "Agent browser access" }).waitFor({ state: "visible" });
  await button("Add profile").click();
  await page.getByRole("menuitem", { name: "Blank profile", exact: true }).waitFor({
    state: "visible",
  });
  assert.equal(await page.getByText("Looking for browsers…").count(), 0);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("switch", { name: "Show key presses in recordings" }).count(), 0);
  await page.screenshot({ path: join(testOutput, "browser-settings.png") });
  console.log("Passed ordinary-mode Browser settings panel.");

  await go("/settings/general");
  await checkSettings(false);
  // M10: Verify Providers is visible in ordinary mode with the curated 1+6 set (and non-core drivers hidden).
  await settingsNav("providers").click();
  await page.getByText("Kimi Code", { exact: true }).first().waitFor({ state: "visible" });
  for (const curatedLabel of ["Codex", "Kimi Code", "Qoder", "Codebuddy Code", "DeepSeek Harness"]) {
    await page.getByText(curatedLabel, { exact: true }).first().waitFor({ state: "visible" });
  }
  const ordinaryProvidersText = await page.locator("body").innerText();
  assert.match(ordinaryProvidersText, /Built-in Assistant|内置助手|小瞳/);
  assert.match(ordinaryProvidersText, /Claude/);
  for (const devOnlyDriver of ["Cursor", "OpenCode", "Grok", "Antigravity", "Kiro", "Muse"]) {
    assert.equal(
      await page.getByRole("button", { name: new RegExp(`^${devOnlyDriver}\\b`) }).count(),
      0,
      `Developer-only driver '${devOnlyDriver}' should stay hidden in ordinary mode`,
    );
  }
  await button("Select Kimi Code").click();
  await page.getByText("Installation", { exact: true }).first().waitFor({ state: "visible" });
  await page.getByRole("button", { name: "One-Click Install", exact: true }).waitFor({
    state: "visible",
  });
  await page.screenshot({ path: join(testOutput, "ordinary-providers.png") });
  console.log("Passed ordinary-mode curated 1+6 Providers visibility and one-click install card.");
  await go("/settings/general");
  await developerToggle.click();
  await checkSettings(true);
  await page.screenshot({ path: join(testOutput, "developer-settings.png") });
  await page.reload();
  await checkSettings(true);
  await settingsNav("providers").click();
  await button("Add provider").first().click();
  const providerDialog = page.getByRole("dialog", { name: "Add provider" });
  await providerDialog.getByText("Codex", { exact: true }).first().waitFor();
  await providerDialog.getByText("Claude", { exact: true }).first().waitFor();
  await page.keyboard.press("Escape");
  await go("/settings/general");
  await button("Open pull requests").click();
  await page.waitForURL(/\/pull-requests/);
  await go("/settings/general");
  await button("Open issues").click();
  await page.waitForURL(/\/issues/);
  console.log("Passed persisted developer switch and PR/Issues navigation.");
  await go(draftPath);
  await page.locator("[data-chat-composer-form]").waitFor({ state: "visible" });
  await modelPicker.waitFor({ state: "visible" });
  await terminal.waitFor({ state: "visible" });
  await absent("Pull requests", "Issues");
  await checkPalette(true);
  await page.keyboard.press("Meta+k");
  await page.locator('input[data-slot="autocomplete-input"]').fill("Open pull requests");
  await page.getByText("Open pull requests", { exact: true }).click();
  await page.waitForURL(/\/pull-requests/);
  await go(draftPath);
  await checkCloneSources(true);

  await go("/settings/general");
  await developerToggle.click();
  await checkSettings(false);
  await go(draftPath);
  await page.locator("[data-chat-composer-form]").waitFor({ state: "visible" });
  await modelPicker.waitFor({ state: "hidden" });
  await terminal.waitFor({ state: "hidden" });
  await checkPalette(false);
  await button("Add project").click();
  await page.getByText("Local folder", { exact: true }).click();
  await page.getByText("Open in Finder", { exact: true }).click();
  await page.getByText("Test folder", { exact: true }).first().waitFor();
  await page.getByText("Changes", { exact: true }).first().waitFor();
  await editor.fill("Reply with the test confirmation.");
  await editor.press("Enter");
  await page.getByText(modelReply, { exact: true }).waitFor({ timeout: 45_000 });
  assert.ok(modelRequests > 0);
  await page.keyboard.press("Meta+d");
  await page.getByRole("button", { name: /^Diff scope:/ }).waitFor();
  await page.getByText("evidence.txt", { exact: true }).first().waitFor();
  await button("Add panel surface").click();
  await page.getByRole("menuitem", { name: /^Diff/ }).waitFor();
  await page.getByRole("menuitem", { name: /^Browser/ }).waitFor();
  for (const name of ["Terminal", "Pull request", "Linked items", "Device"]) {
    assert.equal(
      await page.getByRole("menuitem", { name: new RegExp(`^${name}`, "i") }).count(),
      0,
      name,
    );
  }
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(testOutput, "ordinary-diff.png") });
  await page.keyboard.press("Meta+Shift+j");
  await page.locator("[data-preview-url-input]").waitFor({ state: "visible" });
  console.log("Passed local folder selection, the bundled Pi turn, ordinary Diff/Browser panel menu, and Cmd+Shift+J shortcut.");

  await button("待办").click();
  await page.getByTitle("待办事项").waitFor({ state: "visible" });
  const todoPanel = page.frameLocator('iframe[title="待办事项"]');
  await todoPanel.getByRole("textbox", { name: "待办内容" }).fill("Desktop UI regression check");
  await todoPanel.getByRole("textbox", { name: "待办内容" }).press("Enter");
  await todoPanel
    .getByText("Desktop UI regression check", { exact: true })
    .waitFor({ state: "visible" });
  await page.screenshot({ path: join(testOutput, "todo-panel.png") });
  await button("Close").click();
  await page.getByTitle("待办事项").waitFor({ state: "hidden" });

  const conversationPath = new URL(page.url()).hash.slice(1);
  await go("/settings/scheduled-tasks");
  await button("New task").click();
  const taskDialog = page.getByRole("dialog", { name: "New task" });
  await taskDialog.getByRole("button", { name: "Create task", exact: true }).waitFor();
  assert.equal(await taskDialog.getByText("Workspace", { exact: true }).count(), 0);
  assert.equal(await taskDialog.getByText("Model", { exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await go(conversationPath);

  await go("/settings/general");
  await page.getByRole("combobox", { name: "Language", exact: true }).click();
  await page.getByRole("option", { name: /中文/ }).click();
  await page.getByRole("switch", { name: "显示开发者功能" }).waitFor();
  await page.screenshot({ path: join(testOutput, "general-settings-zh.png") });
  await settingsNav("remote-connections").click();
  await page.locator('[data-testid="holo-card-feishu"]').waitFor({ state: "visible" });
  await page.locator('[data-testid="holo-card-wecom"]').waitFor({ state: "visible" });
  await page.locator('[data-testid="holo-card-wechat"]').waitFor({ state: "visible" });
  await go("/");
  await page.waitForURL(/#\/draft\//);
  await page.locator("[data-chat-composer-form]").waitFor();
  await page.getByRole("dialog", { name: "设置", exact: true }).waitFor({ state: "hidden" });
  const chineseHome = await page.locator("body").innerText();
  const chineseHeaderText = await page.locator("[data-chat-header]").innerText();
  assert.match(chineseHome, /领航员/);
  assert.match(chineseHome, /对话/);
  assert.match(chineseHome, /文件夹/);
  assert.doesNotMatch(chineseHeaderText, /无文件夹|Unknown Subject/i);
  assert.doesNotMatch(chineseHome, /Unknown Subject|T3 Code|会话|线程/);
  console.log("Passed switching back to Chinese conversation, folder, and developer-switch labels.");

  console.log(
    "Verified default Chinese startup, zh/en language switcher, ordinary-mode ServerBrowser, Browser settings, developer switch persistence and routes, command palette, model picker, terminal and clone visibility, a Pi turn, Diff, branding, and the live todo plugin.",
  );
  succeeded = true;
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(testOutput, "failure.png") }).catch(() => {});
    console.error(
      "Page",
      page.url(),
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 3000),
    );
  }
  throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timeout);
  }
  previewFixtureServer.closeAllConnections();
  await new Promise((resolve) => previewFixtureServer.close(resolve));
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  if (succeeded) await rm(state, { recursive: true, force: true });
  else {
    await writeFile(serverLog, serverOutput);
    console.error(`Desktop test server log: ${serverLog}`);
  }
}
