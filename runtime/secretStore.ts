// @effect-diagnostics nodeBuiltinImport:off extendsNativeError:off -- Facade re-exporting canonical OS SecretStore for model channels.
/**
 * Model-channel facade over the single canonical hardened OS SecretStore implementation
 * (`im-bridge/src/platform/secrets.ts`), bound by default to `app.xtwork.model-channels`.
 *
 * `scripts/prepare.mjs` copies `im-bridge/src/platform/secrets.ts` into
 * `.build/t3code/apps/server/src/xtwork/secretsCore.ts` and rewrites this import to
 * `./secretsCore.ts`, guaranteeing zero duplicate implementation lines while keeping
 * `im-bridge` 100% standalone for `scripts/build-desktop.mjs`.
 */

import {
  type CommandRunner,
  createSecretStore as createCanonicalSecretStore,
  defaultSecrets as canonicalDefaultSecrets,
  keychainSecrets as canonicalKeychainSecrets,
  linuxSecrets as canonicalLinuxSecrets,
  MODEL_CHANNELS_SECRET_NAMESPACE,
  type SecretStore,
  type SecretStoreFactoryOptions,
} from "../im-bridge/src/platform/secrets.ts";

export {
  ChannelCredentialFence,
  type CommandResult,
  type CommandRunner,
  type CredentialFenceLease,
  IM_BRIDGE_SECRET_NAMESPACE,
  memorySecrets,
  MODEL_CHANNELS_SECRET_NAMESPACE,
  type SecretReadResult,
  type SecretStore,
  SecretStoreError,
  type SecretStoreErrorCode,
  type SecretStoreFactoryOptions,
  type SecretStoreFailureKind,
  SecretStoreUnavailableError,
  windowsSecrets,
} from "../im-bridge/src/platform/secrets.ts";

export function keychainSecrets(
  run?: CommandRunner,
  service: string = MODEL_CHANNELS_SECRET_NAMESPACE,
): SecretStore {
  return canonicalKeychainSecrets(run, service);
}

export function linuxSecrets(
  run?: CommandRunner,
  service: string = MODEL_CHANNELS_SECRET_NAMESPACE,
): SecretStore {
  return canonicalLinuxSecrets(run, service);
}

export function createSecretStore(options: SecretStoreFactoryOptions = {}): SecretStore {
  return createCanonicalSecretStore({
    ...options,
    namespace: options.namespace ?? MODEL_CHANNELS_SECRET_NAMESPACE,
  });
}

export function defaultSecrets(
  windowsDpapiPath?: string,
  platform: NodeJS.Platform = process.platform,
  namespace: string = MODEL_CHANNELS_SECRET_NAMESPACE,
): SecretStore {
  return canonicalDefaultSecrets(windowsDpapiPath, platform, namespace);
}
