// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  InstallConsentStore,
  installConsentsFilePath,
  type InstallConsentKey,
} from "./installConsent.ts";

const tempDirs: Array<string> = [];

function makeTempDir(): string {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "xtwork-install-consent-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("InstallConsentStore", () => {
  it("persists 5-tuple consent with 0600 permissions and enforces exact tuple matching", () => {
    const dataDir = makeTempDir();
    const store = new InstallConsentStore(dataDir);
    const key: InstallConsentKey = {
      instanceId: "xtworkKimiCode",
      source: "acp-registry",
      version: "1.2.3",
      distribution: "npx",
      installDir: NodePath.join(dataDir, "tools", "kimi-code", "1.2.3", "npm"),
    };

    expect(store.hasConsent(key)).toBe(false);

    const granted = store.grantConsent(key, {
      commandPreview: "npm install --global @kimi/acp@1.2.3",
      officialSource: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
    });
    expect(granted.key).toEqual(key);
    expect(store.hasConsent(key)).toBe(true);

    const filePath = installConsentsFilePath(dataDir);
    expect(NodeFs.existsSync(filePath)).toBe(true);
    if (process.platform !== "win32") {
      const mode = NodeFs.statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // Any change to any element of the 5-tuple MUST NOT match.
    expect(store.hasConsent({ ...key, instanceId: "xtworkQoder" })).toBe(false);
    expect(store.hasConsent({ ...key, source: "npm-managed" })).toBe(false);
    expect(store.hasConsent({ ...key, version: "1.2.4" })).toBe(false);
    expect(store.hasConsent({ ...key, distribution: "binary" })).toBe(false);
    expect(
      store.hasConsent({
        ...key,
        installDir: NodePath.join(dataDir, "tools", "kimi-code", "1.2.4", "npm"),
      }),
    ).toBe(false);

    // Survives reload across a fresh store instance.
    const reloaded = new InstallConsentStore(dataDir);
    expect(reloaded.hasConsent(key)).toBe(true);
    expect(reloaded.listConsents()).toHaveLength(1);
  });

  it("fails closed when the consent file is corrupted", () => {
    const dataDir = makeTempDir();
    const filePath = installConsentsFilePath(dataDir);
    NodeFs.mkdirSync(NodePath.dirname(filePath), { recursive: true });
    NodeFs.writeFileSync(filePath, "{not valid json", "utf8");

    const store = new InstallConsentStore(dataDir);
    expect(
      store.hasConsent({
        instanceId: "xtworkKimiCode",
        source: "acp-registry",
        version: "1.0.0",
        distribution: "npx",
        installDir: NodePath.join(dataDir, "tools", "kimi-code"),
      }),
    ).toBe(false);
    expect(store.listConsents()).toEqual([]);
  });

  it("revokes individual keys and all consents for an instance", () => {
    const dataDir = makeTempDir();
    const store = new InstallConsentStore(dataDir);
    const keyA: InstallConsentKey = {
      instanceId: "xtworkKimiCode",
      source: "acp-registry",
      version: "1.0.0",
      distribution: "npx",
      installDir: NodePath.join(dataDir, "tools", "kimi-code", "1.0.0", "npm"),
    };
    const keyB: InstallConsentKey = {
      instanceId: "xtworkKimiCode",
      source: "acp-registry",
      version: "1.1.0",
      distribution: "npx",
      installDir: NodePath.join(dataDir, "tools", "kimi-code", "1.1.0", "npm"),
    };
    const keyOther: InstallConsentKey = {
      instanceId: "xtworkQoder",
      source: "acp-registry",
      version: "2.0.0",
      distribution: "binary",
      installDir: NodePath.join(dataDir, "tools", "qoder", "2.0.0", "darwin-aarch64"),
    };

    store.grantConsent(keyA);
    store.grantConsent(keyB);
    store.grantConsent(keyOther);

    expect(store.revokeConsent(keyA)).toBe(true);
    expect(store.hasConsent(keyA)).toBe(false);
    expect(store.hasConsent(keyB)).toBe(true);

    expect(store.revokeConsentForInstance("xtworkKimiCode")).toBe(1);
    expect(store.hasConsent(keyB)).toBe(false);
    expect(store.hasConsent(keyOther)).toBe(true);
  });

  it("rejects empty key fields", () => {
    const dataDir = makeTempDir();
    const store = new InstallConsentStore(dataDir);
    expect(() =>
      store.grantConsent({
        instanceId: "",
        source: "acp-registry",
        version: "1.0.0",
        distribution: "npx",
        installDir: "/tmp/a",
      }),
    ).toThrow();
  });
});
