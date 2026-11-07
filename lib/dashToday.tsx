'use client';
import { Fragment, useEffect, useRef, useState } from 'react';
import { FACTORIES, FCHIP, rollerLabel } from '@/lib/factories';
import { URGENCY, cmpQueue } from '@/lib/urgency';
import { dt } from '@/lib/useOrders';
import { TOOL_LABEL, type OrderFull, type DeliveryFull } from '@/types/database';

// Owner dashboard, "Today": what is happening right now at each factory.
// Ordered / made / pending are in pieces. Same rules as the old Today's job cards:
// a tool closed short counts only for what was made; pending = pieces still to make on open orders.

const IST = 'Asia/Kolkata';
const istDay = (x: string | number | Date) => new Date(x).toLocaleDateString('en-CA', { timeZone: IST });
const n0 = (n: number) => Math.round(n).toLocaleString('en-IN');
const rem = (o: OrderFull) => Math.max(0, o.quantity - (o.qty_made ?? 0));
const eff = (o: OrderFull) => (o.status === 'CLOSED' ? (o.qty_made ?? 0) : o.quantity);
const tname = (o: OrderFull) => (o.tooling ? TOOL_LABEL[o.tooling.tool_type] : o.custom_tool_name || 'Other tool');
const ago = (x: string) => {
  const m = Math.max(0, Math.floor((Date.now() - +new Date(x)) / 60000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
};
const dayLabel = (day: string, today: string) => {
  const n = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z')) / 86400000);
  const d = new Date(day + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  return `${d} · ${n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`}`;
};
const Tag = ({ f }: { f: string }) => <span className={`${FCHIP[f] ?? 'bg-slate-600'} text-white rounded-lg font-extrabold px-3 py-0.5 text-sm`}>{f}</span>;
const Pill = ({ p }: { p: OrderFull['priority'] }) => <span className={`${URGENCY[p].chip} rounded-md px-2 py-0.5 text-sm font-bold whitespace-nowrap`}>{URGENCY[p].short}</span>;
const Row = ({ lead, title, sub }: { lead: React.ReactNode; title: string; sub: string }) => (
  <div className="flex items-center gap-3 py-3 border-t border-slate-800">{lead}<div className="flex-1 min-w-0"><div className="text-lg font-bold">{title}</div><div className="text-sm text-slate-400">{sub}</div></div></div>);

const Bar = ({ label, pct, note, f, soft, suffix }: { label: string; pct: number | null; note: string; f: string; soft?: boolean; suffix?: string }) => (
  <div><div className="flex items-baseline justify-between"><span className="text-sm font-semibold text-slate-300">{label}</span><span className="text-lg font-extrabold">{pct == null ? '—' : `${pct}%${suffix ?? ''}`}</span></div>
    <div className="h-2 rounded-full bg-slate-800 overflow-hidden mt-1"><div className={`${FCHIP[f] ?? 'bg-slate-500'} h-2 rounded-full ${soft ? 'opacity-60' : ''}`} style={{ width: `${pct ?? 0}%` }}/></div>
    <div className="text-xs text-slate-400 mt-1">{note}</div></div>);

export function TodayView({ orders, batches, fsel }: { orders: OrderFull[]; batches: DeliveryFull[]; fsel: string | null }) {
  const facs: string[] = fsel ? [fsel] : [...FACTORIES];
  const today = istDay(Date.now());
  const open = (o: OrderFull) => o.status === 'QUEUED' || o.status === 'ON_LATHE';
  const [sel, setSel] = useState<string | null>(null); const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (sel) panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [sel]);
  const openAll = orders.filter(open);   // the pending reference is ALL factories, even when one factory is chosen above
  const allPending = openAll.reduce((a, o) => a + rem(o), 0);

  const stat = (f: string) => {
    const mine = orders.filter(o => o.factory_id === f && istDay(o.created_at) === today);
    const ordered = mine.reduce((a, o) => a + eff(o), 0);
    const ordMade = mine.reduce((a, o) => a + Math.min(o.qty_made ?? 0, eff(o)), 0);   // pieces made so far on the orders placed today
    const made = batches.filter(d => d.factory_id === f && istDay(d.made_at) === today).reduce((a, d) => a + d.qty_made, 0);
    const live = orders.filter(o => o.factory_id === f && open(o));
    const pending = live.reduce((a, o) => a + rem(o), 0);
    const waiting = live.filter(o => o.status === 'QUEUED');
    return { ordered, tools: mine.length, ordMade, ordPct: ordered ? Math.round((ordMade / ordered) * 100) : null,
      made, pending, openTools: live.length, share: allPending ? Math.round((pending / allPending) * 100) : null,
      bd: waiting.filter(o => o.priority === 'URGENT_MACHINE_DOWN').length, ug: waiting.filter(o => o.priority === 'URGENT').length };
  };
  const stats = facs.map(f => ({ f, s: stat(f) }));
  const sum = (k: 'ordered' | 'made' | 'pending') => stats.reduce((a, x) => a + x.s[k], 0);

  const pend = sel ? orders.filter(o => o.factory_id === sel && open(o)) : [];
  const byDay = new Map<string, OrderFull[]>(); pend.forEach(o => { const k = istDay(o.created_at); byDay.set(k, [...(byDay.get(k) ?? []), o]); });
  const dayList = Array.from(byDay.entries()).sort(([x], [y]) => (x < y ? -1 : 1)).map(([day, os]) => ({ day, pcs: os.reduce((a, o) => a + rem(o), 0),
    os: os.slice().sort((x, y) => URGENCY[x.priority].rank - URGENCY[y.priority].rank || (x.roller?.roller_size ?? '').localeCompare(y.roller?.roller_size ?? '', undefined, { numeric: true })) }));

  const onLathe = orders.filter(o => o.status === 'ON_LATHE' && facs.includes(o.factory_id));
  const rush = orders.filter(o => o.status === 'QUEUED' && o.priority !== 'BUFFER_NEXT_SHIFT' && facs.includes(o.factory_id)).sort(cmpQueue);
  const atCnc = batches.filter(d => d.status === 'READY' && d.ord && facs.includes(d.factory_id)).sort((a, b) => +new Date(a.made_at) - +new Date(b.made_at));

  return (<div className="space-y-6">
    <div className="flex items-baseline justify-between flex-wrap gap-2">
      <h2 className="text-2xl font-bold">{new Date().toLocaleDateString('en-IN', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'short' })}</h2>
      <div className="text-lg text-slate-400"><b className="text-slate-100">{n0(sum('ordered'))}</b> ordered · <b className="text-green-400">{n0(sum('made'))}</b> made · <b className="text-amber-300">{n0(sum('pending'))}</b> pending
        <span className="text-sm"> · as of {new Date().toLocaleTimeString('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true })}</span></div></div>

    <div className={`grid gap-5 ${facs.length === 1 ? 'grid-cols-1 max-w-xl' : 'grid-cols-1 md:grid-cols-3'}`}>{stats.map(({ f, s }) => (
      <div key={f} role="button" tabIndex={0} aria-pressed={sel === f} onClick={() => setSel(sel === f ? null : f)} onKeyDown={e => { if (e.key === 'Enter') setSel(sel === f ? null : f); }}
        className={`bg-slate-900 rounded-2xl p-6 border flex flex-col gap-5 cursor-pointer ${sel === f ? 'border-amber-400 ring-2 ring-amber-400' : 'border-slate-800 hover:border-slate-600'}`}>
        <div><Tag f={f}/></div>
        <div className="grid grid-cols-3 gap-3">
          <div><div className="text-4xl font-extrabold leading-none">{n0(s.ordered)}</div><div className="text-sm text-slate-400 mt-1">Ordered today</div><div className="text-xs text-slate-500">{s.tools} tooling{s.tools === 1 ? '' : 's'}</div></div>
          <div><div className="text-4xl font-extrabold leading-none text-green-400">{n0(s.made)}</div><div className="text-sm text-slate-400 mt-1">Made today</div><div className="text-xs text-slate-500">pcs confirmed</div></div>
          <div><div className="text-4xl font-extrabold leading-none text-amber-300">{n0(s.pending)}</div><div className="text-sm text-slate-400 mt-1">Pending</div><div className="text-xs text-slate-500">{s.openTools} open tooling{s.openTools === 1 ? '' : 's'}</div></div></div>
        <div className="space-y-4">
          <Bar f={f} label="Today's orders" pct={s.ordPct} note={s.ordered ? `${n0(s.ordMade)} of ${n0(s.ordered)} pcs made so far` : 'No orders placed today'}/>
          <Bar f={f} soft suffix="" label="Share of all pending work" pct={s.share} note={allPending ? `${n0(s.pending)} of ${n0(allPending)} pcs pending · ${s.openTools} of ${openAll.length} toolings` : 'Nothing is pending'}/></div>
        <div className="mt-auto min-h-8 flex items-center gap-4 flex-wrap">{s.bd || s.ug ? <>
          {s.bd > 0 && <span className="flex items-center gap-2"><span className={`${URGENCY.URGENT_MACHINE_DOWN.chip} rounded-md px-2 py-0.5 text-sm font-bold`}>Breakdown</span>{s.bd} waiting</span>}
          {s.ug > 0 && <span className="flex items-center gap-2"><span className={`${URGENCY.URGENT.chip} rounded-md px-2 py-0.5 text-sm font-bold`}>Urgent</span>{s.ug} waiting</span>}</>
          : <span className="text-slate-400">Nothing urgent waiting</span>}</div>
      </div>))}</div>

    <p className="text-sm text-slate-500 -mt-3">Tap a factory to see its pending toolings by roller size.</p>
    <div ref={panelRef}>{sel && <div className="bg-slate-900 rounded-2xl p-4 border border-slate-800 space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap"><div className="flex items-center gap-3"><Tag f={sel}/><h3 className="text-lg font-bold">Pending toolings, date wise</h3></div>
        <button onClick={() => setSel(null)} className="min-h-10 px-4 rounded-xl border-2 border-slate-700 bg-slate-900 font-bold">Close</button></div>
      <div className="text-sm text-slate-400">{n0(pend.reduce((a, o) => a + rem(o), 0))} pcs · {pend.length} tooling{pend.length === 1 ? '' : 's'} · {new Set(pend.map(o => o.roller?.roller_size)).size} roller size{new Set(pend.map(o => o.roller?.roller_size)).size === 1 ? '' : 's'} · oldest first</div>
      {!pend.length && <p className="text-slate-400 py-2">Nothing is pending for {sel}.</p>}
      {pend.length > 0 && <div className="max-h-[30rem] overflow-auto rounded-xl border border-slate-800"><table className="w-full text-left text-sm">
        <thead className="bg-slate-800 text-slate-300 text-xs sticky top-0"><tr><th className="px-3 py-1.5">Roller size</th><th className="px-3 py-1.5">Tooling</th><th className="px-3 py-1.5 text-right">Pending</th><th className="px-3 py-1.5">Priority</th></tr></thead>
        <tbody>{dayList.map(g => <Fragment key={g.day}>
          <tr className="bg-slate-800"><td colSpan={4} className="px-3 py-1 text-xs font-bold text-slate-300">{dayLabel(g.day, today)} <span className="font-normal text-slate-400">· {g.os.length} tooling{g.os.length === 1 ? '' : 's'} · {n0(g.pcs)} pcs</span></td></tr>
          {g.os.map(o => <tr key={o.id} className="border-t border-slate-800">
            <td className="px-3 py-1 font-bold whitespace-nowrap">{rollerLabel(sel, o.roller?.roller_size ?? '—')}</td>
            <td className="px-3 py-1 whitespace-nowrap">{tname(o)}{o.status === 'ON_LATHE' && <span title="On the lathe now"> ⚙</span>}</td>
            <td className="px-3 py-1 text-right font-bold text-amber-300 whitespace-nowrap">{n0(rem(o))}{(o.qty_made ?? 0) > 0 && <span className="text-xs font-normal text-slate-500"> of {n0(o.quantity)}</span>}</td>
            <td className="px-3 py-1">{o.priority === 'BUFFER_NEXT_SHIFT' ? <span className="text-xs text-slate-500">Normal</span> : <Pill p={o.priority}/>}</td></tr>)}</Fragment>)}</tbody></table></div>}
      <p className="text-xs text-slate-500">Dates are when the toolings were ordered. ⚙ = on the lathe now. “of N” = part of the order is already made.</p>
    </div>}</div>

    <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
      <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800">
        <h3 className="text-xl font-bold mb-1">On the lathe now</h3>
        {!onLathe.length && <p className="text-slate-400 py-3">The lathe is idle.</p>}
        {onLathe.map(o => <Row key={o.id} lead={<Tag f={o.factory_id}/>} title={`${rollerLabel(o.factory_id, o.roller?.roller_size ?? '—')} · ${tname(o)} · ${n0(rem(o))} pcs`} sub={o.started_lathe_at ? `Running for ${ago(o.started_lathe_at)}` : 'Started'}/>)}</div>
      <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800">
        <h3 className="text-xl font-bold mb-1">Needs attention</h3>
        {!rush.length && !atCnc.length && <p className="text-slate-400 py-3">Nothing needs attention right now.</p>}
        {rush.slice(0, 6).map(o => <Row key={o.id} lead={<Pill p={o.priority}/>} title={`${rollerLabel(o.factory_id, o.roller?.roller_size ?? '—')} · ${tname(o)} · ${n0(rem(o))} pcs`} sub={`Waiting ${ago(o.created_at)}`}/>)}
        {rush.length > 6 && <div className="text-sm text-slate-400 py-2">+ {rush.length - 6} more urgent waiting</div>}
        {atCnc.slice(0, 4).map(d => <Row key={d.id} lead={<span className="bg-slate-700 text-slate-100 rounded-md px-2 py-0.5 text-sm font-bold whitespace-nowrap">At CNC</span>} title={`${rollerLabel(d.factory_id, d.ord!.roller?.roller_size ?? '—')} · ${tname(d.ord!)} · ${n0(d.qty_made)} pcs`} sub={`Made ${dt(d.made_at)}, not yet received`}/>)}
        {atCnc.length > 4 && <div className="text-sm text-slate-400 py-2">+ {atCnc.length - 4} more batches waiting at the CNC</div>}</div>
    </div>
  </div>);
}
