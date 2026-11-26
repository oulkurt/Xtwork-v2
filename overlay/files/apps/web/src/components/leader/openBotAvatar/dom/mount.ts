import { createAnimator } from '../animator';
import { pointerGaze } from '../follow';
import { lookOf, type AvatarStateDefinition } from '../motion';
import { DEFAULT_COLOR, DEFAULT_EYE_COLOR, liveFrame, renderAvatarScene, renderAvatarSvg, sceneFrame, type SceneFrame } from '../render';
import type { AvatarDefinition, AvatarMood, AvatarState, RenderOptions } from '../types';
import { requestFrame, subscribeFrames, type FrameSubscriber } from './clock';
import { canvasMaterialOf, type AvatarMaterial } from './materials/material';
import { canvasSupported, mountCanvas, paintCanvas, type CanvasSurface } from './paint';
import { trackPointer } from './pointer';
import { prefersReducedMotion } from './reduced';

export interface AvatarOptions {
  definition: AvatarDefinition;

  color?: string;

  eyeColor?: string;

  material?: AvatarMaterial;

  depth?: number;

  state?: AvatarState | AvatarStateDefinition;

  mood?: AvatarMood | 'idle' | 'thinking';

  followPointer?: boolean;

  lookAt?: { x: number; y: number } | null;

  holdGaze?: boolean;

  view?: { yaw: number; pitch: number };

  reducedMotion?: boolean | 'system';

  still?: boolean;

  renderer?: 'canvas' | 'scene';

  label?: string;

  replayNonce?: number | undefined;
}

export interface MountedAvatar {

  update(options: Partial<AvatarOptions>): void;
  destroy(): void;
}

interface Scene {
  key: string;
  geometry: string;
  motion: HTMLElement;
  view: HTMLElement;
  stacks: Record<'z' | 'x', HTMLElement>;
  slices: Record<'z' | 'x', HTMLElement[]>;
  eyes: { root: HTMLElement; pill: HTMLElement; arc: HTMLElement; morph: HTMLElement; path: SVGPathElement }[];
  fx: Record<'back' | 'front', HTMLElement>;
  last: Record<string, string>;
}

function mountScene(el: HTMLElement, definition: AvatarDefinition, depth: number | undefined): Scene {
  el.innerHTML = renderAvatarScene(definition, { depth });
  const q = (s: string) => el.querySelector(s) as HTMLElement;
  const stacks = { z: q('[data-stack="z"]'), x: q('[data-stack="x"]') };
  return {
    key: q('[data-avatar-scene]').dataset.avatarScene ?? '',
    geometry: geometryKey(definition),
    motion: q('[data-motion]'),
    view: q('[data-view]'),
    stacks,
    slices: { z: [...stacks.z.children] as HTMLElement[], x: [...stacks.x.children] as HTMLElement[] },
    eyes: [0, 1].map((i) => {
      const root = q(`[data-eye="${i}"]`);
      const morph = root.querySelector('[data-morph]') as HTMLElement;
      return { root, pill: root.querySelector('i') as HTMLElement, arc: root.querySelector('svg') as unknown as HTMLElement, morph, path: morph.querySelector('path') as SVGPathElement };
    }),
    fx: { back: q('[data-fx="back"]'), front: q('[data-fx="front"]') },
    last: {},
  };
}

function put(m: Scene, key: string, el: HTMLElement, prop: 'transform' | 'visibility' | 'display', value: string) {
  if (m.last[key] === value) return;
  m.last[key] = value;
  el.style[prop] = value;
}

