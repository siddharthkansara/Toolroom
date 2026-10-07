'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Guard } from '@/lib/auth';
import { useOrders, dt, gkey, SEL } from '@/lib/useOrders';
import { TOOL_LABEL, type OrderFull } from '@/types/database';

const nm = (o: OrderFull) => (o.tooling ? TOOL_LABEL[o.tooling.tool_type] : o.custom_tool_name || 'Other tool');
const det = (o: OrderFull) => { const k = o.tooling; if (!k) return o.custom_dimensions ?? '';
  return k.tool_type === 'DIE_TOP' ? (k.batta_code ? `Batta ${k.batta_code}` : '')
    : k.tool_type === 'BOTTOM' ? `OD ${k.od_dim ?? '—'} × L ${k.length_dim ?? '—'} · OD ${k.od2_dim ?? '—'} · Step ${k.step_depth_dim ?? '—'}`
    : k.tool_type === 'FACING_PUNCH' ? `OD ${k.od_dim ?? '—'} × L ${k.length_dim ?? '—'}` : ''; };

function Cnc() {
  const { orders, reload } = useOrders();
  const [done, setDone] = useState<{ id: string; qty: number } | null>(null);
  const [tab, setTab] = useState<'queue' | 'ready' | 'history'>('queue');
  const [hist, setHist] = useState<OrderFull[]>([]); const [hd, setHd] = useState(7); const [hs, setHs] = useState('');
  useEffect(() => {   // everything ever made (paged: Supabase returns max 1000 rows per request)
    if (tab !== 'history') return;
    (async () => { let all: OrderFull[] = [];
      for (let i = 0; ; i += 1000) {
        const { data } = await supabase.from('tool_orders').select(SEL).not('qty_made', 'is', null).order('dispatched_at', { ascending: false }).range(i, i + 999);
        if (!data?.length) break; all = all.concat(data as unknown as OrderFull[]); if (data.length < 1000) break;
      } setHist(all); })();
  }, [tab, orders]);
  const lathe = orders.some(o => o.status === 'ON_LATHE');   // one job at a time
  const map: Record<string, OrderFull[]> = {};
  orders.filter(o => o.status === 'QUEUED' || o.status === 'ON_LATHE').forEach(o => (map[gkey(o)] ??= []).push(o));
  const batches = Object.entries(map).map(([k, items]) => ({ k, items: items.sort((a, b) => a.slip_no - b.slip_no) }))
    .sort((a, b) => { const r = (x: typeof a) => x.items.some(o => o.status === 'ON_LATHE') ? 0 : x.items[0].priority === 'URGENT_MACHINE_DOWN' ? 1 : 2;
      return r(a) - r(b) || +new Date(a.items[0].created_at) - +new Date(b.items[0].created_at); });
  const ready = (k: string) => orders.filter(o => gkey(o) === k && o.status === 'IN_TRANSIT').length;

  const grp = (list: OrderFull[]) => { const m: Record<string, OrderFull[]> = {}; list.forEach(o => (m[gkey(o)] ??= []).push(o));
    const last = (x: OrderFull[]) => Math.max(...x.map(o => +new Date(o.dispatched_at ?? 0)));
    return Object.entries(m).map(([k, items]) => ({ k, items: items.sort((a, b) => a.slip_no - b.slip_no) })).sort((a, b) => last(b.items) - last(a.items)); };
  const pickup = orders.filter(o => o.status === 'IN_TRANSIT');
  const cutoff = hd ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (hd - 1)); return +d; })() : 0;
  const hlist = hist.filter(o => o.dispatched_at && +new Date(o.dispatched_at) >= cutoff && (o.roller?.roller_size ?? '').toLowerCase().includes(hs.trim().toLowerCase()));
  const card = ({ k, items }: { k: string; items: OrderFull[] }) => { const f = items[0]; return <div key={k} className="rounded-2xl bg-slate-900 border-2 border-slate-700 p-4">
    <div className="text-2xl font-bold">{f.roller?.roller_size ?? '—'} <span className="text-slate-400 text-lg font-normal">Drg {f.roller?.customer_drg ?? '—'}{f.roller?.party_name ? ` · ${f.roller.party_name}` : ''} · {f.machine_id}</span></div>
    <div className="mt-2 space-y-1">{items.map(o => <div key={o.id} className="flex justify-between gap-3 flex-wrap rounded-lg bg-slate-800 p-2">
      <span className="font-bold text-amber-300">{nm(o)}</span>
      <span>Made <b className="text-xl">{o.qty_made}</b> <span className="text-slate-400">of {o.quantity}</span></span>
      <span className="text-sm text-slate-400">{o.dispatched_at ? dt(o.dispatched_at) : ''} · {o.status === 'IN_TRANSIT' ? '📦 still at CNC' : o.received_at ? `✔ at plant ${dt(o.received_at)}` : '✔ at plant'}</span></div>)}</div></div>; };
  async function start(id: string) {
    const { error } = await supabase.from('tool_orders').update({ status: 'ON_LATHE', started_lathe_at: new Date().toISOString() }).eq('id', id);
    if (error) alert('Another job is already on the lathe.'); reload();
  }
  async function stop(id: string) {
    await supabase.from('tool_orders').update({ status: 'QUEUED', started_lathe_at: null }).eq('id', id); setDone(null); reload();
  }
  async function finish() {
    if (!done) return;
    await supabase.from('tool_orders').update({ status: 'IN_TRANSIT', dispatched_at: new Date().toISOString(), qty_made: done.qty }).eq('id', done.id);
    setDone(null); reload();
  }
  return (<div className="p-4 max-w-4xl mx-auto space-y-4">
    <h1 className="text-2xl font-bold">CNC Queue <span className="text-slate-500">({batches.length} orders)</span>
      {lathe && <span className="ml-3 text-base bg-blue-600 rounded-lg px-3 py-1">Lathe busy</span>}</h1>
    <div className="grid grid-cols-3 gap-2">{([['queue', `To make (${batches.length})`], ['ready', `Made · at my place (${pickup.length})`], ['history', 'History']] as const).map(([t, l]) =>
      <button key={t} onClick={() => setTab(t)} className={`h-16 rounded-xl border-2 text-lg font-bold ${tab === t ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{l}</button>)}</div>
    {tab === 'queue' && batches.length === 0 && <p className="text-2xl text-slate-500 py-20 text-center">No orders. New ones appear here instantly.</p>}
    {tab === 'queue' && batches.map(({ k, items }) => { const f = items[0]; const urgent = f.priority === 'URGENT_MACHINE_DOWN'; const running = items.some(o => o.status === 'ON_LATHE'); const rd = ready(k);
      return <div key={k} className={`rounded-2xl bg-slate-900 border-4 p-4 ${urgent ? 'border-red-500 urgent' : running ? 'border-blue-500' : 'border-slate-700'}`}>
        <div className="flex justify-between items-start gap-2 flex-wrap">
          <div><div className="text-3xl font-extrabold">{f.roller?.roller_size ?? '—'} <span className="text-slate-400 text-xl font-semibold">Drg {f.roller?.customer_drg ?? '—'}</span></div>
            <div className="text-slate-300">{f.roller?.party_name ? `Party: ${f.roller.party_name} · ` : ''}For {f.machine_id}{f.roller_qty ? ` · ${f.roller_qty.toLocaleString('en-IN')} rollers to forge` : ''}</div>
            <div className="text-slate-400 text-sm">Ordered {dt(f.created_at)} · Slip #{items[0].slip_no}{rd ? ` · ✔ ${rd} already ready to dispatch` : ''}</div></div>
          <div className="flex gap-2">{urgent && <span className="bg-red-600 rounded-lg px-3 py-1 font-bold">🔴 URGENT</span>}{running && <span className="bg-blue-600 rounded-lg px-3 py-1 font-bold">ON LATHE</span>}</div></div>
        <div className="mt-3 space-y-2">{items.map(o => { const d = done?.id === o.id ? done : null;
          return <div key={o.id} className="rounded-xl bg-slate-800 p-3">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-48"><div className="text-xl font-bold text-amber-300">{nm(o)} × {o.quantity}</div>
                <div className="text-slate-300">{det(o)}</div>
                {o.status === 'ON_LATHE' && o.started_lathe_at && <div className="text-sm text-slate-400">On lathe since {dt(o.started_lathe_at)}</div>}</div>
              {o.status === 'QUEUED'
                ? <button disabled={lathe} onClick={() => start(o.id)} className="h-14 px-6 rounded-xl bg-blue-600 disabled:bg-slate-700 disabled:text-slate-500 text-lg font-bold">{lathe ? 'Lathe busy' : '▶ Start'}</button>
                : !d && <><button onClick={() => setDone({ id: o.id, qty: o.quantity })} className="h-14 px-5 rounded-xl bg-green-600 text-lg font-bold">✔ Complete · Ready to dispatch</button>
                    <button onClick={() => stop(o.id)} className="h-14 px-5 rounded-xl bg-slate-600 text-lg font-bold">✖ Stop</button></>}</div>
            {d && <div className="mt-3 text-center space-y-2"><div className="text-xl">How many did you make? <span className="text-slate-400">(ordered {o.quantity})</span></div>
              <div className="flex items-center justify-center gap-4">
                <button onClick={() => setDone({ id: o.id, qty: Math.max(0, d.qty - 1) })} className="w-20 h-16 rounded-xl bg-slate-700 text-3xl font-bold">−</button>
                <span className="text-6xl font-extrabold w-32">{d.qty}</span>
                <button onClick={() => setDone({ id: o.id, qty: d.qty + 1 })} className="w-20 h-16 rounded-xl bg-slate-700 text-3xl font-bold">+</button></div>
              <div className="flex gap-3"><button onClick={finish} className="flex-1 h-16 rounded-xl bg-green-600 text-xl font-extrabold">✔ CONFIRM · READY TO DISPATCH</button>
                <button onClick={() => setDone(null)} className="px-6 rounded-xl bg-slate-700 text-lg">Cancel</button></div></div>}
          </div>; })}</div>
      </div>; })}
    {tab === 'ready' && <div className="space-y-3">
      <p className="text-slate-400">Made and waiting at your place. They leave this list once the plant marks them received. <b className="text-slate-100">{pickup.reduce((a, o) => a + (o.qty_made ?? 0), 0)} pcs</b> waiting.</p>
      {!pickup.length && <p className="text-2xl text-slate-500 py-16 text-center">Nothing waiting. Everything made has reached the plant.</p>}
      {grp(pickup).map(card)}</div>}
    {tab === 'history' && <div className="space-y-3">
      <div className="flex gap-2 flex-wrap items-center">{([[1, 'Today'], [7, '7 days'], [30, '30 days'], [0, 'All']] as const).map(([d, l]) =>
        <button key={d} onClick={() => setHd(d)} className={`px-5 h-12 rounded-lg ${hd === d ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-slate-800'}`}>{l}</button>)}
        <span className="ml-auto text-slate-400">Total made: <b className="text-slate-100 text-xl">{hlist.reduce((a, o) => a + (o.qty_made ?? 0), 0)}</b></span></div>
      <input className="h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full" placeholder="Search by roller size" value={hs} onChange={e => setHs(e.target.value)}/>
      {!hlist.length && <p className="text-xl text-slate-500 py-10 text-center">Nothing made in this period.</p>}
      {grp(hlist).map(card)}</div>}
  </div>);
}

export default function Page() { return <Guard allow={['cnc', 'owner']}><Cnc/></Guard>; }
