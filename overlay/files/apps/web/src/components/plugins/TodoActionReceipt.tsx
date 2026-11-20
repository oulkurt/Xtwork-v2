import { useState } from "react";
import { useGT } from "gt-react";
import { ListTodoIcon } from "lucide-react";
import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { Button } from "../ui/button";
import type { TodoCreateReceipt } from "@t3tools/shared/xtworkTodoReceipt";

export const openTodoPanelEvent = "xtwork:open-todo-panel";

export function TodoActionReceipt({ item }: { item: TodoCreateReceipt }) {
  const gt = useGT();
  const [status, setStatus] = useState<"ready" | "pending" | "undone" | "changed" | "failed">(
    "ready",
  );

  async function undo() {
    setStatus("pending");
    try {
      const token = await readDesktopPrimaryBearerToken();
      if (!token) throw new Error("Todo service unavailable");
      const response = await fetch("/api/xtwork/todo", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, undoCreatedAt: item.createdAt }),
      });
      if (!response.ok) throw new Error("Todo undo failed");
      const result = (await response.json()) as { deleted?: boolean };
      setStatus(result.deleted === true ? "undone" : "changed");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-1.5 text-sm">
      <ListTodoIcon aria-hidden className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 break-words" role="status">
        {status === "undone"
          ? gt("Todo undone: {title}", { title: item.title })
          : status === "changed"
            ? gt("This todo has changed: {title}", { title: item.title })
            : status === "failed"
              ? gt("Could not undo todo: {title}", { title: item.title })
              : gt("Added to todos: {title}", { title: item.title })}
      </span>
      {status === "undone" ? null : (
        <div className="ms-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => window.dispatchEvent(new Event(openTodoPanelEvent))}
          >
            {gt("Open todos")}
          </Button>
          {status === "changed" ? null : (
            <Button
              variant="ghost"
              size="xs"
              disabled={status === "pending"}
              onClick={() => void undo()}
            >
              {gt("Undo")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
