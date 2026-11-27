import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brandTranslationCatalog, buildBrandedMessageKeys } from "./brandCatalog.mjs";
import { brand, build, gitOutput, lock, overlay, readJson, root, run, source, t3 } from "./project.mjs";

function overlayFile(relativePath, replacements) {
  const path = join(t3, relativePath);
  let content = readFileSync(path, "utf8");
  for (const [before, after] of replacements) {
    if (!content.includes(before)) throw new Error(`Brand anchor missing in ${relativePath}: ${before}`);
    content = content.replaceAll(before, () => after);
  }
  writeFileSync(path, content);
}

mkdirSync(build, { recursive: true });
if (!existsSync(join(source, ".git"))) {
  run("git", ["init", "-q", source]);
  run("git", ["-C", source, "remote", "add", "origin", lock.repository]);
}
if (!gitOutput(source, "rev-parse", "--verify", `${lock.commit}^{commit}`)) {
  run("git", ["-C", source, "fetch", "--depth=1", "origin", lock.commit]);
}
if (!existsSync(t3)) {
  run("git", ["-C", source, "worktree", "add", "--detach", t3, lock.commit]);
} else {
  if (gitOutput(t3, "rev-parse", "--show-toplevel") !== t3) {
    throw new Error(`Expected a generated T3 worktree at ${t3}`);
  }
  run("git", ["-C", t3, "reset", "--hard", lock.commit]);
}

const patchDir = join(overlay, "patches");
const patches = existsSync(patchDir)
  ? readdirSync(patchDir).filter((name) => name.endsWith(".patch")).sort((left, right) => {
      const number = (name) => Number.parseInt(name.match(/^\d+/)?.[0] ?? "999999", 10);
      return number(left) - number(right) || left.localeCompare(right);
    })
  : [];
for (const patch of patches) {
  run("git", ["-C", t3, "apply", "--index", join(patchDir, patch)]);
}
for (const dir of ["files", "packages"]) {
  const from = join(overlay, dir);
  if (existsSync(from)) cpSync(from, dir === "files" ? t3 : join(t3, dir), { recursive: true });
}

const runtimeDir = join(root, "runtime");
if (existsSync(join(runtimeDir, "gateway.ts"))) {
  const target = join(t3, "apps/server/src/xtwork");
  mkdirSync(target, { recursive: true });
  const canonicalSecretsSrc = join(root, "im-bridge/src/platform/secrets.ts");
  cpSync(canonicalSecretsSrc, join(target, "secretsCore.ts"));
  const secretFacadeSource = readFileSync(join(runtimeDir, "secretStore.ts"), "utf8");
  const canonicalImport = '"../im-bridge/src/platform/secrets.ts"';
  if (!secretFacadeSource.includes(canonicalImport)) {
    throw new Error(`Expected canonical secrets import anchor in runtime/secretStore.ts`);
  }
  writeFileSync(
    join(target, "secretStore.ts"),
    secretFacadeSource.replaceAll(canonicalImport, '"./secretsCore.ts"'),
  );
  for (const file of [
    "oauthProxy.ts",
    "gateway.ts",
    "providerCatalog.ts",
    "companyAuth.ts",
    "oauthLoginFlows.ts",
    "channelManager.ts",
    "bundledPiSettings.ts",
    "bundledPiSettings.test.ts",
  ]) {
    cpSync(join(runtimeDir, file), join(target, file));
  }
}
cpSync(join(root, "plugins", "todo", "ui", "todo.html"), join(t3, "apps/web/src/components/plugins/todo.html"));

