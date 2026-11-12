'use client';
import { Fragment, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { SEL, DSEL, dt, gkey } from '@/lib/useOrders';
import { FACTORIES, FCHIP, mname, rollerLabel } from '@/lib/factories';
import { URGENCY } from '@/lib/urgency';
import { TOOL_LABEL, type OrderFull, type DeliveryFull } from '@/types/database';
import { CheckLines, CheckBadge } from '@/lib/checkView';
import { checkText, checkResult } from '@/lib/dimCheck';

// CNC History, two views:
//  Activity: one line per batch the operator confirmed (factory, roller size, tool, quantity, date and time).
//            Tap a line to open the whole order: every tool type ordered with it, what is made and what is left.
//  Monthly summary: Factory + tool type table for a month, with a CSV download (same as the owner dashboard).

type Win = 'today' | 'yesterday' | '7' | 'day';
const WINS: [Win, string][] = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', 'Last 7 days']];
const COLS = ['DIE_TOP', 'BOTTOM', 'FACING_PUNCH', 'SHORT_PIN'] as const;
type Col = (typeof COLS)[number];
const LABEL: Record<Col, string> = { DIE_TOP: 'Die Top', BOTTOM: 'Bottom', FACING_PUNCH: 'Forging Punch', SHORT_PIN: 'Forging Pin' };
const SHORT: Record<Col, string> = { DIE_TOP: 'Die Top', BOTTOM: 'Bottom', FACING_PUNCH: 'Punch', SHORT_PIN: 'Pin' };

const IST = 'Asia/Kolkata';
const istDay = (x: string | number | Date) => new Date(x).toLocaleDateString('en-CA', { timeZone: IST });
const addDays = (day: string, n: number) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonths = (ym: string, n: number) => { const d = new Date(`${ym}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const startOf = (day: string) => new Date(`${day}T00:00:00+05:30`).toISOString();
const fmt = (day: string, o: Intl.DateTimeFormatOptions) => new Date(day + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', ...o });
const n0 = (n: number) => Math.round(n).toLocaleString('en-IN');
const nm = (o: OrderFull) => (o.tooling ? TOOL_LABEL[o.tooling.tool_type] : o.custom_tool_name || 'Other tool');
const colOf = (o: OrderFull | null): Col | null => { const t = o?.tooling?.tool_type; return t === 'DIE_TOP' || t === 'BOTTOM' || t === 'FACING_PUNCH' || t === 'SHORT_PIN' ? t : null; };
const Tag = ({ f }: { f: string }) => <span className={`${FCHIP[f] ?? 'bg-slate-600'} text-white rounded-lg font-extrabold px-3 py-0.5 text-sm`}>{f}</span>;
const chip = (on: boolean) => `px-5 min-h-12 rounded-xl border-2 text-lg font-bold ${on ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`;
const btn = 'min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold disabled:opacity-50';
const th = 'px-3 py-2 text-left whitespace-nowrap';
const td = 'px-3 py-2 align-top';

const statusOf = (o: OrderFull, made: number): { label: string; tone: string } => {
  if (made >= o.quantity) return { label: '✔ Complete', tone: 'text-green-400' };
  if (o.status === 'CLOSED') return { label: made > 0 ? `Closed at ${made} of ${o.quantity}` : 'Closed, none made', tone: 'text-slate-400' };
  if (o.status === 'ON_LATHE') return { label: '⚙ On the lathe now', tone: 'text-amber-300' };
  if (made > 0) return { label: '◐ Partly made', tone: 'text-amber-300' };
  return { label: '✖ Not made yet', tone: 'text-red-400' };
};

const pageDel = async (fromIso: string, toIso: string): Promise<{ data: DeliveryFull[]; error: string }> => {
  let ds: DeliveryFull[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await supabase.from('deliveries').select(DSEL).gte('made_at', fromIso).lt('made_at', toIso).order('made_at', { ascending: false }).range(i, i + 999);
    if (error) return { data: ds, error: error.message };
    if (!data?.length) break;
    ds = ds.concat(data as unknown as DeliveryFull[]); if (data.length < 1000) break;
  }
  return { data: ds, error: '' };
};
const saveCsv = (out: (string | number)[][], name: string) => {
  const text = '\ufeff' + out.map(l => l.map(c => (typeof c === 'number' ? String(c) : `"${c.replace(/"/g, '""')}"`)).join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = name; a.click();
};

export function CncHistory({ fsel, sig }: { fsel: string | null; sig: number }) {
  const [sub, setSub] = useState<'activity' | 'summary'>('activity');
  const [win, setWin] = useState<Win>('today'); const [pick, setPick] = useState(''); const [q, setQ] = useState(''); const [openId, setOpenId] = useState('');
  const [del, setDel] = useState<DeliveryFull[]>([]); const [sibs, setSibs] = useState<OrderFull[]>([]); const [allDel, setAllDel] = useState<DeliveryFull[]>([]);
  const [busy, setBusy] = useState(true); const [err, setErr] = useState(''); const [tick, setTick] = useState(0);
  const [ym, setYm] = useState(istDay(Date.now()).slice(0, 7)); const [sumDel, setSumDel] = useState<DeliveryFull[]>([]); const [sBusy, setSBusy] = useState(true); const [sErr, setSErr] = useState('');
  const facs: string[] = fsel ? [fsel] : [...FACTORIES];

  const t = istDay(Date.now());
  const [fromD, toD] = win === 'today' ? [t, addDays(t, 1)] : win === 'yesterday' ? [addDays(t, -1), t] : win === '7' ? [addDays(t, -6), addDays(t, 1)] : [pick || t, addDays(pick || t, 1)];
  const fromIso = startOf(fromD); const toIso = startOf(toD);

  // Activity data: the batches made in the window, the other tool types of those orders, and every batch of those orders
  useEffect(() => {
    if (sub !== 'activity') return;
    let on = true; setBusy(true); setErr('');
    (async () => {
      const r = await pageDel(fromIso, toIso);
      if (r.error) { if (on) { setErr(r.error); setBusy(false); } return; }
      const groups = Array.from(new Set(r.data.map(d => d.ord?.order_group).filter((g): g is string => !!g)));
      let sib: OrderFull[] = [];
      for (let i = 0; i < groups.length; i += 40) { const { data } = await supabase.from('tool_orders').select(SEL).in('order_group', groups.slice(i, i + 40)); sib = sib.concat((data ?? []) as unknown as OrderFull[]); }
      const ids = Array.from(new Set([...r.data.map(d => d.order_id), ...sib.map(o => o.id)]));
      let all: DeliveryFull[] = [];
      for (let i = 0; i < ids.length; i += 60) { const { data } = await supabase.from('deliveries').select(DSEL).in('order_id', ids.slice(i, i + 60)); all = all.concat((data ?? []) as unknown as DeliveryFull[]); }
      if (!on) return; setDel(r.data); setSibs(sib); setAllDel(all); setBusy(false);
    })();
    return () => { on = false; };
  }, [sub, fromIso, toIso, tick, sig]);

  // Monthly summary data
  useEffect(() => {
    if (sub !== 'summary') return;
    let on = true; setSBusy(true); setSErr('');
    (async () => { const r = await pageDel(startOf(`${ym}-01`), startOf(`${addMonths(ym, 1)}-01`)); if (!on) return; setSErr(r.error); setSumDel(r.data); setSBusy(false); })();
    return () => { on = false; };
  }, [sub, ym, tick, sig]);

  // ---------- Activity ----------
  const orders = new Map<string, OrderFull>(); del.forEach(d => { if (d.ord) orders.set(d.ord.id, d.ord); }); sibs.forEach(o => orders.set(o.id, o));
  const batchesOf = new Map<string, DeliveryFull[]>(); (allDel.length ? allDel : del).forEach(d => { const l = batchesOf.get(d.order_id) ?? []; l.push(d); batchesOf.set(d.order_id, l); });
  const entries = del.filter(d => d.ord && (!fsel || d.factory_id === fsel) && (d.ord.roller?.roller_size ?? '').toLowerCase().includes(q.trim().toLowerCase()));
  const pcs = entries.reduce((a, d) => a + d.qty_made, 0);
  const groupOf = (d: DeliveryFull) => {
    const k = gkey(d.ord as OrderFull); const os = Array.from(orders.values()).filter(o => gkey(o) === k).sort((a, b) => a.slip_no - b.slip_no);
    const rows = os.map(o => { const bs = (batchesOf.get(o.id) ?? []).slice().sort((a, b) => +new Date(a.made_at) - +new Date(b.made_at)); const made = o.qty_made ?? 0;
      return { o, bs, made, toGo: o.status === 'CLOSED' ? 0 : Math.max(0, o.quantity - made), ...statusOf(o, made) }; });
    return { first: os[0] ?? (d.ord as OrderFull), rows, allDone: rows.length > 0 && rows.every(r => r.made >= r.o.quantity), madeTypes: rows.filter(r => r.made > 0).length };
  };
  const activityCsv = () => saveCsv([['Date and time', 'Factory', 'Roller size', 'Tool', 'Quantity made', 'Status at plant', 'CNC dimension check', 'Plant check result', 'Plant check'],
    ...entries.map(d => [dt(d.made_at), d.factory_id, d.ord?.roller?.roller_size ?? '', d.ord ? nm(d.ord) : '', d.qty_made, d.status === 'READY' ? 'At CNC' : 'Received', checkText(d.cnc_check), checkResult(d.plant_check), checkText(d.plant_check)])],
    `cnc-activity_${fromD}${toD === addDays(fromD, 1) ? '' : `-to-${addDays(toD, -1)}`}${fsel ? `_${fsel}` : ''}.csv`);
  const periodLabel = toD === addDays(fromD, 1) ? fromD : `${fromD} to ${addDays(toD, -1)}`;

  // ---------- Monthly summary ----------
  const hits = sumDel.filter(d => d.ord && facs.includes(d.factory_id)).map(d => ({ day: istDay(d.made_at), f: d.factory_id, col: colOf(d.ord), qty: d.qty_made }));
  const days: string[] = []; for (let d = `${ym}-01`; d < `${addMonths(ym, 1)}-01`; d = addDays(d, 1)) days.push(d);
  const rows = days.map(day => { const fc: Record<string, number> = {}; let total = 0;
    hits.forEach(h => { if (h.day === day && h.col) { fc[`${h.f}|${h.col}`] = (fc[`${h.f}|${h.col}`] ?? 0) + h.qty; total += h.qty; } }); return { day, fc, total }; })
    .filter(r => r.total > 0).reverse();
  const fct: Record<string, number> = {}; hits.forEach(h => { if (h.col) fct[`${h.f}|${h.col}`] = (fct[`${h.f}|${h.col}`] ?? 0) + h.qty; });
  const fsum = (f: string, fc: Record<string, number>) => COLS.reduce((a, c) => a + (fc[`${f}|${c}`] ?? 0), 0);
  const grand = facs.reduce((a, f) => a + fsum(f, fct), 0);
  const monthName = fmt(`${ym}-01`, { month: 'long', year: 'numeric' });
  const summaryCsv = () => saveCsv([
    ['Day', ...facs.flatMap(f => [f, ...COLS.map(() => '')]), 'Total'],
    ['', ...facs.flatMap(() => [...COLS.map(c => LABEL[c]), 'Total']), ''],
    ...rows.map(r => [fmt(r.day, { weekday: 'short', day: 'numeric', month: 'short' }), ...facs.flatMap(f => [...COLS.map(c => r.fc[`${f}|${c}`] ?? 0), fsum(f, r.fc)]), r.total]),
    ['Total', ...facs.flatMap(f => [...COLS.map(c => fct[`${f}|${c}`] ?? 0), fsum(f, fct)]), grand]],
    `cnc-made_${fsel ?? 'all-factories'}_${ym}.csv`);

  return (<div className="space-y-4">
    <div className="flex gap-2 flex-wrap">
      <button onClick={() => setSub('activity')} className={chip(sub === 'activity')}>Activity</button>
      <button onClick={() => setSub('summary')} className={chip(sub === 'summary')}>Monthly summary</button></div>

    {sub === 'activity' && <div className="space-y-3">
      <div className="flex gap-2 flex-wrap items-end">
        {WINS.map(([w, l]) => <button key={w} onClick={() => setWin(w)} className={`px-5 h-12 rounded-lg ${win === w ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-slate-800'}`}>{l}</button>)}
        <label className="block"><span className="block text-sm font-semibold text-slate-300 mb-1">Or pick one day</span><input type="date" max={t} value={pick} onChange={e => { setPick(e.target.value); setWin('day'); }} className={`h-12 rounded-lg border-2 px-3 text-lg ${win === 'day' ? 'border-amber-500 bg-slate-800' : 'border-slate-700 bg-slate-900'}`}/></label>
        <button onClick={() => setTick(x => x + 1)} className="px-4 h-12 rounded-lg bg-slate-800" aria-label="Refresh">↻</button>
        <button onClick={activityCsv} disabled={!entries.length} className={btn}>⬇ Download</button></div>
      <label className="block"><span className="block text-sm font-semibold text-slate-300 mb-1">Search roller size</span><input className="h-12 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-lg w-full" placeholder="Type roller size" value={q} onChange={e => setQ(e.target.value)}/></label>
      <div className="text-slate-300"><b className="text-slate-100 text-xl">{entries.length}</b> entr{entries.length === 1 ? 'y' : 'ies'} · <b className="text-slate-100 text-xl">{n0(pcs)}</b> pcs made · {periodLabel}</div>
      {busy && <p className="text-slate-400">Loading…</p>}
      {err && <p className="text-red-400">Could not load: {err}</p>}
      {!busy && !err && !entries.length && <p className="text-slate-500 py-6 text-center">Nothing was made in this period.</p>}
      {!busy && <div className="rounded-xl border border-slate-700 bg-slate-900 divide-y divide-slate-800">{entries.map(d => { const isOpen = openId === d.id; const o = d.ord as OrderFull; return (<div key={d.id}>
        <button onClick={() => setOpenId(isOpen ? '' : d.id)} aria-expanded={isOpen} className="w-full text-left px-4 py-2.5 flex items-center gap-x-4 gap-y-1 flex-wrap">
          <span className="text-sm text-slate-400 w-36 shrink-0">{dt(d.made_at)}</span>
          <Tag f={d.factory_id}/>
          <span className="text-lg font-extrabold">{rollerLabel(d.factory_id, o.roller?.roller_size ?? '—')}</span>
          <span className="text-amber-300 font-bold">{nm(o)}</span>
          <span className="ml-auto text-2xl font-extrabold">{n0(d.qty_made)} <span className="text-sm font-normal text-slate-400">pcs</span></span>
          <CheckBadge d={d}/><span className="text-slate-500">{isOpen ? '▲' : '▼'}</span></button>
        {isOpen && (() => { const g = groupOf(d); return (<div className="bg-slate-950/40 px-4 pb-4 pt-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-slate-300">Header {mname(g.first.machine_id)}</span><span className="text-slate-300">Ordered {dt(g.first.created_at)}</span>
            <span className={`ml-auto font-bold ${g.allDone ? 'text-green-400' : 'text-amber-300'}`}>{g.allDone ? '✔ Order complete' : `${g.madeTypes} of ${g.rows.length} tool type${g.rows.length === 1 ? '' : 's'} made`}</span></div>
                    <CheckLines d={d}/>
          <div className="overflow-x-auto rounded-lg border border-slate-800"><table className="w-full text-left min-w-[760px]">
            <thead className="text-slate-400 text-xs"><tr>{['Tool', 'Priority', 'Ordered', 'Made so far', 'Still to make', 'Batches made', 'Status'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody>{g.rows.map(r => { const U = URGENCY[r.o.priority]; return (<tr key={r.o.id} className={`border-t border-slate-800 text-sm ${r.o.id === d.order_id ? 'bg-amber-400/10' : ''}`}>
              <td className={`${td} font-bold text-amber-300`}>{nm(r.o)}</td>
              <td className={td}><span className={`${U.chip} rounded px-2 text-xs font-bold`}>{U.short}</span></td>
              <td className={td}>{r.o.quantity}</td><td className={`${td} font-bold`}>{r.made}</td><td className={td}>{r.toGo}</td>
              <td className={td}>{r.bs.length ? r.bs.map(b => <div key={b.id} className="whitespace-nowrap">{b.qty_made} pcs · {dt(b.made_at)} · {b.status === 'READY' ? '📦 at CNC' : '✔ received'}<CheckBadge d={b}/></div>) : <span className="text-slate-500">none yet</span>}</td>
              <td className={`${td} font-bold ${r.tone}`}>{r.label}</td></tr>); })}</tbody></table></div></div>); })()}
      </div>); })}</div>}
    </div>}

    {sub === 'summary' && <div className="space-y-3">
      <div className="flex gap-2 flex-wrap items-center">
        <button aria-label="Previous month" onClick={() => setYm(addMonths(ym, -1))} className={chip(false)}>‹</button>
        <span className="text-xl font-bold px-2 min-w-[10rem] text-center">{monthName}</span>
        <button aria-label="Next month" disabled={ym >= istDay(Date.now()).slice(0, 7)} onClick={() => setYm(addMonths(ym, 1))} className={`${chip(false)} disabled:opacity-40`}>›</button>
        <button onClick={summaryCsv} disabled={!rows.length} className={`${btn} ml-auto`}>⬇ Download table (CSV)</button></div>
      <div className="text-slate-300">Made in {monthName}: <b className="text-slate-100 text-2xl">{n0(grand)}</b> pcs{!fsel && <> · {facs.map(f => `${f} ${n0(fsum(f, fct))}`).join(' · ')}</>}</div>
      {sBusy && <p className="text-slate-400">Loading…</p>}
      {sErr && <p className="text-red-400">Could not load: {sErr}</p>}
      {!sBusy && !sErr && !rows.length && <p className="text-slate-500 py-6 text-center">Nothing was made in this month.</p>}
      {!sBusy && rows.length > 0 && <div className="max-h-[32rem] overflow-auto rounded-xl border border-slate-800"><table className="w-full text-left text-sm" style={{ minWidth: 120 + facs.length * (COLS.length + 1) * 62 }}>
        <thead className="bg-slate-800 text-slate-300 text-xs sticky top-0">
          <tr><th rowSpan={2} className="px-3 py-1.5 whitespace-nowrap align-bottom">Day</th>{facs.map(f => <th key={f} colSpan={COLS.length + 1} className="px-2 py-1.5 text-center border-l border-slate-700"><span className={`${FCHIP[f] ?? 'bg-slate-500'} inline-block w-3 h-3 rounded mr-2 align-middle`}/>{f}</th>)}<th rowSpan={2} className="px-3 py-1.5 text-right align-bottom border-l border-slate-700">Total</th></tr>
          <tr>{facs.map(f => <Fragment key={f}>{COLS.map((c, i) => <th key={c} title={LABEL[c]} className={`px-2 py-1 text-right whitespace-nowrap ${i === 0 ? 'border-l border-slate-700' : ''}`}>{SHORT[c]}</th>)}<th className="px-2 py-1 text-right">Total</th></Fragment>)}</tr></thead>
        <tbody>{rows.map(r => <tr key={r.day} className="border-t border-slate-800"><td className="px-3 py-1 whitespace-nowrap">{fmt(r.day, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
          {facs.map(f => <Fragment key={f}>{COLS.map((c, i) => <td key={c} className={`px-2 py-1 text-right ${i === 0 ? 'border-l border-slate-700' : ''}`}>{r.fc[`${f}|${c}`] ? n0(r.fc[`${f}|${c}`]) : <span className="text-slate-600">—</span>}</td>)}<td className="px-2 py-1 text-right font-bold">{fsum(f, r.fc) ? n0(fsum(f, r.fc)) : <span className="text-slate-600">—</span>}</td></Fragment>)}
          <td className="px-3 py-1 text-right font-extrabold border-l border-slate-700">{n0(r.total)}</td></tr>)}
          <tr className="border-t-2 border-slate-600 bg-slate-800 font-extrabold"><td className="px-3 py-1.5">Total</td>{facs.map(f => <Fragment key={f}>{COLS.map((c, i) => <td key={c} className={`px-2 py-1.5 text-right ${i === 0 ? 'border-l border-slate-700' : ''}`}>{n0(fct[`${f}|${c}`] ?? 0)}</td>)}<td className="px-2 py-1.5 text-right">{n0(fsum(f, fct))}</td></Fragment>)}<td className="px-3 py-1.5 text-right border-l border-slate-700">{n0(grand)}</td></tr></tbody></table></div>}
      <p className="text-xs text-slate-500">Pieces confirmed as made, on the day they were confirmed (IST). The download is exactly this table. Use the factory buttons at the top of the page to see one factory.</p>
    </div>}
  </div>);
}
