import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { EllipsisIcon } from "lucide-react";
import { REMOTE_IM_CARD_DESCRIPTION, REMOTE_IM_CHANNELS, type RemoteImChannel } from "./remoteImThemes";
import "./remoteImHoloCard.css";

const EDGE_SLICE_COUNT = 10;
const CARD_THICKNESS_PX = 10;
const EDGE_Z_OFFSETS = Array.from(
  { length: EDGE_SLICE_COUNT },
  (_, index) => -CARD_THICKNESS_PX / 2 + ((index + 0.5) / EDGE_SLICE_COUNT) * CARD_THICKNESS_PX,
);

const TILT_STIFFNESS = 140;
const TILT_DAMPING = 15;
const LIGHT_STIFFNESS = 160;
const LIGHT_DAMPING = 2 * Math.sqrt(LIGHT_STIFFNESS);
const FLIP_STIFFNESS = 70;
const FLIP_DAMPING = 11;
const DEG_TO_RAD = Math.PI / 180;

export interface RemoteImHoloCardProps {
  readonly channel: RemoteImChannel;
  readonly flipped: boolean;
  readonly statusBadge: ReactNode;
  readonly onFlipQr: () => void;
  readonly onFlipManual?: () => void;
  readonly onFlipFront: () => void;
  readonly backContent: ReactNode;
}

function FeishuEmblem() {
  return (
    <svg
      viewBox="0 0 88 88"
      className="size-[76px] drop-shadow-[0_10px_20px_rgb(16_74_204_/_0.32)]"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="xtwork-feishu-cyan" x1="12%" y1="10%" x2="88%" y2="85%">
          <stop offset="0%" stopColor="#00E8C6" />
          <stop offset="100%" stopColor="#00BFA8" />
        </linearGradient>
        <linearGradient id="xtwork-feishu-blue" x1="15%" y1="18%" x2="88%" y2="92%">
          <stop offset="0%" stopColor="#4A89FF" />
          <stop offset="100%" stopColor="#1B57F0" />
        </linearGradient>
        <linearGradient id="xtwork-feishu-fold" x1="20%" y1="0%" x2="80%" y2="100%">
          <stop offset="0%" stopColor="#19C5FF" />
          <stop offset="100%" stopColor="#2A6EFF" />
        </linearGradient>
      </defs>
      <path
        d="M21 15.5c15.5 6.8 29.8 16.5 41.2 28.4 2.1 2.2 1.2 5.9-1.7 6.8L38.2 57.5c-2.5.8-5.1-1.1-5.1-3.8V36.4L18.4 21.8c-2.2-2.2-.3-7.6 2.6-6.3Z"
        fill="url(#xtwork-feishu-cyan)"
      />
      <path
        d="M17.5 29.2c0-2.5 2.7-4 4.8-2.6 15.3 10.3 31.9 15.8 49.4 16.5 2.8.1 4.2 3.4 2.3 5.5-10.2 11.4-24 19.8-39.8 23.7-9.6 2.4-16.7-5-16.7-14.9V29.2Z"
        fill="url(#xtwork-feishu-blue)"
      />
      <path
        d="M33.1 36.4c9.1 5.2 18.9 9.1 29.3 11.4-7.4 6.2-16 10.8-25.2 13.7-2.5.8-4.1-1-4.1-3.4V36.4Z"
        fill="url(#xtwork-feishu-fold)"
        opacity="0.92"
      />
    </svg>
  );
}

function WecomEmblem() {
  return (
    <svg
      viewBox="0 0 88 88"
      className="size-[76px] drop-shadow-[0_10px_20px_rgb(24_92_214_/_0.32)]"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="xtwork-wecom-bg" x1="12%" y1="8%" x2="88%" y2="92%">
          <stop offset="0%" stopColor="#4294FF" />
          <stop offset="100%" stopColor="#1B64EC" />
        </linearGradient>
      </defs>
      <path
        d="M44 13c18.8 0 34 13.3 34 29.8 0 16.4-15.2 29.7-34 29.7-4.4 0-8.6-.7-12.5-2.1L18.4 76c-1.8.8-3.6-.9-3-2.8l3.5-10.7C13.3 57.3 10 50.4 10 42.8 10 26.3 25.2 13 44 13Z"
        fill="url(#xtwork-wecom-bg)"
      />
      <circle cx="33" cy="36" r="5.5" fill="#FFFFFF" />
      <circle cx="48.5" cy="32.5" r="4.6" fill="#FFCE3A" />
      <circle cx="57" cy="45.5" r="5" fill="#32DE8A" />
      <circle cx="42" cy="49.5" r="6" fill="#8CD0FF" />
      <circle cx="29" cy="50" r="3.8" fill="#FF7B54" />
    </svg>
  );
}

