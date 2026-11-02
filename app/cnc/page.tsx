'use client';
import { useEffect, useRef, useState } from 'react';
import { supabase, rpc } from '@/lib/supabase';
import { Guard } from '@/lib/auth';
import { useOrders, dt, gkey, DSEL, chime } from '@/lib/useOrders';
import { FACTORIES, FCHIP, mname as mcode, rollerLabel } from '@/lib/factories';
import { URGENCY, cmpQueue } from '@/lib/urgency';
import { TOOL_LABEL, type OrderFull, type DeliveryFull } from '@/types/database';

const nm = (o: OrderFull) => (o.tooling ? TOOL_LABEL[o.tooling.tool_type] : o.custom_tool_name || 'Other tool');
const det = (o: OrderFull) => { const k = o.tooling; if (!k) return o.custom_dimensions ?? '';
  return k.tool_type === 'DIE_TOP' ? (k.batta_code ? `Batta ${k.batta_code}` : '')
    : k.tool_type === 'BOTTOM' ? `OD ${k.od_dim ?? '—'} × L ${k.length_dim ?? '—'} · OD ${k.od2_dim ?? '—'} · Step ${k.step_depth_dim ?? '—'}`
    : k.tool_type === 'FACING_PUNCH' ? `OD ${k.od_dim ?? '—'} × L ${k.length_dim ?? '—'}` : ''; };
