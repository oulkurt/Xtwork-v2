// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  CODEBUDDY_CODE_INSTANCE_ID,
  DEEPSEEK_HARNESS_INSTANCE_ID,
  KIMI_CODE_INSTANCE_ID,
  QODER_INSTANCE_ID,
  codingAgentSeedMarkerPath,
  seedCodingAgents,
  seedCodingAgentsWithMarker,
  shouldSeedCodingAgents,
} from "./codingAgentSeed.ts";

const tempDirs: Array<string> = [];

function makeTempDir(): string {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "xtwork-coding-agent-seed-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("codingAgentSeed", () => {
  it("seeds all 4 stable ACP coding agent instances on first run", () => {
    const { settings, addedIds } = seedCodingAgents(DEFAULT_SERVER_SETTINGS);

    expect(addedIds).toEqual([
      KIMI_CODE_INSTANCE_ID,
      QODER_INSTANCE_ID,
      CODEBUDDY_CODE_INSTANCE_ID,
      DEEPSEEK_HARNESS_INSTANCE_ID,
    ]);
    expect(settings.providerInstances[KIMI_CODE_INSTANCE_ID]).toEqual({
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: "Kimi Code",
      enabled: true,
      config: { source: "registry", agentId: "kimi-code", enabled: true },
    });
    expect(settings.providerInstances[QODER_INSTANCE_ID]).toEqual({
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: "Qoder",
      enabled: true,
      config: { source: "registry", agentId: "qoder", enabled: true },
    });
    expect(settings.providerInstances[CODEBUDDY_CODE_INSTANCE_ID]).toEqual({
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: "Codebuddy Code",
      enabled: true,
      config: { source: "registry", agentId: "codebuddy-code", enabled: true },
    });
    expect(settings.providerInstances[DEEPSEEK_HARNESS_INSTANCE_ID]).toEqual({
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: "DeepSeek Harness",
      enabled: true,
      config: {
        source: "local",
        commandPath: "dsh",
        commandArgs: ["--profile", "acp"],
        enabled: true,
      },
    });
  });

  it("is idempotent and returns the same settings reference when already seeded", () => {
    const first = seedCodingAgents(DEFAULT_SERVER_SETTINGS);
    const second = seedCodingAgents(first.settings);

    expect(second.addedIds).toEqual([]);
    expect(second.settings).toBe(first.settings);
  });

  it("preserves user edits, disablement, and custom paths on upgrade", () => {
    const existing = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [KIMI_CODE_INSTANCE_ID]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          displayName: "My Custom Kimi",
          enabled: false,
          config: { source: "registry", agentId: "kimi-code", enabled: false },
        },
        [DEEPSEEK_HARNESS_INSTANCE_ID]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          displayName: "DeepSeek Custom",
          enabled: true,
          config: {
            source: "local",
            commandPath: "/opt/custom/bin/dsh",
            commandArgs: ["--profile", "acp", "--verbose"],
            enabled: true,
          },
        },
        [ProviderInstanceId.make("xtworkPi")]: {
          driver: ProviderDriverKind.make("pi"),
          displayName: "小瞳",
          enabled: true,
        },
      },
    };

    const { settings, addedIds } = seedCodingAgents(existing);

    expect(addedIds).toEqual([QODER_INSTANCE_ID, CODEBUDDY_CODE_INSTANCE_ID]);
    expect(settings.providerInstances[KIMI_CODE_INSTANCE_ID]).toEqual(
      existing.providerInstances[KIMI_CODE_INSTANCE_ID],
    );
    expect(settings.providerInstances[DEEPSEEK_HARNESS_INSTANCE_ID]).toEqual(
      existing.providerInstances[DEEPSEEK_HARNESS_INSTANCE_ID],
    );
    expect(settings.providerInstances[ProviderInstanceId.make("xtworkPi")]).toEqual(
      existing.providerInstances[ProviderInstanceId.make("xtworkPi")],
    );
    expect(settings.providerInstances[QODER_INSTANCE_ID]?.displayName).toBe("Qoder");
    expect(settings.providerInstances[CODEBUDDY_CODE_INSTANCE_ID]?.displayName).toBe(
      "Codebuddy Code",
    );
  });

  it("does not re-seed an agent the user explicitly deleted after initial seeding", () => {
    const baseDir = makeTempDir();
    const seeded = seedCodingAgentsWithMarker(DEFAULT_SERVER_SETTINGS, baseDir);
    expect(NodeFs.existsSync(codingAgentSeedMarkerPath(baseDir))).toBe(true);

    const { [QODER_INSTANCE_ID]: _deleted, ...remainingProviders } = seeded.providerInstances;
    const afterDelete = {
      ...seeded,
      providerInstances: remainingProviders,
    };

    const afterRestart = seedCodingAgentsWithMarker(afterDelete, baseDir);
    expect(afterRestart).toBe(afterDelete);
    expect(afterRestart.providerInstances[QODER_INSTANCE_ID]).toBeUndefined();
    expect(afterRestart.providerInstances[KIMI_CODE_INSTANCE_ID]).toBeDefined();
    expect(afterRestart.providerInstances[CODEBUDDY_CODE_INSTANCE_ID]).toBeDefined();
    expect(afterRestart.providerInstances[DEEPSEEK_HARNESS_INSTANCE_ID]).toBeDefined();
  });

  it("activates only in Xtwork environments unless explicitly toggled", () => {
    expect(shouldSeedCodingAgents({})).toBe(false);
    expect(shouldSeedCodingAgents({ XTWORK_DATA_DIR: "/tmp/xt" })).toBe(true);
    expect(shouldSeedCodingAgents({ XTWORK_PI_BINARY: "/tmp/pi" })).toBe(true);
    expect(shouldSeedCodingAgents({ XTWORK_BRAND_CONFIG: "/tmp/brand.json" })).toBe(true);
    expect(shouldSeedCodingAgents({ XTWORK_SEED_CODING_AGENTS: "1" })).toBe(true);
    expect(
      shouldSeedCodingAgents({ XTWORK_DATA_DIR: "/tmp/xt", XTWORK_SEED_CODING_AGENTS: "0" }),
    ).toBe(false);
  });
});
