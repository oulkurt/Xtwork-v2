export { mountAvatar } from "./dom/mount";
export type {
  AvatarOptions,
  AvatarOptions as MountOptions,
  MountedAvatar,
} from "./dom/mount";
export {
  getOpenBotAvatarEntry,
  OPEN_BOT_AVATAR_CATALOG,
  OPEN_BOT_AVATAR_PALETTE,
} from "./gallery";
export type { OpenBotAvatarCatalogEntry } from "./gallery";
export { DONE_TURN_S, MOODS, STATES } from "./motion";
export type { AvatarStateDefinition } from "./motion";
export { renderAvatarSvg } from "./render";
export type {
  AvatarDefinition,
  AvatarEyes,
  AvatarMood,
  AvatarState,
  RenderOptions,
  ValidationResult,
} from "./types";
export { validateAvatar } from "./validate";
