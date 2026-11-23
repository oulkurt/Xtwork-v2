import { ListTodoIcon } from "lucide-react";

export function TodoContextChip({ label }: { label: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 align-middle text-sm">
      <ListTodoIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}
