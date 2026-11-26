export interface FollowState {
  x: number;
  y: number;

  attention: number;
}

export const REST: FollowState = { x: 0, y: 0, attention: 0 };

const TAU = 0.12;

const ATTEND_TAU = 0.3;

const REACH = 1;

const MIN_SIZE = 160;

export function pointerGaze(
  pointer: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
  origin: { x: number; y: number } = { x: 0.5, y: 0.5 },
) {
  const reach = Math.max(box.width, box.height, MIN_SIZE) * REACH;
  const dx = (pointer.x - (box.left + box.width * origin.x)) / reach;
  const dy = (pointer.y - (box.top + box.height * origin.y)) / reach;
  const m = Math.hypot(dx, dy);
  if (!Number.isFinite(m) || m < 1e-9) return { x: 0, y: 0 };
  const k = Math.tanh(m) / m;
  return { x: dx * k, y: dy * k };
}

export function followStep(state: FollowState, target: { x: number; y: number } | null, dt: number, reduced: boolean): { state: FollowState; moving: boolean } {
  const goal: FollowState = target ? { x: target.x, y: target.y, attention: 1 } : REST;
  const step = Math.max(0, Math.min(dt, 0.1));
  const ease = (tau: number) => (reduced ? 1 : 1 - Math.exp(-step / tau));

  const k = ease(target ? TAU : ATTEND_TAU);
  const next: FollowState = {
    x: state.x + (goal.x - state.x) * k,
    y: state.y + (goal.y - state.y) * k,
    attention: state.attention + (goal.attention - state.attention) * ease(ATTEND_TAU),
  };
  const moving = Math.abs(goal.x - next.x) > 0.002 || Math.abs(goal.y - next.y) > 0.002 || Math.abs(goal.attention - next.attention) > 0.002;
  return { state: moving ? next : goal, moving };
}

export function followGaze(state: FollowState): { x: number; y: number; weight: number } | undefined {
  const a = Math.min(1, Math.max(0, state.attention));
  return a > 0 ? { x: state.x, y: state.y, weight: a * a * (3 - 2 * a) } : undefined;
}
