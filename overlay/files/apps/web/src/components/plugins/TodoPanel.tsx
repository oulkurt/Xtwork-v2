import { ListTodoIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import todoView from "./todo.html?raw";

const channel = "xtwork:todo";

export function TodoPanel() {
  const [open, setOpen] = useState(false);
  const iframe = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let active = true;

    async function receive(event: MessageEvent) {
      const frame = iframe.current?.contentWindow;
      const request = event.data;
      if (!frame || event.source !== frame || event.origin !== "null" ||
          request?.channel !== channel || !Number.isSafeInteger(request.id)) return;

      const title = typeof request.title === "string" ? request.title.trim() : "";
      const creating = request.method === "create";
      if (request.method !== "list" && (!creating || title.length < 1 || title.length > 200)) return;

      function reply(result: { value?: unknown; error?: string }) {
        if (active && frame === iframe.current?.contentWindow) {
          frame.postMessage({ channel, id: request.id, ...result }, "*");
        }
      }

      try {
        const token = await readDesktopPrimaryBearerToken();
        if (!token) throw new Error("请先连接本机服务");
        const headers = new Headers({ Authorization: `Bearer ${token}` });
        if (creating) headers.set("Content-Type", "application/json");
        const response = await fetch("/api/xtwork/todo", {
          headers,
          ...(creating ? { method: "POST", body: JSON.stringify({ title }) } : {}),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "待办服务暂不可用");
        reply({ value: result });
      } catch (error) {
        reply({ error: error instanceof Error ? error.message : "待办服务暂不可用" });
      }
    }

    window.addEventListener("message", receive);
    return () => {
      active = false;
      window.removeEventListener("message", receive);
    };
  }, []);

  return (
    <>
      <SidebarMenuItem className="shrink-0">
        <Tooltip>
          <TooltipTrigger render={
            <SidebarMenuButton aria-label="待办" size="icon" onClick={() => setOpen(true)}>
              <ListTodoIcon />
            </SidebarMenuButton>
          } />
          <TooltipPopup side="top">待办</TooltipPopup>
        </Tooltip>
      </SidebarMenuItem>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup>
          <SheetHeader><SheetTitle>待办</SheetTitle></SheetHeader>
          <iframe
            ref={iframe}
            title="待办事项"
            sandbox="allow-scripts"
            srcDoc={todoView}
            className="min-h-0 w-full flex-1 border-0"
            onLoad={() => iframe.current?.contentWindow?.postMessage({
              channel,
              theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
            }, "*")}
          />
        </SheetPopup>
      </Sheet>
    </>
  );
}
