import type { ReactNode } from "react";

import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";

type PluginModalHostProps = {
  open: boolean;
  label: string;
  title: string;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
};

export function PluginModalHost({
  open,
  label,
  title,
  onOpenChange,
  children,
}: PluginModalHostProps) {
  if (!open) return null;

  return (
    <AppRouteModal label={label} onClose={() => onOpenChange(false)}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-[calc(var(--workspace-controls-top)+var(--workspace-topbar-height))]">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b ps-5 pe-2">
          <h1 className="min-w-0 truncate text-sm font-medium">{title}</h1>
          <div className="ms-auto flex shrink-0 items-center">
            <AppRouteModalClose />
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </AppRouteModal>
  );
}
