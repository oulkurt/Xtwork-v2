import { describe, expect, it } from "vite-plus/test";
import {
  DONE_TURN_S,
  OPEN_BOT_AVATAR_CATALOG,
  OPEN_BOT_AVATAR_PALETTE,
  getOpenBotAvatarEntry,
} from "./openBotAvatar";
import {
  CELEBRATION_DURATION_MS,
  DOWNGRADE_DWELL_MS,
  INITIAL_NAVIGATOR_AVATAR_CONTROLLER_STATE,
  NavigatorAvatarShuffleBag,
  computeContrastEyeColor,
  computeContrastRatio,
  createNavigatorAvatarControllerState,
  encodeNavigatorAvatar,
  extractPinnedThreadSignal,
  isConnectionBound,
  isConnectionStrictlyOnline,
  parseNavigatorAvatar,
  pickRandomNavigatorAvatar,
  resolveAvatarPresentation,
  resolveNavigatorBoundChannels,
  rollupNavigatorWorkState,
  stepNavigatorAvatarController,
  type NavigatorWorkSignals,
} from "./navigatorAvatarModel";

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function idleSignals(overrides?: Partial<NavigatorWorkSignals>): NavigatorWorkSignals {
  return {
    leaderStatus: "active",
    pinnedThread: null,
    runningCount: 0,
    startingCount: 0,
    waitingCount: 0,
    failedCount: 0,
    pendingApprovalCount: 0,
    pausedPendingCount: 0,
    needsYouCount: 0,
    latestCompletedKey: null,
    ...overrides,
  };
}

describe("computeContrastEyeColor", () => {
  it("picks light eyes for dark bodies and dark eyes for light bodies", () => {
    expect(computeContrastEyeColor("#000000")).toBe("#f8fafc");
    expect(computeContrastEyeColor("#151515")).toBe("#f8fafc");
    expect(computeContrastEyeColor("#1e293b")).toBe("#f8fafc");
    expect(computeContrastEyeColor("#2563eb")).toBe("#f8fafc");
    expect(computeContrastEyeColor("#ffffff")).toBe("#151515");
    expect(computeContrastEyeColor("#f8fafc")).toBe("#151515");
    expect(computeContrastEyeColor("#f59e0b")).toBe("#151515");
    expect(computeContrastEyeColor("#22c55e")).toBe("#151515");
  });

  it("supports 3-digit shorthand, uppercase, whitespace, and exact WCAG luminance threshold", () => {
    expect(computeContrastEyeColor("#000")).toBe("#f8fafc");
    expect(computeContrastEyeColor("#00f")).toBe("#f8fafc");
    expect(computeContrastEyeColor("#fff")).toBe("#151515");
    expect(computeContrastEyeColor("#ff0")).toBe("#151515");
    expect(computeContrastEyeColor("  #0F172A  ")).toBe("#f8fafc");
    expect(computeContrastEyeColor("#747474")).toBe("#f8fafc");
    expect(computeContrastEyeColor("#767676")).toBe("#151515");
  });

  it("falls back safely on invalid hex strings", () => {
    expect(computeContrastEyeColor("not-a-color")).toBe("#151515");
    expect(computeContrastEyeColor("#12345")).toBe("#151515");
  });
});