function apply(m: Scene, frame: SceneFrame) {
  put(m, 'motion', m.motion, 'transform', frame.motion);
  put(m, 'view', m.view, 'transform', frame.view);

  put(m, 'body', m.view, 'display', frame.body > 0 ? 'block' : 'none');
  for (const side of ['back', 'front'] as const) {
    if (m.last[side] === frame[side]) continue;
    m.last[side] = frame[side];
    m.fx[side].innerHTML = frame[side];
  }

  put(m, 'z', m.stacks.z, 'display', frame.stack === 'z' ? 'block' : 'none');
  put(m, 'x', m.stacks.x, 'display', frame.stack === 'x' ? 'block' : 'none');
  const slices = m.slices[frame.stack];
  frame.slices.forEach((shown, i) => slices[i] && put(m, `${frame.stack}${i}`, slices[i], 'display', shown ? 'block' : 'none'));
  frame.eyes.forEach((eye, i) => {
    const e = m.eyes[i];
    if (!e) return;
    put(m, `e${i}`, e.root, 'transform', eye.transform);
    put(m, `v${i}`, e.root, 'visibility', eye.visible ? 'visible' : 'hidden');
    put(m, `p${i}`, e.pill, 'transform', eye.pill);
    put(m, `ph${i}`, e.pill, 'display', eye.happy || eye.d ? 'none' : 'block');
    put(m, `a${i}`, e.arc, 'display', eye.happy && !eye.d ? 'block' : 'none');
    put(m, `m${i}`, e.morph, 'display', eye.d ? 'block' : 'none');
    if (eye.d && m.last[`d${i}`] !== eye.d) {
      m.last[`d${i}`] = eye.d;
      e.path.setAttribute('d', eye.d);
    }
  });
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const isHex = (c: string | undefined) => c === undefined || HEX.test(c);

const keys = new WeakMap<object, string>();

function geometryKey(definition: AvatarDefinition): string {
  let key = keys.get(definition);
  if (key === undefined) {
    key = JSON.stringify([definition?.id, definition?.name, definition?.body?.path, definition?.eyes]);
    keys.set(definition, key);
  }
  return key;
}

function eyesOrigin(definition: AvatarDefinition): { x: number; y: number } {
  const { x, y } = definition.eyes ?? {};
  const at = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 0.5);
  return { x: at(x), y: at(y) };
}

const SMALL_SIZE = 128;
const SMALL_FPS = 30;

const VIEW_MARGIN = 100;

const FRAME_SLACK = 0.004;

let materialStillAt = -1;
let svgInstanceSeq = 0;

