import { useAtomValue } from "@effect/atom-react";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  useEnvironments,
  useIssuesSupported,
  usePrimaryEnvironmentId,
  usePullRequestsSupported,
} from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { readIssueListPreferences } from "../issue/issueListPreferences";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const unavailableDeveloperSettings = Atom.make(null);

export function DeveloperFeaturesSettings() {
  const gt = useGT();
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentId =
    primaryEnvironmentId ??
    environments.find(
      (environment) =>
        environment.connection.phase === "connected" && environment.serverConfig !== null,
    )?.environmentId ??
    null;
  const enabled = useAtomValue(
    environmentId === null
      ? unavailableDeveloperSettings
      : serverEnvironment.settingsValueAtom(environmentId),
    (settings) => settings?.developerFeaturesEnabled ?? false,
  );
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();

  return (
    <SettingsSection id="developer-features" title={gt("Developer features")}>
      <SettingsRow
        title={gt("Show developer features")}
        control={
          <Switch
            aria-label={gt("Show developer features")}
            checked={enabled}
            disabled={!canWrite}
            onCheckedChange={(checked) => updateSettings({ developerFeaturesEnabled: checked })}
          />
        }
      />
      {enabled && pullRequestsSupported ? (
        <SettingsRow
          title={gt("Pull requests")}
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() })
              }
            >
              {gt("Open pull requests")}
            </Button>
          }
        />
      ) : null}
      {enabled && issuesSupported ? (
        <SettingsRow
          title={gt("Issues", { $context: "sidebar link to the list of issues" })}
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void navigate({ to: "/issues", search: readIssueListPreferences() })}
            >
              {gt("Open issues")}
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