describe("encodeNavigatorAvatar & parseNavigatorAvatar", () => {
  it("encodes canonical specs and only appends eyeColor when custom", () => {
    expect(encodeNavigatorAvatar("cat", "#FF8A3D")).toBe("bot:v1:cat:#ff8a3d");
    expect(encodeNavigatorAvatar("cat", "#000", "#F8FAFC")).toBe("bot:v1:cat:#000000");
    expect(encodeNavigatorAvatar("cat", "#fff", "#151515")).toBe("bot:v1:cat:#ffffff");
    expect(encodeNavigatorAvatar("rocket", "#0F172A", "#FBBF24")).toBe(
      "bot:v1:rocket:#0f172a:#fbbf24",
    );
    expect(encodeNavigatorAvatar("ghost", "#abc", "#f0f")).toBe("bot:v1:ghost:#aabbcc");
    expect(encodeNavigatorAvatar("ghost", "#0f172a", "#38bdf8")).toBe("bot:v1:ghost:#0f172a:#38bdf8");
    expect(encodeNavigatorAvatar("cat", "#222222", "#222222")).toBe("bot:v1:cat:#222222");
    expect(computeContrastRatio("#222222", "#f8fafc")).toBeGreaterThan(3);
    expect(computeContrastRatio("#222222", "#222222")).toBe(1);
  });

  it("parses valid bot:v1 specs with auto and contrast-checked explicit custom eye colors", () => {
    const autoParsed = parseNavigatorAvatar("bot:v1:rocket:#1E293B");
    expect(autoParsed.kind).toBe("bot");
    expect(autoParsed.shapeId).toBe("rocket");
    expect(autoParsed.color).toBe("#1e293b");
    expect(autoParsed.eyeColor).toBe("#f8fafc");
    expect(autoParsed.entry).toBe(getOpenBotAvatarEntry("rocket"));
    expect(autoParsed.encoded).toBe("bot:v1:rocket:#1e293b");

    const customParsed = parseNavigatorAvatar("bot:v1:star:#1e293b:#fbbf24");
    expect(customParsed.shapeId).toBe("star");
    expect(customParsed.color).toBe("#1e293b");
    expect(customParsed.eyeColor).toBe("#fbbf24");
    expect(customParsed.encoded).toBe("bot:v1:star:#1e293b:#fbbf24");

    const lowContrastDark = parseNavigatorAvatar("bot:v1:cat:#222222:#222222");
    expect(lowContrastDark.eyeColor).toBe("#f8fafc");
    expect(lowContrastDark.encoded).toBe("bot:v1:cat:#222222");

    const lowContrastLight = parseNavigatorAvatar("bot:v1:cat:#ffffff:#f1f5f9");
    expect(lowContrastLight.eyeColor).toBe("#151515");
    expect(lowContrastLight.encoded).toBe("bot:v1:cat:#ffffff");

    const roundTrip = parseNavigatorAvatar(customParsed.encoded);
    expect(roundTrip).toEqual(customParsed);
  });

  it("maps leader-default and empty inputs to the default cat avatar", () => {
    const expectedCat = getOpenBotAvatarEntry("cat") ?? OPEN_BOT_AVATAR_CATALOG[0];
    if (!expectedCat) {
      throw new Error("Expected OPEN_BOT_AVATAR_CATALOG to be non-empty");
    }
    const fromDefaultLeader = parseNavigatorAvatar("瞳", "leader-default");
    expect(fromDefaultLeader.shapeId).toBe(expectedCat.definition.id);
    expect(fromDefaultLeader.entry).toBe(expectedCat);
    expect(fromDefaultLeader.color).toBe(expectedCat.defaultColor.toLowerCase());
    expect(fromDefaultLeader.eyeColor).toBe(computeContrastEyeColor(expectedCat.defaultColor));

    const fromEmpty = parseNavigatorAvatar("", undefined);
    expect(fromEmpty.shapeId).toBe(expectedCat.definition.id);

    const fromNull = parseNavigatorAvatar(null, "");
    expect(fromNull.shapeId).toBe(expectedCat.definition.id);
  });

  it("deterministically maps legacy avatars and malformed specs via FNV-1a fallback", () => {
    const a1 = parseNavigatorAvatar("研", "leader-eng");
    const a2 = parseNavigatorAvatar("", "leader-eng");
    const a3 = parseNavigatorAvatar("bot:v1:unknown-shape:#123456", "leader-eng");
    const a4 = parseNavigatorAvatar("bot:v1:cat:invalidhex", "leader-eng");
    expect(a1).toEqual(a2);
    expect(a1).toEqual(a3);
    expect(a1).toEqual(a4);
    expect(OPEN_BOT_AVATAR_CATALOG).toContain(a1.entry);

    const legacyOnly1 = parseNavigatorAvatar("阿");
    const legacyOnly2 = parseNavigatorAvatar("阿");
    expect(legacyOnly1).toEqual(legacyOnly2);
    expect(OPEN_BOT_AVATAR_CATALOG).toContain(legacyOnly1.entry);
  });
});

