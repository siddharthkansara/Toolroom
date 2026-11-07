'use client';
import { useState } from 'react';
import { FACTORIES, FCHIP } from '@/lib/factories';
import { TOOL_LABEL, type LatheLog } from '@/types/database';

// Owner dashboard, "Lathe": lathe run time.
// A month is shown day by day, a full year month by month. Bars are stacked by factory.
// Run time is counted on the day the cycle ENDED, as before. Logs come from the dashboard (already filtered by factory).

const IST = 'Asia/Kolkata';
const istDay = (x: string | number | Date) => new Date(x).toLocaleDateString('en-CA', { timeZone: IST });
const dur = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
const Tag = ({ f }: { f: string }) => <span className={`${FCHIP[f] ?? 'bg-slate-600'} text-white rounded-lg font-extrabold px-3 py-0.5 text-sm`}>{f}</span>;
const th = 'px-3 py-2 text-left whitespace-nowrap';

type Bucket = { k: string; label: string; full: string };

export function LatheView({ logs, rs, re, daily, fsel, period }: { logs: LatheLog[]; rs: Date; re: Date; daily: boolean; fsel: string | null; period: string }) {
  const [showC, setShowC] = useState(false);
  const facs: string[] = fsel ? [fsel] : [...FACTORIES];

  // the days of the month, or the 12 months of the year
  const buckets: Bucket[] = [];
  if (daily) {
    for (let d = new Date(rs); d < re; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))
      buckets.push({ k: istDay(d), label: String(d.getDate()), full: d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) });
  } else {
    for (let m = 0; m < 12; m++) { const d = new Date(rs.getFullYear(), rs.getMonth() + m, 1);
      buckets.push({ k: istDay(d).slice(0, 7), label: d.toLocaleDateString('en-IN', { month: 'short' }), full: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) }); }
  }

  const sec: Record<string, Record<string, number>> = {};
  logs.forEach(l => { const k = daily ? istDay(l.ended_at) : istDay(l.ended_at).slice(0, 7); const e = (sec[k] ??= {}); e[l.factory_id] = (e[l.factory_id] ?? 0) + l.duration_seconds; });
  const rows = buckets.map(b => { const per = facs.map(f => sec[b.k]?.[f] ?? 0); return { ...b, per, total: per.reduce((a, x) => a + x, 0) }; });
  const max = Math.max(1, ...rows.map(r => r.total));
  const total = rows.reduce((a, r) => a + r.total, 0);
  const byFac = facs.map((f, i) => ({ f, s: rows.reduce((a, r) => a + r.per[i], 0) }));
  const busiest = [...byFac].sort((a, b) => b.s - a.s)[0];
  const active = rows.filter(r => r.total > 0).length;
  const unit = daily ? 'day' : 'month';

  return (<div className="space-y-5">
    <h2 className="text-2xl font-bold">Lathe run time · {period}</h2>
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div className="bg-slate-900 rounded-2xl p-5 border border-slate-800"><div className="text-slate-400">Total run time</div><div className="text-4xl font-extrabold mt-1">{dur(total)}</div><div className="text-sm text-slate-400">{logs.length} cycle{logs.length === 1 ? '' : 's'}</div></div>
      <div className="bg-slate-900 rounded-2xl p-5 border border-slate-800"><div className="text-slate-400">{fsel ? `Average per ${unit} worked` : 'Busiest factory'}</div>
        <div className="text-4xl font-extrabold mt-1">{fsel ? (active ? dur(Math.round(total / active)) : '—') : (busiest && busiest.s > 0 ? busiest.f : '—')}</div>
        <div className="text-sm text-slate-400">{fsel ? `${active} ${unit}${active === 1 ? '' : 's'} with lathe work` : busiest && total ? `${Math.round((busiest.s / total) * 100)}% of lathe time` : 'No cycles yet'}</div></div>
      <div className="bg-slate-900 rounded-2xl p-5 border border-slate-800"><div className="text-slate-400">Busiest {unit}</div>
        <div className="text-4xl font-extrabold mt-1">{total ? dur(max) : '—'}</div><div className="text-sm text-slate-400">{total ? rows.find(r => r.total === max)?.full : 'No cycles yet'}</div></div></div>

    <div className="bg-slate-900 rounded-2xl p-5 border border-slate-800 space-y-3">
      <div className="flex gap-x-6 gap-y-2 flex-wrap items-center">{byFac.map(x => <span key={x.f} className="flex items-center gap-2"><span className={`${FCHIP[x.f] ?? 'bg-slate-500'} inline-block w-4 h-4 rounded`}/><b>{x.f}</b><span className="text-slate-400">{dur(x.s)}{total ? ` · ${Math.round((x.s / total) * 100)}%` : ''}</span></span>)}</div>
      <div className="flex items-end gap-1 h-56 border-b border-slate-700">{rows.map(r => (
        <div key={r.k} title={`${r.full}: ${dur(r.total)}${facs.length > 1 ? ' (' + facs.map((f, i) => `${f} ${dur(r.per[i])}`).join(', ') + ')' : ''}`} className="flex-1 h-full flex flex-col justify-end">
          {facs.map((f, i) => r.per[i] > 0 && <div key={f} className={FCHIP[f] ?? 'bg-slate-500'} style={{ height: `${(r.per[i] / max) * 100}%`, minHeight: 2 }}/>)}</div>))}</div>
      <div className="flex gap-1">{rows.map(r => <div key={r.k} className="flex-1 text-center text-[10px] sm:text-xs text-slate-400">{r.label}</div>)}</div>
      <p className="text-xs text-slate-500">Each bar is one {unit}. Tallest bar: {total ? dur(max) : '—'}. Press and hold a bar to see its exact time.</p></div>

    <div className="bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden">
      <div className="max-h-[28rem] overflow-auto"><table className="w-full text-left">
        <thead className="bg-slate-800 text-slate-300 text-sm sticky top-0"><tr><th className={th}>{daily ? 'Date' : 'Month'}</th>{facs.map(f => <th key={f} className={th}>{f}</th>)}{facs.length > 1 && <th className={th}>Total</th>}</tr></thead>
        <tbody>{rows.map(r => <tr key={r.k} className="border-t border-slate-800">
          <td className="px-3 py-2 whitespace-nowrap">{r.full}</td>
          {r.per.map((s, i) => <td key={facs[i]} className={`px-3 py-2 whitespace-nowrap ${s ? '' : 'text-slate-600'}`}>{s ? dur(s) : '—'}</td>)}
          {facs.length > 1 && <td className={`px-3 py-2 whitespace-nowrap font-bold ${r.total ? '' : 'text-slate-600'}`}>{r.total ? dur(r.total) : '—'}</td>}</tr>)}
          <tr className="border-t-2 border-slate-600 bg-slate-800 font-extrabold"><td className="px-3 py-2">Total</td>{byFac.map(x => <td key={x.f} className="px-3 py-2 whitespace-nowrap">{dur(x.s)}</td>)}{facs.length > 1 && <td className="px-3 py-2 whitespace-nowrap">{dur(total)}</td>}</tr></tbody></table></div></div>

    <div>
      <button onClick={() => setShowC(!showC)} className="min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold">{showC ? 'Hide latest cycles' : 'Show latest cycles'}</button>
      {showC && <div className="overflow-x-auto mt-3"><table className="w-full text-sm min-w-[560px]"><thead><tr className="text-left text-slate-400"><th className="py-1">Ended</th><th>Factory</th><th>Roller size</th><th>Tool</th><th>Duration</th><th>Result</th></tr></thead>
        <tbody>{logs.slice(0, 20).map(l => <tr key={l.id} className="border-t border-slate-800"><td className="py-1 whitespace-nowrap">{new Date(l.ended_at).toLocaleString('en-IN', { timeZone: IST, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}</td><td><Tag f={l.factory_id}/></td><td>{l.roller_size ?? '—'}</td>
          <td>{l.tool_type && l.tool_type in TOOL_LABEL ? TOOL_LABEL[l.tool_type as keyof typeof TOOL_LABEL] : l.tool_type ?? '—'}</td><td>{dur(l.duration_seconds)}</td>
          <td className={l.action === 'COMPLETED' ? 'text-green-400' : 'text-amber-400'}>{l.action === 'COMPLETED' ? 'Completed' : 'Stopped'}{l.qty_made != null ? ` · ${l.qty_made} pcs` : ''}</td></tr>)}</tbody></table>
        <p className="text-xs text-slate-500 mt-2">The latest 20 cycles in this period.</p></div>}</div>
    <p className="text-xs text-slate-500">Run time runs from Start to Completed or Stop and is counted on the day the cycle ended. When a factory is chosen above, only that factory's cycles are counted. Pick a month for a day-by-day view, or Full year for month by month.</p>
  </div>);
}
