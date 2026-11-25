/**
 * Dynamic registry for launch IM adapters (`feishu`, `wecom`, `wechat`).
 *
 * Adapted from earayu/Mingle (MIT, commit 006220e880d2134665ce2745ab6233f52c8eabe9),
 * src/channels/registry.ts. Loads each adapter dynamically if present on disk so core
 * tests and builds succeed standalone even before individual channel modules are present.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Channel, Platform } from "./channel.ts";

interface AdapterEntry {
  readonly platform: Platform;
  readonly dir: string;
  readonly file: string;
  readonly exportName: string;
}

const LAUNCH_ADAPTERS: readonly AdapterEntry[] = [
  { platform: "feishu", dir: "feishu", file: "feishu", exportName: "feishuChannel" },
  { platform: "wecom", dir: "wecom", file: "wecom", exportName: "wecomChannel" },
  { platform: "wechat", dir: "wechat", file: "wechat", exportName: "wechatChannel" },
];

export type ChannelMap = Partial<Record<Platform, Channel>>;

/**
 * Load all available channel adapters (`feishu`, `wecom`, `wechat`).
 * Works both when running raw TypeScript (Node 24+ strip-types) and compiled JS (`dist/`).
 */
export async function loadChannels(overrides?: ChannelMap): Promise<ChannelMap> {
  const channels: ChannelMap = {};
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

  for (const entry of LAUNCH_ADAPTERS) {
    if (overrides?.[entry.platform]) {
      channels[entry.platform] = overrides[entry.platform];
      continue;
    }
    const url = new URL(`./${entry.dir}/${entry.file}${ext}`, import.meta.url);
    if (!existsSync(fileURLToPath(url))) continue;
    const mod = (await import(url.href)) as Record<string, unknown>;
    const factory = mod[entry.exportName];
    if (typeof factory === "function") {
      channels[entry.platform] = (factory as () => Channel)();
    }
  }

  if (overrides) {
    for (const [platform, channel] of Object.entries(overrides)) {
      if (channel) channels[platform as Platform] = channel;
    }
  }

  return channels;
}