describe("NavigatorAvatarShuffleBag & pickRandomNavigatorAvatar", () => {
  it("draws every catalog shape once per cycle and avoids repeats across refill boundaries", () => {
    const bag = new NavigatorAvatarShuffleBag();
    const total = OPEN_BOT_AVATAR_CATALOG.length;
    const rng = createSeededRandom(42);

    const cycle1: string[] = [];
    for (let i = 0; i < total; i += 1) {
      cycle1.push(bag.next({ random: rng }));
    }
    expect(new Set(cycle1).size).toBe(total);
    expect(bag.remaining).toBe(0);

    const cycle2: string[] = [];
    for (let i = 0; i < total; i += 1) {
      cycle2.push(bag.next({ random: rng }));
    }
    expect(new Set(cycle2).size).toBe(total);
    expect(cycle2[0]).not.toBe(cycle1[total - 1]);
  });

  it("avoids repeating across refill boundary even with a constant RNG", () => {
    const bag = new NavigatorAvatarShuffleBag();
    const total = OPEN_BOT_AVATAR_CATALOG.length;
    const zeroRng = () => 0;

    let previous = "";
    for (let i = 0; i < total * 3; i += 1) {
      const next = bag.next({ random: zeroRng });
      if (i > 0) {
        expect(next).not.toBe(previous);
      }
      previous = next;
    }
  });

  it("prioritizes shapes not in usedShapeIds and falls back gracefully when all are used", () => {
    const allIds = OPEN_BOT_AVATAR_CATALOG.map((entry) => entry.definition.id);
    const unused = allIds.slice(0, 3);
    const used = allIds.slice(3);
    const bag = new NavigatorAvatarShuffleBag();
    const rng = createSeededRandom(99);

    const firstThree = [
      bag.next({ usedShapeIds: used, random: rng }),
      bag.next({ usedShapeIds: used, random: rng }),
      bag.next({ usedShapeIds: used, random: rng }),
    ];
    expect(new Set(firstThree)).toEqual(new Set(unused));

    const singleUnused = allIds[0];
    const secondShape = allIds[1];
    if (!singleUnused || !secondShape) {
      throw new Error("Expected at least two catalog shapes");
    }
    const allButOne = allIds.slice(1);
    expect(bag.next({ currentShapeId: secondShape, usedShapeIds: allButOne, random: rng })).toBe(
      singleUnused,
    );
    expect(bag.next({ currentShapeId: singleUnused, usedShapeIds: allButOne, random: rng })).not.toBe(
      singleUnused,
    );

    const whenAllUsed = bag.next({ currentShapeId: singleUnused, usedShapeIds: allIds, random: rng });
    expect(whenAllUsed).not.toBe(singleUnused);
    expect(allIds).toContain(whenAllUsed);
  });

  it("supports reset and avoids identical (shapeId, color) pairs with vibrant palette colors", () => {
    const normalizedPalette = OPEN_BOT_AVATAR_PALETTE.map((hex) => hex.toLowerCase());
    const bag = new NavigatorAvatarShuffleBag();
    const rng = createSeededRandom(7);

    let currentShapeId = "cat";
    let currentColor = normalizedPalette[0] ?? "#ff6a1a";
    for (let i = 0; i < 30; i += 1) {
      const pick = pickRandomNavigatorAvatar({
        currentShapeId,
        currentColor,
        random: rng,
        bag,
      });
      expect(normalizedPalette).toContain(pick.color);
      expect(pick.color).not.toBe("#f4f4f4");
      expect(pick.color).not.toBe("#7a7a7a");
      expect(pick.eyeColor).toBe(computeContrastEyeColor(pick.color));
      expect(pick.shapeId === currentShapeId && pick.color === currentColor).toBe(false);
      const parsed = parseNavigatorAvatar(pick.encoded);
      expect(parsed.shapeId).toBe(pick.shapeId);
      expect(parsed.color).toBe(pick.color);
      expect(parsed.eyeColor).toBe(pick.eyeColor);
      currentShapeId = pick.shapeId;
      currentColor = pick.color;
    }

    bag.reset();
    expect(bag.remaining).toBe(0);

    const singleShapeBag = new NavigatorAvatarShuffleBag(["cat"]);
    const firstColor =
      normalizedPalette.find((hex) => hex !== "#f4f4f4" && hex !== "#7a7a7a") ?? "#ff6a1a";
    const forcedColorChange = pickRandomNavigatorAvatar({
      currentShapeId: "cat",
      currentColor: firstColor,
      random: () => 0,
      bag: singleShapeBag,
    });
    expect(forcedColorChange.shapeId).toBe("cat");
    expect(forcedColorChange.color).not.toBe(firstColor);

    const defaultBagPick = pickRandomNavigatorAvatar({
      currentShapeId: "cat",
      random: createSeededRandom(123),
    });
    expect(defaultBagPick.shapeId).not.toBe("cat");
    expect(normalizedPalette).toContain(defaultBagPick.color);
  });
});