const quotedName = JSON.stringify(brand.name);
const quotedLabel = JSON.stringify(brand.stageLabel);
const quotedDisplayName = JSON.stringify(brand.displayName);
const support = JSON.stringify(brand.supportUrl);
const safeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
overlayFile("apps/web/src/branding.ts", [
  ['injectedDesktopAppBranding?.baseName ?? "T3 Code"', `injectedDesktopAppBranding?.baseName ?? ${quotedName}`],
  [
    `  injectedDesktopAppBranding?.stageLabel ??\n  resolveWebAppStageLabel({\n    hostedAppChannel: HOSTED_APP_CHANNEL,\n    development: import.meta.env.DEV,\n  });`,
    `  injectedDesktopAppBranding?.stageLabel ?? ${quotedLabel};`,
  ],
  ["  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });", `  ${quotedDisplayName};`],
  ['"https://t3.codes/download"', support],
  ['"https://t3.codes/mobile"', support],
  [
    'import {\n  formatAppDisplayName,\n  resolveHostedAppChannelLabel,\n  resolveWebAppStageLabel,\n} from "./branding.logic";',
    'import { resolveHostedAppChannelLabel } from "./branding.logic";',
  ],
]);
overlayFile("apps/web/vite.config.ts", [
  ['formatAppDisplayName({ baseName: "T3 Code", stageLabel })', quotedDisplayName],
  ['import { formatAppDisplayName, resolveWebAppStageLabel } from "./src/branding.logic";\n', ""],
  [
    "  let development = false;\n  return {\n    name: \"t3code:bootstrap-title\",\n    configResolved(config) {\n      // The same flag Vite exposes to the app as import.meta.env.DEV.\n      development = !config.isProduction;\n    },\n",
    '  return {\n    name: "t3code:bootstrap-title",\n',
  ],
  [
    "      const stageLabel = resolveWebAppStageLabel({\n        hostedAppChannel: configuredHostedAppChannel,\n        development,\n      });\n",
    "",
  ],
]);
overlayFile("apps/web/index.html", [
  ["T3 Code", safeHtml(brand.displayName)],
  ['href="/favicon.ico" sizes="48x48"', 'href="/favicon-32x32.png" type="image/png" sizes="32x32"'],
]);
const sidebarPath = "apps/web/src/components/sidebar/SidebarChrome.tsx";
const sidebarSource = readFileSync(join(t3, sidebarPath), "utf8");
const wordmark = sidebarSource.match(/      <T3Wordmark[\s\S]+?\n      <\/span>/)?.[0];
if (!wordmark) throw new Error(`Brand wordmark anchor missing in ${sidebarPath}`);
overlayFile(sidebarPath, [
  ['import { T3Wordmark } from "../T3Wordmark";', 'import { TodoPanel } from "../plugins/TodoPanel";\nimport { APP_BASE_NAME } from "../../branding";'],
  ['aria-label={gt("T3 Code home")}', 'aria-label={gt("Home")}'],
  [wordmark, '      <img src="/favicon-32x32.png" alt="" className="size-4 self-center" />\n      <span className={cn("truncate", onBackdrop && "text-white")}>{APP_BASE_NAME}</span>'],
  ['        <>\n          <SidebarUtilityItem\n            icon={<SettingsIcon />}', '        <>\n          {window.desktopBridge ? <TodoPanel /> : null}\n          <SidebarUtilityItem\n            icon={<SettingsIcon />}'],
]);
const welcomePath = "apps/web/src/components/onboarding/WelcomePage.tsx";
const welcomeSource = readFileSync(join(t3, welcomePath), "utf8");
const telemetryNotice = welcomeSource.match(/function TelemetryNotice\([\s\S]+?\n}\n\n(?=\/\/ Each part)/)?.[0];
if (!telemetryNotice) throw new Error(`Telemetry notice anchor missing in ${welcomePath}`);
overlayFile(welcomePath, [
  ["<T>Welcome to T3 Code</T>", `<T>Welcome to <Var>{${quotedDisplayName}}</Var></T>`],
  ['import { PRIVACY_POLICY_URL } from "../../legalLinks";\n', ""],
  ["managedTelemetryOffMessage, useManagedPolicy", "useManagedPolicy"],
  ["            <TelemetryNotice environmentId={environmentId} />\n", ""],
  [telemetryNotice, ""],
]);

overlayFile("apps/server/src/telemetry/AnalyticsService.ts", [
  ['import * as Exit from "effect/Exit";', 'import * as Exit from "effect/Exit";\nimport { constant } from "effect/Function";'],
  [
    "export const layer = Layer.effect(AnalyticsService, make);",
    "export const layer = Layer.succeed(AnalyticsService, AnalyticsService.of({\n" +
      "  record: constant(Effect.void),\n  flush: Effect.void,\n  recordOwners: constant(Effect.void),\n}));",
  ],
]);
overlayFile("apps/server/src/cli/config.ts", [
  ["otlpTracesUrl: traces?.url,", "otlpTracesUrl: undefined,"],
  ["otlpMetricsUrl: metrics?.url,", "otlpMetricsUrl: undefined,"],
  ["otlpLogsUrl: logs?.url,", "otlpLogsUrl: undefined,"],
]);

