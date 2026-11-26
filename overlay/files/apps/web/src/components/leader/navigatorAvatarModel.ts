import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  DONE_TURN_S,
  OPEN_BOT_AVATAR_CATALOG,
  OPEN_BOT_AVATAR_PALETTE,
  getOpenBotAvatarEntry,
  type AvatarMood,
  type AvatarState,
  type OpenBotAvatarCatalogEntry,
} from "./openBotAvatar";
import type { RemoteImChannel } from "../settings/remoteImThemes";
import {
  navigatorChannelLabel,
  type LeaderConnectionSummary,
  type NavigatorLang,
} from "./leaderTypes";

export interface ResolvedNavigatorAvatar {
  readonly kind: "bot";
  readonly shapeId: string;
  readonly color: string;
  readonly eyeColor: string;
  readonly entry: OpenBotAvatarCatalogEntry;
  readonly encoded: string;
}

export interface NavigatorAvatarShuffleOptions {
  readonly currentShapeId?: string | undefined;
  readonly currentColor?: string | undefined;
  readonly usedShapeIds?: readonly string[] | undefined;
  readonly random?: (() => number) | undefined;
  readonly bag?: NavigatorAvatarShuffleBag | undefined;
}

export interface RandomNavigatorAvatarPick {
  readonly shapeId: string;
  readonly color: string;
  readonly eyeColor: string;
  readonly encoded: string;
}

export interface NavigatorChannelBadge {
  readonly platform: RemoteImChannel;
  readonly label: string;
  readonly online: boolean;
}

export interface ResolveNavigatorBoundChannelsInput {
  readonly connections: readonly LeaderConnectionSummary[];
  readonly boundPlatforms?: readonly string[] | undefined;
  readonly bindings?:
    | readonly {
        readonly platform?: string | null | undefined;
        readonly claimed?: boolean | undefined;
      }[]
    | undefined;
  readonly lang: NavigatorLang;
}

export type NavigatorWorkState = Exclude<AvatarState, "done">;

export interface NavigatorThreadSignal {
  readonly status?: string | null | undefined;
  readonly runtimeStatus?: string | null | undefined;
  readonly activityRunStatus?: string | null | undefined;
  readonly blockedOnThreadWait?: boolean | undefined;
  readonly pendingRuntimeRequest?: unknown | null | undefined;
  readonly latestRunId?: string | null | undefined;
  readonly latestRunCompletedAt?: unknown | null | undefined;
  readonly latestRunStopRequested?: boolean | undefined;
  readonly hasAwaitedBackgroundWork?: boolean | undefined;
}

export function extractPinnedThreadSignal(shell: {
  readonly runtime?: { readonly status?: string | null | undefined } | null | undefined;
  readonly blockedOnThreadWait?: boolean | undefined;
  readonly pendingBackgroundTasks?: Parameters<typeof backgroundWorkHoldsCompletion>[0] | undefined;
  readonly source: {
    readonly status?: string | null | undefined;
    readonly activityRunStatus?: string | null | undefined;
    readonly blockedOnThreadWait?: boolean | undefined;
    readonly pendingRuntimeRequest?: unknown | null | undefined;
    readonly latestRunId?: string | null | undefined;
    readonly latestRunCompletedAt?: unknown | null | undefined;
    readonly latestRunStopRequested?: boolean | undefined;
  };
}): NavigatorThreadSignal {
  const hasAwaitedBackgroundWork =
    backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? []) ||
    (shell.source.status === "completed" && shell.runtime?.status === "idle");
  return {
    status: shell.source.status,
    runtimeStatus: shell.runtime?.status ?? null,
    activityRunStatus: shell.source.activityRunStatus,
    blockedOnThreadWait: shell.blockedOnThreadWait ?? shell.source.blockedOnThreadWait,
    pendingRuntimeRequest: shell.source.pendingRuntimeRequest,
    latestRunId: shell.source.latestRunId,
    latestRunCompletedAt: shell.source.latestRunCompletedAt,
    latestRunStopRequested: shell.source.latestRunStopRequested,
    hasAwaitedBackgroundWork,
  };
}

