'use client';
import { useEffect, useRef } from 'react';
// Runs fn every `ms`, but only while the screen is visible. Refreshes once when the screen comes back.
export function useVisibleInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  useEffect(() => {
    const run = () => { if (document.visibilityState === 'visible') ref.current(); };
    const t = setInterval(run, ms);
    document.addEventListener('visibilitychange', run);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', run); };
  }, [ms]);
}