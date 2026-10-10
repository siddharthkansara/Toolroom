'use client';
import { useEffect, useState } from 'react';
import { supabase, rpc } from '@/lib/supabase';
import { Guard } from '@/lib/auth';
import { useOrders, dt, gkey, DSEL } from '@/lib/useOrders';
import { TOOL_LABEL, type OrderFull, type DeliveryFull } from '@/types/database';

const nm = (o: OrderFull) => (o.tooling ? TOOL_LABEL[o.tooling.tool_type] : o.custom_tool_name || 'Other tool');
const det = (o: OrderFull) => { const k = o.tooling; if (!k) return o.custom_dimensions ?? '';
  return k.tool_type === 'DIE_TOP' ? (k.batta_code ? `Batta ${k.batta_code}` : '')
    : k.tool_type === 'BOTTOM' ? `OD ${k.od_dim ?? '—'} × L ${k.length_dim ?? '—'} · OD ${k.od2_dim ?? '—'} · Step ${k.step_depth_dim ?? '—'}`
    : k.tool_type === 'FACING_PUNCH' ? `OD ${k.od_dim ?? '—'} × L ${k.length_dim ?? '—'}` : ''; };
const rem = (o: OrderFull) => Math.max(0, o.quantity - (o.qty_made ?? 0));
const dayKey = (d: string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const dayLabel = (k: string) => { const n = Date.now();
  return k === dayKey(new Date(n).toISOString()) ? 'Today' : k === dayKey(new Date(n - 864e5).toISOString()) ? 'Yesterday'
    : new Date(k + 'T12:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
const groupBy = <T,>(list: T[], key: (x: T) => string) => { const m: Record<string, T[]> = {}; list.forEach(x => (m[key(x)] ??= []).push(x)); return Object.entries(m); };

function Cnc() {
  const { orders, deliveries, reload } = useOrders();
  const [tab, setTab] = useState<'queue' | 'ready' | 'history'>('queue');
  const [done, setDone] = useState<{ id: string; qty: number } | null>(null);
  const [openB, setOpenB] = useState<Record<string, boolean>>({});
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const [hist, setHist] = useState<DeliveryFull[]>([]); const [hd, setHd] = useState(7); const [hs, setHs] = useState('');

  useEffect(() => {   // every batch ever made (paged: Supabase returns max 1000 rows per request)
    if (tab !== 'history') return;
    (async () => { let all: DeliveryFull[] = [];
      for (let i = 0; ; i += 1000) {
        const { data } = await supabase.from('deliveries').select(DSEL).order('made_at', { ascending: false }).range(i, i + 999);
        if (!data?.length) break; all = all.concat(data as unknown as DeliveryFull[]); if (data.length < 1000) break;
      } setHist(all); })();
  }, [tab, deliveries]);

  const running = orders.find(o => o.status === 'ON_LATHE');   // one job at a time
  const waiting = orders.filter(o => o.status === 'QUEUED');
  const urgent = (o: OrderFull) => o.priority === 'URGENT_MACHINE_DOWN';
  const oldest = (l: OrderFull[]) => [...l].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
  const pcs = (l: OrderFull[]) => l.reduce((a, o) => a + rem(o), 0);
  const ready = deliveries.filter(d => d.status === 'READY' && d.ord);

  async function start(id: string) {
    const { error } = await supabase.from('tool_orders').update({ status: 'ON_LATHE', started_lathe_at: new Date().toISOString() }).eq('id', id);
    if (error) alert('Another job is already on the lathe.'); reload();
  }
  async function stop(id: string) {   // back to the queue, nothing recorded
    await supabase.from('tool_orders').update({ status: 'QUEUED', started_lathe_at: null }).eq('id', id); setDone(null); reload();
  }
  async function finish() {   // records this batch; the rest (if any) stays in the queue
    if (!done) return;
    const { error } = await rpc('complete_batch', { p_order: done.id, p_qty: done.qty });
    if (error) alert('Could not save: ' + error.message);
    setDone(null); reload();
  }

  const row = ([k, items]: [string, OrderFull[]]) => { const f = items[0]; const isOpen = !!openB[k]; const u = urgent(f);
    return (<div key={k} className={`rounded-xl border-2 bg-slate-900 ${u ? 'border-red-500' : 'border-slate-700'}`}>
      <button onClick={() => setOpenB({ ...openB, [k]: !isOpen })} className="w-full min-h-16 flex items-center gap-3 px-4 text-left">
        <span className="text-2xl font-extrabold">{f.roller?.roller_size ?? '—'}</span>
        <span className="flex-1 text-slate-400">{f.machine_id} · {items.length} tool{items.length > 1 ? 's' : ''} · {pcs(items)} pcs · {dt(f.created_at)}</span>
        {u && <span className="bg-red-600 rounded px-2 text-sm font-bold">URGENT</span>}<span className="text-xl">{isOpen ? '▲' : '▼'}</span></button>
      {isOpen && <div className="px-4 pb-4 space-y-2">
        <div className="text-sm text-slate-400">Drg {f.roller?.customer_drg ?? '—'}{f.roller?.party_name ? ` · Party ${f.roller.party_name}` : ''}{f.roller_qty ? ` · ${f.roller_qty.toLocaleString('en-IN')} rollers to forge` : ''} · Slip #{f.slip_no}</div>
        {items.sort((a, b) => a.slip_no - b.slip_no).map(o => <div key={o.id} className="rounded-xl bg-slate-800 p-3 flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-48"><div className="text-xl font-bold text-amber-300">{nm(o)} · {rem(o)} to make</div>
            <div className="text-slate-300">{det(o)}</div>
            <div className="text-sm text-slate-400">Ordered {o.quantity}{(o.qty_made ?? 0) > 0 ? ` · already made ${o.qty_made}` : ''}</div></div>
          <button disabled={!!running} onClick={() => start(o.id)} className="h-14 px-6 rounded-xl bg-blue-600 disabled:bg-slate-700 disabled:text-slate-500 text-lg font-bold">{running ? 'Lathe busy' : '▶ Start'}</button></div>)}</div>}
    </div>); };

  const dcard = ([k, items]: [string, DeliveryFull[]]) => { const f = items[0].ord!; return (<div key={k} className="rounded-2xl bg-slate-900 border-2 border-slate-700 p-4">
    <div className="text-2xl font-bold">{f.roller?.roller_size ?? '—'} <span className="text-slate-400 text-lg font-normal">Drg {f.roller?.customer_drg ?? '—'}{f.roller?.party_name ? ` · ${f.roller.party_name}` : ''} · {f.machine_id}</span></div>
    <div className="mt-2 space-y-1">{items.map(d => <div key={d.id} className="flex justify-between gap-3 flex-wrap rounded-lg bg-slate-800 p-2">
      <span className="font-bold text-amber-300">{nm(d.ord!)}</span>
      <span>Batch <b className="text-xl">{d.qty_made}</b> <span className="text-slate-400">(order {d.ord!.quantity}, made so far {d.ord!.qty_made ?? 0})</span></span>
      <span className="text-sm text-slate-400">{dt(d.made_at)} · {d.status === 'READY' ? '📦 still at CNC' : `✔ at plant (${d.qty_received ?? '?'} received)`}</span></div>)}</div></div>); };

  const cutoff = hd ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (hd - 1)); return +d; })() : 0;
  const hlist = hist.filter(d => d.ord && +new Date(d.made_at) >= cutoff && (d.ord.roller?.roller_size ?? '').toLowerCase().includes(hs.trim().toLowerCase()));
  const newest = (g: [string, DeliveryFull[]][]) => g.sort((a, b) => +new Date(b[1][0].made_at) - +new Date(a[1][0].made_at));
  const days = groupBy(oldest(waiting.filter(o => !urgent(o))), o => dayKey(o.created_at));
  const urg = waiting.filter(urgent);

  return (<div className="p-4 max-w-4xl mx-auto space-y-4">
    <h1 className="text-2xl font-bold">CNC {running && <span className="ml-2 text-base bg-blue-600 rounded-lg px-3 py-1">Lathe busy</span>}</h1>
    <div className="grid grid-cols-3 gap-2">{([['queue', `To make (${waiting.length + (running ? 1 : 0)})`], ['ready', `Ready · at my place (${ready.length})`], ['history', 'History']] as const).map(([t, l]) =>
      <button key={t} onClick={() => setTab(t)} className={`h-16 rounded-xl border-2 text-lg font-bold ${tab === t ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{l}</button>)}</div>

    {tab === 'queue' && <>
      {running && (() => { const o = running; const d = done?.id === o.id ? done : null;
        return <div className="rounded-2xl bg-slate-900 border-4 border-blue-500 p-4">
          <div className="flex justify-between gap-2 flex-wrap"><div>
            <div className="text-3xl font-extrabold">{o.roller?.roller_size ?? '—'} <span className="text-slate-400 text-xl font-semibold">Drg {o.roller?.customer_drg ?? '—'}</span></div>
            <div className="text-slate-300">{o.roller?.party_name ? `Party: ${o.roller.party_name} · ` : ''}For {o.machine_id}{o.roller_qty ? ` · ${o.roller_qty.toLocaleString('en-IN')} rollers to forge` : ''}</div>
            <div className="text-3xl mt-2 text-amber-300 font-bold">{nm(o)} · {rem(o)} to make</div>
            <div className="text-xl text-slate-300">{det(o)}</div>
            <div className="text-sm text-slate-400">Ordered {o.quantity}{(o.qty_made ?? 0) > 0 ? ` · already made ${o.qty_made}` : ''} · placed {dt(o.created_at)}{o.started_lathe_at ? ` · on lathe since ${dt(o.started_lathe_at)}` : ''}</div></div>
            <div className="flex gap-2 h-fit">{urgent(o) && <span className="bg-red-600 rounded-lg px-3 py-1 font-bold">URGENT</span>}<span className="bg-blue-600 rounded-lg px-3 py-1 font-bold">ON LATHE</span></div></div>
          {!d ? <div className="grid grid-cols-2 gap-3 mt-4">
              <button onClick={() => setDone({ id: o.id, qty: Math.max(1, rem(o)) })} className="h-20 rounded-2xl bg-green-600 text-xl font-extrabold">✔ COMPLETE BATCH · READY TO DISPATCH</button>
              <button onClick={() => stop(o.id)} className="h-20 rounded-2xl bg-slate-600 text-xl font-extrabold">✖ STOP</button></div>
            : <div className="mt-4 rounded-2xl bg-slate-800 p-4 text-center space-y-3">
              <div className="text-xl">How many did you make in this batch? <span className="text-slate-400">({rem(o)} still owed)</span></div>
              <div className="flex items-center justify-center gap-4">
                <button onClick={() => setDone({ id: o.id, qty: Math.max(1, d.qty - 1) })} className="w-24 h-20 rounded-xl bg-slate-700 text-4xl font-bold">−</button>
                <span className="text-7xl font-extrabold w-40">{d.qty}</span>
                <button onClick={() => setDone({ id: o.id, qty: d.qty + 1 })} className="w-24 h-20 rounded-xl bg-slate-700 text-4xl font-bold">+</button></div>
              <div className="text-sm text-slate-400">Anything not made stays in the queue. Only the toolroom can close the balance.</div>
              <div className="flex gap-3"><button onClick={finish} className="flex-1 h-20 rounded-2xl bg-green-600 text-xl font-extrabold">✔ CONFIRM · READY TO DISPATCH</button>
                <button onClick={() => setDone(null)} className="px-6 rounded-2xl bg-slate-700 text-lg">Cancel</button></div></div>}
        </div>; })()}

      {urg.length > 0 && <section className="space-y-2"><h2 className="text-lg font-bold text-red-400">🔴 Urgent · {urg.length} tool{urg.length > 1 ? 's' : ''} · {pcs(urg)} pcs</h2>
        {groupBy(oldest(urg), gkey).map(row)}</section>}

      {days.map(([k, list]) => { const closed = !!shut[k]; return <section key={k} className="space-y-2">
        <button onClick={() => setShut({ ...shut, [k]: !closed })} className="w-full min-h-14 flex items-center justify-between rounded-xl bg-slate-800 px-4 text-left">
          <span className="text-lg font-bold">{dayLabel(k)} <span className="text-slate-400 font-normal">· {groupBy(list, gkey).length} order{groupBy(list, gkey).length > 1 ? 's' : ''} · {pcs(list)} pcs pending</span></span><span>{closed ? '▼' : '▲'}</span></button>
        {!closed && groupBy(list, gkey).map(row)}</section>; })}
      {!waiting.length && !running && <p className="text-2xl text-slate-500 py-20 text-center">No orders. New ones appear here instantly.</p>}</>}

    {tab === 'ready' && <div className="space-y-3">
      <p className="text-slate-400">Made and waiting at your place. They leave this list once the plant confirms receipt. <b className="text-slate-100">{ready.reduce((a, d) => a + d.qty_made, 0)} pcs</b> waiting.</p>
      {!ready.length && <p className="text-2xl text-slate-500 py-16 text-center">Nothing waiting. Everything made has reached the plant.</p>}
      {newest(groupBy(ready, d => gkey(d.ord!))).map(dcard)}</div>}

    {tab === 'history' && <div className="space-y-3">
      <div className="flex gap-2 flex-wrap items-center">{([[1, 'Today'], [7, '7 days'], [30, '30 days'], [0, 'All']] as const).map(([d, l]) =>
        <button key={d} onClick={() => setHd(d)} className={`px-5 h-12 rounded-lg ${hd === d ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-slate-800'}`}>{l}</button>)}
        <span className="ml-auto text-slate-400">Total made: <b className="text-slate-100 text-xl">{hlist.reduce((a, d) => a + d.qty_made, 0)}</b></span></div>
      <input className="h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full" placeholder="Search by roller size" value={hs} onChange={e => setHs(e.target.value)}/>
      {!hlist.length && <p className="text-xl text-slate-500 py-10 text-center">Nothing made in this period.</p>}
      {newest(groupBy(hlist, d => gkey(d.ord!))).map(dcard)}</div>}
  </div>);
}

export default function Page() { return <Guard allow={['cnc', 'owner']}><Cnc/></Guard>; }
