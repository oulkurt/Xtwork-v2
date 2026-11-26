import { REST, followGaze, followStep, type FollowState } from './follow';
import { lookOf, stateDefinition, stateId, type AvatarStateDefinition } from './motion';
import { moodProgress, settleMood, type MoodState } from './mood';
import type { AvatarMood, AvatarMotion, AvatarMotionBlend, AvatarState } from './types';

export interface AnimatorInput {

  now: number;
  state?: AvatarState | AvatarStateDefinition | undefined;
  mood?: AvatarMood | undefined;

  motion?: AvatarMotion | undefined;

  target: { x: number; y: number } | null;

  hold?: boolean | undefined;

  reducedMotion: boolean;
}

export interface AnimatorStep {
  gaze?: { x: number; y: number; weight: number } | undefined;
  motionBlend?: AvatarMotionBlend | undefined;

  stateAge: number;

  moving: boolean;
}

export interface Animator {
  step(input: AnimatorInput): AnimatorStep;

  restartState(now: number): void;

  reset(): void;
}

export function createAnimator(): Animator {
  let follow: FollowState = REST;
  let last: number | null = null;

  let shown: { state: AvatarState | AvatarStateDefinition; mood: AvatarMood; blend?: AvatarMotionBlend | undefined; since: number; began: number } | null = null;

  return {
    step({ now, target, hold = false, reducedMotion, ...given }) {
      const dt = last === null ? 0 : (now - last) / 1000;
      last = now;
      let moving = false;
      if (!hold) ({ state: follow, moving } = followStep(follow, target, dt, reducedMotion));

      const { state, mood } = lookOf(given);
      const same = shown !== null && stateId(state) === stateId(shown.state);

      if (shown && same) shown.state = state;
      if (shown && (!same || mood !== shown.mood)) {
        const before: MoodState = {
          state: shown.state,
          mood: shown.mood,
          age: (now - shown.began) / 1000,
          blend: shown.blend && { from: shown.blend.from, t: moodProgress(now - shown.since) },
        };
        shown = {
          state,
          mood,
          blend: reducedMotion ? undefined : { from: settleMood(before), t: 0 },
          since: now,
          began: same ? shown.began : now,
        };
      }

      const startAge = stateDefinition(state).startAge;
      shown ??= { state, mood, since: now, began: now - (Number.isFinite(startAge) ? Math.max(0, startAge as number) : 0) * 1000 };
      const t = reducedMotion ? 1 : moodProgress(now - shown.since);
      let motionBlend: AvatarMotionBlend | undefined;
      if (shown.blend && t < 1) motionBlend = { from: shown.blend.from, t };
      else shown.blend = undefined;

      return { gaze: followGaze(follow), motionBlend, stateAge: (now - shown.began) / 1000, moving: moving || motionBlend !== undefined };
    },
    restartState(now: number) {
      if (shown) {
        shown = { state: shown.state, mood: shown.mood, since: now, began: now };
      }
    },
    reset() {
      follow = REST;
      last = null;
      shown = null;
    },
  };
}
