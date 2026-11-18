import { useSyncExternalStore } from 'react';
import type { healthSnapshotSchema } from '@patrick/contracts/resources';
import logo from '../../../../docs/designs/设计资产/v2/logo-curious-p.svg?url';
import '../styles/motion.css';

type Health = ReturnType<typeof healthSnapshotSchema.parse>;

export function animateServiceLogo(health: Health | undefined, reducedMotion: boolean, pageVisible: boolean): boolean {
  return health?.service === 'running' && health.freshness === 'fresh' && !reducedMotion && pageVisible;
}

const motionQuery = '(prefers-reduced-motion: reduce)';
function subscribeSystemMotion(notify: () => void) {
  const media = window.matchMedia(motionQuery);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
}
function systemReducesMotion() {
  return window.matchMedia(motionQuery).matches;
}

export function ServiceLogo({ health, reducedMotion, pageVisible, label }: {
  health?: Health; reducedMotion: boolean; pageVisible: boolean; label: string;
}) {
  const systemReduced = useSyncExternalStore(subscribeSystemMotion, systemReducesMotion);
  const reduce = reducedMotion || systemReduced;
  const playing = animateServiceLogo(health, reduce, pageVisible);
  // Keep the same animation and phase while the otherwise eligible page is hidden.
  const paused = !pageVisible && animateServiceLogo(health, reduce, true);
  return <div className="curious-logo" data-background={paused}>
    <img src={logo} alt={label} />
    <svg aria-hidden="true" focusable="false" viewBox="0 0 96 96" className="logo-orbit" fill="none">
      <circle cx="48" cy="48" r="43" stroke="currentColor" opacity=".16" />
      {(playing || paused) && <g className="logo-runner">
        <path d="M87.82 31.7A43 43 0 0 1 91 48" stroke="currentColor" opacity=".38" strokeWidth="1.8" />
        <circle cx="91" cy="48" r="2.35" fill="currentColor" />
      </g>}
    </svg>
  </div>;
}