function WechatEmblem() {
  return (
    <svg
      viewBox="0 0 88 88"
      className="size-[76px] drop-shadow-[0_10px_20px_rgb(7_148_74_/_0.32)]"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="xtwork-wechat-main" x1="12%" y1="8%" x2="88%" y2="92%">
          <stop offset="0%" stopColor="#2EE484" />
          <stop offset="100%" stopColor="#07B95B" />
        </linearGradient>
        <linearGradient id="xtwork-wechat-sub" x1="12%" y1="10%" x2="88%" y2="90%">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#DCFCEB" />
        </linearGradient>
      </defs>
      <path
        d="M36.5 16C21.3 16 9 26.3 9 39c0 7 3.7 13.3 9.6 17.5l-2.4 7.7c-.4 1.3.9 2.5 2.2 1.9l8.5-4.1c3 .8 6.2 1.2 9.6 1.2 15.2 0 27.5-10.3 27.5-23.1S51.7 16 36.5 16Z"
        fill="url(#xtwork-wechat-main)"
      />
      <circle cx="27.5" cy="34.5" r="3.3" fill="#FFFFFF" />
      <circle cx="45.5" cy="34.5" r="3.3" fill="#FFFFFF" />
      <path
        d="M55.8 36.5c-12.5 0-22.7 8.4-22.7 18.8s10.2 18.8 22.7 18.8c2.7 0 5.3-.4 7.8-1.1l6.8 3.4c1.1.5 2.2-.5 1.9-1.6l-1.9-6.2c4.9-3.4 8.1-8.1 8.1-13.3 0-10.4-10.2-18.8-22.7-18.8Z"
        fill="url(#xtwork-wechat-sub)"
      />
      <circle cx="48.5" cy="52" r="2.8" fill="#07B95B" />
      <circle cx="63" cy="52" r="2.8" fill="#07B95B" />
    </svg>
  );
}

function ChannelEmblem({ channel }: { readonly channel: RemoteImChannel }) {
  switch (channel) {
    case "feishu":
      return <FeishuEmblem />;
    case "wecom":
      return <WecomEmblem />;
    case "wechat":
      return <WechatEmblem />;
  }
}