export function mountAvatar(host: HTMLElement, initial: AvatarOptions): MountedAvatar {
  let opts: AvatarOptions = { ...initial };
  const animator = createAnimator();
  const svgIdPrefix = `m${(++svgInstanceSeq).toString(36)}-`;
  let lastReplayNonce = initial.replayNonce;
  let rect: DOMRect | null = null;
  let scene: Scene | null = null;
  let surface: CanvasSurface | null = null;
  let lastStill = '';
  let failed = false;
  let dirty = true;
  let releasePointer: (() => void) | null = null;
  let size = host.clientWidth;
  let subscriber: FrameSubscriber | undefined;
  const resize = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(([entry]) => {
        if (!entry) return;
        const next = entry.contentRect.width;
        if (next === size) return;
        size = next;
        dirty = true;
        requestFrame(subscriber);
      });
  resize?.observe(host);

  let visible = true;
  const intersect = typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver(
        (entries) => {
          const lastEntry = entries[entries.length - 1];
          if (!lastEntry) return;
          const next = lastEntry.isIntersecting;
          if (next === visible) return;
          visible = next;
          if (visible) requestFrame(subscriber);
        },
        { rootMargin: `${VIEW_MARGIN}px` },
      );
  intersect?.observe(host);

  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  const syncHost = () => {
    host.style.color = opts.color ?? DEFAULT_COLOR;
    host.style.setProperty('--avatar-ink', opts.eyeColor ?? DEFAULT_EYE_COLOR);
    const decorative = opts.label === '';
    if (decorative) {
      host.removeAttribute('role');
      host.removeAttribute('aria-label');
      host.setAttribute('aria-hidden', 'true');
    } else {
      host.setAttribute('role', 'img');
      host.setAttribute('aria-label', opts.label ?? opts.definition?.name ?? 'Avatar');
      host.removeAttribute('aria-hidden');
    }
    const wantsPointer = !!opts.followPointer && !opts.still;
    if (wantsPointer && !releasePointer) releasePointer = trackPointer();
    else if (!wantsPointer && releasePointer) {
      releasePointer();
      releasePointer = null;
    }
  };

  const clear = () => {
    host.textContent = '';
    scene = null;
    surface = null;
    lastStill = '';
  };

  const canvasMaterial = () => canvasMaterialOf(opts.material) !== null && opts.renderer !== 'scene' && canvasSupported();

  const paint = (p: AvatarOptions, options: RenderOptions) => {
    if (scene || lastStill) clear();
    const flat = liveFrame(p.definition, { ...options, color: p.color, eyeColor: p.eyeColor });
    const key = `${geometryKey(p.definition)}|${p.depth}`;
    if (!surface || surface.key !== key || !host.contains(surface.canvas)) surface = mountCanvas(host, key, p.definition, p.depth);

    const css = isHex(p.color) && isHex(p.eyeColor) ? null : getComputedStyle(host);
    const fill = css && !isHex(p.color) ? css.color || flat.color : flat.color;
    const ink = css && !isHex(p.eyeColor) ? css.getPropertyValue('--avatar-ink').trim() || flat.ink : flat.ink;
    paintCanvas(surface, flat, size, fill, ink, p.material);
  };

  const draw = (time: number, pointer: { x: number; y: number } | null): boolean => {
    const p = opts;
    const reducedMotion = p.reducedMotion === 'system' || p.reducedMotion === undefined ? prefersReducedMotion() : p.reducedMotion;
    const now = performance.now();

    const look = lookOf({ state: p.state, mood: p.mood, motion: p.mood });
    try {
      if (p.still) {
        const parsedStyleWidth = Number.parseFloat(host.style.width);
        const stillSize =
          size > 0
            ? size
            : host.clientWidth > 0
              ? host.clientWidth
              : Number.isFinite(parsedStyleWidth) && parsedStyleWidth > 0
                ? parsedStyleWidth
                : undefined;
        const options: RenderOptions = {
          color: p.color,
          eyeColor: p.eyeColor,
          depth: p.depth,
          size: stillSize,
          state: look.state,
          mood: look.mood,
          view: p.view,
          gaze: p.lookAt ?? undefined,
          reducedMotion: true,
          idPrefix: svgIdPrefix,
        };
        if (canvasMaterial()) {

          if (stillSize && stillSize > 0) paint(p, { ...options, size: stillSize });
          failed = false;
          return false;
        }
        if (scene || surface) clear();
        const svg = renderAvatarSvg(p.definition, options);

        if (svg !== lastStill) {
          host.innerHTML = svg;
          lastStill = svg;
        }
        failed = false;
        return false;
      }
      if (lastStill) clear();

      const target = p.lookAt
        ? p.lookAt
        : p.followPointer && pointer && rect && rect.width > 0
          ? pointerGaze(pointer, rect, eyesOrigin(p.definition))
          : null;
      const step = animator.step({ now, state: look.state, mood: look.mood, target, hold: p.holdGaze, reducedMotion });
      const options: RenderOptions = {
        depth: p.depth,
        state: look.state,
        mood: look.mood,
        stateAge: step.stateAge,
        motionBlend: step.motionBlend,
        size: size || undefined,
        time,
        gaze: step.gaze,
        view: p.view,
        reducedMotion,
      };
      if (p.renderer !== 'scene' && canvasSupported()) {
        paint(p, options);
        failed = false;
        return !reducedMotion || step.moving;
      }
      if (surface) clear();
      const frame = sceneFrame(p.definition, { ...options, color: p.color });
      if (!scene || scene.key !== frame.scene || scene.geometry !== geometryKey(p.definition) || !host.contains(scene.view)) {
        scene = mountScene(host, p.definition, p.depth);
      }
      apply(scene, frame);
      failed = false;
      return !reducedMotion || step.moving;
    } catch (error) {
      if (!failed) {
        clear();
        console.error('open-bot-avatar: render failed', error);
        failed = true;
      }
      return false;
    }
  };

  syncHost();
  subscriber = {
    measure: () => {
      rect = visible && opts.followPointer && !opts.still && !opts.holdGaze && !opts.lookAt ? host.getBoundingClientRect() : null;
    },
    draw: (time, pointer) => {

      if ((opts.still || !visible) && !dirty) return false;
      if (opts.still && size > 0 && canvasMaterial()) {
        if (materialStillAt === time) return true;
        materialStillAt = time;
      }
      dirty = false;
      const more = draw(time, pointer);
      if (!visible) return false;
      return more && size > 0 && size < SMALL_SIZE ? 1 / SMALL_FPS - FRAME_SLACK : more;
    },
  };
  const unsubscribe = subscribeFrames(subscriber);

  return {
    update(next) {
      opts = { ...opts, ...next };
      if (next.replayNonce !== undefined && next.replayNonce !== lastReplayNonce) {
        lastReplayNonce = next.replayNonce;
        animator.restartState(performance.now());
      }
      syncHost();
      dirty = true;
      requestFrame(subscriber);
    },
    destroy() {
      unsubscribe();
      resize?.disconnect();
      intersect?.disconnect();
      releasePointer?.();
      releasePointer = null;
      clear();
    },
  };
}