describe("IM channel online & bound resolver", () => {
  it("evaluates strict online status requiring synced, claimed, connected transport", () => {
    expect(isConnectionStrictlyOnline({ platform: "feishu", state: "connected" })).toBe(true);
    expect(
      isConnectionStrictlyOnline({ platform: "wechat", lifecycleState: "active", state: "connected" }),
    ).toBe(true);
    expect(
      isConnectionStrictlyOnline({ platform: "wechat", lifecycleState: "active" }),
    ).toBe(false);
    expect(
      isConnectionStrictlyOnline({
        platform: "feishu",
        lifecycleState: "active",
        state: "connected",
        syncPending: true,
      }),
    ).toBe(false);
    expect(
      isConnectionStrictlyOnline({ platform: "feishu", state: "connected", paused: true }),
    ).toBe(false);
    expect(
      isConnectionStrictlyOnline({ platform: "feishu", state: "connected", leaderPaused: true }),
    ).toBe(false);
    expect(
      isConnectionStrictlyOnline({
        platform: "feishu",
        lifecycleState: "pairing",
        state: "connected",
      }),
    ).toBe(false);
    expect(
      isConnectionStrictlyOnline({
        platform: "wechat",
        lifecycleState: "idle",
        state: "connected",
      }),
    ).toBe(false);

    for (const offlineState of [
      "paused",
      "error",
      "reconnecting",
      "idle",
      "awaiting_approval",
      "offline",
      "connecting",
    ]) {
      expect(
        isConnectionStrictlyOnline({
          platform: "wecom",
          lifecycleState: "active",
          state: offlineState,
        }),
      ).toBe(false);
    }
    expect(isConnectionStrictlyOnline({ platform: "wechat" })).toBe(false);
  });

  it("distinguishes bound connections from unpaired pairing or idle sessions", () => {
    expect(isConnectionBound({ platform: "feishu", lifecycleState: "pairing", state: "qr_ready" })).toBe(false);
    expect(isConnectionBound({ platform: "feishu", lifecycleState: "pairing" })).toBe(false);
    expect(isConnectionBound({ platform: "feishu", lifecycleState: "pairing", state: "connected" })).toBe(false);
    expect(isConnectionBound({ platform: "wechat", lifecycleState: "idle", state: "idle" })).toBe(false);
    expect(isConnectionBound({ platform: "feishu", lifecycleState: "active", state: "error" })).toBe(true);
    expect(isConnectionBound({ platform: "wechat", state: "offline" })).toBe(true);
  });

  it("resolves deduplicated bound channels in canonical wechat/feishu/wecom order", () => {
    expect(resolveNavigatorBoundChannels({ connections: [], lang: "zh" })).toEqual([]);
    expect(
      resolveNavigatorBoundChannels({
        connections: [{ platform: "feishu", lifecycleState: "pairing", state: "connected" }],
        bindings: [{ platform: "feishu", claimed: false }],
        boundPlatforms: [],
        lang: "zh",
      }),
    ).toEqual([]);

    const badgesZh = resolveNavigatorBoundChannels({
      connections: [
        { platform: "wecom", lifecycleState: "active", state: "reconnecting" },
        { platform: "feishu", lifecycleState: "active", state: "error" },
        { platform: "feishu", lifecycleState: "active", state: "connected" },
      ],
      bindings: [
        { platform: "wechat", claimed: true },
        { platform: "feishu", claimed: true },
        { platform: "unknown" },
        { platform: null },
      ],
      lang: "zh",
    });

    expect(badgesZh).toEqual([
      { platform: "wechat", label: "微信", online: false },
      { platform: "feishu", label: "飞书", online: true },
      { platform: "wecom", label: "企业微信", online: false },
    ]);

    const badgesEn = resolveNavigatorBoundChannels({
      connections: [
        { platform: "wechat", lifecycleState: "active", state: "connected" },
        { platform: "feishu", state: "connected", leaderPaused: true },
        { platform: "wecom", lifecycleState: "active", state: "connected", syncPending: true },
      ],
      boundPlatforms: ["wechat", "feishu", "wecom"],
      lang: "en",
    });

    expect(badgesEn).toEqual([
      { platform: "wechat", label: "WeChat", online: true },
      { platform: "feishu", label: "Feishu", online: false },
      { platform: "wecom", label: "WeCom", online: false },
    ]);
  });
});

