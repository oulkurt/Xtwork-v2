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
  native.on("xtwork:fullscreen", (value) => { fullscreen = value; });

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
    preview: {
      setForwardedShortcuts: noop, createTab: noop, closeTab: noop, registerWebview: noop,
      navigate: unavailable, goBack: noop, goForward: noop, refresh: noop, stopLoading: noop,
      zoomIn: noop, zoomOut: noop, resetZoom: noop, setZoomFactor: noop, hardReload: noop,
      setColorScheme: noop, setAudioMuted: noop, findInPage: noop, stopFindInPage: noop,
      setShown: noop, setCaptureDrawn: noop, openDevTools: noop, clearCookies: noop, clearCache: noop,
      getPreviewConfig: unavailable, listBrowserImportSources: empty, importBrowserCookies: unavailable,
      setAnnotationTheme: noop, setAnnotationSendEnabled: noop,
      annotationVoice: { onEvent: onUnavailable, update: noop }, pickElement: nothing,
      cancelPickElement: noop, captureScreenshot: unavailable, revealArtifact: noop,
      copyArtifactToClipboard: noop, pictureInPicture: { open: unavailable, close: noop },
      recording: { onInput: onUnavailable, startScreencast: unavailable, stopScreencast: noop, save: unavailable },
      onStateChange: onUnavailable, onPointerEvent: onUnavailable, onOpenLink: onUnavailable,
      onFindResult: onUnavailable,
    },
  }) });

  const titlebar = new CSSStyleSheet();
  titlebar.replaceSync(`
    .drag-region { --app-region: drag; }
    [class~="[-webkit-app-region:no-drag]"] { --app-region: no-drag; }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, titlebar];

  call("GetWindowCornerRadius").then((radius) => {
    if (radius > 0) {
      titlebar.insertRule(`:root { --xtwork-window-radius: ${radius}px; }`);
    }
  }).catch(() => {});
}
