import { ListTodoIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PluginModalHost } from "./PluginModalHost";
import todoView from "./todo.html?raw";
import { openTodoPanelEvent } from "./TodoActionReceipt";

const channel = "xtwork:todo";

export function TodoPanel() {
  const [open, setOpen] = useState(false);
  const iframe = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let active = true;

    async function receive(event: MessageEvent) {
      const frame = iframe.current?.contentWindow;
      const request = event.data;
      if (
        !frame ||
        event.source !== frame ||
        event.origin !== "null" ||
        request?.channel !== channel ||
        !Number.isSafeInteger(request.id)
      )
        return;

      const method = request.method;
      const creating = method === "create";
      const listing = method === "list";
      const mutating =
        creating || method === "update" || method === "complete" || method === "delete";
      if (!creating && !listing && !mutating) return;
      const title = typeof request.title === "string" ? request.title.trim() : "";
      if (creating && (title.length < 1 || title.length > 200)) return;
      const id = typeof request.todoId === "string" ? request.todoId : "";
      if (!creating && !listing && !id) return;
      const offset = request.offset ?? 0;
      if (listing && (!Number.isInteger(offset) || offset < 0 || offset > 1000)) return;
      const target = frame;

      function reply(result: { value?: unknown; error?: string }) {
        if (active && target === iframe.current?.contentWindow) {
          target.postMessage({ channel, id: request.id, ...result }, "*");
        }
      }

      try {
        const token = await readDesktopPrimaryBearerToken();
        if (!token) return reply({ error: "请先连接本机服务" });
        const headers = new Headers({ Authorization: `Bearer ${token}` });
        if (mutating) headers.set("Content-Type", "application/json");
        const url = listing
          ? `/api/xtwork/todo?filter=${encodeURIComponent(typeof request.filter === "string" ? request.filter : "all")}&offset=${offset}&fullNotes=${request.fullNotes === true ? "true" : "false"}`
          : "/api/xtwork/todo";
        const body = creating
          ? {
              title,
              ...(typeof request.notes === "string" ? { notes: request.notes } : {}),
              ...(typeof request.group === "string" ? { group: request.group } : {}),
              ...(typeof request.due === "string" ? { due: request.due } : {}),
              ...(typeof request.time === "string" ? { time: request.time } : {}),
              ...(typeof request.priority === "string" ? { priority: request.priority } : {}),
            }
          : method === "update"
            ? {
                id,
                ...(typeof request.title === "string" ? { title: request.title } : {}),
                ...(typeof request.notes === "string" ? { notes: request.notes } : {}),
                ...(typeof request.group === "string" ? { group: request.group } : {}),
                ...(typeof request.due === "string" ? { due: request.due } : {}),
                ...(typeof request.time === "string" ? { time: request.time } : {}),
                ...(typeof request.priority === "string" ? { priority: request.priority } : {}),
              }
            : method === "complete"
              ? {
                  action: "complete",
                  id,
                  ...(typeof request.done === "boolean" ? { done: request.done } : {}),
                }
              : { id };
        const response = await fetch(url, {
          headers,
          ...(mutating
            ? {
                method: creating ? "POST" : method === "delete" ? "DELETE" : "PATCH",
                body: JSON.stringify(body),
              }
            : {}),
        });
        const result = await response.json();
        if (!response.ok) return reply({ error: String(result.error || "待办服务暂不可用") });
        reply({ value: result });
      } catch (error) {
        reply({ error: error instanceof Error ? error.message : "待办服务暂不可用" });
      }
    }

    const openPanel = () => setOpen(true);
    window.addEventListener(openTodoPanelEvent, openPanel);
    window.addEventListener("message", receive);
    return () => {
      active = false;
      window.removeEventListener(openTodoPanelEvent, openPanel);
      window.removeEventListener("message", receive);
    };
  }, []);

  return (
    <>
      <SidebarMenuItem className="shrink-0">
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuButton aria-label="待办" size="icon" onClick={() => setOpen(true)}>
                <ListTodoIcon />
              </SidebarMenuButton>
            }
          />
          <TooltipPopup side="top">待办</TooltipPopup>
        </Tooltip>
      </SidebarMenuItem>
      <PluginModalHost open={open} label="待办" title="待办" onOpenChange={setOpen}>
        <iframe
          ref={iframe}
          title="待办事项"
          sandbox="allow-scripts allow-forms"
          srcDoc={todoView}
          className="min-h-0 w-full flex-1 border-0"
          onLoad={() =>
            iframe.current?.contentWindow?.postMessage(
              {
                channel,
                theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
              },
              "*",
            )
          }
        />
      </PluginModalHost>
    </>
  );
}
