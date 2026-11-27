// Injected by MyGo as a function before the T3 page's scripts.
(init) => {
  if (window.top !== window || location.origin !== init.origin || !window.mygo) return;

  const native = window.mygo;
  const call = (method, ...args) => native.call(`Desktop.${method}`, ...args);
  const noop = async () => {};
  const no = async () => false;
  const nothing = async () => null;
  const empty = async () => [];
  const unavailable = async () => { throw new Error("This feature is unavailable in the desktop shell."); };
  const onUnavailable = () => () => {};
  const state = Object.freeze({
    id: "primary",
    label: init.branding.displayName,
    httpBaseUrl: init.origin,
    wsBaseUrl: init.wsOrigin,
    bootstrapToken: init.bootstrapToken,
  });
  const inactiveWsl = async () => ({
    enabled: false, distro: null, available: false, wslOnly: false, distros: [], preflightError: null,
  });
  const localOnly = async () => ({
    mode: "local-only", endpointUrl: null, advertisedHost: null,
    tailscaleServeEnabled: false, tailscaleServePort: 443,
  });
  const unsupportedCli = async () => ({ supported: false, installedPath: null, onPath: false });
  let fullscreen = false;
  let cornerRadiusRequest = 0;
  let resizeSyncTimer = 0;
  let pendingCornerRadiusSync = false;
  const scheduleCornerRadiusSyncOnReady = () => {
    if (pendingCornerRadiusSync || typeof document.addEventListener !== "function") return;
    pendingCornerRadiusSync = true;
    document.addEventListener("DOMContentLoaded", () => {
      pendingCornerRadiusSync = false;
      syncWindowCornerRadius();
    }, { once: true });
  };
  const applyWindowCornerRadius = (radius) => {
    if (!document.documentElement) {
      scheduleCornerRadiusSyncOnReady();
      return;
    }
    if (fullscreen) {
      document.documentElement.style.setProperty("--xtwork-window-radius", "0px");
    } else if (typeof radius === "number" && Number.isFinite(radius) && radius >= 0) {
      document.documentElement.style.setProperty("--xtwork-window-radius", `${radius}px`);
    } else {
      document.documentElement.style.removeProperty("--xtwork-window-radius");
    }
  };
  const syncWindowCornerRadius = () => {
    if (resizeSyncTimer) {
      clearTimeout(resizeSyncTimer);
      resizeSyncTimer = 0;
    }
    if (!document.documentElement) {
      scheduleCornerRadiusSyncOnReady();
      return;
    }
    const requestId = ++cornerRadiusRequest;
    if (fullscreen) {
      applyWindowCornerRadius(0);
      return;
    }
    call("GetWindowCornerRadius").then((radius) => {
      if (requestId !== cornerRadiusRequest) return;
      applyWindowCornerRadius(radius);
    }).catch(() => {});
  };
  native.on("xtwork:fullscreen", (value) => { fullscreen = value; syncWindowCornerRadius(); });
  native.on("xtwork:window-state", () => { syncWindowCornerRadius(); });
  if (typeof window.addEventListener === "function") {
    window.addEventListener("resize", () => {
      if (resizeSyncTimer) clearTimeout(resizeSyncTimer);
      resizeSyncTimer = setTimeout(() => {
        resizeSyncTimer = 0;
        syncWindowCornerRadius();
      }, 50);
    });
  }

  Object.defineProperty(window, "desktopBridge", { value: Object.freeze({
    xtwork: true,
    getAppBranding: () => ({ ...init.branding }),
    getRelayTelemetryEnabled: () => false,
    getClientPlatform: () => init.platform,
    getBackendLogPath: () => init.backendLogPath ?? null,
    getSystemLocale: () => init.preferredLanguages[0] ?? navigator.language,
    getPreferredSystemLanguages: () => init.preferredLanguages.slice(),
    getPathForFile: () => "",
    revealWindow: () => call("RevealWindow"),
    setNotificationBadge: ({ count }) => call("GiveBadgeCount", count),
    onNotificationBadgeClear: onUnavailable,
    onTrackpadScrollBegin: onUnavailable,
    onTrackpadScrollEnd: onUnavailable,
    getLocalEnvironmentBootstraps: () => [state],
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBearerToken: () => call("GetLocalEnvironmentBearerToken"),
    getClientSettings: async () => JSON.parse(await call("ReadClientState", "client-settings") ?? "null"),
    setClientSettings: (settings) => call("WriteClientState", "client-settings", JSON.stringify(settings)),
    getConnectionCatalog: () => call("ReadClientState", "connection-catalog"),
    setConnectionCatalog: async (catalog) => {
      await call("WriteClientState", "connection-catalog", catalog);
      return true;
    },
    pickFolder: (options = {}) => call("PickFolder", options),
    toLocalBackendPath: nothing,
    pickProjectFavicon: nothing,
    pickThemeFiles: nothing,
    setTheme: (theme) => call("SetTheme", theme),
    showContextMenu: (items, point) => call("ShowContextMenu", items, point ?? null),
    startFileDrag: no,
    openExternal: (url) => call("OpenExternal", url),
    readMedia: nothing,
    openSystemSettings: no,
    checkSystemPermission: no,
    probeRemoteEditors: empty,
    pasteAsText: noop,
    onMenuAction: onUnavailable,
    onQuitShortcut: onUnavailable,
    getWindowFullscreenState: () => fullscreen,
    onWindowFullscreenStateChange: (listener) => native.on("xtwork:fullscreen", listener),
    getWindowZoomFactor: () => 1,
    getUpdateState: () => call("GetUpdateState"),
    setUpdateChannel: () => call("GetUpdateState"),
    checkForUpdate: () => call("CheckForUpdate"),
    downloadUpdate: () => call("DownloadUpdate"),
    installUpdate: (version) => call("InstallUpdate", version ?? ""),
    onUpdateState: (listener) => native.on("xtwork:update", listener),

    // T3 mounts desktop coordinators at startup. Report absent native capabilities in their contracts.
    discoverSshHosts: empty,
    resolveSshHost: unavailable,
    ensureSshEnvironment: unavailable,
    disconnectSshEnvironment: noop,
    fetchSshEnvironmentDescriptor: unavailable,
    bootstrapSshBearerSession: unavailable,
    fetchSshSessionState: unavailable,
    onSshPasswordPrompt: onUnavailable,
    onSshPasswordPromptSettled: onUnavailable,
    resolveSshPasswordPrompt: noop,
    getServerExposureState: localOnly,
    setServerExposureMode: localOnly,
    setTailscaleServeEnabled: localOnly,
    getAdvertisedEndpoints: empty,
    getWslState: inactiveWsl,
    setWslBackendEnabled: inactiveWsl,
    setWslDistro: inactiveWsl,
    setWslOnly: inactiveWsl,
    requestSnapShotPermissions: noop,
    getSnapShotState: async () => ({
      mode: "unavailable", shortcut: { kind: "both-shift-keys" }, shortcutRegistered: false,
      shortcutMessage: null, message: null,
    }),
    setupSnapShot: unavailable,
    previewSnapShotConfig: nothing,
    applySnapShotConfig: unavailable,
    checkSnapShotShortcut: async () => ({ available: false, message: null }),
    setSnapShotShortcutSuppressed: noop,
    listPendingSnapShots: empty,
    readSnapShot: unavailable,
    setSnapShotAnimationDestination: noop,
    dismissSnapShotAnimation: noop,
    acknowledgeSnapShot: noop,
    onSnapShotEvent: onUnavailable,
    receiveProviderAuthCallback: unavailable,
    cancelProviderAuthCallback: noop,
    cliCommand: { getState: unsupportedCli, install: unsupportedCli, uninstall: unsupportedCli, addToPath: unsupportedCli },
    webLinks: { setReady: noop, onOpen: onUnavailable },
    appActivation: { setReady: noop, complete: noop, onRequest: onUnavailable },
  }) });

  const titlebar = new CSSStyleSheet();
  titlebar.replaceSync(`
    .drag-region { --app-region: drag; }
    .drag-region :is(button, input, textarea, select, a), [class~="[-webkit-app-region:no-drag]"] { --app-region: no-drag; }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, titlebar];

  syncWindowCornerRadius();
}
