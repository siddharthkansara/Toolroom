'use client';
import { Fragment, useState } from 'react';
import { FACTORIES, FCHIP } from '@/lib/factories';
import type { DeliveryFull, OrderFull } from '@/types/database';

const COLS = ['DIE_TOP', 'BOTTOM', 'FACING_PUNCH', 'SHORT_PIN', 'OTHER'] as const;
type Col = (typeof COLS)[number];
type Cell = Record<Col, number> & { total: number };
const LABEL: Record<Col, string> = { DIE_TOP: 'Die Top', BOTTOM: 'Bottom', FACING_PUNCH: 'Forging Punch', SHORT_PIN: 'Forging Pin', OTHER: 'Other' };
const FILL: Record<string, string> = { NIC: 'fill-sky-600', PEW: 'fill-violet-600', BABA: 'fill-orange-600' };
const blank = (): Cell => ({ DIE_TOP: 0, BOTTOM: 0, FACING_PUNCH: 0, SHORT_PIN: 0, OTHER: 0, total: 0 });
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDay = (iso: string) => ymd(new Date(iso));
const addDays = (day: string, n: number) => { const d = new Date(day + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const weekOf = (day: string) => addDays(day, -((new Date(day + 'T00:00:00').getDay() + 6) % 7));   // weeks run Monday to Sunday
const short = (day: string) => new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
const colOf = (o: OrderFull | null): Col => { const t = o?.tooling?.tool_type; return t === 'DIE_TOP' || t === 'BOTTOM' || t === 'FACING_PUNCH' || t === 'SHORT_PIN' ? t : 'OTHER'; };
const FTag = ({ f }: { f: string }) => <span className={`${FCHIP[f] ?? 'bg-slate-600'} text-white rounded px-2 py-0.5 text-sm font-bold`}>{f}</span>;
const chip = (on: boolean) => `px-5 min-h-12 rounded-xl border-2 text-lg font-bold ${on ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`;

type B = { label: string; vals: Record<string, number> };
function Chart({ buckets, facs }: { buckets: B[]; facs: string[] }) {
  const W = 760, H = 240, L = 40, R = 8, T = 18, Bt = 34, iw = W - L - R, ih = H - T - Bt;
  const tot = (b: B) => facs.reduce((a, f) => a + (b.vals[f] ?? 0), 0);
  const max = Math.max(1, ...buckets.map(tot));
  const nice = max > 200 ? 100 : max > 50 ? 50 : 10; const top = Math.max(10, Math.ceil(max / nice) * nice);
  const bw = iw / Math.max(1, buckets.length); const step = buckets.length > 20 ? Math.ceil(buckets.length / 12) : 1;
  return (<svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Toolings made">
    {[0, 0.5, 1].map(p => <g key={p}><line x1={L} x2={W - R} y1={T + ih * (1 - p)} y2={T + ih * (1 - p)} className="stroke-current text-slate-500" opacity=".3"/>
      <text x={L - 6} y={T + ih * (1 - p) + 4} textAnchor="end" fontSize="11" className="fill-current text-slate-400">{Math.round(top * p)}</text></g>)}
    {buckets.map((b, i) => { let y = T + ih; const x = L + i * bw + bw * 0.15; const total = tot(b);
      return (<g key={i}><title>{`${b.label}: ${facs.map(f => `${f} ${b.vals[f] ?? 0}`).join(', ')} · total ${total}`}</title>
        {facs.map(f => { const h = ((b.vals[f] ?? 0) / top) * ih; y -= h; return h > 0 ? <rect key={f} x={x} y={y} width={bw * 0.7} height={h} className={FILL[f] ?? 'fill-slate-500'}/> : null; })}
        {total > 0 && buckets.length <= 31 && <text x={x + bw * 0.35} y={y - 3} textAnchor="middle" fontSize="10" className="fill-current text-slate-300">{total}</text>}
        {i % step === 0 && <text x={x + bw * 0.35} y={H - 14} textAnchor="middle" fontSize="11" className="fill-current text-slate-400">{b.label}</text>}</g>); })}
  </svg>);
}

// Toolings made (pieces confirmed by the CNC operator): weekly/daily graph, then week -> day -> factory -> tool-type table
export function DailyProduction({ data, from, to, mode, fsel, focus }: { data: DeliveryFull[]; from: Date; to: Date; mode: 'month' | 'year'; fsel: string | null; focus: string | null }) {
  const [weekly, setWeekly] = useState(false);
  const [openW, setOpenW] = useState<Record<string, boolean>>({});
  const facs: string[] = fsel ? [fsel] : [...FACTORIES];
  const f0 = ymd(from), t0 = ymd(to);   // days from f0 up to (not including) t0

  const byDay: Record<string, Record<string, Cell>> = {};
  data.forEach(d => {
    if (!d.ord || !facs.includes(d.factory_id)) return;
    const day = toDay(d.made_at); if (day < f0 || day >= t0) return;
    const c = ((byDay[day] ??= {})[d.factory_id] ??= blank());
    const k = colOf(d.ord); c[k] += d.qty_made; c.total += d.qty_made;
  });
  const sumCells = (cells: Cell[]) => { const s = blank(); cells.forEach(c => { COLS.forEach(k => { s[k] += c[k]; }); s.total += c.total; }); return s; };
  const dayTotal = (day: string) => sumCells(Object.values(byDay[day] ?? {}));
  const weeks: { key: string; days: string[] }[] = [];
  Object.keys(byDay).sort().reverse().forEach(day => {
    const k = weekOf(day); const w = weeks.find(x => x.key === k) ?? (() => { const n = { key: k, days: [] as string[] }; weeks.push(n); return n; })(); w.days.push(day); });
  const scopeSum = (f: string) => Object.values(byDay).reduce((a, m) => a + (m[f]?.total ?? 0), 0);
  const grand = facs.reduce((a, f) => a + scopeSum(f), 0);

  const mk = (label: string, keys: string[]): B => ({ label, vals: Object.fromEntries(facs.map(f => [f, keys.reduce((a, k) => a + (byDay[k]?.[f]?.total ?? 0), 0)])) });
  const gran = weekly ? 'week' : mode === 'year' ? 'month' : 'day';
  const buckets: B[] = [];
  if (gran === 'day') { for (let d = f0; d < t0; d = addDays(d, 1)) buckets.push(mk(String(+d.slice(8)), [d])); }
  else if (gran === 'week') { for (let w = weekOf(f0); w < t0; w = addDays(w, 7)) buckets.push(mk(short(w), Array.from({ length: 7 }, (_, i) => addDays(w, i)).filter(k => k >= f0 && k < t0))); }
  else { for (let i = 0; i < 12; i++) { const m = new Date(from.getFullYear(), from.getMonth() + i, 1); const pre = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
    buckets.push(mk(m.toLocaleDateString('en-IN', { month: 'short' }), Object.keys(byDay).filter(k => k.startsWith(pre)))); } }

  const isOpen = (k: string) => openW[k] ?? (focus ? k === weekOf(focus) : k === weeks[0]?.key);
  const scope = mode === 'year' ? 'year' : 'month';

  return (<div className="space-y-4">
    <div className="flex flex-wrap items-center gap-3"><span className="text-slate-400">Made this {scope}:</span>
      {facs.map(f => <span key={f} className="flex items-center gap-1"><FTag f={f}/><b>{scopeSum(f)}</b></span>)}
      <span className="ml-auto text-lg">All: <b className="text-2xl">{grand}</b></span></div>

    <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
      <div className="flex flex-wrap items-center gap-2 mb-2"><span className="font-semibold mr-2">Toolings made per {gran}</span>
        <button onClick={() => setWeekly(false)} className={chip(!weekly)}>{mode === 'year' ? 'Monthly' : 'Daily'}</button>
        <button onClick={() => setWeekly(true)} className={chip(weekly)}>Weekly</button>
        <span className="ml-auto flex gap-3 text-sm">{facs.map(f => <span key={f} className="flex items-center gap-1"><span className={`inline-block w-3 h-3 rounded ${FCHIP[f] ?? 'bg-slate-600'}`}/>{f}</span>)}</span></div>
      <Chart buckets={buckets} facs={facs}/></div>

    {!weeks.length && <p className="text-slate-500">No toolings made in this {scope}.</p>}
    {weeks.length > 0 && <div className="overflow-x-auto"><table className="w-full text-sm">
      <thead><tr className="text-left text-slate-400"><th className="py-1">Date</th><th>Factory</th>{COLS.map(c => <th key={c} className="text-right">{LABEL[c]}</th>)}<th className="text-right">Total</th></tr></thead>
      {weeks.map(w => { const s = sumCells(w.days.map(dayTotal)); const open = isOpen(w.key);
        return (<tbody key={w.key}>
          <tr onClick={() => setOpenW({ ...openW, [w.key]: !open })} className="border-t border-slate-700 bg-slate-800 cursor-pointer font-bold">
            <td colSpan={2} className="py-2 pl-2">{open ? '▲' : '▼'} Week {short(w.key)} – {short(addDays(w.key, 6))}</td>
            {COLS.map(c => <td key={c} className="text-right">{s[c]}</td>)}<td className="text-right pr-2">{s.total}</td></tr>
          {open && w.days.map(day => { const rows = facs.filter(f => byDay[day][f]); const t = dayTotal(day);
            return (<Fragment key={day}>
              {rows.map((f, i) => { const c = byDay[day][f]; return (<tr key={f} className="border-t border-slate-800">
                <td className="py-1 pl-2">{i === 0 ? new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' }) : ''}</td>
                <td><FTag f={f}/></td>{COLS.map(k => <td key={k} className="text-right">{c[k] || '·'}</td>)}<td className="text-right pr-2">{c.total}</td></tr>); })}
              {rows.length > 1 && <tr className="font-semibold"><td/><td className="text-slate-400">Day total</td>{COLS.map(k => <td key={k} className="text-right">{t[k] || '·'}</td>)}<td className="text-right pr-2">{t.total}</td></tr>}
            </Fragment>); })}
        </tbody>); })}</table></div>}
    <p className="text-xs text-slate-500">Counts are pieces the CNC operator confirmed as made, shown on the day they were confirmed. Weeks run Monday to Sunday. The table lists only days with production; the graph shows every day.</p>
  </div>);
}
