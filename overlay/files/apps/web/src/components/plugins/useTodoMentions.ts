import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import type { ComposerCommandItem } from "../chat/ComposerCommandMenu";
import { isTodoId } from "@t3tools/shared/xtworkTodoReceipt";

type TodoMention = Extract<ComposerCommandItem, { type: "todo-item" }>;

export function useTodoMentions(environmentId: EnvironmentId, query: string | null) {
  const gt = useGT();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const localQuery =
    isElectron && environmentId === primaryEnvironmentId && query !== null ? query.trim() : null;
  const [result, setResult] = useState<{
    query: string;
    items: Array<{ id: string; title: string }>;
  } | null>(null);

  useEffect(() => {
    if (localQuery === null) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const token = await readDesktopPrimaryBearerToken();
        if (!token) return;
        const params = new URLSearchParams({ query: localQuery.slice(0, 200) });
        const response = await fetch(`/api/xtwork/todo?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Todo suggestions unavailable");
        const { items } = (await response.json()) as {
          items: Array<{ id: unknown; title: unknown }>;
        };
        if (!controller.signal.aborted) {
          setResult({
            query: localQuery,
            items: items.flatMap(({ id, title }) =>
              isTodoId(id) && typeof title === "string" ? [{ id, title }] : [],
            ),
          });
        }
      } catch {
        if (!controller.signal.aborted) setResult({ query: localQuery, items: [] });
      }
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [localQuery]);

  const items: TodoMention[] =
    localQuery !== null && result?.query === localQuery
      ? result.items.map(({ id, title }) => ({
          id: `todo:${id}`,
          type: "todo-item",
          todoId: id,
          label: title,
          description: gt("Todo"),
        }))
      : [];
  return items;
}
