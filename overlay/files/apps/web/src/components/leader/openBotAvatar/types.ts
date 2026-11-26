import type { AvatarStateDefinition } from './motion';

export interface AvatarEyes {

  x: number;
  y: number;

  spacing: number;

  scale: number;
}

export interface AvatarDefinition {
  version: 1;

  id: string;

  name: string;

  body: { path: string };
  eyes: AvatarEyes;
}

export type AvatarState = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done';

export type AvatarMood = 'neutral' | 'happy';

export type AvatarMotion = 'idle' | 'thinking' | 'happy';

export interface AvatarMotionBlend {
  from:
    | AvatarMotion
    | {
        state?: AvatarState | AvatarStateDefinition | undefined;
        mood?: AvatarMood | undefined;

        motion?: AvatarMotion | undefined;

        age?: number | undefined;
        blend?: AvatarMotionBlend | undefined;
      };
  t: number;
}

export interface RenderOptions {

  color?: string | undefined;

  eyeColor?: string | undefined;

  size?: number | undefined;

  depth?: number | undefined;

  view?: { yaw: number; pitch: number } | undefined;

  time?: number | undefined;

  gaze?: { x: number; y: number; weight?: number | undefined } | undefined;

  state?: AvatarState | AvatarStateDefinition | undefined;

  mood?: AvatarMood | undefined;

  motion?: AvatarMotion | undefined;

  stateAge?: number | undefined;

  motionBlend?: AvatarMotionBlend | undefined;

  reducedMotion?: boolean | undefined;

  idPrefix?: string | undefined;
}

export type ValidationResult =
  | { ok: true; value: AvatarDefinition }
  | { ok: false; errors: string[] };
