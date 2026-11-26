export interface Pointer {
  x: number;
  y: number;
}

export interface FrameSubscriber {
  measure?: () => void;

  draw: (time: number, pointer: Pointer | null) => boolean | number;
}

const subscribers = new Set<FrameSubscriber>();
let frame = 0;

const due = new WeakMap<FrameSubscriber, number>();
let pointer: Pointer | null = null;
const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;

function tick(now: number) {
  frame = 0;
  const time = (now - startedAt) / 1000;
  let busy = false;
  const ready: FrameSubscriber[] = [];
  for (const s of subscribers) {
    const at = due.get(s);
    if (at !== undefined && at > time) busy = true;
    else ready.push(s);
  }
  for (const s of ready) s.measure?.();
  for (const s of ready) {
    const next = s.draw(time, pointer);
    if (typeof next === 'number') due.set(s, time + next);
    else due.delete(s);
    busy = next !== false || busy;
  }
  if (busy) wake();
}

function wake() {
  if (!frame && subscribers.size > 0 && typeof requestAnimationFrame !== 'undefined') frame = requestAnimationFrame(tick);
}

export function subscribeFrames(subscriber: FrameSubscriber): () => void {
  subscribers.add(subscriber);
  wake();
  return () => {
    subscribers.delete(subscriber);
    due.delete(subscriber);
    if (subscribers.size === 0) {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}

export function setPointer(next: Pointer | null) {
  pointer = next;
  wake();
}

export function requestFrame(subscriber?: FrameSubscriber) {
  if (subscriber) due.delete(subscriber);
  wake();
}
