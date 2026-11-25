import { createFileRoute } from "@tanstack/react-router";

import { RemoteImSettings } from "../components/settings/RemoteImSettings";

function SettingsRemoteConnectionsRoute() {
  return <RemoteImSettings />;
}

export const Route = createFileRoute("/_chat/settings/remote-connections")({
  component: SettingsRemoteConnectionsRoute,
});