describe("rollupNavigatorWorkState", () => {
  it("enforces Worst-of precedence: blocked > waiting > working > thinking > idle", () => {
    expect(rollupNavigatorWorkState(idleSignals())).toBe("idle");
    expect(rollupNavigatorWorkState(idleSignals({ leaderStatus: "archived" }))).toBe("idle");

    expect(rollupNavigatorWorkState(idleSignals({ startingCount: 1, runningCount: 1 }))).toBe("thinking");
    expect(
      rollupNavigatorWorkState(idleSignals({ pinnedThread: { status: "queued" } })),
    ).toBe("thinking");
    expect(
      rollupNavigatorWorkState(idleSignals({ pinnedThread: { status: "preparing" } })),
    ).toBe("thinking");
    expect(
      rollupNavigatorWorkState(idleSignals({ pinnedThread: { status: "starting" } })),
    ).toBe("thinking");
    expect(
      rollupNavigatorWorkState(idleSignals({ pinnedThread: { activityRunStatus: "preparing" } })),
    ).toBe("thinking");
    expect(
      rollupNavigatorWorkState(idleSignals({ pinnedThread: { activityRunStatus: "starting" } })),
    ).toBe("thinking");

    expect(rollupNavigatorWorkState(idleSignals({ runningCount: 2, startingCount: 1 }))).toBe("working");
    expect(
      rollupNavigatorWorkState(idleSignals({ pinnedThread: { status: "running" }, startingCount: 1 })),
    ).toBe("working");
    expect(
      rollupNavigatorWorkState(idleSignals({ pinnedThread: { activityRunStatus: "running" } })),
    ).toBe("working");

    expect(
      rollupNavigatorWorkState(idleSignals({ leaderStatus: "paused", runningCount: 3 })),
    ).toBe("waiting");
    expect(
      rollupNavigatorWorkState(idleSignals({ pendingApprovalCount: 1, runningCount: 2 })),
    ).toBe("waiting");
    expect(rollupNavigatorWorkState(idleSignals({ waitingCount: 1, runningCount: 2 }))).toBe("waiting");
    expect(rollupNavigatorWorkState(idleSignals({ pausedPendingCount: 1 }))).toBe("waiting");
    expect(rollupNavigatorWorkState(idleSignals({ needsYouCount: 1 }))).toBe("waiting");
    expect(
      rollupNavigatorWorkState(
        idleSignals({ pinnedThread: { pendingRuntimeRequest: { id: "req-1" }, status: "running" } }),
      ),
    ).toBe("waiting");
    expect(
      rollupNavigatorWorkState(
        idleSignals({ pinnedThread: { blockedOnThreadWait: true, status: "running" } }),
      ),
    ).toBe("waiting");
    expect(
      rollupNavigatorWorkState(idleSignals({ pinnedThread: { status: "waiting" } })),
    ).toBe("waiting");
    expect(
      rollupNavigatorWorkState(idleSignals({ pinnedThread: { activityRunStatus: "waiting" } })),
    ).toBe("waiting");

    expect(
      rollupNavigatorWorkState(
        idleSignals({
          leaderStatus: "paused",
          pendingApprovalCount: 2,
          runningCount: 2,
          failedCount: 1,
        }),
      ),
    ).toBe("blocked");
    expect(
      rollupNavigatorWorkState(
        idleSignals({
          pendingApprovalCount: 1,
          pinnedThread: { status: "failed" },
        }),
      ),
    ).toBe("blocked");
  });
});