export interface NavigatorWorkSignals {
  readonly leaderStatus: "active" | "paused" | "archived";
  readonly pinnedThread?: NavigatorThreadSignal | null | undefined;
  readonly runningCount: number;
  readonly startingCount?: number | undefined;
  readonly waitingCount?: number | undefined;
  readonly failedCount?: number | undefined;
  readonly pendingApprovalCount: number;
  readonly pausedPendingCount: number;
  readonly needsYouCount: number;
  readonly latestCompletedKey?: string | null | undefined;
  readonly latestCompletedAtMs?: number | null | undefined;
  readonly awarenessScopeKey?: string | null | undefined;
}

export interface NavigatorAvatarControllerState {
  readonly hydrated: boolean;
  readonly lastPinnedCompletedRunId: string | null;
  readonly lastServerCompletedKey: string | null;
  readonly lastServerCompletedAtMs: number | null;
  readonly lastAwarenessScopeKey: string | null;
  readonly celebrateUntilMs: number | null;
  readonly displayedState: NavigatorWorkState;
  readonly dwellUntilMs: number | null;
}

export interface NavigatorAvatarPresentation {
  readonly state: AvatarState;
  readonly mood: AvatarMood;
  readonly nextWakeMs: number | null;
}

export const CELEBRATION_DURATION_MS = Math.ceil(DONE_TURN_S * 1000) + 120;
export const DOWNGRADE_DWELL_MS = 900;

export const INITIAL_NAVIGATOR_AVATAR_CONTROLLER_STATE: NavigatorAvatarControllerState = {
  hydrated: false,
  lastPinnedCompletedRunId: null,
  lastServerCompletedKey: null,
  lastServerCompletedAtMs: null,
  lastAwarenessScopeKey: null,
  celebrateUntilMs: null,
  displayedState: "idle",
  dwellUntilMs: null,
};

const LIGHT_EYE_COLOR = "#f8fafc";
const DARK_EYE_COLOR = "#151515";
const CONTRAST_LUMINANCE_THRESHOLD = 0.18;
const MIN_EYE_CONTRAST_RATIO = 3.0;
const BOT_AVATAR_PATTERN =
  /^bot:v1:([a-zA-Z0-9_-]+):(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})(?::(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}))?$/;
const NAVIGATOR_CHANNEL_ORDER: readonly RemoteImChannel[] = ["wechat", "feishu", "wecom"];
const WORK_STATE_SEVERITY: Readonly<Record<NavigatorWorkState, number>> = {
  idle: 0,
  thinking: 1,
  working: 2,
  waiting: 3,
  blocked: 4,
};

