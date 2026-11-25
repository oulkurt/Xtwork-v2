import {
  ProviderInstanceId,
  type CodingAgentBlockedReason,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";

export interface CodingAgentBlockedPayload {
  readonly blocked: true;
  readonly code: "coding_agent_unavailable";
  readonly reason: CodingAgentBlockedReason;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly canInstall: boolean;
  readonly canLogin: boolean;
  readonly message: string;
}

const KNOWN_AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  xtworkKimiCode: "Kimi Code",
  xtworkQoder: "Qoder",
  xtworkCodebuddyCode: "Codebuddy Code",
  xtworkDeepseekHarness: "DeepSeek Harness",
};

const VALID_BLOCKED_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "disabled",
  "not_installed",
  "update_required",
  "not_authenticated",
  "unavailable",
]);

const MAX_INSTANCE_ID_CHARS = 128;
const MAX_DISPLAY_NAME_CHARS = 120;
const MAX_MESSAGE_CHARS = 600;
const MAX_RAW_JSON_CHARS = 16_384;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function clampString(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

function extractBlockedRecord(value: unknown, depth = 0): CodingAgentBlockedPayload | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_RAW_JSON_CHARS ||
      (!trimmed.startsWith("{") && !trimmed.startsWith("["))
    ) {
      return null;
    }
    try {
      return extractBlockedRecord(JSON.parse(trimmed), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 16)) {
      const rec = asRecord(entry);
      const found =
        extractBlockedRecord(rec?.text, depth + 1) ??
        extractBlockedRecord(asRecord(rec?.content)?.text, depth + 1) ??
        extractBlockedRecord(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  if (
    record.code === "coding_agent_unavailable" &&
    typeof record.instanceId === "string" &&
    record.instanceId.trim().length > 0 &&
    record.instanceId.trim().length <= MAX_INSTANCE_ID_CHARS
  ) {
    const rawReason = typeof record.reason === "string" ? record.reason : "unavailable";
    const reason: CodingAgentBlockedReason = VALID_BLOCKED_REASONS.has(rawReason)
      ? (rawReason as CodingAgentBlockedReason)
      : "unavailable";
    const instanceId = ProviderInstanceId.make(record.instanceId.trim());
    const displayName =
      typeof record.displayName === "string" && record.displayName.trim().length > 0
        ? clampString(record.displayName, MAX_DISPLAY_NAME_CHARS)
        : (KNOWN_AGENT_DISPLAY_NAMES[instanceId] ?? clampString(String(instanceId), MAX_DISPLAY_NAME_CHARS));
    const message =
      typeof record.message === "string" && record.message.trim().length > 0
        ? clampString(record.message, MAX_MESSAGE_CHARS)
        : `Coding Agent ${displayName} is currently unavailable.`;
    return {
      blocked: true,
      code: "coding_agent_unavailable",
      reason,
      instanceId,
      displayName,
      canInstall: record.canInstall === true,
      canLogin: record.canLogin === true,
      message,
    };
  }
  return (
    extractBlockedRecord(record.structuredContent, depth + 1) ??
    extractBlockedRecord(record.content, depth + 1) ??
    extractBlockedRecord(record.error, depth + 1)
  );
}

export function isDelegateTaskToolName(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  return (
    toolName === "delegate_task" ||
    toolName.endsWith("__delegate_task") ||
    toolName.endsWith(".delegate_task") ||
    toolName.endsWith("/delegate_task")
  );
}

/**
 * Parses and bounds a blocked `coding_agent_unavailable` payload from a `delegate_task` turn item
 * (works on both raw MCP tool outputs and wire-projected `{ isError: true, structuredContent }` items).
 */
export function readCodingAgentBlockedResult(
  item:
    | (Pick<OrchestrationV2TurnItem, "type"> & {
        readonly toolName?: string | null | undefined;
        readonly output?: unknown;
      })
    | undefined,
): CodingAgentBlockedPayload | null {
  if (!item || item.type !== "dynamic_tool" || !isDelegateTaskToolName(item.toolName)) {
    return null;
  }
  return extractBlockedRecord(item.output);
}
