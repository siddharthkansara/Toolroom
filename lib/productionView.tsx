'use client';
import { Fragment, useState } from 'react';
import { FACTORIES, FCHIP, rollerLabel } from '@/lib/factories';
import type { DeliveryFull, OrderFull } from '@/types/database';

// Owner dashboard, "Production": toolings made (pieces the CNC operator confirmed), counted on the day each batch was confirmed.
// Two views: the chart (day by day, or month by month for a year) and a list by roller size.

const COLS = ['DIE_TOP', 'BOTTOM', 'FACING_PUNCH', 'SHORT_PIN', 'OTHER'] as const;
type Col = (typeof COLS)[number];
const LABEL: Record<Col, string> = { DIE_TOP: 'Die Top', BOTTOM: 'Bottom', FACING_PUNCH: 'Forging Punch', SHORT_PIN: 'Forging Pin', OTHER: 'Other' };
const SHORT: Record<Col, string> = { DIE_TOP: 'Die Top', BOTTOM: 'Bottom', FACING_PUNCH: 'Punch', SHORT_PIN: 'Pin', OTHER: 'Other' };
const TBG: Record<Col, string> = { DIE_TOP: 'bg-amber-500', BOTTOM: 'bg-emerald-500', FACING_PUNCH: 'bg-rose-500', SHORT_PIN: 'bg-indigo-400', OTHER: 'bg-slate-500' };
const colOf = (o: OrderFull | null): Col => { const t = o?.tooling?.tool_type; return t === 'DIE_TOP' || t === 'BOTTOM' || t === 'FACING_PUNCH' || t === 'SHORT_PIN' ? t : 'OTHER'; };

