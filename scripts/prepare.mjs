import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  ? readdirSync(patchDir).filter((name) => name.endsWith(".patch")).sort()
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
  for (const file of ["gateway.ts", "bundledPiSettings.ts"]) cpSync(join(runtimeDir, file), join(target, file));
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

const publicDir = join(t3, "apps/web/public");
const manifestPath = join(publicDir, "manifest.webmanifest");
const manifest = readJson(manifestPath);
writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, name: brand.displayName, short_name: brand.name }, null, 2)}\n`);
for (const icon of ["favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png", "icon-192x192.png", "icon-512x512.png", "favicon.ico"]) {
  cpSync(join(overlay, "brand", "icons", icon), join(publicDir, icon));
}

console.log(`Prepared ${brand.displayName} from T3 ${lock.commit.slice(0, 8)} in ${t3}`);
