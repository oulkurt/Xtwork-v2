import { useEffect, useState } from "react";
import { DicesIcon } from "lucide-react";
import {
  OPEN_BOT_AVATAR_CATALOG,
  OPEN_BOT_AVATAR_PALETTE,
  type AvatarMood,
  type AvatarState,
} from "./openBotAvatar";
import type { NavigatorLang } from "./leaderTypes";
import {
  CELEBRATION_DURATION_MS,
  encodeNavigatorAvatar,
  isLightAvatarBodyColor,
  parseNavigatorAvatar,
  pickRandomNavigatorAvatar,
} from "./navigatorAvatarModel";
import { NavigatorBotAvatar } from "./NavigatorBotAvatar";

export interface NavigatorAvatarEditorProps {
  readonly value: string;
  readonly leaderId?: string;
  readonly usedShapeIds?: readonly string[];
  readonly lang: NavigatorLang;
  readonly onChange: (encoded: string) => void;
}

const PREVIEW_STATES: readonly {
  readonly id: string;
  readonly state: AvatarState;
  readonly mood: AvatarMood;
  readonly labelZh: string;
  readonly labelEn: string;
}[] = [
  { id: "idle", state: "idle", mood: "neutral", labelZh: "待机", labelEn: "Idle" },
  { id: "thinking", state: "thinking", mood: "neutral", labelZh: "思考", labelEn: "Thinking" },
  { id: "working", state: "working", mood: "neutral", labelZh: "执行", labelEn: "Working" },
  { id: "done", state: "done", mood: "happy", labelZh: "庆祝", labelEn: "Celebrate" },
];

export function NavigatorAvatarEditor({
  value,
  leaderId,
  usedShapeIds,
  lang,
  onChange,
}: NavigatorAvatarEditorProps) {
  const isEn = lang === "en";
  const resolved = parseNavigatorAvatar(value, leaderId);
  const lightBody = isLightAvatarBodyColor(resolved.color);
  const [previewKey, setPreviewKey] = useState<string>("idle");
  const [celebrateNonce, setCelebrateNonce] = useState<number>(0);
  const activePreview =
    PREVIEW_STATES.find((item) => item.id === previewKey) ?? PREVIEW_STATES[0]!;

  useEffect(() => {
    if (previewKey !== "done") return;
    const timer = setTimeout(() => {
      setPreviewKey("idle");
    }, CELEBRATION_DURATION_MS);
    return () => clearTimeout(timer);
  }, [previewKey, celebrateNonce]);

  function handleRandomize() {
    const picked = pickRandomNavigatorAvatar({
      currentShapeId: resolved.shapeId,
      currentColor: resolved.color,
      usedShapeIds,
    });
    onChange(picked.encoded);
  }

  return (
    <div
      data-testid="leader-avatar-editor"
      className="min-w-0 space-y-3 rounded-xl border border-border/70 bg-muted/25 p-3 text-xs"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            data-testid="leader-avatar-editor-preview-plate"
            data-light-contrast={lightBody ? "true" : "false"}
            className={`flex size-14 shrink-0 items-center justify-center rounded-xl border border-border/70 shadow-2xs ${
              lightBody ? "bg-foreground/[0.08] dark:bg-white/10" : "bg-background/85"
            }`}
          >
            <NavigatorBotAvatar
              avatar={resolved.encoded}
              leaderId={leaderId}
              state={activePreview.state}
              mood={activePreview.mood}
              replayNonce={activePreview.id === "done" ? celebrateNonce : undefined}
              size={48}
              followPointer
              testId="leader-avatar-editor-preview"
            />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="truncate font-medium text-foreground">
              {isEn ? resolved.entry.labelEn : resolved.entry.labelZh}
            </div>
            <div className="flex flex-wrap gap-1">
              {PREVIEW_STATES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`leader-avatar-preview-state-${item.id}`}
                  aria-pressed={activePreview.id === item.id}
                  onClick={() => {
                    setPreviewKey(item.id);
                    if (item.id === "done") {
                      setCelebrateNonce((prev) => prev + 1);
                    }
                  }}
                  className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                    activePreview.id === item.id
                      ? "bg-primary text-primary-foreground"
                      : "border border-border/70 bg-background/70 text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  {isEn ? item.labelEn : item.labelZh}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          type="button"
          data-testid="leader-avatar-randomize"
          onClick={handleRandomize}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <DicesIcon className="size-3.5" aria-hidden="true" />
          {isEn ? "Randomize avatar" : "随机生成头像"}
        </button>
      </div>

      <div className="min-w-0 space-y-1.5">
        <div className="text-[11px] text-muted-foreground">
          {isEn
            ? `Bot shapes (${OPEN_BOT_AVATAR_CATALOG.length})`
            : `动态 Bot 造型（${OPEN_BOT_AVATAR_CATALOG.length} 款）`}
        </div>
        <div
          data-testid="leader-avatar-shape-grid"
          className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(36px,1fr))] gap-1.5"
        >
          {OPEN_BOT_AVATAR_CATALOG.map((entry) => {
            const selected = entry.definition.id === resolved.shapeId;
            const label = isEn ? entry.labelEn : entry.labelZh;
            const thumbEncoded = encodeNavigatorAvatar(entry.definition.id, resolved.color);
            return (
              <button
                key={entry.definition.id}
                type="button"
                data-testid={`leader-avatar-shape-${entry.definition.id}`}
                aria-label={label}
                aria-pressed={selected}
                title={label}
                onClick={() => onChange(encodeNavigatorAvatar(entry.definition.id, resolved.color))}
                className={`flex h-9 w-full min-w-9 items-center justify-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selected
                    ? "border-primary bg-primary/10 ring-1 ring-primary"
                    : lightBody
                      ? "border-border/60 bg-foreground/[0.06] hover:border-border hover:bg-accent/60"
                      : "border-border/60 bg-background/70 hover:border-border hover:bg-accent/60"
                }`}
              >
                <NavigatorBotAvatar avatar={thumbEncoded} size={24} still />
              </button>
            );
          })}
        </div>
      </div>

      <div
        data-testid="leader-avatar-color-picker"
        className="flex min-w-0 flex-wrap items-center gap-2 pt-0.5"
      >
        <span className="text-[11px] text-muted-foreground">{isEn ? "Color" : "颜色"}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {OPEN_BOT_AVATAR_PALETTE.map((swatch, idx) => {
            const active = swatch.toLowerCase() === resolved.color.toLowerCase();
            return (
              <button
                key={swatch}
                type="button"
                data-testid={`leader-avatar-swatch-${idx}`}
                aria-label={swatch}
                aria-pressed={active}
                title={swatch}
                onClick={() => onChange(encodeNavigatorAvatar(resolved.shapeId, swatch))}
                style={{ backgroundColor: swatch }}
                className={`size-5 rounded-full border border-foreground/20 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
                }`}
              />
            );
          })}
          <label className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[11px] text-foreground hover:bg-accent">
            <span>{isEn ? "Custom" : "自定义"}</span>
            <input
              type="color"
              data-testid="leader-avatar-color-input"
              aria-label={isEn ? "Custom avatar color" : "自定义头像颜色"}
              value={resolved.color}
              onChange={(event) => onChange(encodeNavigatorAvatar(resolved.shapeId, event.target.value))}
              className="size-4 cursor-pointer border-0 bg-transparent p-0"
            />
          </label>
        </div>
      </div>
    </div>
  );
}
