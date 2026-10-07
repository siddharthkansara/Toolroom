'use client';
import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Guard } from '@/lib/auth';
import { useOrders, dt, SEL } from '@/lib/useOrders';
import { TOOL_LABEL, type OrderFull } from '@/types/database';

const fd = (d: string | null) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '');
const tname = (o: OrderFull) => (o.tooling ? `${TOOL_LABEL[o.tooling.tool_type]} ${o.tooling.batta_code ?? ''}`.trim() : o.custom_tool_name || 'Other tool');
const kind = (o: OrderFull) => (o.tooling ? TOOL_LABEL[o.tooling.tool_type] : o.custom_tool_name || 'Other tool');
const ym = (x: string) => { const d = new Date(x); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const card = 'bg-slate-900 rounded-xl p-5 border border-slate-800';

function Dashboard() {
  const { orders } = useOrders();
  const [days, setDays] = useState(1);
  const [month, setMonth] = useState(() => ym(new Date().toISOString()));
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');

  async function exportCsv() {
    let all: OrderFull[] = [];
    for (let i = 0; ; i += 1000) {   // page through all rows (Supabase returns max 1000 per request)
      const { data } = await supabase.from('tool_orders').select(SEL).order('created_at').range(i, i + 999);
      if (!data?.length) break; all = all.concat(data as unknown as OrderFull[]); if (data.length < 1000) break;
    }
    const day = (x: string) => { const d = new Date(x); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    all = all.filter(o => (!from || day(o.created_at) >= from) && (!to || day(o.created_at) <= to));
    const head = ['Slip No', 'Ordered At', 'Machine', 'Roller Size', 'Drawing No', 'Party', 'Tool', 'Batta No', 'OD', 'Length', 'OD 2', 'Step', 'Custom Tool Dims', 'Priority', 'Rollers To Forge', 'Qty Ordered', 'Qty Made', 'Shortfall', 'Status', 'Machining Started', 'Ready To Dispatch At', 'Received At'];
    const rows = all.map(o => [o.slip_no, fd(o.created_at), o.machine_id, o.roller?.roller_size, o.roller?.customer_drg, o.roller?.party_name, kind(o), o.tooling?.batta_code, o.tooling?.od_dim, o.tooling?.length_dim, o.tooling?.od2_dim, o.tooling?.step_depth_dim,
      o.custom_dimensions, o.priority === 'URGENT_MACHINE_DOWN' ? 'Urgent' : 'Next morning', o.roller_qty, o.quantity, o.qty_made, o.qty_made != null ? o.quantity - o.qty_made : '', o.status, fd(o.started_lathe_at), fd(o.dispatched_at), fd(o.received_at)]);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = '\uFEFF' + [head, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `tool-orders-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  }

  const today = new Date().toDateString();
  const lathe = orders.filter(o => o.status === 'ON_LATHE');
  const stat = [['Active headers', new Set(orders.filter(o => ['QUEUED', 'ON_LATHE', 'IN_TRANSIT'].includes(o.status)).map(o => o.machine_id)).size], ['On lathe now', lathe.length],
    ['Ready to dispatch', orders.filter(o => o.status === 'IN_TRANSIT').length], ["Today's orders", orders.filter(o => new Date(o.created_at).toDateString() === today).length]];

  const cutoff = days ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (days - 1)); return +d; })() : 0;
  const made = orders.filter(o => o.qty_made != null && o.dispatched_at && +new Date(o.dispatched_at) >= cutoff);
  const grp: Record<string, { drg: string | null; tools: Record<string, number>; total: number }> = {};
  made.forEach(o => { const g = (grp[o.roller?.roller_size ?? '—'] ??= { drg: o.roller?.customer_drg ?? null, tools: {}, total: 0 });
    g.tools[kind(o)] = (g.tools[kind(o)] ?? 0) + o.qty_made!; g.total += o.qty_made!; });
  const totalMade = made.reduce((a, o) => a + o.qty_made!, 0);

  const rep: Record<string, OrderFull[]> = {};
  orders.filter(o => ym(o.created_at) === month).forEach(o => (rep[o.roller?.roller_size ?? '—'] ??= []).push(o));

  return (<div className="p-6 max-w-7xl mx-auto space-y-8">
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">{stat.map(([k, v]) =>
      <div key={k} className={card}><div className="text-slate-400">{k}</div><div className="text-5xl font-bold mt-1">{v}</div></div>)}</div>

    <section className={card}><h2 className="text-xl font-bold mb-3">On the CNC lathe now</h2>
      {!lathe.length && <p className="text-slate-500">Lathe is idle.</p>}
      <div className="grid md:grid-cols-2 gap-3">{lathe.map(o => <div key={o.id} className="bg-slate-800 rounded-lg p-3">
        <div className="text-lg font-bold">{o.machine_id} · {o.roller?.roller_size ?? '—'} <span className="text-slate-400 font-normal">Drg {o.roller?.customer_drg ?? '—'}</span></div>
        <div className="text-amber-300 text-lg">{tname(o)} × {o.quantity}</div>
        <div className="text-sm text-slate-400">Ordered {dt(o.created_at)}{o.started_lathe_at ? ` · started ${dt(o.started_lathe_at)}` : ''}</div></div>)}</div></section>

    <section className={card}><div className="flex items-center gap-2 flex-wrap mb-3"><h2 className="text-xl font-bold mr-3">Tools made</h2>
      {([[1, 'Today'], [7, '7 days'], [14, '14 days'], [30, '30 days'], [0, 'All time']] as const).map(([d, l]) =>
        <button key={d} onClick={() => setDays(d)} className={`px-4 py-2 rounded-lg ${days === d ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-slate-800'}`}>{l}</button>)}
      <span className="ml-auto text-slate-400">Total made: <b className="text-slate-100 text-xl">{totalMade}</b></span></div>
      {!made.length && <p className="text-slate-500">Nothing confirmed as made in this period.</p>}
      <table className="w-full"><tbody>{Object.entries(grp).sort((a, b) => b[1].total - a[1].total).map(([s, g]) => <tr key={s} className="border-t border-slate-800">
        <td className="py-2 font-bold">{s}</td><td className="text-slate-400">{g.drg ?? ''}</td>
        <td>{Object.entries(g.tools).map(([k, n]) => `${n} ${k}`).join(' · ')}</td><td className="text-right font-bold">{g.total}</td></tr>)}</tbody></table></section>

    <section className={card}><h2 className="text-xl font-bold mb-3">Export orders (CSV)</h2>
      <div className="flex gap-3 items-center flex-wrap"><label className="text-slate-400">From <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="bg-slate-800 rounded-lg p-2 text-slate-100"/></label>
        <label className="text-slate-400">To <input type="date" value={to} onChange={e => setTo(e.target.value)} className="bg-slate-800 rounded-lg p-2 text-slate-100"/></label>
        <button onClick={exportCsv} className="px-6 py-3 rounded-lg bg-amber-500 text-slate-950 font-bold">⬇ Download</button>
        <span className="text-slate-500 text-sm">Leave dates empty for all orders. Includes qty ordered, qty made and times.</span></div></section>

    <section><div className="flex items-center gap-4 mb-3 flex-wrap"><h2 className="text-xl font-bold">Monthly orders by roller size</h2>
      <input type="month" value={month} onChange={e => setMonth(e.target.value)} className="bg-slate-800 rounded-lg p-2"/></div>
      {!Object.keys(rep).length && <p className="text-slate-500">No orders this month.</p>}
      <div className="grid xl:grid-cols-2 gap-4">{Object.entries(rep).sort().map(([size, list]) => <div key={size} className={card}>
        <div className="text-lg font-bold">{size} <span className="text-slate-400 font-normal">Drg {list[0].roller?.customer_drg ?? '—'} · ordered {list.reduce((a, o) => a + o.quantity, 0)} · made {list.reduce((a, o) => a + (o.qty_made ?? 0), 0)}</span></div>
        <table className="w-full mt-2 text-sm"><tbody>{[...list].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)).map(o => <tr key={o.id} className="border-t border-slate-800">
          <td className="py-1">{dt(o.created_at)}</td><td>{o.machine_id}</td><td>{tname(o)}</td><td className="text-right">{o.quantity}</td><td className="text-right text-green-400">{o.qty_made ?? '—'}</td></tr>)}</tbody></table></div>)}</div></section>
  </div>);
}

export default function Page() { return <Guard allow={['owner']}><Dashboard/></Guard>; }
