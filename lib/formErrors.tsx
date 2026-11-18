'use client';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

// Errors shown next to the box they belong to, so nobody has to scroll to the top to find out why a form will not save.
// How to use it in a form:
//   const { errs, fail, put, root, onFieldChange } = useFormErrors();
//   <div ref={root} onChange={onFieldChange}> ... a field is wrapped like this:
//     <label data-k="weight"> <input className={inp + ring(errs, 'weight')} .../> <Err errs={errs} k="weight"/> </label>
//   when saving: build an object of messages by field key and call fail({ weight: 'Enter the weight.' })
export type Errs = Record<string, string>;

export function useFormErrors() {
  const [errs, setErrs] = useState<Errs>({});
  const root = useRef<HTMLDivElement>(null);
  // Show these messages (an empty object clears them all)
  const fail = (e: Errs) => setErrs(e);
  // Add or replace one message without touching the others
  const put = (key: string, v: string) => setErrs(cur => ({ ...cur, [key]: v }));
  // Typing in a box clears that box's message, and the general message
  const onFieldChange = (e: FormEvent<HTMLElement>) => {
    const k = (e.target as HTMLElement).closest('[data-k]')?.getAttribute('data-k');
    setErrs(cur => { if (!(k && (k in cur || `info:${k}` in cur)) && !('form' in cur)) return cur; const n = { ...cur }; if (k) { delete n[k]; delete n[`info:${k}`]; } delete n.form; return n; });
  };
  // After messages appear, bring the first one into view
  useEffect(() => { if (Object.keys(errs).length) root.current?.querySelector('[data-err="1"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [errs]);
  return { errs, fail, put, root, onFieldChange };
}

// The red message directly under a box. Use the same key as in fail({...}).
// tone="info" shows a calm amber note instead (for things like "Added operator Ravi"); its key starts with "info:".
export function Err({ errs, k, tone }: { errs: Errs; k: string; tone?: 'info' }) {
  if (!errs[k]) return null;
  return tone === 'info' ? <div role="status" className="mt-1 text-amber-300 font-semibold text-sm">{errs[k]}</div>
    : <div data-err="1" role="alert" className="mt-1 text-red-400 font-semibold text-sm">⚠ {errs[k]}</div>;
}
// Adds a red border to a box that has a message: className={inp + ring(errs, 'weight')}
export const ring = (errs: Errs, k: string) => (errs[k] ? ' !border-red-500' : '');
// "It worked" note pinned to the bottom of the screen, so it is seen without scrolling even when the form has closed.
// The screen that owns `msg` clears it after a few seconds. tone="warn" is for a save that worked but needs a look (e.g. stock was short).
export function Toast({ msg, tone }: { msg: string; tone?: 'warn' }) {
  if (!msg) return null;
  return (<div className="fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4 pointer-events-none">
    <div role="status" aria-live="polite" className={`max-w-xl rounded-2xl px-5 py-3 text-lg font-bold shadow-lg ${tone === 'warn' ? 'bg-amber-500 text-slate-950' : 'bg-green-600 text-white'}`}>{tone === 'warn' ? '⚠ ' : '✔ '}{msg}</div></div>);
}

// Enter in a text box runs the form's save, as on any PC form: <div onKeyDown={enterTo(save, busy)}>.
// Ignored in dropdowns, checkboxes and buttons, on a held-down key, and while a save is running.
// A box inside a bigger form can have its own enterTo (e.g. "New roller size"); it stops the outer one from also running.
export const enterTo = (fn: () => void, busy = false) => (e: KeyboardEvent<HTMLElement>) => {
  if (e.key !== 'Enter' || e.shiftKey || e.repeat || e.nativeEvent.isComposing) return;
  const t = e.target as HTMLInputElement;
  if (t.tagName !== 'INPUT' || ['checkbox', 'radio', 'button', 'submit'].includes(t.type)) return;
  e.preventDefault(); e.stopPropagation();
  if (!busy) fn();
};