function normalizeHexColor(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
  if (!match) return null;
  const digits = match[1];
  if (!digits) return null;
  if (digits.length === 3) {
    const r = digits.charAt(0);
    const g = digits.charAt(1);
    const b = digits.charAt(2);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return `#${digits.toLowerCase()}`;
}

function parseHexRgb(hex: string): readonly [number, number, number] | null {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  return [r, g, b];
}

function srgbChannelToLinear(channel255: number): number {
  const srgb = channel255 / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number | null {
  const rgb = parseHexRgb(hex);
  if (!rgb) return null;
  const r = srgbChannelToLinear(rgb[0]);
  const g = srgbChannelToLinear(rgb[1]);
  const b = srgbChannelToLinear(rgb[2]);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function computeContrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  if (lumA === null || lumB === null) return 1;
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

export function computeContrastEyeColor(bodyColor: string): string {
  const luminance = relativeLuminance(bodyColor);
  if (luminance === null) return DARK_EYE_COLOR;
  return luminance < CONTRAST_LUMINANCE_THRESHOLD ? LIGHT_EYE_COLOR : DARK_EYE_COLOR;
}

export function isLightAvatarBodyColor(bodyColor: string): boolean {
  const luminance = relativeLuminance(bodyColor);
  return luminance !== null && luminance >= 0.72;
}

function resolveAccessibleEyeColor(bodyColor: string, explicitEye: string | null): string {
  if (explicitEye !== null && computeContrastRatio(bodyColor, explicitEye) >= MIN_EYE_CONTRAST_RATIO) {
    return explicitEye;
  }
  return computeContrastEyeColor(bodyColor);
}

export function encodeNavigatorAvatar(shapeId: string, color: string, eyeColor?: string): string {
  const normalizedShapeId = shapeId.trim();
  const normalizedColor = normalizeHexColor(color) ?? color.trim().toLowerCase();
  const autoEye = computeContrastEyeColor(normalizedColor);
  if (typeof eyeColor === "string") {
    const normalizedEye = normalizeHexColor(eyeColor);
    const accessibleEye = resolveAccessibleEyeColor(normalizedColor, normalizedEye);
    if (accessibleEye !== autoEye) {
      return `bot:v1:${normalizedShapeId}:${normalizedColor}:${accessibleEye}`;
    }
  }
  return `bot:v1:${normalizedShapeId}:${normalizedColor}`;
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function getFallbackCatalogEntry(seed: string): OpenBotAvatarCatalogEntry {
  if (seed === "leader-default") {
    const catEntry = getOpenBotAvatarEntry("cat") ?? OPEN_BOT_AVATAR_CATALOG[0];
    if (catEntry) return catEntry;
  }
  const count = OPEN_BOT_AVATAR_CATALOG.length;
  const index = count > 0 ? fnv1a32(seed) % count : 0;
  const picked = OPEN_BOT_AVATAR_CATALOG[index] ?? OPEN_BOT_AVATAR_CATALOG[0];
  if (!picked) {
    throw new Error("OPEN_BOT_AVATAR_CATALOG must contain at least one entry");
  }
  return picked;
}

export function parseNavigatorAvatar(
  rawAvatar: string | null | undefined,
  leaderId?: string,
): ResolvedNavigatorAvatar {
  const trimmedRaw = typeof rawAvatar === "string" ? rawAvatar.trim() : "";
  const match = BOT_AVATAR_PATTERN.exec(trimmedRaw);
  if (match) {
    const rawShapeId = match[1];
    const rawColor = match[2];
    const rawEye = match[3];
    if (rawShapeId && rawColor) {
      const entry = getOpenBotAvatarEntry(rawShapeId);
      const color = normalizeHexColor(rawColor);
      if (entry && color) {
        const explicitEye = rawEye ? normalizeHexColor(rawEye) : null;
        const eyeColor = resolveAccessibleEyeColor(color, explicitEye);
        return {
          kind: "bot",
          shapeId: entry.definition.id,
          color,
          eyeColor,
          entry,
          encoded: encodeNavigatorAvatar(entry.definition.id, color, eyeColor),
        };
      }
    }
  }
  const trimmedLeaderId = typeof leaderId === "string" ? leaderId.trim() : "";
  const seed = trimmedLeaderId || trimmedRaw || "leader-default";
  const entry = getFallbackCatalogEntry(seed);
  const color = normalizeHexColor(entry.defaultColor) ?? entry.defaultColor.trim().toLowerCase();
  const eyeColor = computeContrastEyeColor(color);
  return {
    kind: "bot",
    shapeId: entry.definition.id,
    color,
    eyeColor,
    entry,
    encoded: encodeNavigatorAvatar(entry.definition.id, color),
  };
}

function clampRandomIndex(randomValue: number, length: number): number {
  if (length <= 1) return 0;
  const bounded = Number.isFinite(randomValue) ? randomValue : 0;
  const clamped = Math.min(Math.max(bounded, 0), 0.999999999999);
  return Math.floor(clamped * length);
}

function fisherYatesShuffle(items: readonly string[], rng: () => number): string[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = clampRandomIndex(rng(), i + 1);
    const current = result[i];
    const swap = result[j];
    if (current !== undefined && swap !== undefined) {
      result[i] = swap;
      result[j] = current;
    }
  }
  return result;
}

export class NavigatorAvatarShuffleBag {
  private readonly shapeIds: readonly string[];
  private queue: string[] = [];
  private lastShapeId: string | null = null;

  constructor(shapeIds?: readonly string[]) {
    const source =
      shapeIds && shapeIds.length > 0
        ? shapeIds
        : OPEN_BOT_AVATAR_CATALOG.map((entry) => entry.definition.id);
    this.shapeIds = [...new Set(source)];
  }

  get remaining(): number {
    return this.queue.length;
  }

  reset(): void {
    this.queue = [];
    this.lastShapeId = null;
  }

  private refill(avoidShapeId: string | undefined, rng: () => number): void {
    const shuffled = fisherYatesShuffle(this.shapeIds, rng);
    if (avoidShapeId && shuffled.length > 1 && shuffled[0] === avoidShapeId) {
      const swapIndex = 1 + clampRandomIndex(rng(), shuffled.length - 1);
      const first = shuffled[0];
      const replacement = shuffled[swapIndex];
      if (first !== undefined && replacement !== undefined) {
        shuffled[0] = replacement;
        shuffled[swapIndex] = first;
      }
    }
    this.queue = shuffled;
  }

  next(options?: {
    readonly currentShapeId?: string | undefined;
    readonly usedShapeIds?: readonly string[] | undefined;
    readonly random?: (() => number) | undefined;
  }): string {
    const rng = options?.random ?? Math.random;
    const avoidShapeId = options?.currentShapeId ?? this.lastShapeId ?? undefined;
    const usedSet = new Set(options?.usedShapeIds ?? []);

    if (this.queue.length === 0) {
      this.refill(avoidShapeId, rng);
    }

    let pickedIndex = -1;

    if (usedSet.size > 0) {
      pickedIndex = this.queue.findIndex((id) => id !== avoidShapeId && !usedSet.has(id));
      if (pickedIndex === -1) {
        const hasUnusedAlternative = this.shapeIds.some(
          (id) => id !== avoidShapeId && !usedSet.has(id),
        );
        if (hasUnusedAlternative) {
          this.refill(avoidShapeId, rng);
          pickedIndex = this.queue.findIndex((id) => id !== avoidShapeId && !usedSet.has(id));
        }
      }
    }

    if (pickedIndex === -1) {
      pickedIndex = this.queue.findIndex((id) => id !== avoidShapeId);
      if (pickedIndex === -1 && this.shapeIds.length > 1) {
        this.refill(avoidShapeId, rng);
        pickedIndex = this.queue.findIndex((id) => id !== avoidShapeId);
      }
    }

    if (pickedIndex === -1) {
      pickedIndex = 0;
    }

    const [picked] = this.queue.splice(pickedIndex, 1);
    const resolved = picked ?? this.shapeIds[0] ?? "cat";
    this.lastShapeId = resolved;
    return resolved;
  }
}

let defaultShuffleBag: NavigatorAvatarShuffleBag | null = null;

function getDefaultShuffleBag(): NavigatorAvatarShuffleBag {
  if (!defaultShuffleBag) {
    defaultShuffleBag = new NavigatorAvatarShuffleBag();
  }
  return defaultShuffleBag;
}

function isVibrantHexColor(hex: string): boolean {
  const rgb = parseHexRgb(hex);
  if (!rgb) return false;
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const lightness = (max + min) / 2;
  return chroma >= 0.16 && lightness >= 0.14 && lightness <= 0.92;
}

function getNormalizedPalette(): readonly string[] {
  const seen = new Set<string>();
  const colors: string[] = [];
  for (const swatch of OPEN_BOT_AVATAR_PALETTE) {
    const normalized = normalizeHexColor(swatch);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      colors.push(normalized);
    }
  }
  return colors;
}

function pickPaletteColor(
  shapeId: string,
  currentShapeId: string | undefined,
  currentColor: string | undefined,
  rng: () => number,
): string {
  const palette = getNormalizedPalette();
  const vibrant = palette.filter(isVibrantHexColor);
  const preferredPool = vibrant.length > 0 ? vibrant : palette;
  const normalizedCurrent =
    typeof currentColor === "string" ? normalizeHexColor(currentColor) : null;
  const sameShape = currentShapeId !== undefined && shapeId === currentShapeId;

  const entry = getOpenBotAvatarEntry(shapeId);
  const defaultColor = entry ? normalizeHexColor(entry.defaultColor) : null;
  const defaultIsPreferred =
    defaultColor !== null &&
    preferredPool.includes(defaultColor) &&
    !(sameShape && defaultColor === normalizedCurrent) &&
    defaultColor !== normalizedCurrent;

  if (defaultIsPreferred && rng() < 0.45) {
    return defaultColor;
  }

  const withoutCurrent =
    normalizedCurrent !== null
      ? preferredPool.filter((color) => color !== normalizedCurrent)
      : preferredPool;

  const fallbackWithoutCurrent =
    normalizedCurrent !== null
      ? palette.filter((color) => color !== normalizedCurrent)
      : palette;

  const pool =
    withoutCurrent.length > 0
      ? withoutCurrent
      : fallbackWithoutCurrent.length > 0
        ? fallbackWithoutCurrent
        : palette;

  const picked = pool[clampRandomIndex(rng(), pool.length)];
  if (picked) return picked;
  return defaultColor ?? "#3b82f6";
}

export function pickRandomNavigatorAvatar(
  options?: NavigatorAvatarShuffleOptions,
): RandomNavigatorAvatarPick {
  const rng = options?.random ?? Math.random;
  const bag = options?.bag ?? getDefaultShuffleBag();
  const nextOptions: {
    currentShapeId?: string;
    usedShapeIds?: readonly string[];
    random: () => number;
  } = { random: rng };
  if (options?.currentShapeId !== undefined) {
    nextOptions.currentShapeId = options.currentShapeId;
  }
  if (options?.usedShapeIds !== undefined) {
    nextOptions.usedShapeIds = options.usedShapeIds;
  }
  const shapeId = bag.next(nextOptions);
  const color = pickPaletteColor(shapeId, options?.currentShapeId, options?.currentColor, rng);
  const eyeColor = computeContrastEyeColor(color);
  return {
    shapeId,
    color,
    eyeColor,
    encoded: encodeNavigatorAvatar(shapeId, color),
  };
}

function isRemoteImChannel(value: unknown): value is RemoteImChannel {
  return value === "wechat" || value === "feishu" || value === "wecom";
}

export function isConnectionStrictlyOnline(conn: LeaderConnectionSummary): boolean {
  if (
    conn.paused === true ||
    conn.leaderPaused === true ||
    conn.syncPending === true ||
    conn.lifecycleState === "pairing" ||
    conn.lifecycleState === "idle"
  ) {
    return false;
  }
  return conn.state === "connected";
}

export function isConnectionBound(conn: LeaderConnectionSummary): boolean {
  if (conn.lifecycleState === "pairing" || conn.lifecycleState === "idle") {
    return false;
  }
  return true;
}

export function resolveNavigatorBoundChannels(
  input: ResolveNavigatorBoundChannelsInput,
): readonly NavigatorChannelBadge[] {
  const boundPlatforms = new Set<RemoteImChannel>();
  for (const conn of input.connections) {
    if (isRemoteImChannel(conn.platform) && isConnectionBound(conn)) {
      boundPlatforms.add(conn.platform);
    }
  }
  if (input.boundPlatforms !== undefined) {
    for (const platform of input.boundPlatforms) {
      if (isRemoteImChannel(platform)) {
        boundPlatforms.add(platform);
      }
    }
  } else if (input.bindings) {
    for (const binding of input.bindings) {
      if (binding.claimed !== false && isRemoteImChannel(binding.platform)) {
        boundPlatforms.add(binding.platform);
      }
    }
  }
  const badges: NavigatorChannelBadge[] = [];
  for (const platform of NAVIGATOR_CHANNEL_ORDER) {
    if (!boundPlatforms.has(platform)) continue;
    const online = input.connections.some(
      (conn) => conn.platform === platform && isConnectionStrictlyOnline(conn),
    );
    badges.push({
      platform,
      label: navigatorChannelLabel(platform, input.lang),
      online,
    });
  }
  return badges;
}

export function createNavigatorAvatarControllerState(): NavigatorAvatarControllerState {
  return { ...INITIAL_NAVIGATOR_AVATAR_CONTROLLER_STATE };
}

function resolveEffectivePinnedStatus(pinned: NavigatorThreadSignal | null | undefined): string | null {
  if (!pinned) return null;
  if (typeof pinned.runtimeStatus === "string" && pinned.runtimeStatus.length > 0) {
    return pinned.runtimeStatus;
  }
  return typeof pinned.status === "string" && pinned.status.length > 0 ? pinned.status : null;
}

export function rollupNavigatorWorkState(signals: NavigatorWorkSignals): NavigatorWorkState {
  const pinned = signals.pinnedThread;
  const effectivePinnedStatus = resolveEffectivePinnedStatus(pinned);
  if ((signals.failedCount ?? 0) > 0 || pinned?.status === "failed" || effectivePinnedStatus === "failed") {
    return "blocked";
  }
  if (
    signals.leaderStatus === "paused" ||
    signals.pendingApprovalCount > 0 ||
    (signals.waitingCount ?? 0) > 0 ||
    signals.pausedPendingCount > 0 ||
    signals.needsYouCount > 0 ||
    Boolean(pinned?.pendingRuntimeRequest) ||
    pinned?.blockedOnThreadWait === true ||
    effectivePinnedStatus === "waiting" ||
    pinned?.activityRunStatus === "waiting"
  ) {
    return "waiting";
  }
  const activeRunningCount = signals.runningCount - (signals.startingCount ?? 0);
  if (
    pinned?.activityRunStatus === "running" ||
    effectivePinnedStatus === "running" ||
    activeRunningCount > 0
  ) {
    return "working";
  }
  if (
    pinned?.activityRunStatus === "preparing" ||
    pinned?.activityRunStatus === "starting" ||
    effectivePinnedStatus === "queued" ||
    effectivePinnedStatus === "preparing" ||
    effectivePinnedStatus === "starting" ||
    (signals.startingCount ?? 0) > 0
  ) {
    return "thinking";
  }
  return "idle";
}

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeFiniteTimestamp(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stepNavigatorAvatarController(
  prev: NavigatorAvatarControllerState,
  input: NavigatorWorkSignals,
  nowMs: number,
): NavigatorAvatarControllerState {
  const rolledUp = rollupNavigatorWorkState(input);
  const pinnedRunId = normalizeNonEmptyString(input.pinnedThread?.latestRunId);
  const effectivePinnedStatus = resolveEffectivePinnedStatus(input.pinnedThread);
  const pinnedIsCompleted = effectivePinnedStatus === "completed" && pinnedRunId !== null;
  const serverKey = normalizeNonEmptyString(input.latestCompletedKey);
  const serverAtMs = normalizeFiniteTimestamp(input.latestCompletedAtMs);
  const scopeKey = normalizeNonEmptyString(input.awarenessScopeKey);

  const nextPinnedCompletedRunId = pinnedIsCompleted ? pinnedRunId : prev.lastPinnedCompletedRunId;

  if (!prev.hydrated) {
    return {
      hydrated: true,
      lastPinnedCompletedRunId: nextPinnedCompletedRunId,
      lastServerCompletedKey: serverKey,
      lastServerCompletedAtMs: serverAtMs,
      lastAwarenessScopeKey: scopeKey,
      celebrateUntilMs: null,
      displayedState: rolledUp,
      dwellUntilMs: null,
    };
  }

  const scopeChanged = scopeKey !== prev.lastAwarenessScopeKey;
  let serverCompletedEdge = false;
  let nextServerCompletedKey = prev.lastServerCompletedKey;
  let nextServerCompletedAtMs = prev.lastServerCompletedAtMs;

  if (scopeChanged) {
    nextServerCompletedKey = serverKey;
    nextServerCompletedAtMs = serverAtMs;
  } else if (serverKey !== null) {
    if (serverAtMs !== null && prev.lastServerCompletedAtMs !== null) {
      if (
        serverAtMs > prev.lastServerCompletedAtMs ||
        (serverAtMs === prev.lastServerCompletedAtMs && serverKey !== prev.lastServerCompletedKey)
      ) {
        serverCompletedEdge = true;
        nextServerCompletedKey = serverKey;
        nextServerCompletedAtMs = serverAtMs;
      }
    } else if (serverKey !== prev.lastServerCompletedKey) {
      serverCompletedEdge = true;
      nextServerCompletedKey = serverKey;
      nextServerCompletedAtMs = serverAtMs ?? prev.lastServerCompletedAtMs;
    }
  }

  const pinnedAwaitsBackgroundWork =
    input.pinnedThread?.hasAwaitedBackgroundWork === true ||
    (input.pinnedThread?.status === "completed" && input.pinnedThread?.runtimeStatus === "idle");
  const pinnedCompletedEdge =
    pinnedIsCompleted &&
    !pinnedAwaitsBackgroundWork &&
    pinnedRunId !== prev.lastPinnedCompletedRunId &&
    input.pinnedThread?.latestRunStopRequested !== true;
  const completionEdge = pinnedCompletedEdge || serverCompletedEdge;

  const wasCelebrating = prev.celebrateUntilMs !== null && nowMs < prev.celebrateUntilMs;
  let celebrateUntilMs: number | null;
  if (rolledUp !== "idle" || pinnedAwaitsBackgroundWork) {
    celebrateUntilMs = null;
  } else if (wasCelebrating) {
    celebrateUntilMs = prev.celebrateUntilMs;
  } else if (completionEdge) {
    celebrateUntilMs = nowMs + CELEBRATION_DURATION_MS;
  } else {
    celebrateUntilMs = null;
  }

  const isCelebratingNow = celebrateUntilMs !== null && nowMs < celebrateUntilMs;
  const prevSeverity = WORK_STATE_SEVERITY[prev.displayedState];
  const nextSeverity = WORK_STATE_SEVERITY[rolledUp];

  let displayedState: NavigatorWorkState;
  let dwellUntilMs: number | null;

  if (rolledUp === prev.displayedState) {
    displayedState = rolledUp;
    dwellUntilMs = null;
  } else if (nextSeverity > prevSeverity) {
    displayedState = rolledUp;
    dwellUntilMs = null;
  } else if (prev.displayedState === "working" || prev.displayedState === "thinking") {
    if (isCelebratingNow && rolledUp === "idle") {
      displayedState = "idle";
      dwellUntilMs = null;
    } else if (prev.dwellUntilMs === null) {
      displayedState = prev.displayedState;
      dwellUntilMs = nowMs + DOWNGRADE_DWELL_MS;
    } else if (nowMs < prev.dwellUntilMs) {
      displayedState = prev.displayedState;
      dwellUntilMs = prev.dwellUntilMs;
    } else {
      displayedState = rolledUp;
      dwellUntilMs = null;
    }
  } else {
    displayedState = rolledUp;
    dwellUntilMs = null;
  }

  if (
    prev.hydrated &&
    prev.lastPinnedCompletedRunId === nextPinnedCompletedRunId &&
    prev.lastServerCompletedKey === nextServerCompletedKey &&
    prev.lastServerCompletedAtMs === nextServerCompletedAtMs &&
    prev.lastAwarenessScopeKey === scopeKey &&
    prev.celebrateUntilMs === celebrateUntilMs &&
    prev.displayedState === displayedState &&
    prev.dwellUntilMs === dwellUntilMs
  ) {
    return prev;
  }

  return {
    hydrated: true,
    lastPinnedCompletedRunId: nextPinnedCompletedRunId,
    lastServerCompletedKey: nextServerCompletedKey,
    lastServerCompletedAtMs: nextServerCompletedAtMs,
    lastAwarenessScopeKey: scopeKey,
    celebrateUntilMs,
    displayedState,
    dwellUntilMs,
  };
}

export function resolveAvatarPresentation(
  controllerState: NavigatorAvatarControllerState,
  nowMs: number,
): NavigatorAvatarPresentation {
  if (controllerState.celebrateUntilMs !== null && nowMs < controllerState.celebrateUntilMs) {
    return {
      state: "done",
      mood: "happy",
      nextWakeMs: Math.max(0, controllerState.celebrateUntilMs - nowMs),
    };
  }
  const nextWakeMs =
    controllerState.dwellUntilMs !== null
      ? Math.max(0, controllerState.dwellUntilMs - nowMs)
      : null;
  return {
    state: controllerState.displayedState,
    mood: "neutral",
    nextWakeMs,
  };
}
