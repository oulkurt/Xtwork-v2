import type { AvatarStateDefinition } from './motion';
import type { AvatarMood, AvatarMotion, AvatarMotionBlend, AvatarState } from './types';

export const MOOD_MS = 420;

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

export function moodProgress(elapsedMs: number): number {
  return smooth(elapsedMs / MOOD_MS);
}

export interface MoodState {
  state?: AvatarState | AvatarStateDefinition | undefined;
  mood?: AvatarMood | undefined;

  motion?: AvatarMotion | undefined;

  age?: number | undefined;
  blend?: AvatarMotionBlend | undefined;
}

export function settleMood(state: MoodState, share = 1, depth = 0): MoodState {
  const b = state.blend;
  if (!b) return state;
  const { blend: _, ...settled } = state;
  const rest = share * (1 - b.t);
  if (rest < 0.02 || depth >= 3) return settled;
  return { ...settled, blend: { from: typeof b.from === 'string' ? b.from : settleMood(b.from, rest, depth + 1), t: b.t } };
}
