import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

export const isTodoId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9-]{1,100}$/u.test(value);

export function readTodoCreateReceipt(item: OrchestrationV2TurnItem | undefined) {
  if (
    item?.type !== "dynamic_tool" ||
    item.status !== "completed" ||
    item.toolName !== "mcp__t3-code__todo__create" ||
    typeof item.output !== "object" ||
    item.output === null ||
    !("structuredContent" in item.output)
  )
    return null;
  const result = item.output.structuredContent;
  if (
    typeof result !== "object" ||
    result === null ||
    !("id" in result) ||
    !isTodoId(result.id) ||
    !("title" in result) ||
    typeof result.title !== "string" ||
    !("createdAt" in result) ||
    typeof result.createdAt !== "string" ||
    ("undone" in result && result.undone === true)
  )
    return null;
  return { id: result.id, title: result.title, createdAt: result.createdAt };
}

export type TodoCreateReceipt = NonNullable<ReturnType<typeof readTodoCreateReceipt>>;