export function RemoteImHoloCard({
  channel,
  flipped,
  statusBadge,
  onFlipQr,
  onFlipManual,
  onFlipFront,
  backContent,
}: RemoteImHoloCardProps) {
  const meta = REMOTE_IM_CHANNELS[channel];
  const sceneRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const frontFaceRef = useRef<HTMLDivElement>(null);
  const backFaceRef = useRef<HTMLDivElement>(null);
  const edgeRefs = useRef<Array<HTMLDivElement | null>>([]);
  const glowLayerRef = useRef<HTMLDivElement>(null);
  const ringOuterRef = useRef<HTMLDivElement>(null);
  const ringDashedRef = useRef<HTMLDivElement>(null);
  const emblemLayerRef = useRef<HTMLDivElement>(null);

  const flippedRef = useRef(flipped);
  const prevFlippedRef = useRef(flipped);
  useEffect(() => {
    const wasFlipped = prevFlippedRef.current;
    prevFlippedRef.current = flipped;
    flippedRef.current = flipped;
    if (!wasFlipped && flipped) {
      const target =
        backFaceRef.current?.querySelector<HTMLElement>("input:not([disabled])") ?? backFaceRef.current;
      target?.focus({ preventScroll: true });
    } else if (wasFlipped && !flipped) {
      inputFocusedRef.current = false;
      if (sceneRef.current?.contains(document.activeElement) || document.activeElement === document.body) {
        frontFaceRef.current?.focus({ preventScroll: true });
      }
    }
  }, [flipped]);

  const hoverRef = useRef({ active: false, fx: 0.34, fy: 0.22 });
  const inputFocusedRef = useRef(false);

  useEffect(() => {
    const sceneEl = sceneRef.current;
    const cardEl = cardRef.current;
    if (!sceneEl || !cardEl) return;

    const motionQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    let reducedMotion = motionQuery?.matches ?? false;
    const onMotionChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
    };
    motionQuery?.addEventListener?.("change", onMotionChange);

    let inView = true;
    const observer =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            inView = entries[0]?.isIntersecting ?? true;
          })
        : null;
    observer?.observe(sceneEl);

    let rotX = 0;
    let rotY = 0;
    let velX = 0;
    let velY = 0;
    let lx = 34;
    let ly = 22;
    let velLx = 0;
    let velLy = 0;
    let on = 0;
    let turn = flippedRef.current ? 180 : 0;
    let velTurn = 0;
    let elapsed = meta.swayPhase;
    let lastTs = performance.now();
    let prevEdgeVisible = false;
    let rafId = 0;

    const applyFaceLight = (el: HTMLDivElement | null, x: number, y: number, strength: number, ry: number) => {
      if (!el) return;
      const sealAngle = Math.atan2(y - 50, x - 50) * (180 / Math.PI) * 1.5 + ry * 6;
      const glareX = (x - 50) * 0.5;
      const glareY = (y - 50) * 0.5;
      el.style.setProperty("--holo-lx", `${x.toFixed(2)}%`);
      el.style.setProperty("--holo-ly", `${y.toFixed(2)}%`);
      el.style.setProperty("--holo-on", strength.toFixed(3));
      el.style.setProperty("--holo-seal-angle", `${sealAngle.toFixed(1)}deg`);
      el.style.setProperty("--holo-glare-x", `${glareX.toFixed(2)}%`);
      el.style.setProperty("--holo-glare-y", `${glareY.toFixed(2)}%`);
    };

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      if (!inView || document.hidden) {
        lastTs = now;
        return;
      }
      const dt = Math.min((now - lastTs) / 1000, 0.05);
      lastTs = now;
      elapsed += dt;

      const isFlipped = flippedRef.current;
      const hover = hoverRef.current;

      if (reducedMotion) {
        const targetLx = hover.active ? hover.fx * 100 : 34;
        const targetLy = hover.active ? hover.fy * 100 : 22;
        const targetOn = hover.active ? 1 : 0;
        lx += (targetLx - lx) * (1 - Math.exp(-10 * dt));
        ly += (targetLy - ly) * (1 - Math.exp(-10 * dt));
        on += (targetOn - on) * (1 - Math.exp(-7 * dt));
        applyFaceLight(frontFaceRef.current, lx, ly, on, 0);
        applyFaceLight(backFaceRef.current, 100 - lx, ly, on, 0);
        return;
      }

      let targetX = 0;
      let targetY = 0;
      if (hover.active) {
        const maxTilt = isFlipped ? (inputFocusedRef.current ? 0 : 3.2) : 12;
        const nx = hover.fx * 2 - 1;
        const ny = hover.fy * 2 - 1;
        targetY = nx * maxTilt;
        targetX = -ny * maxTilt;
      } else if (!isFlipped) {
        targetX = 2.2 * Math.sin(0.9 * elapsed + 0.6) + 0.8 * Math.sin(2.3 * elapsed);
        targetY = 3.2 * Math.sin(0.7 * elapsed) + 0.9 * Math.sin(1.9 * elapsed + 1.2);
      }

      const accX = TILT_STIFFNESS * (targetX - rotX) - TILT_DAMPING * velX;
      const accY = TILT_STIFFNESS * (targetY - rotY) - TILT_DAMPING * velY;
      velX += accX * dt;
      velY += accY * dt;
      rotX += velX * dt;
      rotY += velY * dt;

      const targetTurn = isFlipped ? 180 : 0;
      const accTurn = FLIP_STIFFNESS * (targetTurn - turn) - FLIP_DAMPING * velTurn;
      velTurn += accTurn * dt;
      turn += velTurn * dt;
      if (Math.abs(targetTurn - turn) < 0.04 && Math.abs(velTurn) < 0.04) {
        turn = targetTurn;
        velTurn = 0;
      }

      const targetLx = hover.active ? hover.fx * 100 : 34 + rotY * 3;
      const targetLy = hover.active ? hover.fy * 100 : 22 - rotX * 3;
      const accLx = LIGHT_STIFFNESS * (targetLx - lx) - LIGHT_DAMPING * velLx;
      const accLy = LIGHT_STIFFNESS * (targetLy - ly) - LIGHT_DAMPING * velLy;
      velLx += accLx * dt;
      velLy += accLy * dt;
      lx += velLx * dt;
      ly += velLy * dt;

      const targetOn = hover.active ? 1 : 0;
      on += (targetOn - on) * (1 - Math.exp(-7 * dt));

      const turnRad = turn * DEG_TO_RAD;
      const edgeSin = Math.abs(Math.sin(turnRad));
      const liftZ = edgeSin * 40;
      const totalY = rotY + turn;

      cardEl.style.transform = `translateZ(${liftZ.toFixed(2)}px) rotateX(${rotX.toFixed(2)}deg) rotateY(${totalY.toFixed(2)}deg)`;

      if (shadowRef.current) {
        const shadowX = -rotY * 1.8;
        const shadowY = rotX * 1.2 + edgeSin * 14;
        const shadowScaleX = 1 - edgeSin * 0.45;
        shadowRef.current.style.transform = `translate3d(${shadowX.toFixed(1)}px, ${shadowY.toFixed(1)}px, 0) scaleX(${shadowScaleX.toFixed(3)})`;
      }

      const edgeVisible = edgeSin > 0.025;
      if (edgeVisible !== prevEdgeVisible) {
        prevEdgeVisible = edgeVisible;
        const nextOpacity = edgeVisible ? "1" : "0";
        for (const slice of edgeRefs.current) {
          if (slice) slice.style.opacity = nextOpacity;
        }
      }

      const normalizedTurn = ((turn % 360) + 360) % 360;
      const backShowing = normalizedTurn > 90 && normalizedTurn < 270;

      if (!backShowing) {
        applyFaceLight(frontFaceRef.current, lx, ly, on, rotY);

        const sinY = Math.sin(totalY * DEG_TO_RAD);
        const sinX = Math.sin(rotX * DEG_TO_RAD);
        if (glowLayerRef.current) {
          glowLayerRef.current.style.transform = `translate3d(${(-56 * sinY).toFixed(2)}px, ${(56 * sinX).toFixed(2)}px, 0)`;
        }
        if (ringOuterRef.current) {
          const ringAngle = (elapsed * 9) % 360;
          ringOuterRef.current.style.transform = `translate3d(${(-32 * sinY).toFixed(2)}px, ${(32 * sinX).toFixed(2)}px, 0) rotate(${ringAngle.toFixed(2)}deg)`;
        }
        if (ringDashedRef.current) {
          const dashedAngle = (-elapsed * 15) % 360;
          ringDashedRef.current.style.transform = `translate3d(${(-18 * sinY).toFixed(2)}px, ${(18 * sinX).toFixed(2)}px, 0) rotate(${dashedAngle.toFixed(2)}deg)`;
        }
        if (emblemLayerRef.current) {
          emblemLayerRef.current.style.transform = `translate3d(${(10 * sinY).toFixed(2)}px, ${(-10 * sinX).toFixed(2)}px, 0)`;
        }
      } else {
        applyFaceLight(backFaceRef.current, 100 - lx, ly, on, -rotY);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      observer?.disconnect();
      motionQuery?.removeEventListener?.("change", onMotionChange);
    };
  }, [meta.swayPhase]);

  const updatePointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = sceneRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const fx = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const fy = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    hoverRef.current = { active: true, fx, fy };
  };

  const handlePointerLeave = () => {
    hoverRef.current = { active: false, fx: 0.34, fy: 0.22 };
  };

  const handleFrontClick = (event: MouseEvent<HTMLDivElement>) => {
    if (flipped) return;
    if ((event.target as HTMLElement | null)?.closest("[data-holo-action]")) return;
    onFlipQr();
  };

  const handleFrontKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (flipped) return;
    if ((event.target as HTMLElement | null)?.closest("[data-holo-action]")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onFlipQr();
    }
  };

  const handleBackClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!flipped) return;
    if (
      (event.target as HTMLElement | null)?.closest(
        "button, a, input, textarea, select, label, form, output, [data-holo-interactive]",
      )
    ) {
      return;
    }
    onFlipFront();
  };

  const handleSceneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (flipped && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onFlipFront();
    }
  };

  return (
    <div
      ref={sceneRef}
      data-testid={`holo-card-${channel}`}
      data-channel={channel}
      data-holo-card={channel}
      data-flipped={flipped ? "true" : "false"}
      className="xtwork-holo-scene"
      onPointerEnter={updatePointer}
      onPointerMove={updatePointer}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleSceneKeyDown}
    >
      <div ref={shadowRef} className="xtwork-holo-shadow" aria-hidden="true" />
      <div ref={cardRef} data-flipped={flipped ? "true" : "false"} className="xtwork-holo-card">
        {EDGE_Z_OFFSETS.map((z, index) => (
          <div
            key={z}
            ref={(el) => {
              edgeRefs.current[index] = el;
            }}
            aria-hidden="true"
            className="xtwork-holo-edge"
            style={{ transform: `translateZ(${z.toFixed(2)}px)` }}
          />
        ))}

        {/* FRONT FACE */}
        <div
          ref={frontFaceRef}
          role="button"
          tabIndex={flipped ? -1 : 0}
          aria-hidden={flipped}
          aria-expanded={flipped}
          aria-label={`连接${meta.name}，${REMOTE_IM_CARD_DESCRIPTION}`}
          inert={flipped}
          className="xtwork-holo-face xtwork-holo-face-front outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          onClick={handleFrontClick}
          onKeyDown={handleFrontKeyDown}
        >
          <div className="xtwork-holo-foil" aria-hidden="true" />
          <div className="xtwork-holo-print">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">{statusBadge}</div>
              {meta.supportsManual && onFlipManual ? (
                <button
                  type="button"
                  data-holo-action="manual"
                  aria-label={`手动填入${meta.name}凭据`}
                  title="手动填入凭据"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{
                    backgroundColor: "var(--holo-control-bg)",
                    borderColor: "var(--holo-chip-border)",
                    color: "var(--holo-ink)",
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    onFlipManual();
                  }}
                >
                  <EllipsisIcon className="size-4" aria-hidden="true" />
                </button>
              ) : (
                <span className="size-8 shrink-0" aria-hidden="true" />
              )}
            </div>

            <div className="xtwork-holo-window">
              <div ref={glowLayerRef} className="xtwork-holo-window-glow" aria-hidden="true" />
              <div ref={ringOuterRef} className="xtwork-holo-depth-layer" aria-hidden="true">
                <div className="xtwork-holo-ring size-44" />
              </div>
              <div ref={ringDashedRef} className="xtwork-holo-depth-layer" aria-hidden="true">
                <div className="xtwork-holo-ring-dashed size-32" />
              </div>
              <div ref={emblemLayerRef} className="xtwork-holo-depth-layer">
                <ChannelEmblem channel={channel} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg font-semibold tracking-tight" style={{ color: "var(--holo-ink)" }}>
                  {meta.name}
                </h3>
                <span className="xtwork-holo-seal" aria-hidden="true" />
              </div>
              <p className="text-xs leading-relaxed" style={{ color: "var(--holo-ink-muted)" }}>
                {REMOTE_IM_CARD_DESCRIPTION}
              </p>
            </div>
          </div>
          <div className="xtwork-holo-glare-clip" aria-hidden="true">
            <div className="xtwork-holo-glare" />
          </div>
          <div className="xtwork-holo-rim" aria-hidden="true" />
        </div>

        {/* BACK FACE */}
        <div
          ref={backFaceRef}
          tabIndex={flipped ? -1 : undefined}
          aria-hidden={!flipped}
          inert={!flipped}
          className="xtwork-holo-face xtwork-holo-face-back outline-none"
          onClick={handleBackClick}
          onFocusCapture={(event) => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
              inputFocusedRef.current = true;
            }
          }}
          onBlurCapture={(event) => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
              inputFocusedRef.current = false;
            }
          }}
        >
          <div className="xtwork-holo-foil" aria-hidden="true" />
          <div className="xtwork-holo-print">{backContent}</div>
          <div className="xtwork-holo-glare-clip" aria-hidden="true">
            <div className="xtwork-holo-glare" />
          </div>
          <div className="xtwork-holo-rim" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