overlayFile("apps/web/src/legalLinks.ts", [
  ['"https://t3.codes/privacy-policy"', JSON.stringify(`https://github.com/${brand.repository}#数据与隐私`)],
]);
overlayFile("apps/web/src/lib/bootError.ts", [
  [
    'const DOWNLOAD_URL = "https://t3.codes/download";',
    `const DOWNLOAD_URL = ${JSON.stringify(`https://github.com/${brand.repository}/releases`)};`,
  ],
  [
    'const ISSUE_URL = "https://github.com/pingdotgg/t3code/issues/new";',
    `const ISSUE_URL = ${JSON.stringify(`${brand.supportUrl}/new`)};`,
  ],
]);
const settingsPath = "apps/web/src/components/settings/SettingsPanels.tsx";
const settingsSource = readFileSync(join(t3, settingsPath), "utf8");
const desktopTrack = settingsSource.match(/\{hasDesktopBridge \? \(\n        <SettingsRow\n          \{\.\.\.setting\("update-track"\)\}[\s\S]+?\) : selectedHostedAppChannel/)
  ?.[0];
const trackState = settingsSource.match(/  const nightlyDeniedBy =[\s\S]+?(?=  const handleButtonClick)/)?.[0];
const trackEnvironments = settingsSource.match(/  const \{ environments \} = useEnvironments\(\);[\s\S]+?(?=  const hasDesktopBridge)/)?.[0];
if (!desktopTrack || !trackState || !trackEnvironments) throw new Error(`Desktop update track anchor missing in ${settingsPath}`);
overlayFile(settingsPath, [
  [desktopTrack, "{selectedHostedAppChannel"],
  [trackState, "  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL;\n\n"],
  ['...(appOffTrack ? {} : { "up-to-date": gt("Up to Date") }),', '"up-to-date": gt("Up to Date"),'],
  [trackEnvironments, "\n"],
  ['  const [switchChannel, setSwitchChannel] = useState<DesktopUpdateChannel | null>(null);\n', ""],
  ['  const selectedUpdateChannel = updateState?.channel ?? "latest";\n', ""],
  ['    void checkProviderUpdates();\n', ""],
  ['      {switchChannel === null ? null : (\n        <UpdateTrackSwitchDialog channel={switchChannel} onClose={() => setSwitchChannel(null)} />\n      )}\n', ""],
  ['  type DesktopUpdateChannel,\n', ""],
  ['  managedUpdatesMessage,\n', ""],
  ['  useEnvironments,\n', ""],
  ['import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL }', 'import { HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL }'],
  ...settingsSource.split("\n")
    .filter((line) => /^import \{ (?:useAtomValue|desktopUpdateChannelOf|MobileAppSettingsRow|UpdateTrackSwitchDialog|environmentIdsKey|environmentSessionStatesAtom|useCheckProviderUpdates|canUpdateServer|useUpdateEverythingRun|awaitsTrackSwitch|isHostedByThisApp)\b/.test(line))
    .map((line) => [`${line}\n`, ""]),
  ['import { managedTelemetryOffMessage, usePrimaryManagedPolicy }', 'import { usePrimaryManagedPolicy }'],
  ['  const telemetryOff = managedTelemetryOffMessage(primaryPolicy, messages);\n', ""],
  ['description={\n            telemetryOff === undefined\n              ? gt("How we handle your data, including the anonymous usage data T3 Code collects.")\n              : gt("How we handle your data. {telemetryOff}", { telemetryOff })\n          }', 'description={gt("How we handle your data.")}'],
  ['        <MobileAppSettingsRow />\n', ""],
  ['See your agents, import projects, and set up your phone.', 'See your agents and import projects.'],
  ['Notices for dependencies, assets, and optional tools used by T3 Code.', 'Open-source notices for dependencies, assets, and optional tools.'],
]);

const webSource = join(t3, "apps/web/src");
const translationsDir = join(webSource, "i18n", "translations");
const brandSourceDirs = [
  webSource,
  join(t3, "packages/client-runtime/src"),
  join(t3, "packages/shared/src"),
];
const brandedMessageKeys = buildBrandedMessageKeys(readJson(join(translationsDir, "en.json")), brand.name);
for (const dir of brandSourceDirs) {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !/\.(?:tsx?|json)$/.test(entry.name) ||
      /(?:test|fixture|OpenSourceLicenses)\b/.test(entry.name)
    ) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    const original = readFileSync(path, "utf8");
    let branded = original;
    if (entry.parentPath === translationsDir) {
      const catalog = brandTranslationCatalog(JSON.parse(original), brand.name, brandedMessageKeys);
      branded = `${JSON.stringify(catalog, null, 2)}\n`;
    } else {
      if (/T3(?: |\r?\n[ \t]*)Code/.test(branded)) {
        branded = branded.replace(/T3(?: |\r?\n[ \t]*)Code/g, () => brand.name);
      }
      if (/T3(?: |\r?\n[ \t]*)Connect/.test(branded)) {
        branded = branded.replace(/T3(?: |\r?\n[ \t]*)Connect/g, () => `${brand.name} Connect`);
      }
    }
    if (branded !== original) writeFileSync(path, branded);
  }
}
overlayFile("packages/client-runtime/src/mcpApps/host.ts", [
  ['export const MCP_APP_HOST_NAME = "t3-code";', `export const MCP_APP_HOST_NAME = ${JSON.stringify(brand.slug)};`],
]);
overlayFile("apps/web/src/components/settings/AcpSessionManagementSection.tsx", [
  ["Resume agent-owned conversations as T3 threads.", "Resume agent-owned conversations as threads."],
]);
overlayFile("apps/web/src/components/settings/CodexSetupSection.tsx", [
  ["<T>Use T3 desktop for automatic return</T>", `<T>Use ${brand.name} desktop for automatic return</T>`],
]);
overlayFile("packages/shared/src/speechCopy.ts", [
  ["T3 requests zero data retention", `${brand.name} requests zero data retention`],
]);
overlayFile("apps/web/src/components/settings/DiagnosticsSettings.tsx", [
  ["T3 Server", `${brand.name} server`],
  ["T3 server", `${brand.name} server`],
]);
overlayFile("apps/web/src/components/settings/ResourceTelemetryDiagnostics.tsx", [
  ['msg("T3 process")', `msg(${JSON.stringify(`${brand.name} process`)})`],
  ["<T>T3 system footprint</T>", `<T>${brand.name} system footprint</T>`],
  ["known T3 operations", `known ${brand.name} operations`],
]);
overlayFile("apps/web/src/components/settings/LabsSettingsPanel.tsx", [
  ["T3 home folder", `${brand.name} home folder`],
]);
overlayFile("apps/web/src/components/settings/StorageSettings.tsx", [
  ["T3 home folder", `${brand.name} home folder`],
]);
overlayFile("apps/web/src/connection/platform.ts", [
  ["Restart the T3 server", `Restart the ${brand.name} server`],
]);
overlayFile("packages/client-runtime/src/state/device.ts", [
  ["This environment's T3 server", `This environment's ${brand.name} server`],
]);
overlayFile("packages/shared/src/htmlRender.ts", [
  ["T3 adds an overridable 8px html gutter", `${brand.name} adds an overridable 8px html gutter`],
]);
for (const path of [
  "apps/server/src/orchestration-v2/Orchestrator.ts",
  "apps/server/src/orchestration-v2/ProviderTurnStartService.ts",
  "apps/server/src/orchestration-v2/PullRequestWatchReactor.ts",
  "apps/server/src/orchestration-v2/UserFacingErrors.ts",
  "apps/server/src/orchestration-v2/RestartContinuation.ts",
  "apps/server/src/orchestration-v2/ContextHandoffService.ts",
  "apps/server/src/orchestration-v2/pullRequestWatch.ts",
  "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
  "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts",
  "apps/server/src/textGeneration/textGeneratorDrivers.ts",
  "apps/server/src/desktopUpdate/DesktopAppUpdate.ts",
  "apps/server/src/provider/AntigravityInstallation.ts",
  "apps/server/src/provider/AntigravityProvider.ts",
  "apps/server/src/provider/ClaudeProvider.ts",
  "apps/server/src/provider/CodexInstallation.ts",
  "apps/server/src/provider/CodexAuthCallbackPage.ts",
  "apps/server/src/provider/CodexChatGptAuth.ts",
  "apps/server/src/provider/ProviderAuthService.ts",
  "apps/server/src/provider/providerCompatibility.ts",
  "apps/server/src/provider/providerInstallation.ts",
  "apps/server/src/provider/providerMaintenanceRunner.ts",
  "apps/server/src/provider/acp/AntigravityAcpSupport.ts",
  "apps/server/src/persistence/Sqlite.ts",
  "apps/server/src/persistence/DatabaseMaintenance.ts",
  "apps/server/src/persistence/DatabaseStorage.ts",
  "apps/server/src/serverOwnership.ts",
  "apps/server/src/project/ManagedProjectFolders.ts",
  "apps/server/src/preview/ServerBrowserPage.ts",
  "apps/server/src/device/SshDeviceHost.ts",
  "apps/server/src/device/DeviceToolchain.ts",
  "apps/server/src/device/AgentDeviceShim.ts",
  "apps/server/src/cli/managedChatGptToken.ts",
  "apps/server/src/peer/PeerLinks.ts",
  "apps/server/src/mcp/McpHttpServer.ts",
  "apps/server/src/mcp/McpInvocationContext.ts",
  "apps/server/src/mcp/WorktreeMcpService.ts",
  "apps/server/src/mcp/AcpMcpStdioBridge.ts",
  "apps/server/src/mcp/toolkits/issues/tools.ts",
  "apps/server/src/mcp/toolkits/theme/tools.ts",
  "apps/server/src/mcp/toolkits/device/handlers.ts",
  "apps/server/src/cloud/cliAuthHtml.ts",
  "apps/server/src/cloud/relayResponse.ts",
  "apps/server/src/cloud/selfUpdate.ts",
  "apps/server/src/cloud/ConnectReachability.ts",
  "apps/server/src/cloud/bootService.ts",
  "apps/server/src/cloud/RelayClientLedger.ts",
  "apps/server/src/startupAccess.ts",
  "apps/server/src/serverRuntimeStartup.ts",
  "apps/server/src/background/KeepAwake.ts",
  "apps/server/src/auth/McpOAuth.ts",
  "apps/server/src/device/EasDeviceHost.ts",
  "apps/server/src/policy/policyTemplates.ts",
  "apps/server/src/binCli.ts",
  "apps/server/src/serviceLauncher.ts",
  "apps/server/src/cli/app.ts",
  "apps/server/src/cli/acpMcpBridge.ts",
  "apps/server/src/cli/automaticPort.ts",
  "apps/server/src/cli/config.ts",
  "apps/server/src/cli/doctor.ts",
  "apps/server/src/cli/environment.ts",
  "apps/server/src/cli/pair.ts",
  "apps/server/src/cli/policy.ts",
  "apps/server/src/cli/server.ts",
  "apps/server/src/cli/service.ts",
  "apps/server/src/cli/theme.ts",
  "apps/server/src/cli/thread.ts",
  "apps/server/src/cli/triage.ts",
  "apps/server/src/cli/uninstall.ts",
  "apps/server/src/cli/up.ts",
  "apps/server/src/cli/update.ts",
  "apps/server/src/cli/updateProgress.ts",
  "apps/server/src/triage/triagePrompt.ts",
  ".github/triage/PLAYBOOK.md",
  "packages/contracts/src/pullRequest.ts",
  "packages/contracts/src/device.ts",
  "packages/contracts/src/preview.ts",
  "packages/contracts/src/managedPolicy.ts",
  "packages/contracts/src/browserImport.ts",
  "packages/provider-opencode/src/server/OpenCodeServerLedger.ts",
  "packages/source-control-forgejo/src/server/ForgejoPullRequestProvider.ts",
  "packages/source-control-gitcafe/src/server/GitCafePullRequestProvider.ts",
  "packages/ssh/src/auth.ts",
  "packages/provider-core/src/server/orchestrationInstructions.ts",
  "packages/provider-core/src/server/runtimeInstructions.ts",
  "packages/provider-core/src/server/maintenanceResolver.ts",
  "packages/provider-pi/src/server/status.ts",
  "packages/provider-pi/src/server/mcpExtensionSource.ts",
  "packages/provider-pi/src/server/adapter.ts",
  "packages/provider-pi/src/server/mcpInjection.ts",
  "packages/provider-acp/src/server/adapter.ts",
  "packages/provider-acp/src/server/mcpOverAcpBridge.ts",
  "packages/provider-kiro/src/server/status.ts",
  "packages/provider-acp-registry/src/server/driver.ts",
  "packages/provider-cursor/src/server/adapter.ts",
  "packages/provider-cursor/src/server/auth.ts",
  "packages/provider-cursor/src/server/textGeneration.ts",
  "packages/provider-grok/src/server/status.ts",
  "packages/provider-fx/src/server/status.ts",
  "packages/provider-muse/src/server/adapter.ts",
  "packages/provider-muse/src/server/sdk.ts",
  "packages/provider-muse/src/server/status.ts",
  "packages/provider-muse/src/server/textGeneration.ts",
  "packages/provider-opencode/src/server/status.ts",
  "packages/provider-opencode/src/server/OpenCodeRuntime.ts",
  "packages/provider-opencode/src/server/versionProbe.ts",
  "packages/provider-opencode/src/settings.ts",
  "packages/provider-opencode/src/server/textGeneration.ts",
  "packages/provider-opencode/src/server/v2/textGeneration.ts",
  "packages/provider-opencode/src/server/v2/adapter.ts",
]) {
  overlayFile(path, [["T3 Code", brand.name]]);
}
overlayFile("apps/server/src/provider/CodexProvider.ts", [
  ["Codex is disabled in T3 Code settings.", `Codex is disabled in ${brand.name} settings.`],
  ['export const CODEX_CLIENT_TITLE = "T3 Code";', `export const CODEX_CLIENT_TITLE = ${quotedName};`],
]);
overlayFile("packages/provider-cursor/src/server/status.ts", [
  ["Cursor is disabled in T3 Code settings.", `Cursor is disabled in ${brand.name} settings.`],
  ["run in T3 Code.", `run in ${brand.name}.`],
]);
overlayFile("apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts", [
  ["T3 MCP tools are deferred:", "Workspace tools are deferred:"],
  ["T3 could not confirm Claude bypass permissions here", `${brand.name} could not confirm Claude bypass permissions here`],
]);
overlayFile("apps/server/src/mcp/McpInvocationContext.ts", [
  ["calling T3 thread", "calling thread"],
]);
overlayFile("apps/server/src/mcp/OrchestratorMcpService.ts", [
  ["inside a T3 thread.", "inside a thread."],
]);
overlayFile("apps/server/src/mcp/ThreadMetadataMcpService.ts", [
  ["inside a T3 thread.", "inside a thread."],
]);
overlayFile("apps/server/src/mcp/WorktreeMcpService.ts", [
  ["calling T3 thread", "calling thread"],
]);
overlayFile("apps/server/src/mcp/threadAccess.ts", [
  ["inside a T3 thread.", "inside a thread."],
]);
overlayFile("apps/server/src/mcp/toolkits/toolSearch/tools.ts", [
  ["Load T3 Code tools you do not have yet", "Load workspace tools you do not have yet"],
]);
overlayFile("apps/server/src/mcp/toolkits/issues/tools.ts", [
  ["inside a T3 thread", "inside a thread"],
]);
overlayFile("apps/server/src/mcp/toolkits/pullRequests/tools.ts", [
  ["inside a T3 thread.", "inside a thread."],
  ["T3 shows its status", `${brand.name} shows its status`],
  ["T3 wakes you on failed checks", `${brand.name} wakes you on failed checks`],
]);
overlayFile("apps/server/src/device/DeviceToolchain.ts", [
  ["the T3 server's PATH", `the ${brand.name} server's PATH`],
]);
overlayFile("apps/server/src/device/SimlockDeviceHost.ts", [
  ["answer T3 could not read.", `answer ${brand.name} could not read.`],
]);
overlayFile("apps/server/src/provider/AcpRegistrySessions.ts", [
  ["Could not create a T3 thread", "Could not create a thread"],
]);
overlayFile("apps/server/src/ws.ts", [
  ["Delete the imported T3 thread", "Delete the imported thread"],
]);
overlayFile("packages/contracts/src/orchestratorMcp.ts", [
  ["for a T3 tool; file for a command.", "for a workspace tool; file for a command."],
]);
overlayFile("packages/contracts/src/device.ts", [
  ["the T3 server's PATH", `the ${brand.name} server's PATH`],
]);
overlayFile("packages/provider-core/src/server/failure.ts", [
  ["T3 could not confirm whether conversation history reached the provider.", `${brand.name} could not confirm whether conversation history reached the provider.`],
]);
overlayFile("packages/provider-pi/src/server/adapter.ts", [
  ["outside an active T3 turn.", "outside an active turn."],
]);
overlayFile("packages/provider-acp/src/server/adapter.ts", [
  ["The active T3 runtime policy", "The active runtime policy"],
]);
overlayFile("packages/provider-muse/src/server/status.ts", [
  ["on this T3 server host", `on this ${brand.name} server host`],
]);
overlayFile("packages/provider-muse/src/server/textGeneration.ts", [
  ["on this T3 server host", `on this ${brand.name} server host`],
]);
overlayFile("packages/provider-acp/src/server/AcpSessionRuntime.ts", [
  ["Cannot identify the current T3 process group", `Cannot identify the current ${brand.name} process group`],
]);
overlayFile("apps/server/src/diagnostics/ProcessDiagnostics.ts", [
  ["Refusing to signal the T3 server process.", `Refusing to signal the ${brand.name} server process.`],
  ["is not a signalable T3 backend descendant.", `is not a signalable ${brand.name} backend descendant.`],
]);
overlayFile("apps/server/src/provider/CodexAuthCallbackPage.ts", [
  ["<strong>T3</strong> Code", `<strong>${safeHtml(brand.name)}</strong>`],
]);
overlayFile("apps/server/src/provider/CodexManagedRuntime.ts", [
  ["Restart T3 and retry.", `Restart ${brand.name} and retry.`],
]);
overlayFile("apps/server/src/provider/antigravityAuthSupport.ts", [
  ["The T3 runtime path cannot be used", `The ${brand.name} runtime path cannot be used`],
]);
overlayFile("apps/server/src/environment/ServerEnvironmentLabel.ts", [
  ['"T3 environment"', JSON.stringify(`${brand.name} environment`)],
]);
overlayFile("apps/server/src/preview/PreviewBrowserHost.ts", [
  ["T3 server is running as root", `${brand.name} server is running as root`],
  ["Run T3 as a nonroot user.", `Run ${brand.name} as a nonroot user.`],
  ["in the T3 server's environment", `in the ${brand.name} server's environment`],
  ["T3 Code's headless browser", `${brand.name}'s headless browser`],
  ["T3's browser", `${brand.name}'s browser`],
]);
overlayFile("apps/server/src/preview/PreviewBrowser.ts", [
  ["T3 could not install its headless browser", `${brand.name} could not install its headless browser`],
  ["T3 is installing its headless browser", `${brand.name} is installing its headless browser`],
  ["T3's headless browser", `${brand.name}'s headless browser`],
  ["T3's home directory", `${brand.name}'s home directory`],
]);
for (const path of [
  "apps/server/src/cloud/bootService.ts",
  "apps/server/src/serverOwnership.ts",
  "apps/server/src/cli/up.ts",
  "apps/server/src/cli/policy.ts",
  "apps/server/src/cli/service.ts",
  "apps/server/src/cli/update.ts",
  "apps/server/src/project/ManagedProjectFolders.ts",
  "apps/server/src/serviceLauncher.ts",
]) {
  overlayFile(path, [["T3 home", `${brand.name} home`]]);
}
for (const path of [
  "apps/server/src/auth/EnvironmentAuth.ts",
  "apps/server/src/auth/PairingGrantStore.ts",
  "apps/server/src/binCli.ts",
  "apps/server/src/cli/auth.ts",
  "apps/server/src/cli/connect.ts",
  "apps/server/src/cli/environment.ts",
  "apps/server/src/cli/pair.ts",
  "apps/server/src/cli/up.ts",
  "apps/server/src/cliAuthFormat.ts",
  "apps/server/src/cloud/CliTokenManager.ts",
  "apps/server/src/cloud/CloudLink.ts",
  "apps/server/src/cloud/ConnectReachability.ts",
  "apps/server/src/cloud/cliAuthHtml.ts",
  "apps/server/src/cloud/managedTunnelStartup.ts",
  "apps/server/src/cloud/relayResponse.ts",
  "apps/server/src/mcp/toolkits/orchestrator/tools.ts",
  "apps/server/src/policy/managedLimits.ts",
  "apps/server/src/policy/policyTemplates.ts",
  "apps/server/src/relay/AgentAwarenessRelay.ts",
  "apps/server/src/relay/HeldHooksWaker.ts",
  "apps/server/src/server.ts",
  "apps/server/src/telemetry/Identify.ts",
  "apps/server/src/triage/triagePrompt.ts",
  "packages/contracts/src/guestShare.ts",
  "packages/contracts/src/managedPolicy.ts",
  "packages/contracts/src/orchestratorMcp.ts",
  "packages/contracts/src/relay.ts",
]) {
  overlayFile(path, [["T3 Connect", `${brand.name} Connect`]]);
}
for (const path of [
  "apps/server/src/cli/up.ts",
  "apps/server/src/cli/connect.ts",
]) {
  overlayFile(path, [["your T3 account", `your ${brand.name} account`]]);
}
overlayFile("apps/server/src/preview/ServerBrowser.ts", [
  ["T3's browser", `${brand.name}'s browser`],
]);
overlayFile("apps/server/src/cli/browser.ts", [
  ["Restart the T3 server if browser tabs were already open.", `Restart the ${brand.name} server if browser tabs were already open.`],
  ["T3's browser", `${brand.name}'s browser`],
  ["T3's headless browser", `${brand.name}'s headless browser`],
]);
overlayFile("apps/server/src/cli/connect.ts", [
  ["The T3 server on this machine did not answer.", `The ${brand.name} server on this machine did not answer.`],
  ["Start T3 to ", `Start ${brand.name} to `],
  ["Restart T3 to ", `Restart ${brand.name} to `],
  ["The T3 relay client", `The ${brand.name} relay client`],
]);
overlayFile("apps/server/src/cloud/bootService.ts", [
  ["do not run T3 with sudo.", `do not run ${brand.name} with sudo.`],
]);
overlayFile("apps/server/src/cloud/ConnectReachability.ts", [
  ["reach the T3 server on this machine.", `reach the ${brand.name} server on this machine.`],
]);
overlayFile("packages/ssh/src/tunnel.ts", [
  ["A T3 server launch stopped", `A ${brand.name} server launch stopped`],
  ["Another T3 server launch has held", `Another ${brand.name} server launch has held`],
  ["Remote T3 server is still running", `Remote ${brand.name} server is still running`],
  ["A T3 server or boot service holds", `A ${brand.name} server or boot service holds`],
  ["Remote T3 server did not become ready", `Remote ${brand.name} server did not become ready`],
  ["Remote T3 server with PID", `Remote ${brand.name} server with PID`],
]);

const publicDir = join(t3, "apps/web/public");
const manifestPath = join(publicDir, "manifest.webmanifest");
const manifest = readJson(manifestPath);
writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, name: brand.displayName, short_name: brand.name }, null, 2)}\n`);
for (const icon of ["favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png", "icon-192x192.png", "icon-512x512.png", "favicon.ico"]) {
  cpSync(join(overlay, "brand", "icons", icon), join(publicDir, icon));
}

console.log(`Prepared ${brand.displayName} from T3 ${lock.commit.slice(0, 8)} in ${t3}`);
