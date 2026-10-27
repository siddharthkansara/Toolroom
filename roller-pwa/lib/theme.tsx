'use client';
import { useEffect, useState } from 'react';

const paint = (light: boolean) => {
  if (light) document.documentElement.setAttribute('data-theme', 'light'); else document.documentElement.removeAttribute('data-theme');
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', light ? '#f1f5f9' : '#020617'));
};

// Remembers the choice on this device (dark is the default)
export function ThemeToggle() {
  const [light, setLight] = useState(false);
  useEffect(() => { const l = document.documentElement.getAttribute('data-theme') === 'light'; setLight(l); paint(l); }, []);
  function toggle() {
    const next = !light; setLight(next); paint(next);
    try { localStorage.setItem('theme', next ? 'light' : 'dark'); } catch {}
  }
  return <button onClick={toggle} aria-label="Switch between light and dark" className="px-4 min-h-10 rounded-lg bg-slate-800">{light ? '🌙 Dark' : '☀️ Light'}</button>;
}