const IST = 'Asia/Kolkata';
const pad = (n: number) => String(n).padStart(2, '0');
const istDay = (x: string | number | Date) => new Date(x).toLocaleDateString('en-CA', { timeZone: IST });
const addDays = (day: string, n: number) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekOf = (day: string) => addDays(day, -((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7));   // weeks run Monday to Sunday
const fmt = (day: string, o: Intl.DateTimeFormatOptions) => new Date(day + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', ...o });
const n0 = (n: number) => Math.round(n).toLocaleString('en-IN');
const chip = (on: boolean) => `px-5 min-h-12 rounded-xl border-2 text-lg font-bold ${on ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`;
const th = 'px-3 py-2 text-left whitespace-nowrap';

type Hit = { day: string; f: string; col: Col; qty: number; rec: number; o: OrderFull };
type Bucket = { k: string; label: string; full: string };

export function ProductionView({ data, from, to, mode, fsel, period }: { data: DeliveryFull[]; from: Date; to: Date; mode: 'month' | 'year'; fsel: string | null; period: string }) {
  const [tab, setTab] = useState<'chart' | 'size'>('chart'); const [by, setBy] = useState<'tool' | 'factory' | 'both'>('tool');
  const [weekly, setWeekly] = useState(false); const [showTable, setShowTable] = useState(false); const [q, setQ] = useState('');
  const facs: string[] = fsel ? [fsel] : [...FACTORIES];
  const f0 = istDay(from), t0 = istDay(to);   // days from f0 up to (not including) t0
  const seriesBy: 'tool' | 'factory' = fsel || by === 'both' ? 'tool' : by;   // one factory, or the combined table: the chart is coloured by tool type

  const hits: Hit[] = [];
  data.forEach(d => {
    if (!d.ord || !facs.includes(d.factory_id)) return;
    const day = istDay(d.made_at); if (day < f0 || day >= t0) return;
    hits.push({ day, f: d.factory_id, col: colOf(d.ord), qty: d.qty_made, rec: d.qty_received ?? 0, o: d.ord });
  });
  const total = hits.reduce((a, h) => a + h.qty, 0);
  const recd = hits.reduce((a, h) => a + h.rec, 0);
  const keyOf = (h: Hit): string => (seriesBy === 'tool' ? h.col : h.f);
  const allKeys: string[] = seriesBy === 'tool' ? [...COLS] : facs;
  const tot: Record<string, number> = {}; hits.forEach(h => { tot[keyOf(h)] = (tot[keyOf(h)] ?? 0) + h.qty; });
  const keys = allKeys.filter(k => (tot[k] ?? 0) > 0 || seriesBy === 'factory' || k !== 'OTHER');
  const colour = (k: string) => (seriesBy === 'tool' ? TBG[k as Col] : FCHIP[k] ?? 'bg-slate-500');
  const name = (k: string) => (seriesBy === 'tool' ? LABEL[k as Col] : k);

  const gran = weekly ? 'week' : mode === 'year' ? 'month' : 'day';
  const buckets: Bucket[] = [];
  if (gran === 'day') { for (let d = f0; d < t0; d = addDays(d, 1)) buckets.push({ k: d, label: String(+d.slice(8)), full: fmt(d, { weekday: 'short', day: 'numeric', month: 'short' }) }); }
  else if (gran === 'week') { for (let w = weekOf(f0); w < t0; w = addDays(w, 7)) buckets.push({ k: w, label: fmt(w, { day: '2-digit', month: 'short' }), full: `Week ${fmt(w, { day: '2-digit', month: 'short' })} – ${fmt(addDays(w, 6), { day: '2-digit', month: 'short' })}` }); }
  else { const y = +f0.slice(0, 4), m0 = +f0.slice(5, 7) - 1;
    for (let i = 0; i < 12; i++) { const d = new Date(Date.UTC(y, m0 + i, 1)); const k = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
      buckets.push({ k, label: fmt(k + '-01', { month: 'short' }), full: fmt(k + '-01', { month: 'long', year: 'numeric' }) }); } }
  const bk = (day: string) => (gran === 'day' ? day : gran === 'week' ? weekOf(day) : day.slice(0, 7));
  const rows = buckets.map(b => ({ ...b, vals: {} as Record<string, number>, fc: {} as Record<string, number>, total: 0 }));
  const byK: Record<string, (typeof rows)[number]> = {}; rows.forEach(r => { byK[r.k] = r; });
  hits.forEach(h => { const r = byK[bk(h.day)]; if (r) { r.vals[keyOf(h)] = (r.vals[keyOf(h)] ?? 0) + h.qty; r.fc[`${h.f}|${h.col}`] = (r.fc[`${h.f}|${h.col}`] ?? 0) + h.qty; r.total += h.qty; } });
  const tcols = COLS.filter(c => c !== 'OTHER' || hits.some(h => h.col === 'OTHER'));   // for the combined table
  const fct: Record<string, number> = {}; hits.forEach(h => { fct[`${h.f}|${h.col}`] = (fct[`${h.f}|${h.col}`] ?? 0) + h.qty; });
  const fsum = (f: string, fc: Record<string, number>) => tcols.reduce((a, c) => a + (fc[`${f}|${c}`] ?? 0), 0);
  const max = Math.max(1, ...rows.map(r => r.total));
  const topTotals = new Set(rows.map(r => r.total).filter(x => x > 0).sort((a, b) => b - a).slice(0, 3));
  const showAll = rows.length <= 16;
  const unit = gran === 'day' ? 'Day' : gran === 'week' ? 'Week' : 'Month';

  // Download exactly the table that is chosen above (same rows, same columns, same order), as a CSV that opens in Excel
  const download = () => {
    const body = rows.filter(r => r.total > 0).reverse();   // newest first, like the screen
    const out: (string | number)[][] = [];
    if (by === 'both') {
      out.push([unit, ...facs.flatMap(f => [f, ...tcols.map(() => '')]), 'Total']);
      out.push(['', ...facs.flatMap(() => [...tcols.map(c => LABEL[c]), 'Total']), '']);
      body.forEach(r => out.push([r.full, ...facs.flatMap(f => [...tcols.map(c => r.fc[`${f}|${c}`] ?? 0), fsum(f, r.fc)]), r.total]));
      out.push(['Total', ...facs.flatMap(f => [...tcols.map(c => fct[`${f}|${c}`] ?? 0), fsum(f, fct)]), total]);
    } else {
      out.push([unit, ...keys.map(name), 'Total']);
      body.forEach(r => out.push([r.full, ...keys.map(k => r.vals[k] ?? 0), r.total]));
      out.push(['Total', ...keys.map(k => tot[k] ?? 0), total]);
    }
    const text = '\ufeff' + out.map(l => l.map(c => (typeof c === 'number' ? String(c) : `"${c.replace(/"/g, '""')}"`)).join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = `toolings-made_${fsel ?? 'all-factories'}_${period.replace(/[^A-Za-z0-9]+/g, '-')}_${by === 'both' ? 'factory-and-tool' : seriesBy === 'tool' ? 'by-tool' : 'by-factory'}.csv`; a.click();
  };

  // by roller size
  const grp: Record<string, { f: string; size: string; drg: string | null; tools: Record<string, number>; made: number; recd: number }> = {};
  hits.forEach(h => { const key = `${h.o.factory_id}|${h.o.roller?.roller_size ?? '—'}`;
    const g = (grp[key] ??= { f: h.o.factory_id, size: h.o.roller?.roller_size ?? '—', drg: h.o.roller?.customer_drg ?? null, tools: {}, made: 0, recd: 0 });
    g.tools[h.col] = (g.tools[h.col] ?? 0) + h.qty; g.made += h.qty; g.recd += h.rec; });
  const list = Object.values(grp).filter(g => rollerLabel(g.f, g.size).toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => b.made - a.made);

  return (<div className="space-y-5">
    <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800 space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div><div className="text-slate-400">Toolings made · {period}</div><div className="text-6xl font-extrabold leading-none mt-1">{n0(total)}</div><div className="text-sm text-slate-400 mt-1">received at plants: {n0(recd)}</div></div>
        {!fsel && <div className="flex gap-x-5 gap-y-2 flex-wrap text-lg">{facs.map(f => <span key={f} className="flex items-center gap-2"><span className={`${FCHIP[f] ?? 'bg-slate-500'} inline-block w-4 h-4 rounded`}/><b>{f}</b> {n0(hits.filter(h => h.f === f).reduce((a, h) => a + h.qty, 0))}</span>)}</div>}</div>
      <div className="flex gap-x-5 gap-y-2 flex-wrap">{COLS.filter(c => hits.some(h => h.col === c) || c !== 'OTHER').map(c => <span key={c} className="flex items-center gap-2"><span className={`${TBG[c]} inline-block w-4 h-4 rounded`}/>{LABEL[c]} <b>{n0(hits.filter(h => h.col === c).reduce((a, h) => a + h.qty, 0))}</b></span>)}</div></div>

    <div className="flex gap-2 flex-wrap">
      <button onClick={() => setTab('chart')} className={chip(tab === 'chart')}>{mode === 'year' ? 'Month by month' : 'Day by day'}</button>
      <button onClick={() => setTab('size')} className={chip(tab === 'size')}>By roller size</button></div>

    {tab === 'chart' && <div className="bg-slate-900 rounded-2xl p-5 border border-slate-800 space-y-4">
      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={() => setWeekly(false)} className={chip(!weekly)}>{mode === 'year' ? 'Monthly' : 'Daily'}</button>
        <button onClick={() => setWeekly(true)} className={chip(weekly)}>Weekly</button>
        {!fsel && <><span className="text-slate-400 ml-3">Colour by</span>
          <button onClick={() => setBy('tool')} className={chip(by === 'tool')}>Tool type</button>
          <button onClick={() => setBy('factory')} className={chip(by === 'factory')}>Factory</button>
          <button onClick={() => { setBy('both'); setShowTable(true); }} className={chip(by === 'both')}>Factory + tool type</button></>}</div>
      {by === 'both' && !fsel && <p className="text-xs text-slate-500">The chart is coloured by tool type. The table shows factory and tool type together.</p>}
      <div className="flex gap-x-5 gap-y-1 flex-wrap text-sm">{keys.map(k => <span key={k} className="flex items-center gap-2"><span className={`${colour(k)} inline-block w-3 h-3 rounded`}/>{name(k)}</span>)}</div>
      <div className="flex items-end gap-1 h-56 border-b border-slate-700">{rows.map(r => (
        <div key={r.k} title={`${r.full}: ${n0(r.total)}${keys.length > 1 ? ' (' + keys.filter(k => r.vals[k]).map(k => `${name(k)} ${r.vals[k]}`).join(', ') + ')' : ''}`} className="flex-1 h-full relative flex flex-col-reverse justify-start">
          {keys.map(k => (r.vals[k] ?? 0) > 0 && <div key={k} className={colour(k)} style={{ height: `${((r.vals[k] ?? 0) / max) * 88}%`, minHeight: 2 }}/>)}
          {r.total > 0 && (showAll || topTotals.has(r.total)) && <div className="absolute left-0 right-0 text-center text-[10px] sm:text-xs text-slate-300" style={{ bottom: `${(r.total / max) * 88}%` }}>{n0(r.total)}</div>}</div>))}</div>
      <div className="flex gap-1">{rows.map(r => <div key={r.k} className="flex-1 text-center text-[10px] sm:text-xs text-slate-400">{r.label}</div>)}</div>
      {!total && <p className="text-slate-500">Nothing was made in this period.</p>}
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setShowTable(!showTable)} className="min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold">{showTable ? 'Hide table' : 'Show table'}</button>
        <button onClick={download} disabled={!total} className="min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold disabled:opacity-50">⬇ Download table (CSV)</button></div>
      {showTable && by === 'both' && <div className="max-h-[28rem] overflow-auto rounded-xl border border-slate-800"><table className="w-full text-left text-sm" style={{ minWidth: 120 + facs.length * (tcols.length + 1) * 62 }}>
        <thead className="bg-slate-800 text-slate-300 text-xs sticky top-0">
          <tr><th rowSpan={2} className="px-3 py-1.5 whitespace-nowrap align-bottom">{unit}</th>{facs.map(f => <th key={f} colSpan={tcols.length + 1} className="px-2 py-1.5 text-center border-l border-slate-700"><span className={`${FCHIP[f] ?? 'bg-slate-500'} inline-block w-3 h-3 rounded mr-2 align-middle`}/>{f}</th>)}<th rowSpan={2} className="px-3 py-1.5 text-right align-bottom border-l border-slate-700">Total</th></tr>
          <tr>{facs.map(f => <Fragment key={f}>{tcols.map((c, i) => <th key={c} title={LABEL[c]} className={`px-2 py-1 text-right whitespace-nowrap ${i === 0 ? 'border-l border-slate-700' : ''}`}>{SHORT[c]}</th>)}<th className="px-2 py-1 text-right">Total</th></Fragment>)}</tr></thead>
        <tbody>{rows.filter(r => r.total > 0).reverse().map(r => <tr key={r.k} className="border-t border-slate-800"><td className="px-3 py-1 whitespace-nowrap">{r.full}</td>
          {facs.map(f => <Fragment key={f}>{tcols.map((c, i) => <td key={c} className={`px-2 py-1 text-right ${i === 0 ? 'border-l border-slate-700' : ''}`}>{r.fc[`${f}|${c}`] ? n0(r.fc[`${f}|${c}`]) : <span className="text-slate-600">—</span>}</td>)}<td className="px-2 py-1 text-right font-bold">{fsum(f, r.fc) ? n0(fsum(f, r.fc)) : <span className="text-slate-600">—</span>}</td></Fragment>)}
          <td className="px-3 py-1 text-right font-extrabold border-l border-slate-700">{n0(r.total)}</td></tr>)}
          <tr className="border-t-2 border-slate-600 bg-slate-800 font-extrabold"><td className="px-3 py-1.5">Total</td>{facs.map(f => <Fragment key={f}>{tcols.map((c, i) => <td key={c} className={`px-2 py-1.5 text-right ${i === 0 ? 'border-l border-slate-700' : ''}`}>{n0(fct[`${f}|${c}`] ?? 0)}</td>)}<td className="px-2 py-1.5 text-right">{n0(fsum(f, fct))}</td></Fragment>)}<td className="px-3 py-1.5 text-right border-l border-slate-700">{n0(total)}</td></tr></tbody></table></div>}
      {showTable && by !== 'both' && <div className="max-h-[28rem] overflow-auto rounded-xl border border-slate-800"><table className="w-full text-left">
        <thead className="bg-slate-800 text-slate-300 text-sm sticky top-0"><tr><th className={th}>{unit}</th>{keys.map(k => <th key={k} className={`${th} text-right`}>{name(k)}</th>)}<th className={`${th} text-right`}>Total</th></tr></thead>
        <tbody>{rows.filter(r => r.total > 0).reverse().map(r => <tr key={r.k} className="border-t border-slate-800"><td className="px-3 py-2 whitespace-nowrap">{r.full}</td>
          {keys.map(k => <td key={k} className="px-3 py-2 text-right">{r.vals[k] ? n0(r.vals[k]) : <span className="text-slate-600">—</span>}</td>)}<td className="px-3 py-2 text-right font-bold">{n0(r.total)}</td></tr>)}
          <tr className="border-t-2 border-slate-600 bg-slate-800 font-extrabold"><td className="px-3 py-2">Total</td>{keys.map(k => <td key={k} className="px-3 py-2 text-right">{n0(tot[k] ?? 0)}</td>)}<td className="px-3 py-2 text-right">{n0(total)}</td></tr></tbody></table></div>}
      <p className="text-xs text-slate-500">Pieces the CNC operator confirmed as made, shown on the day they were confirmed. Each bar is one {unit.toLowerCase()}. Weeks run Monday to Sunday. Press and hold a bar to see its exact numbers.</p></div>}

    {tab === 'size' && <div className="bg-slate-900 rounded-2xl p-5 border border-slate-800 space-y-3">
      <label className="block"><span className="block text-sm font-semibold text-slate-300 mb-1">Search roller size</span>
        <input className="h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full" placeholder="e.g. 31309 or PEW" value={q} onChange={e => setQ(e.target.value)}/></label>
      {!list.length && <p className="text-slate-500">{Object.keys(grp).length ? 'No roller size matches your search.' : 'Nothing made in this period.'}</p>}
      {list.map(g => <div key={`${g.f}|${g.size}`} className="border-t border-slate-800 pt-3 flex items-center gap-x-5 gap-y-2 flex-wrap">
        <div className="min-w-[10rem]"><div className="text-xl font-extrabold">{rollerLabel(g.f, g.size)}</div>{g.drg && <div className="text-sm text-slate-400">{g.drg}</div>}</div>
        <div className="flex gap-x-4 gap-y-1 flex-wrap flex-1">{COLS.filter(c => g.tools[c]).map(c => <span key={c} className="flex items-center gap-2 text-sm"><span className={`${TBG[c]} inline-block w-3 h-3 rounded`}/>{LABEL[c]} <b>{n0(g.tools[c])}</b></span>)}</div>
        <div className="text-right"><div className="text-3xl font-extrabold leading-none">{n0(g.made)}</div><div className="text-sm text-sky-400">received {n0(g.recd)}</div></div></div>)}
      <p className="text-xs text-slate-500">Largest first. Each line: factory - roller size, drawing, tools made, total made, received at the plant.</p></div>}
  </div>);
}
