import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarMenu, SidebarProvider } from "../ui/sidebar";
import { TodoPanel } from "./TodoPanel";

vi.mock(import("../../environments/primary/desktopAuth"), () => ({
  readDesktopPrimaryBearerToken: async () => "test-token",
}));

it("creates and edits todos through forms inside the sandboxed panel", async () => {
  let items: Array<{ id: string; title: string }> = [];
  const fetch = window.fetch.bind(window);
  using request = vi.spyOn(window, "fetch").mockImplementation(async (url, options) => {
    if (!String(url).startsWith("/api/xtwork/todo")) return fetch(url, options);
    if (options?.method === "POST" || options?.method === "PATCH") {
      const { title } = JSON.parse(String(options.body));
      const item = { id: "todo-1", title };
      items = [item];
      return Response.json(item);
    }
    return Response.json({ items, nextOffset: null });
  });

  await using screen = await render(
    <SidebarProvider>
      <SidebarMenu>
        <TodoPanel />
      </SidebarMenu>
    </SidebarProvider>,
  );
  await screen.getByRole("button", { name: "待办", exact: true }).click();
  const panel = page.frameLocator(page.getByTitle("待办事项"));

  const title = panel.getByRole("textbox", { name: "待办内容" });
  await title.fill("Draft");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("/api/xtwork/todo", expect.objectContaining({ method: "POST" })),
  );

  await panel.getByRole("button", { name: "编辑" }).click();
  await panel.getByRole("textbox", { name: "标题" }).fill("Ready");
  await panel.getByRole("button", { name: "保存" }).click();
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("/api/xtwork/todo", expect.objectContaining({ method: "PATCH" })),
  );
});
