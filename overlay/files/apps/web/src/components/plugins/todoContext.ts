import { isTodoId } from "@t3tools/shared/xtworkTodoReceipt";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import type { UnknownContextRecord } from "@t3tools/contracts";

export const todoContextKind = "todo-item";
const idPrefix = `${todoContextKind}_`;
export function todoContextReference(id: string, title: string) {
  return formatComposerContextReference({
    kind: todoContextKind,
    contextId: toKindScopedComposerContextId(todoContextKind, id),
    label: title,
  });
}

export function todoContextRecords(prompt: string): UnknownContextRecord[] {
  const records = new Map<string, UnknownContextRecord>();
  for (const reference of collectComposerContextReferences(prompt)) {
    if (reference.kind !== todoContextKind || !reference.contextId.startsWith(idPrefix)) continue;
    const id = reference.contextId.slice(idPrefix.length);
    if (!isTodoId(id) || records.has(reference.contextId)) continue;
    records.set(reference.contextId, {
      version: 1,
      kind: todoContextKind,
      contextId: reference.contextId,
      label: reference.label,
      payload: { id, title: reference.label },
    });
  }
  return [...records.values()];
}
