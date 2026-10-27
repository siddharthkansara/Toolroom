'use client';
import { FactoryTag } from '@/lib/factories';

// ---- Grouping utility: one group per [factory + roller size], so the same size in two factories never merges ----
export type RollerGroup<T> = { key: string; factory: string; size: string; items: T[] };
export function groupByRoller<T>(list: T[], pick: (x: T) => { factory: string; size: string; at: string }): RollerGroup<T>[] {
  const m = new Map<string, RollerGroup<T> & { last: number }>();
  list.forEach(x => {
    const { factory, size, at } = pick(x); const key = `${factory}|${size}`;
    const g = m.get(key) ?? { key, factory, size, items: [], last: 0 };
    g.items.push(x); g.last = Math.max(g.last, +new Date(at)); m.set(key, g);
  });
  return [...m.values()].sort((a, b) => b.last - a.last).map(({ last, ...g }) => g);   // most recently active size first; items keep the order they came in
}

// ---- Accordion: top row = roller size + factory badge + item count; tap to unfurl the items ----
type Props<T> = { groups: RollerGroup<T>[]; scope: string; open: Record<string, boolean>; setOpen: (v: Record<string, boolean>) => void; pcs: (x: T) => number; render: (x: T) => React.ReactNode };
export function RollerAccordion<T>({ groups, scope, open, setOpen, pcs, render }: Props<T>) {
  if (!groups.length) return <p className="text-slate-500 py-3 text-center">None</p>;
  return (<div className="space-y-2">{groups.map(g => { const k = `${scope}|${g.key}`; const isOpen = !!open[k];
    return (<div key={k} className="rounded-lg bg-slate-800">
      <button onClick={() => setOpen({ ...open, [k]: !isOpen })} aria-expanded={isOpen} className="w-full min-h-16 px-3 py-2 flex items-center gap-2 text-left">
        <span className="text-xl font-extrabold">{g.size}</span><FactoryTag f={g.factory}/>
        <span className="ml-auto text-sm text-slate-300">{g.items.length} item{g.items.length === 1 ? '' : 's'} · {g.items.reduce((a, x) => a + pcs(x), 0)} pcs</span>
        <span>{isOpen ? '▲' : '▼'}</span></button>
      {isOpen && <div className="px-3 pb-3 space-y-2">{g.items.map(render)}</div>}
    </div>); })}</div>);
}
