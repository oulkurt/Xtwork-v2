import { requestFrame } from './clock';

const QUERY = '(prefers-reduced-motion: reduce)';
let mql: MediaQueryList | null | undefined;

function media(): MediaQueryList | null {
  if (mql === undefined) {
    mql = typeof matchMedia === 'undefined' ? null : matchMedia(QUERY);

    mql?.addEventListener('change', () => requestFrame());
  }
  return mql;
}

export function prefersReducedMotion(): boolean {
  return media()?.matches ?? false;
}
