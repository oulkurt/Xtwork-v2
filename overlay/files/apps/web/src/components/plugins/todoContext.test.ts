import { expect, it } from "vite-plus/test";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { todoContextRecords, todoContextReference } from "./todoContext";

it("sends only retained todo references with their exact IDs", () => {
  const reference = todoContextReference("req-12", "发季度报告");
  const text = `Summarize ${reference} and ${reference}`;
  const records = todoContextRecords(text);
  expect(records).toHaveLength(1);
  const projected = projectComposerContextForProvider({ text, records });
  expect(projected).toContain('kind="todo-item" id="todo-item_req-12"');
  expect(projected).toContain('{"id":"req-12","title":"发季度报告"}');
  expect(todoContextRecords("Summarize")).toEqual([]);
});