const rem = (o: OrderFull) => Math.max(0, o.quantity - (o.qty_made ?? 0));
const dayKey = (d: string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const when = (d: string) => { const n = Date.now(); const k = dayKey(d);
  const day = k === dayKey(new Date(n).toISOString()) ? 'Today' : k === dayKey(new Date(n - 864e5).toISOString()) ? 'Yesterday'
    : new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
  return `${day}, ${new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true })}`; };
const groupBy = <T,>(list: T[], key: (x: T) => string) => { const m: Record<string, T[]> = {}; list.forEach(x => (m[key(x)] ??= []).push(x)); return Object.entries(m); };
const FTag = ({ f, big }: { f: string; big?: boolean }) => <span className={`${FCHIP[f] ?? 'bg-slate-600'} text-white rounded-lg font-extrabold ${big ? 'px-4 py-1 text-2xl' : 'px-2 py-0.5 text-sm'}`}>{f}</span>;

// circular progress for the overall figure
function Ring({ pct }: { pct: number | null }) {
  const r = 40, c = 2 * Math.PI * r, p = pct ?? 0;
  return (<svg viewBox="0 0 100 100" className="w-28 h-28 shrink-0" role="img" aria-label={`Overall progress ${p}%`}>
    <circle cx="50" cy="50" r={r} fill="none" strokeWidth="12" className="stroke-current text-slate-500" opacity=".3"/>
    <circle cx="50" cy="50" r={r} fill="none" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${(c * p) / 100} ${c}`} transform="rotate(-90 50 50)" className="stroke-current text-green-500"/>
    <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fontSize="20" fontWeight="800" className="fill-current">{pct == null ? '—' : `${p}%`}</text></svg>);
}

function Cnc() {
  const { orders, deliveries, reload } = useOrders();
  const [tab, setTab] = useState<'queue' | 'ready' | 'history'>('queue');
  const [fsel, setFsel] = useState<string | null>(null);
  const [win, setWin] = useState<'today' | 'week' | 'month'>('month');
  const [showProg, setShowProg] = useState(false);
  const [done, setDone] = useState<{ id: string; qty: number } | null>(null); const [doneNote, setDoneNote] = useState('');
  const [openB, setOpenB] = useState<Record<string, boolean>>({});
  const [hist, setHist] = useState<DeliveryFull[]>([]); const [hd, setHd] = useState(7); const [hs, setHs] = useState('');

  useEffect(() => {   // every batch ever made (paged: Supabase returns max 1000 rows per request)
    if (tab !== 'history') return;
    (async () => { let all: DeliveryFull[] = [];
      for (let i = 0; ; i += 1000) {
        const { data } = await supabase.from('deliveries').select(DSEL).order('made_at', { ascending: false }).range(i, i + 999);
        if (!data?.length) break; all = all.concat(data as unknown as DeliveryFull[]); if (data.length < 1000) break;
      } setHist(all); })();
  }, [tab, deliveries]);

  const facs: string[] = fsel ? [fsel] : [...FACTORIES];
  const running = orders.find(o => o.status === 'ON_LATHE');   // one job at a time on the lathe
  const waiting = orders.filter(o => o.status === 'QUEUED');
  const pcs = (l: OrderFull[]) => l.reduce((a, o) => a + rem(o), 0);
  // Progress = pieces made / pieces ordered, for orders placed in the chosen window. Balance the toolroom closed short is not counted against the CNC.
  const todayK = dayKey(new Date().toISOString());
  const startK = win === 'today' ? todayK : win === 'month' ? todayK.slice(0, 8) + '01'
    : (() => { const d = new Date(todayK + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toLocaleDateString('en-CA'); })();
  const eff = (o: OrderFull) => (o.status === 'CLOSED' ? (o.qty_made ?? 0) : o.quantity);
  const progress = (l: OrderFull[]) => { const ord = l.reduce((a, o) => a + eff(o), 0); const made = l.reduce((a, o) => a + Math.min(o.qty_made ?? 0, eff(o)), 0);
    return { ord, made, pct: ord ? Math.round((made / ord) * 100) : null }; };
  const inWin = orders.filter(o => dayKey(o.created_at) >= startK);
  const pAll = progress(inWin);
  const winLabel = { today: 'today', week: 'this week', month: 'this month' }[win];
  const batchesOf = (f: string) => groupBy(waiting.filter(o => o.factory_id === f), gkey)
    .map(([k, items]) => ({ k, items: items.sort((a, b) => URGENCY[a.priority].rank - URGENCY[b.priority].rank || a.slip_no - b.slip_no) }))
    .sort((a, b) => cmpQueue(a.items[0], b.items[0]));   // Breakdown > Urgent > Normal, then oldest first
    const rushParts = FACTORIES.map(f => { const w = waiting.filter(o => o.factory_id === f); const x = w.filter(o => o.priority === 'URGENT_MACHINE_DOWN').length; const u = w.filter(o => o.priority === 'URGENT').length;
    return x || u ? `${f}: ${[x ? `${x} breakdown` : '', u ? `${u} urgent` : ''].filter(Boolean).join(', ')}` : ''; }).filter(Boolean);
  const anyBreakdown = waiting.some(o => o.priority === 'URGENT_MACHINE_DOWN');
    const loaded = orders.length > 0;
  const changedKey = waiting.filter(o => o.priority_changed_at).map(o => `${o.id}@${o.priority_changed_at}`).join(',');   // plain text, so it is safe in the effect list
  const seenPrio = useRef<Set<string> | null>(null); const [prioNote, setPrioNote] = useState('');
  useEffect(() => {   // chime + banner when the toolroom raises a tool's priority while this screen is open
    if (!loaded) return;
    const cur = changedKey ? changedKey.split(',') : [];
    if (!seenPrio.current) { seenPrio.current = new Set(cur); return; }   // first load: remember what is already marked, do not announce it
    const seen = seenPrio.current; const fresh = cur.filter(x => !seen.has(x)); cur.forEach(x => seen.add(x));
    if (!fresh.length) return;
    chime(); setPrioNote(`⬆ Priority raised for ${fresh.length} tool${fresh.length > 1 ? 's' : ''}. Check the marked orders.`);
    setTimeout(() => setPrioNote(''), 10000);
  }, [changedKey, loaded]);
  const ready = deliveries.filter(d => d.status === 'READY' && d.ord && (!fsel || d.factory_id === fsel));
  const cutoff = hd ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (hd - 1)); return +d; })() : 0;
  const hlist = hist.filter(d => d.ord && (!fsel || d.factory_id === fsel) && +new Date(d.made_at) >= cutoff && (d.ord.roller?.roller_size ?? '').toLowerCase().includes(hs.trim().toLowerCase()));

  // logs one lathe cycle; a failed log never blocks the operator
  async function logRun(o: OrderFull | undefined, action: 'COMPLETED' | 'STOPPED', qty: number | null) {
    if (!o?.started_lathe_at) return;   // no start time, nothing to measure
    const ended = new Date();
    const secs = Math.max(0, Math.round((+ended - +new Date(o.started_lathe_at)) / 1000));
    const { error } = await supabase.from('lathe_activity_logs').insert({
      order_id: o.id, factory_id: o.factory_id, roller_size: o.roller?.roller_size ?? null, tool_type: o.tooling?.tool_type ?? 'OTHER',
      action, started_at: o.started_lathe_at, ended_at: ended.toISOString(), duration_seconds: secs, qty_made: qty });
    if (error) alert('Saved, but the runtime log failed: ' + error.message);
  }
  async function start(id: string) {   // In Progress
    const { error } = await supabase.from('tool_orders').update({ status: 'ON_LATHE', started_lathe_at: new Date().toISOString() }).eq('id', id);
    if (error) alert('Another job is already on the lathe.'); reload();
  }
  async function stop(id: string) {
    const o = orders.find(x => x.id === id);   // read the start time before the order is reset
    const { error } = await supabase.from('tool_orders').update({ status: 'QUEUED', started_lathe_at: null }).eq('id', id);
    if (error) { alert('Could not stop: ' + error.message); return; }
    await logRun(o, 'STOPPED', null);
    setDone(null); reload();
  }
  async function finish() {   // Completed / Made: records this batch; anything not made stays in the queue
    if (!done) return;
    const o = orders.find(x => x.id === done.id);   // complete_batch clears started_lathe_at, so capture it first
    const { error } = await rpc('complete_batch', { p_order: done.id, p_qty: done.qty, p_note: doneNote.trim() || null });
    if (error) { alert('Could not save: ' + error.message); return; }
    await logRun(o, 'COMPLETED', done.qty);
    setDone(null); reload();
  }

    const bcard = ({ k, items }: { k: string; items: OrderFull[] }) => { const f = items[0]; const isOpen = !!openB[k];
        return (<div key={k} className="rounded-xl border-2 border-slate-700 bg-slate-900">
      <button onClick={() => setOpenB({ ...openB, [k]: !isOpen })} className="w-full text-left px-4 py-3 min-h-20 space-y-1">
        <div className="flex items-center gap-2 flex-wrap"><span className="text-2xl font-extrabold">{rollerLabel(f.factory_id, f.roller?.roller_size ?? '—')}</span>
                    {items.some(o => o.priority_changed_at) && <span className="rounded px-2 text-sm font-bold bg-blue-600 text-white">⬆ Priority changed</span>}{items.some(o => o.notes) && <span title="Has a note">📝</span>}
          <span className="ml-auto text-xl">{isOpen ? '▲' : '▼'}</span></div>
        <div className="text-slate-400">{mcode(f.machine_id)} · requested {when(f.created_at)}</div>
               <div className="text-slate-200 flex gap-x-4 gap-y-1 flex-wrap">{items.map(o => <span key={o.id}>{nm(o)} ×{rem(o)}{o.priority !== 'BUFFER_NEXT_SHIFT' && <span className={`${URGENCY[o.priority].chip} rounded px-1.5 ml-1 text-xs font-bold`}>{URGENCY[o.priority].short}</span>}</span>)}</div></button>
      {isOpen && <div className="px-4 pb-4 space-y-2">
        <div className="text-sm text-slate-400">Drg {f.roller?.customer_drg ?? '—'}{f.roller?.party_name ? ` · Party ${f.roller.party_name}` : ''}{f.roller_qty ? ` · ${f.roller_qty.toLocaleString('en-IN')} rollers to forge` : ''} · Slip #{f.slip_no}</div>
                {items.map(o => <div key={o.id} className={`rounded-xl bg-slate-800 p-3 flex items-center gap-3 flex-wrap ${o.priority !== 'BUFFER_NEXT_SHIFT' ? `border-l-4 ${URGENCY[o.priority].border}` : ''}`}>
          <div className="flex-1 min-w-40"><div className="text-xl font-bold text-amber-300">{nm(o)} · {rem(o)} to make</div>
            {o.priority !== 'BUFFER_NEXT_SHIFT' && <div className="flex items-center gap-2 flex-wrap"><span className={`${URGENCY[o.priority].chip} rounded px-2 text-sm font-bold`}>{URGENCY[o.priority].short}</span>{o.priority_changed_at && <span className="text-sm font-semibold text-amber-300">⬆ raised from {URGENCY[o.priority_was ?? 'BUFFER_NEXT_SHIFT'].short} · {dt(o.priority_changed_at)}</span>}</div>}
            <div className="text-slate-300">{det(o)}</div>
            {o.notes && <div className="text-amber-300 font-semibold">📝 {o.notes}</div>}
            <div className="text-sm text-slate-400">Ordered {o.quantity}{(o.qty_made ?? 0) > 0 ? ` · already made ${o.qty_made}` : ''}</div></div>
          <button disabled={!!running} onClick={() => start(o.id)} className="h-14 px-5 rounded-xl bg-blue-600 disabled:bg-slate-700 disabled:text-slate-500 text-lg font-bold">{running ? 'Lathe busy' : '▶ Start'}</button></div>)}</div>}
    </div>); };

  const column = (f: string) => { const bs = batchesOf(f); const w = waiting.filter(o => o.factory_id === f);
    return (<div key={f} className="rounded-2xl border border-slate-700 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap"><FTag f={f} big/><span className="text-slate-400">{bs.length} order{bs.length === 1 ? '' : 's'} · {pcs(w)} pcs</span></div>
      {!bs.length && <p className="text-slate-500 py-6 text-center">Nothing waiting</p>}
      {bs.map(bcard)}</div>); };

  const dcard = ([k, items]: [string, DeliveryFull[]]) => { const f = items[0].ord!; return (<div key={k} className="rounded-2xl bg-slate-900 border-2 border-slate-700 p-4">
    <div className="text-xl font-bold">{rollerLabel(f.factory_id, f.roller?.roller_size ?? '—')} <span className="text-slate-400 text-base font-normal">Drg {f.roller?.customer_drg ?? '—'} · {mcode(f.machine_id)}</span></div>
    <div className="mt-2 space-y-1">{items.map(d => <div key={d.id} className="flex justify-between gap-3 flex-wrap rounded-lg bg-slate-800 p-2">
      <span className="font-bold text-amber-300">{nm(d.ord!)}</span>
      <span>Batch <b className="text-xl">{d.qty_made}</b> <span className="text-slate-400">(order {d.ord!.quantity}, made so far {d.ord!.qty_made ?? 0})</span></span>
      <span className="text-sm text-slate-400">{dt(d.made_at)} · {d.status === 'READY' ? '📦 still at CNC' : `✔ at plant (${d.qty_received ?? '?'} received)`}</span>
      {d.note && <span className="w-full text-sm text-amber-300">📝 {d.note}</span>}</div>)}</div></div>); };
  const fcols = (list: DeliveryFull[]) => (<div className={`grid gap-4 ${facs.length > 1 ? 'lg:grid-cols-3' : ''}`}>{facs.map(f => { const l = list.filter(d => d.factory_id === f);
    const g = groupBy(l, d => gkey(d.ord!)).sort((a, b) => +new Date(b[1][0].made_at) - +new Date(a[1][0].made_at));
    return <div key={f} className="space-y-3"><div className="flex items-center justify-between"><FTag f={f} big/><span className="text-slate-400">{l.reduce((a, d) => a + d.qty_made, 0)} pcs</span></div>
      {!g.length && <p className="text-slate-500 py-4 text-center">None</p>}{g.map(dcard)}</div>; })}</div>);

  return (<div className="p-4 max-w-7xl mx-auto space-y-4">
    <h1 className="text-2xl font-bold">CNC {running && <span className="ml-2 text-base bg-blue-600 text-white rounded-lg px-3 py-1">Lathe busy</span>}</h1>
    <div className="grid grid-cols-3 gap-2">{([['queue', `To make (${waiting.length + (running ? 1 : 0)})`], ['ready', `Ready · at my place (${deliveries.filter(d => d.status === 'READY').length})`], ['history', 'History']] as const).map(([t, l]) =>
      <button key={t} onClick={() => setTab(t)} className={`h-16 rounded-xl border-2 text-lg font-bold ${tab === t ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{l}</button>)}</div>
    <div className="flex gap-2 flex-wrap">{[null, ...FACTORIES].map(f => <button key={f ?? 'all'} onClick={() => setFsel(f)} className={`px-5 min-h-12 rounded-xl border-2 text-lg font-bold ${fsel === f ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{f ?? 'All factories'}</button>)}</div>

    {tab === 'queue' && <>
      {!showProg ? <button onClick={() => setShowProg(true)} className="w-full min-h-12 rounded-xl border-2 border-slate-700 bg-slate-900 px-4 py-2 flex items-center gap-3 flex-wrap text-left">
        <span className="font-bold">Progress · {winLabel}</span>
        <span className="text-xl font-extrabold">{pAll.pct == null ? '—' : `${pAll.pct}%`}</span>
        <span className="text-slate-400 text-sm">{pAll.made} of {pAll.ord} pcs</span>
        <span className="ml-auto text-slate-400">▼</span></button>
      : <section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap"><h2 className="text-lg font-bold mr-2">Progress · orders placed {winLabel}</h2>
          {(['today', 'week', 'month'] as const).map(w => <button key={w} onClick={() => setWin(w)} className={`px-4 min-h-10 rounded-xl border-2 font-bold ${win === w ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{{ today: 'Today', week: 'This week', month: 'This month' }[w]}</button>)}
          <button onClick={() => setShowProg(false)} className="ml-auto px-4 min-h-10 rounded-xl border-2 border-slate-700 font-bold">Hide ▲</button></div>
        {!inWin.length ? <p className="text-slate-500">No orders placed {winLabel}.</p> : <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-3"><Ring pct={pAll.pct}/><div><div className="text-slate-400 text-sm">All factories</div><div className="text-2xl font-extrabold">{pAll.made} <span className="text-slate-400 text-base font-semibold">of {pAll.ord} pcs</span></div></div></div>
          <div className="flex-1 min-w-60 space-y-3">{FACTORIES.map(f => { const x = progress(inWin.filter(o => o.factory_id === f));
            return <div key={f}><div className="flex justify-between items-center text-sm mb-1"><span className="flex items-center gap-2"><FTag f={f}/>{x.made} of {x.ord} pcs</span><b className="text-base">{x.pct == null ? '—' : `${x.pct}%`}</b></div>
              <div className="h-4 rounded-full bg-slate-800 overflow-hidden"><div className={`${FCHIP[f] ?? 'bg-slate-500'} h-4 rounded-full`} style={{ width: `${x.pct ?? 0}%` }}/></div></div>; })}</div></div>}
        <p className="text-xs text-slate-500">Progress = pieces made ÷ pieces ordered, for orders placed {winLabel}. Pieces the toolroom closed short are not counted against you.</p></section>}
            {prioNote && <div className="rounded-xl p-3 font-bold bg-blue-600 text-white">{prioNote}</div>}
      {rushParts.length > 0 && <div className={`rounded-xl p-3 font-bold ${anyBreakdown ? 'bg-red-600 text-white' : 'bg-amber-500 text-slate-950'}`}>{anyBreakdown ? '🔴' : '🟠'} Rush waiting · {rushParts.join(' · ')}</div>}
      {running && (() => { const o = running; const d = done?.id === o.id ? done : null; const U = URGENCY[o.priority];
        return <div className="rounded-2xl bg-slate-900 border-4 border-blue-500 p-4">
          <div className="flex justify-between gap-2 flex-wrap"><div>
            <div className="text-3xl font-extrabold">{rollerLabel(o.factory_id, o.roller?.roller_size ?? '—')} <span className="text-slate-400 text-xl font-semibold">Drg {o.roller?.customer_drg ?? '—'}</span></div>
            <div className="text-slate-300">{o.roller?.party_name ? `Party: ${o.roller.party_name} · ` : ''}Header {mcode(o.machine_id)}{o.roller_qty ? ` · ${o.roller_qty.toLocaleString('en-IN')} rollers to forge` : ''}</div>
            <div className="text-3xl mt-2 text-amber-300 font-bold">{nm(o)} · {rem(o)} to make</div>
            <div className="text-xl text-slate-300">{det(o)}</div>
            {o.notes && <div className="text-xl text-amber-300 font-semibold mt-1">📝 {o.notes}</div>}
            <div className="text-sm text-slate-400">Ordered {o.quantity}{(o.qty_made ?? 0) > 0 ? ` · already made ${o.qty_made}` : ''} · requested {when(o.created_at)}{o.started_lathe_at ? ` · in progress since ${dt(o.started_lathe_at)}` : ''}</div></div>
            <div className="flex gap-2 h-fit"><FTag f={o.factory_id}/><span className={`${U.chip} rounded-lg px-3 py-0.5 font-bold`}>{U.short}</span><span className="bg-blue-600 text-white rounded-lg px-3 py-0.5 font-bold">IN PROGRESS</span></div></div>
          {!d ? <div className="grid grid-cols-2 gap-3 mt-4">
              <button onClick={() => { setDoneNote(''); setDone({ id: o.id, qty: Math.max(1, rem(o)) }); }} className="h-20 rounded-2xl bg-green-600 text-xl font-extrabold">✔ COMPLETED / MADE</button>
              <button onClick={() => stop(o.id)} className="h-20 rounded-2xl bg-slate-600 text-xl font-extrabold">✖ STOP</button></div>
            : <div className="mt-4 rounded-2xl bg-slate-800 p-4 text-center space-y-3">
              <div className="text-xl">How many did you make in this batch? <span className="text-slate-400">({rem(o)} still owed)</span></div>
              <div className="flex items-center justify-center gap-4">
                <button onClick={() => setDone({ id: o.id, qty: Math.max(1, d.qty - 1) })} className="w-24 h-20 rounded-xl bg-slate-700 text-4xl font-bold">−</button>
                <span className="text-7xl font-extrabold w-40">{d.qty}</span>
                <button onClick={() => setDone({ id: o.id, qty: d.qty + 1 })} className="w-24 h-20 rounded-xl bg-slate-700 text-4xl font-bold">+</button></div>
              <label className="block text-left"><span className="block text-sm font-semibold text-slate-300 mb-1">Note for toolroom (optional)</span>
                <input className="h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-lg w-full" placeholder="e.g. 3 pcs are 0.5 mm short" value={doneNote} onChange={e => setDoneNote(e.target.value)}/></label>
              <div className="text-sm text-slate-400">Anything not made stays in the queue. Only the toolroom can close the balance.</div>
              <div className="flex gap-3"><button onClick={finish} className="flex-1 h-20 rounded-2xl bg-green-600 text-xl font-extrabold">✔ CONFIRM · READY TO DISPATCH</button>
                <button onClick={() => setDone(null)} className="px-6 rounded-2xl bg-slate-700 text-lg">Cancel</button></div></div>}
        </div>; })()}
      <div className={`grid gap-4 ${facs.length > 1 ? 'lg:grid-cols-3' : ''}`}>{facs.map(column)}</div></>}

    {tab === 'ready' && <div className="space-y-3">
      <p className="text-slate-400">Made and waiting at your place. They leave this list once the plant confirms receipt. <b className="text-slate-100">{ready.reduce((a, d) => a + d.qty_made, 0)} pcs</b> waiting.</p>
      {fcols(ready)}</div>}

    {tab === 'history' && <div className="space-y-3">
      <div className="flex gap-2 flex-wrap items-center">{([[1, 'Today'], [7, '7 days'], [30, '30 days'], [0, 'All']] as const).map(([d, l]) =>
        <button key={d} onClick={() => setHd(d)} className={`px-5 h-12 rounded-lg ${hd === d ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-slate-800'}`}>{l}</button>)}
        <span className="ml-auto text-slate-400">{FACTORIES.map(f => `${f} ${hlist.filter(d => d.factory_id === f).reduce((a, d) => a + d.qty_made, 0)}`).join(' · ')} · Total made <b className="text-slate-100 text-xl">{hlist.reduce((a, d) => a + d.qty_made, 0)}</b></span></div>
      <input className="h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full" placeholder="Search by roller size" value={hs} onChange={e => setHs(e.target.value)}/>
            <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
        <table className="w-full text-left min-w-[820px]">
          <thead className="bg-slate-800 text-slate-300 text-sm"><tr>{['Made on', 'Factory', 'Roller size', 'Tool', 'Batch made', 'Order qty', 'Made so far', 'At plant', 'Note'].map(h => <th key={h} className="px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody>{hlist.map(d => <tr key={d.id} className="border-t border-slate-800">
            <td className="px-3 py-2 whitespace-nowrap">{dt(d.made_at)}</td>
            <td className="px-3 py-2"><FTag f={d.factory_id}/></td>
            <td className="px-3 py-2 font-bold whitespace-nowrap">{rollerLabel(d.factory_id, d.ord!.roller?.roller_size ?? '—')}</td>
            <td className="px-3 py-2 text-amber-300 font-semibold">{nm(d.ord!)}</td>
            <td className="px-3 py-2 font-extrabold text-lg">{d.qty_made}</td>
            <td className="px-3 py-2">{d.ord!.quantity}</td>
            <td className="px-3 py-2">{d.ord!.qty_made ?? 0}</td>
            <td className="px-3 py-2 whitespace-nowrap">{d.status === 'READY' ? '📦 still at CNC' : `✔ ${d.qty_received ?? '?'} received`}</td>
            <td className="px-3 py-2 text-sm">{d.note ?? ''}</td></tr>)}
            {!hlist.length && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-500">No batches in this period.</td></tr>}</tbody>
          {hlist.length > 0 && <tfoot className="border-t-2 border-slate-700 font-extrabold"><tr><td className="px-3 py-2" colSpan={4}>Total</td><td className="px-3 py-2 text-lg">{hlist.reduce((a, d) => a + d.qty_made, 0)}</td><td colSpan={4}/></tr></tfoot>}
        </table></div></div>}
  </div>);
}

export default function Page() { return <Guard allow={['cnc', 'owner']}><Cnc/></Guard>; }