describe("stepNavigatorAvatarController & resolveAvatarPresentation", () => {
  it("exports timing constants matching DONE_TURN_S and dwell spec", () => {
    expect(CELEBRATION_DURATION_MS).toBe(Math.ceil(DONE_TURN_S * 1000) + 120);
    expect(DOWNGRADE_DWELL_MS).toBe(900);
  });

  it("hydrates existing watermarks without triggering celebration", () => {
    const initial = createNavigatorAvatarControllerState();
    expect(initial).toEqual(INITIAL_NAVIGATOR_AVATAR_CONTROLLER_STATE);

    const hydrated = stepNavigatorAvatarController(
      initial,
      idleSignals({
        pinnedThread: { status: "completed", latestRunId: "run-1" },
        latestCompletedKey: "srv-1",
      }),
      1000,
    );
    expect(hydrated.hydrated).toBe(true);
    expect(hydrated.lastPinnedCompletedRunId).toBe("run-1");
    expect(hydrated.lastServerCompletedKey).toBe("srv-1");
    expect(hydrated.celebrateUntilMs).toBeNull();
    expect(resolveAvatarPresentation(hydrated, 1000)).toEqual({
      state: "idle",
      mood: "neutral",
      nextWakeMs: null,
    });

    const repeat = stepNavigatorAvatarController(
      hydrated,
      idleSignals({
        pinnedThread: { status: "completed", latestRunId: "run-1" },
        latestCompletedKey: "srv-1",
      }),
      2000,
    );
    expect(repeat).toBe(hydrated);
    expect(resolveAvatarPresentation(repeat, 2000)).toEqual({
      state: "idle",
      mood: "neutral",
      nextWakeMs: null,
    });
  });

  it("triggers one-shot celebration on pinned completion edge and ignores stop-requested runs", () => {
    let state = stepNavigatorAvatarController(
      createNavigatorAvatarControllerState(),
      idleSignals({ pinnedThread: { status: "running", latestRunId: "run-1" } }),
      1000,
    );
    expect(resolveAvatarPresentation(state, 1000)).toEqual({
      state: "working",
      mood: "neutral",
      nextWakeMs: null,
    });

    state = stepNavigatorAvatarController(
      state,
      idleSignals({ pinnedThread: { status: "completed", latestRunId: "run-1" } }),
      2000,
    );
    expect(state.displayedState).toBe("idle");
    expect(state.dwellUntilMs).toBeNull();
    expect(state.celebrateUntilMs).toBe(2000 + CELEBRATION_DURATION_MS);
    expect(resolveAvatarPresentation(state, 2000)).toEqual({
      state: "done",
      mood: "happy",
      nextWakeMs: CELEBRATION_DURATION_MS,
    });

    const retriggerAttempt = stepNavigatorAvatarController(
      state,
      idleSignals({
        pinnedThread: { status: "completed", latestRunId: "run-2" },
        latestCompletedKey: "srv-2",
      }),
      3000,
    );
    expect(retriggerAttempt.celebrateUntilMs).toBe(2000 + CELEBRATION_DURATION_MS);
    expect(resolveAvatarPresentation(retriggerAttempt, 3000)).toEqual({
      state: "done",
      mood: "happy",
      nextWakeMs: CELEBRATION_DURATION_MS - 1000,
    });

    const afterExpiryTime = 2000 + CELEBRATION_DURATION_MS;
    expect(resolveAvatarPresentation(retriggerAttempt, afterExpiryTime)).toEqual({
      state: "idle",
      mood: "neutral",
      nextWakeMs: null,
    });
    const settled = stepNavigatorAvatarController(
      retriggerAttempt,
      idleSignals({
        pinnedThread: { status: "completed", latestRunId: "run-2" },
        latestCompletedKey: "srv-2",
      }),
      afterExpiryTime,
    );
    expect(settled.celebrateUntilMs).toBeNull();

    const stoppedRun = stepNavigatorAvatarController(
      settled,
      idleSignals({
        pinnedThread: {
          status: "completed",
          latestRunId: "run-3",
          latestRunStopRequested: true,
        },
      }),
      afterExpiryTime + 500,
    );
    expect(stoppedRun.lastPinnedCompletedRunId).toBe("run-3");
    expect(stoppedRun.celebrateUntilMs).toBeNull();
    expect(resolveAvatarPresentation(stoppedRun, afterExpiryTime + 500)).toEqual({
      state: "idle",
      mood: "neutral",
      nextWakeMs: null,
    });
  });

  it("triggers celebration on server completion edge and clears immediately on overriding work", () => {
    let state = stepNavigatorAvatarController(
      createNavigatorAvatarControllerState(),
      idleSignals({ runningCount: 1, latestCompletedKey: "srv-1" }),
      1000,
    );
    expect(state.displayedState).toBe("working");

    state = stepNavigatorAvatarController(
      state,
      idleSignals({ runningCount: 0, latestCompletedKey: "srv-2" }),
      2000,
    );
    expect(resolveAvatarPresentation(state, 2000)).toEqual({
      state: "done",
      mood: "happy",
      nextWakeMs: CELEBRATION_DURATION_MS,
    });

    const overridden = stepNavigatorAvatarController(
      state,
      idleSignals({ startingCount: 1, runningCount: 1, latestCompletedKey: "srv-2" }),
      2500,
    );
    expect(overridden.celebrateUntilMs).toBeNull();
    expect(overridden.displayedState).toBe("thinking");
    expect(resolveAvatarPresentation(overridden, 2500)).toEqual({
      state: "thinking",
      mood: "neutral",
      nextWakeMs: null,
    });

    const completedWhileStillBusy = stepNavigatorAvatarController(
      overridden,
      idleSignals({ runningCount: 1, latestCompletedKey: "srv-3" }),
      3000,
    );
    expect(completedWhileStillBusy.celebrateUntilMs).toBeNull();
    expect(completedWhileStillBusy.displayedState).toBe("working");
  });

  it("applies immediate escalation and asymmetric dwell hysteresis on working/thinking downgrades", () => {
    let state = stepNavigatorAvatarController(
      createNavigatorAvatarControllerState(),
      idleSignals(),
      0,
    );
    expect(state.displayedState).toBe("idle");

    state = stepNavigatorAvatarController(
      state,
      idleSignals({ startingCount: 1, runningCount: 1 }),
      100,
    );
    expect(state.displayedState).toBe("thinking");
    expect(state.dwellUntilMs).toBeNull();

    state = stepNavigatorAvatarController(state, idleSignals({ runningCount: 1 }), 200);
    expect(state.displayedState).toBe("working");
    expect(state.dwellUntilMs).toBeNull();

    state = stepNavigatorAvatarController(state, idleSignals(), 1000);
    expect(state.displayedState).toBe("working");
    expect(state.dwellUntilMs).toBe(1000 + DOWNGRADE_DWELL_MS);
    expect(resolveAvatarPresentation(state, 1000)).toEqual({
      state: "working",
      mood: "neutral",
      nextWakeMs: DOWNGRADE_DWELL_MS,
    });

    state = stepNavigatorAvatarController(state, idleSignals(), 1500);
    expect(state.displayedState).toBe("working");
    expect(state.dwellUntilMs).toBe(1000 + DOWNGRADE_DWELL_MS);
    expect(resolveAvatarPresentation(state, 1500)).toEqual({
      state: "working",
      mood: "neutral",
      nextWakeMs: 400,
    });

    const rebounded = stepNavigatorAvatarController(state, idleSignals({ runningCount: 1 }), 1600);
    expect(rebounded.displayedState).toBe("working");
    expect(rebounded.dwellUntilMs).toBeNull();

    const dwellingAgain = stepNavigatorAvatarController(rebounded, idleSignals(), 2000);
    expect(dwellingAgain.displayedState).toBe("working");
    expect(dwellingAgain.dwellUntilMs).toBe(2900);

    const committed = stepNavigatorAvatarController(dwellingAgain, idleSignals(), 2900);
    expect(committed.displayedState).toBe("idle");
    expect(committed.dwellUntilMs).toBeNull();
    expect(resolveAvatarPresentation(committed, 2900)).toEqual({
      state: "idle",
      mood: "neutral",
      nextWakeMs: null,
    });
  });

  it("holds thinking downgrades for dwell window and drops blocked/waiting immediately", () => {
    let state = stepNavigatorAvatarController(
      createNavigatorAvatarControllerState(),
      idleSignals({ startingCount: 1, runningCount: 1 }),
      0,
    );
    expect(state.displayedState).toBe("thinking");

    state = stepNavigatorAvatarController(state, idleSignals(), 500);
    expect(state.displayedState).toBe("thinking");
    expect(state.dwellUntilMs).toBe(500 + DOWNGRADE_DWELL_MS);

    state = stepNavigatorAvatarController(state, idleSignals({ failedCount: 1 }), 700);
    expect(state.displayedState).toBe("blocked");
    expect(state.dwellUntilMs).toBeNull();

    state = stepNavigatorAvatarController(state, idleSignals({ needsYouCount: 1 }), 800);
    expect(state.displayedState).toBe("waiting");
    expect(state.dwellUntilMs).toBeNull();

    state = stepNavigatorAvatarController(state, idleSignals(), 900);
    expect(state.displayedState).toBe("idle");
    expect(state.dwellUntilMs).toBeNull();
  });

  it("handles working-to-thinking dwell, mid-dwell celebration, and empty run ids safely", () => {
    let state = stepNavigatorAvatarController(
      createNavigatorAvatarControllerState(),
      idleSignals({ runningCount: 2 }),
      0,
    );
    expect(state.displayedState).toBe("working");

    state = stepNavigatorAvatarController(
      state,
      idleSignals({ runningCount: 1, startingCount: 1 }),
      1000,
    );
    expect(state.displayedState).toBe("working");
    expect(state.dwellUntilMs).toBe(1000 + DOWNGRADE_DWELL_MS);

    state = stepNavigatorAvatarController(
      state,
      idleSignals({ runningCount: 1, startingCount: 1 }),
      1000 + DOWNGRADE_DWELL_MS,
    );
    expect(state.displayedState).toBe("thinking");
    expect(state.dwellUntilMs).toBeNull();

    const dwellingIdle = stepNavigatorAvatarController(
      state,
      idleSignals({ pinnedThread: { status: "completed", latestRunId: "" } }),
      3000,
    );
    expect(dwellingIdle.displayedState).toBe("thinking");
    expect(dwellingIdle.celebrateUntilMs).toBeNull();
    expect(dwellingIdle.dwellUntilMs).toBe(3000 + DOWNGRADE_DWELL_MS);

    const midDwellCelebration = stepNavigatorAvatarController(
      dwellingIdle,
      idleSignals({ pinnedThread: { status: "completed", latestRunId: "run-9" } }),
      3300,
    );
    expect(midDwellCelebration.displayedState).toBe("idle");
    expect(midDwellCelebration.dwellUntilMs).toBeNull();
    expect(midDwellCelebration.celebrateUntilMs).toBe(3300 + CELEBRATION_DURATION_MS);
    expect(resolveAvatarPresentation(midDwellCelebration, 3300)).toEqual({
      state: "done",
      mood: "happy",
      nextWakeMs: CELEBRATION_DURATION_MS,
    });
  });

  it("ignores older server completion watermarks when a newer thread settles and re-baselines silently on scope changes", () => {
    let state = stepNavigatorAvatarController(
      createNavigatorAvatarControllerState(),
      idleSignals({
        latestCompletedKey: "t-b:run-b:2000",
        latestCompletedAtMs: 2000,
        awarenessScopeKey: '{"kind":"projects","projectIds":["proj-a"]}',
      }),
      1000,
    );
    expect(resolveAvatarPresentation(state, 1000).state).toBe("idle");

    state = stepNavigatorAvatarController(
      state,
      idleSignals({
        latestCompletedKey: "t-a:run-a:1000",
        latestCompletedAtMs: 1000,
        awarenessScopeKey: '{"kind":"projects","projectIds":["proj-a"]}',
      }),
      2000,
    );
    expect(state.celebrateUntilMs).toBeNull();
    expect(state.lastServerCompletedAtMs).toBe(2000);
    expect(resolveAvatarPresentation(state, 2000).state).toBe("idle");

    state = stepNavigatorAvatarController(
      state,
      idleSignals({
        latestCompletedKey: "t-other:run-other:5000",
        latestCompletedAtMs: 5000,
        awarenessScopeKey: '{"kind":"all_local","projectIds":[]}',
      }),
      3000,
    );
    expect(state.celebrateUntilMs).toBeNull();
    expect(state.lastServerCompletedAtMs).toBe(5000);
    expect(state.lastServerCompletedKey).toBe("t-other:run-other:5000");

    state = stepNavigatorAvatarController(
      state,
      idleSignals({
        latestCompletedKey: "t-c:run-c:6000",
        latestCompletedAtMs: 6000,
        awarenessScopeKey: '{"kind":"all_local","projectIds":[]}',
      }),
      4000,
    );
    expect(resolveAvatarPresentation(state, 4000)).toEqual({
      state: "done",
      mood: "happy",
      nextWakeMs: CELEBRATION_DURATION_MS,
    });
  });

  it("defers pinned completion celebration while runtime.status is parked at idle for awaited background tasks", () => {
    let state = stepNavigatorAvatarController(
      createNavigatorAvatarControllerState(),
      idleSignals({
        pinnedThread: extractPinnedThreadSignal({
          runtime: { status: "running" },
          source: { status: "running", activityRunStatus: "running", latestRunId: "run-bg" },
        }),
      }),
      1000,
    );
    expect(resolveAvatarPresentation(state, 1000).state).toBe("working");

    state = stepNavigatorAvatarController(
      state,
      idleSignals({
        pinnedThread: extractPinnedThreadSignal({
          runtime: { status: "idle" },
          source: { status: "completed", activityRunStatus: null, latestRunId: "run-bg" },
        }),
      }),
      2000,
    );
    expect(state.celebrateUntilMs).toBeNull();
    expect(state.lastPinnedCompletedRunId).toBeNull();

    state = stepNavigatorAvatarController(
      state,
      idleSignals({
        pinnedThread: extractPinnedThreadSignal({
          runtime: { status: "idle" },
          source: { status: "completed", activityRunStatus: null, latestRunId: "run-bg" },
        }),
      }),
      2000 + DOWNGRADE_DWELL_MS,
    );
    expect(resolveAvatarPresentation(state, 2000 + DOWNGRADE_DWELL_MS)).toEqual({
      state: "idle",
      mood: "neutral",
      nextWakeMs: null,
    });

    state = stepNavigatorAvatarController(
      state,
      idleSignals({
        pinnedThread: extractPinnedThreadSignal({
          runtime: { status: "idle" },
          pendingBackgroundTasks: [{ kind: "subagent" }],
          source: { status: "completed", activityRunStatus: null, latestRunId: "run-bg" },
        }),
        latestCompletedKey: "other-thread:run-other:9000",
        latestCompletedAtMs: 9000,
      }),
      3500,
    );
    expect(state.celebrateUntilMs).toBeNull();
    expect(state.lastServerCompletedKey).toBe("other-thread:run-other:9000");
    expect(resolveAvatarPresentation(state, 3500)).toEqual({
      state: "idle",
      mood: "neutral",
      nextWakeMs: null,
    });

    state = stepNavigatorAvatarController(
      state,
      idleSignals({
        pinnedThread: extractPinnedThreadSignal({
          runtime: { status: "completed" },
          pendingBackgroundTasks: [],
          source: { status: "completed", activityRunStatus: null, latestRunId: "run-bg" },
        }),
        latestCompletedKey: "other-thread:run-other:9000",
        latestCompletedAtMs: 9000,
      }),
      4000,
    );
    expect(resolveAvatarPresentation(state, 4000)).toEqual({
      state: "done",
      mood: "happy",
      nextWakeMs: CELEBRATION_DURATION_MS,
    });
  });
});
