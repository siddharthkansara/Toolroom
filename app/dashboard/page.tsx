'use client';
import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Guard } from '@/lib/auth';
import { useOrders, dt, SEL } from '@/lib/useOrders';
import { TOOL_LABEL, type OrderFull, type Delivery } from '@/types/database';

const fd = (d: string | null) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '');
const kind = (o: OrderFull) => (o.tooling ? TOOL_LABEL[o.tooling.tool_type] : o.custom_tool_name || 'Other tool');
const tname = (o: OrderFull) => (o.tooling ? `${TOOL_LABEL[o.tooling.tool_type]} ${o.tooling.batta_code ?? ''}`.trim() : o.custom_tool_name || 'Other tool');
const ym = (x: string) => { const d = new Date(x); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const rem = (o: OrderFull) => Math.max(0, o.quantity - (o.qty_made ?? 0));
const stText = (o: OrderFull) => o.status === 'CLOSED' ? ((o.qty_made ?? 0) >= o.quantity ? 'Completed' : 'Closed short')
  : o.status === 'ON_LATHE' ? 'On lathe' : (o.qty_made ?? 0) > 0 ? 'Partly made' : 'Queued';
const card = 'bg-slate-900 rounded-xl p-5 border border-slate-800';

function Dashboard() {
  const { orders, deliveries } = useOrders();
  const [days, setDays] = useState(1);
  const [month, setMonth] = useState(() => ym(new Date().toISOString()));
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');

  async function exportCsv() {
    let all: OrderFull[] = []; let dl: Delivery[] = [];
    for (let i = 0; ; i += 1000) {   // page through everything (Supabase returns max 1000 rows per request)
      const { data } = await supabase.from('tool_orders').select(SEL).order('created_at').range(i, i + 999);
      if (!data?.length) break; all = all.concat(data as unknown as OrderFull[]); if (data.length < 1000) break;
    }
    for (let i = 0; ; i += 1000) {
      const { data } = await supabase.from('deliveries').select('*').order('made_at').range(i, i + 999);
      if (!data?.length) break; dl = dl.concat(data as unknown as Delivery[]); if (data.length < 1000) break;
    }
    const by: Record<string, Delivery[]> = {}; dl.forEach(d => (by[d.order_id] ??= []).push(d));
    const day = (x: string) => { const d = new Date(x); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    all = all.filter(o => (!from || day(o.created_at) >= from) && (!to || day(o.created_at) <= to));
    const head = ['Slip No', 'Ordered At', 'Machine', 'Roller Size', 'Drawing No', 'Party', 'Tool', 'Batta No', 'OD', 'Length', 'OD 2', 'Step', 'Custom Tool Dims', 'Priority', 'Rollers To Forge',
      'Qty Ordered', 'Qty Made', 'Short (ordered-made)', 'Qty Received', 'Missing in transit (made-received)', 'Status', 'Closed At', 'Number of Batches', 'Batches'];
    const rows = all.map(o => { const b = by[o.id] ?? [];
      return [o.slip_no, fd(o.created_at), o.machine_id, o.roller?.roller_size, o.roller?.customer_drg, o.roller?.party_name, kind(o), o.tooling?.batta_code, o.tooling?.od_dim, o.tooling?.length_dim, o.tooling?.od2_dim, o.tooling?.step_depth_dim,
        o.custom_dimensions, o.priority === 'URGENT_MACHINE_DOWN' ? 'Urgent' : 'Next morning', o.roller_qty, o.quantity, o.qty_made ?? 0, o.quantity - (o.qty_made ?? 0), o.qty_received ?? 0,
        (o.qty_made ?? 0) - (o.qty_received ?? 0), stText(o), fd(o.closed_at), b.length,
        b.map(d => `${d.qty_made} made ${fd(d.made_at)} -> ${d.status === 'RECEIVED' ? `${d.qty_received} received ${fd(d.received_at)}` : 'not received yet'}`).join(' | ')]; });
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = '\uFEFF' + [head, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `tool-orders-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  }

  const today = new Date().toDateString();
  const open = orders.filter(o => o.status === 'QUEUED' || o.status === 'ON_LATHE');
  const lathe = open.filter(o => o.status === 'ON_LATHE');
  const atCnc = deliveries.filter(d => d.status === 'READY').reduce((a, d) => a + d.qty_made, 0);
  const stat = [['Machines waiting', new Set(open.map(o => o.machine_id)).size], ['Pieces still to make', open.reduce((a, o) => a + rem(o), 0)], ['On lathe now', lathe.length],
    ['Pieces at CNC, not received', atCnc], ["Today's orders", orders.filter(o => new Date(o.created_at).toDateString() === today).length]];

  const cutoff = days ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (days - 1)); return +d; })() : 0;
  const dm = deliveries.filter(d => d.ord && +new Date(d.made_at) >= cutoff);
  const grp: Record<string, { drg: string | null; tools: Record<string, number>; made: number; recd: number }> = {};
  dm.forEach(d => { const o = d.ord!; const g = (grp[o.roller?.roller_size ?? '—'] ??= { drg: o.roller?.customer_drg ?? null, tools: {}, made: 0, recd: 0 });
    g.tools[kind(o)] = (g.tools[kind(o)] ?? 0) + d.qty_made; g.made += d.qty_made; g.recd += d.qty_received ?? 0; });

  const rep: Record<string, OrderFull[]> = {};
  orders.filter(o => ym(o.created_at) === month).forEach(o => (rep[o.roller?.roller_size ?? '—'] ??= []).push(o));

  return (<div className="p-6 max-w-7xl mx-auto space-y-8">
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">{stat.map(([k, v]) =>
      <div key={k} className={card}><div className="text-slate-400">{k}</div><div className="text-5xl font-bold mt-1">{v}</div></div>)}</div>

    <section className={card}><h2 className="text-xl font-bold mb-3">On the CNC lathe now</h2>
      {!lathe.length && <p className="text-slate-500">Lathe is idle.</p>}
      <div className="grid md:grid-cols-2 gap-3">{lathe.map(o => <div key={o.id} className="bg-slate-800 rounded-lg p-3">
        <div className="text-lg font-bold">{o.machine_id} · {o.roller?.roller_size ?? '—'} <span className="text-slate-400 font-normal">Drg {o.roller?.customer_drg ?? '—'}</span></div>
        <div className="text-amber-300 text-lg">{tname(o)} · {rem(o)} to make <span className="text-slate-400">(ordered {o.quantity})</span></div>
        <div className="text-sm text-slate-400">Ordered {dt(o.created_at)}{o.started_lathe_at ? ` · started ${dt(o.started_lathe_at)}` : ''}</div></div>)}</div></section>

    <section className={card}><div className="flex items-center gap-2 flex-wrap mb-3"><h2 className="text-xl font-bold mr-3">Tools made</h2>
      {([[1, 'Today'], [7, '7 days'], [14, '14 days'], [30, '30 days'], [0, 'All time']] as const).map(([d, l]) =>
        <button key={d} onClick={() => setDays(d)} className={`px-4 py-2 rounded-lg ${days === d ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-slate-800'}`}>{l}</button>)}
      <span className="ml-auto text-slate-400">Made <b className="text-slate-100 text-xl">{dm.reduce((a, d) => a + d.qty_made, 0)}</b> · Received <b className="text-sky-400 text-xl">{dm.reduce((a, d) => a + (d.qty_received ?? 0), 0)}</b></span></div>
      {!dm.length && <p className="text-slate-500">Nothing made in this period.</p>}
      <table className="w-full"><tbody>{Object.entries(grp).sort((a, b) => b[1].made - a[1].made).map(([s, g]) => <tr key={s} className="border-t border-slate-800">
        <td className="py-2 font-bold">{s}</td><td className="text-slate-400">{g.drg ?? ''}</td>
        <td>{Object.entries(g.tools).map(([k, n]) => `${n} ${k}`).join(' · ')}</td><td className="text-right font-bold">{g.made}</td><td className="text-right text-sky-400">{g.recd}</td></tr>)}</tbody></table>
      <p className="text-xs text-slate-500 mt-2">Columns: roller size, drawing, tools made, total made, total received at plant. Each batch is counted on the day the CNC operator confirmed it.</p></section>

    <section className={card}><h2 className="text-xl font-bold mb-3">Export orders (CSV)</h2>
      <div className="flex gap-3 items-center flex-wrap"><label className="text-slate-400">From <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="bg-slate-800 rounded-lg p-2 text-slate-100"/></label>
        <label className="text-slate-400">To <input type="date" value={to} onChange={e => setTo(e.target.value)} className="bg-slate-800 rounded-lg p-2 text-slate-100"/></label>
        <button onClick={exportCsv} className="px-6 py-3 rounded-lg bg-amber-500 text-slate-950 font-bold">⬇ Download</button>
        <span className="text-slate-500 text-sm">Leave dates empty for all orders. One row per order, with every batch (made and received) listed in the last column.</span></div></section>

    <section><div className="flex items-center gap-4 mb-3 flex-wrap"><h2 className="text-xl font-bold">Monthly orders by roller size</h2>
      <input type="month" value={month} onChange={e => setMonth(e.target.value)} className="bg-slate-800 rounded-lg p-2"/></div>
      {!Object.keys(rep).length && <p className="text-slate-500">No orders this month.</p>}
      <div className="grid xl:grid-cols-2 gap-4">{Object.entries(rep).sort().map(([size, list]) => <div key={size} className={card}>
        <div className="text-lg font-bold">{size} <span className="text-slate-400 font-normal">Drg {list[0].roller?.customer_drg ?? '—'} · ordered {list.reduce((a, o) => a + o.quantity, 0)} · made {list.reduce((a, o) => a + (o.qty_made ?? 0), 0)} · received {list.reduce((a, o) => a + (o.qty_received ?? 0), 0)}</span></div>
        <table className="w-full mt-2 text-sm"><tbody>{[...list].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)).map(o => <tr key={o.id} className="border-t border-slate-800">
          <td className="py-1">{dt(o.created_at)}</td><td>{o.machine_id}</td><td>{tname(o)}</td><td className="text-right">{o.quantity}</td>
          <td className="text-right text-green-400">{o.qty_made ?? '—'}</td><td className="text-right text-sky-400">{o.qty_received ?? '—'}</td><td className="text-right text-slate-400">{stText(o)}</td></tr>)}</tbody></table></div>)}</div>
      <p className="text-xs text-slate-500 mt-2">Columns: date, machine, tool, ordered, made, received, status.</p></section>
  </div>);
}

export default function Page() { return <Guard allow={['owner']}><Dashboard/></Guard>; }
