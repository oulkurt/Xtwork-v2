import { createFileRoute } from "@tanstack/react-router";

import { XtworkModelChannelsSettings } from "../components/settings/XtworkModelChannelsSettings";

function SettingsChannelsRoute() {
  return <XtworkModelChannelsSettings />;
}

export const Route = createFileRoute("/_chat/settings/channels")({
  component: SettingsChannelsRoute,
});
