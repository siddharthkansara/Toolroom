'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Guard } from '@/lib/auth';
import { DailyProduction } from '@/lib/dailyProduction';
import { useOrders, dt, SEL, DSEL } from '@/lib/useOrders';
import { FACTORIES, FCHIP, mname as mcode, rollerLabel } from '@/lib/factories';
import { TOOL_LABEL, type OrderFull, type DeliveryFull, type Delivery, type LatheLog, type RollerMaster, type MonthlyProduction } from '@/types/database';
import { StockFreshness } from '@/lib/stockReminder';
import { ShiftReports } from '@/lib/shiftReports';

const fd = (d: string | null) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '');
const kind = (o: OrderFull) => (o.tooling ? TOOL_LABEL[o.tooling.tool_type] : o.custom_tool_name || 'Other tool');
const tname = (o: OrderFull) => (o.tooling ? `${TOOL_LABEL[o.tooling.tool_type]} ${o.tooling.batta_code ?? ''}`.trim() : o.custom_tool_name || 'Other tool');
const pad = (n: number) => String(n).padStart(2, '0');
const ym = (x: string) => { const d = new Date(x); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const dayStr = (x: string) => { const d = new Date(x); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const rem = (o: OrderFull) => Math.max(0, o.quantity - (o.qty_made ?? 0));
const stText = (o: OrderFull) => o.status === 'CLOSED' ? ((o.qty_made ?? 0) >= o.quantity ? 'Completed' : 'Closed short')
  : o.status === 'ON_LATHE' ? 'In progress' : (o.qty_made ?? 0) > 0 ? 'Partly made' : 'Queued';
const card = 'bg-slate-900 rounded-xl p-5 border border-slate-800';
const dur = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
const hms = (s: number) => `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];   // financial year runs April to March
const FTag = ({ f }: { f: string }) => <span className={`${FCHIP[f] ?? 'bg-slate-600'} text-white rounded px-2 py-0.5 text-sm font-bold`}>{f}</span>;

function download(head: string[], rows: unknown[][], name: string) {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '\uFEFF' + [head, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = name; a.click();
}
async function pageAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: unknown }>): Promise<T[]> {   // Supabase returns max 1000 rows per request
  let all: T[] = [];
  for (let i = 0; ; i += 1000) { const { data } = await fetchPage(i, i + 999); const d = (data ?? []) as T[]; if (!d.length) break; all = all.concat(d); if (d.length < 1000) break; }
  return all;
}

function Dashboard() {
  const { orders, deliveries } = useOrders();
  const [allD, setAllD] = useState<DeliveryFull[]>([]);   // every batch ever made, so totals are exact
  const [fy, setFy] = useState(() => { const t = new Date(); return t.getMonth() >= 3 ? t.getFullYear() : t.getFullYear() - 1; });   // FY 2026 = 1 Apr 2026 to 31 Mar 2027
  const [mi, setMi] = useState<number | 'year'>(() => (new Date().getMonth() + 9) % 12);   // 0 = April ... 11 = March
  const [focus, setFocus] = useState<string | null>(null); const [rsq, setRsq] = useState(''); const [jobTab, setJobTab] = useState<'today' | 'overall'>('today');
  const [fsel, setFsel] = useState<string | null>(null);
  const [month, setMonth] = useState(() => ym(new Date().toISOString()));
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');

  useEffect(() => { (async () => setAllD(await pageAll<DeliveryFull>((a, b) => supabase.from('deliveries').select(DSEL).order('made_at').range(a, b))))(); }, [deliveries]);

  const inRange = (x: string) => (!from || dayStr(x) >= from) && (!to || dayStr(x) <= to);

  async function exportMade(f: string | null) {   // "Toolings completed": one row per batch the CNC operator confirmed
    let q = supabase.from('deliveries').select(DSEL); if (f) q = q.eq('factory_id', f);
    const all = await pageAll<DeliveryFull>((a, b) => q.order('made_at').range(a, b));
    const lg = await pageAll<LatheLog>((a, b) => { let ql = supabase.from('lathe_activity_logs').select('*').eq('action', 'COMPLETED'); if (f) ql = ql.eq('factory_id', f); return ql.order('ended_at').range(a, b); });
    const runtimeOf = (d: DeliveryFull) => {   // the COMPLETED cycle of the same order that ended closest to this batch (within a minute)
      const t = +new Date(d.made_at);
      const best = lg.filter(l => l.order_id === d.order_id).map(l => ({ l, gap: Math.abs(+new Date(l.ended_at) - t) })).filter(x => x.gap < 60000).sort((a, b) => a.gap - b.gap)[0];
      return best ? hms(best.l.duration_seconds) : ''; };
    const rows = all.filter(d => d.ord && inRange(d.made_at)).map(d => { const o = d.ord!;
      return [d.factory_id, rollerLabel(o.factory_id, o.roller?.roller_size ?? ''), o.roller?.roller_size, o.roller?.customer_drg, o.roller?.party_name, mcode(o.machine_id), kind(o), o.tooling?.batta_code, o.slip_no,
        o.quantity, d.qty_made, fd(d.made_at), runtimeOf(d), d.qty_received, fd(d.received_at), d.status === 'RECEIVED' ? 'Received' : 'At CNC, not received yet', d.note, o.notes]; });
    download(['Factory', 'Factory - Roller Size', 'Roller Size', 'Drawing No', 'Party', 'Header Machine', 'Tool', 'Batta No', 'Slip No', 'Qty Ordered', 'Qty Made (this batch)', 'Made At', 'Lathe Runtime (h:mm:ss)', 'Qty Received', 'Received At', 'Receipt Status', 'CNC Note', 'Toolroom Note'],
      rows, `toolings-completed-${f ?? 'ALL'}-${new Date().toISOString().slice(0, 10)}.csv`);
  }
  async function exportOrders(f: string | null) {   // every order, including pending ones, with all its batches
    let qo = supabase.from('tool_orders').select(SEL); if (f) qo = qo.eq('factory_id', f);
    let qd = supabase.from('deliveries').select('*'); if (f) qd = qd.eq('factory_id', f);
    const [all, dl] = await Promise.all([pageAll<OrderFull>((a, b) => qo.order('created_at').range(a, b)), pageAll<Delivery>((a, b) => qd.order('made_at').range(a, b))]);
    const by: Record<string, Delivery[]> = {}; dl.forEach(d => (by[d.order_id] ??= []).push(d));
    const rows = all.filter(o => inRange(o.created_at)).map(o => { const b = by[o.id] ?? [];
      return [o.factory_id, rollerLabel(o.factory_id, o.roller?.roller_size ?? ''), o.slip_no, fd(o.created_at), mcode(o.machine_id), o.roller?.customer_drg, o.roller?.party_name, kind(o), o.tooling?.batta_code,
        o.tooling?.od_dim, o.tooling?.length_dim, o.tooling?.od2_dim, o.tooling?.step_depth_dim, o.custom_dimensions, URGENCY_LABEL[o.priority] ?? o.priority, o.roller_qty, o.quantity, o.qty_made ?? 0, o.quantity - (o.qty_made ?? 0),
        o.qty_received ?? 0, (o.qty_made ?? 0) - (o.qty_received ?? 0), stText(o), fd(o.closed_at), b.length,
        b.map(d => `${d.qty_made} made ${fd(d.made_at)} -> ${d.status === 'RECEIVED' ? `${d.qty_received} received ${fd(d.received_at)}` : 'not received yet'}${d.note ? ` [CNC note: ${d.note}]` : ''}`).join(' | '), o.notes]; });
    download(['Factory', 'Factory - Roller Size', 'Slip No', 'Ordered At', 'Header Machine', 'Drawing No', 'Party', 'Tool', 'Batta No', 'OD', 'Length', 'OD 2', 'Step', 'Custom Tool Dims', 'Urgency', 'Rollers To Forge',
      'Qty Ordered', 'Qty Made', 'Short (ordered-made)', 'Qty Received', 'Missing in transit (made-received)', 'Status', 'Closed At', 'Number of Batches', 'Batches', 'Toolroom Note'], rows, `tool-orders-${f ?? 'ALL'}-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  const todayStr = new Date().toDateString();
  const rs = mi === 'year' ? new Date(fy, 3, 1) : new Date(fy, 3 + mi, 1);   // selected range [rs, re)
  const re = mi === 'year' ? new Date(fy + 1, 3, 1) : new Date(fy, 4 + mi, 1);
  const period = mi === 'year' ? `FY ${fy}-${String(fy + 1).slice(2)}` : `${MONTHS[mi]} ${rs.getFullYear()}`;
  const [logs, setLogs] = useState<LatheLog[]>([]);
  useEffect(() => { (async () => {   // lathe cycles in the chosen period and factory
    let q = supabase.from('lathe_activity_logs').select('*').gte('ended_at', rs.toISOString()).lt('ended_at', re.toISOString());
    if (fsel) q = q.eq('factory_id', fsel);
    setLogs(await pageAll<LatheLog>((a, b) => q.order('ended_at', { ascending: false }).range(a, b)));
  })(); }, [rs.getTime(), re.getTime(), fsel, orders]);
  const secsOf = (f: string) => logs.filter(l => l.factory_id === f).reduce((a, l) => a + l.duration_seconds, 0);
  const totalSecs = logs.reduce((a, l) => a + l.duration_seconds, 0);
  const dper = allD.filter(d => +new Date(d.made_at) >= +rs && +new Date(d.made_at) < +re);
    const [mp, setMp] = useState<MonthlyProduction[]>([]); const [csq, setCsq] = useState('');
  useEffect(() => { (async () => {   // rollers-forged figures typed in for the chosen months
    const ym = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
    let q = supabase.from('monthly_production').select('*').gte('month', ym(rs)).lt('month', ym(re));
    if (fsel) q = q.eq('factory_id', fsel);
    setMp(await pageAll<MonthlyProduction>((a, b) => q.order('month').range(a, b)));
  })(); }, [rs.getTime(), re.getTime(), fsel]);
  const consCalc = (() => {
    const rows: Record<string, { f: string; rid: string; size: string; kind: string; made: number }> = {};
    dper.filter(d => d.ord && d.ord.roller_id && (!fsel || d.factory_id === fsel)).forEach(d => {
      const o = d.ord!, size = o.roller?.roller_size ?? '—', kind = o.tooling ? TOOL_LABEL[o.tooling.tool_type] : o.custom_tool_name || 'Other tool';
      const r = (rows[`${d.factory_id}|${o.roller_id}|${kind}`] ??= { f: d.factory_id, rid: o.roller_id!, size, kind, made: 0 });
      r.made += d.qty_made;
    });
    const forged: Record<string, number> = {};
    mp.forEach(m => { const k = `${m.factory_id}|${m.roller_id}`; forged[k] = (forged[k] ?? 0) + m.rollers_forged; });
    const s = csq.trim().toLowerCase();
    return Object.values(rows).filter(r => !s || r.size.toLowerCase().includes(s)).map(r => ({ ...r, rollers: forged[`${r.f}|${r.rid}`] ?? 0 }))
      .sort((a, b) => a.f.localeCompare(b.f) || a.size.localeCompare(b.size, undefined, { numeric: true }) || a.kind.localeCompare(b.kind));
  })();
  const consMissing = consCalc.filter(r => !r.rollers).length;
  const open = (o: OrderFull) => o.status === 'QUEUED' || o.status === 'ON_LATHE';
  const rowFor = (f: string | null) => { const fo = orders.filter(o => !f || o.factory_id === f); const fa = allD.filter(d => !f || d.factory_id === f); const dp = dper.filter(d => !f || d.factory_id === f);
    return { today: fo.filter(o => new Date(o.created_at).toDateString() === todayStr).length, toMake: fo.filter(open).reduce((a, o) => a + rem(o), 0), lathe: fo.filter(o => o.status === 'ON_LATHE').length,
      atCnc: fa.filter(d => d.status === 'READY').reduce((a, d) => a + d.qty_made, 0), made: dp.reduce((a, d) => a + d.qty_made, 0), recd: dp.reduce((a, d) => a + (d.qty_received ?? 0), 0) }; };
  const total = rowFor(null);
  // Overall performance = pieces made today + pieces still waiting (all pending orders, older ones included); balance closed short is not counted
  const todayK = dayStr(new Date().toISOString());
  // Today's job = only orders placed today: pieces made so far / pieces ordered (balance closed short is not counted)
  const todayFor = (f: string | null) => {
    const mine = orders.filter(o => dayStr(o.created_at) === todayK && (!f || o.factory_id === f));
    const eff = (o: OrderFull) => (o.status === 'CLOSED' ? (o.qty_made ?? 0) : o.quantity);
    const ord = mine.reduce((a, o) => a + eff(o), 0);
    const made = mine.reduce((a, o) => a + Math.min(o.qty_made ?? 0, eff(o)), 0);
    return { orders: mine.length, ord, made, left: ord - made, pct: ord ? Math.round((made / ord) * 100) : null, rush: mine.filter(o => open(o) && o.priority !== 'BUFFER_NEXT_SHIFT').length };
  };
  const jobFor = (f: string | null) => {
    const made = allD.filter(d => (!f || d.factory_id === f) && dayStr(d.made_at) === todayK).reduce((a, d) => a + d.qty_made, 0);
    const mine = orders.filter(o => open(o) && (!f || o.factory_id === f));
    const left = mine.reduce((a, o) => a + rem(o), 0);
    return { made, left, job: made + left, pct: made + left ? Math.round((made / (made + left)) * 100) : null, rush: mine.filter(o => o.priority !== 'BUFFER_NEXT_SHIFT').length, orders: mine.length };
  };
  const lathe = orders.filter(o => o.status === 'ON_LATHE' && (!fsel || o.factory_id === fsel));

  const grp: Record<string, { f: string; size: string; drg: string | null; tools: Record<string, number>; made: number; recd: number }> = {};
  dper.filter(d => d.ord && (!fsel || d.factory_id === fsel)).forEach(d => { const o = d.ord!; const key = `${o.factory_id}|${o.roller?.roller_size ?? '—'}`;
    const g = (grp[key] ??= { f: o.factory_id, size: o.roller?.roller_size ?? '—', drg: o.roller?.customer_drg ?? null, tools: {}, made: 0, recd: 0 });
    g.tools[kind(o)] = (g.tools[kind(o)] ?? 0) + d.qty_made; g.made += d.qty_made; g.recd += d.qty_received ?? 0; });
  const grpList = Object.values(grp).filter(g => rollerLabel(g.f, g.size).toLowerCase().includes(rsq.trim().toLowerCase())).sort((a, b) => b.made - a.made);
  const rep: Record<string, OrderFull[]> = {};
  orders.filter(o => ym(o.created_at) === month && (!fsel || o.factory_id === fsel)).forEach(o => (rep[`${o.factory_id}|${o.roller?.roller_size ?? '—'}`] ??= []).push(o));
  const chip = (on: boolean) => `px-5 min-h-12 rounded-xl border-2 text-lg font-bold ${on ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`;   // same look as the CNC page chips

  return (<div className="p-6 max-w-7xl mx-auto space-y-8">
    <section>
      <div className="grid grid-cols-2 gap-2 mb-3">{([['today', "Today's job"], ['overall', 'Overall performance']] as const).map(([t, l]) =>
        <button key={t} onClick={() => setJobTab(t)} className={`h-16 rounded-xl border-2 text-lg font-bold ${jobTab === t ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{l}</button>)}</div>
      <h2 className="text-xl font-bold mb-3">{jobTab === 'today' ? `Today's job · ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short' })}` : 'Overall performance · all pending orders'}</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[null, ...FACTORIES].map(f => { const t = todayFor(f); const o = jobFor(f);
        const v = jobTab === 'today'
          ? { made: t.made, job: t.ord, left: t.left, pct: t.pct, rush: t.rush, note: t.orders ? `${t.orders} order${t.orders > 1 ? 's' : ''} placed today` : 'No orders placed today' }
          : { made: o.made, job: o.job, left: o.left, pct: o.pct, rush: o.rush, note: o.job ? `${o.orders} pending order${o.orders === 1 ? '' : 's'}` : 'No pending job' };
        return <div key={f ?? 'all'} className={`${card} ${f ? '' : 'ring-2 ring-amber-500'}`}>
          <div className="flex items-center justify-between">{f ? <FTag f={f}/> : <span className="font-bold">All factories</span>}<b className="text-2xl">{v.pct == null ? '—' : `${v.pct}%`}</b></div>
          <div className="mt-2 text-3xl font-extrabold">{v.made} <span className="text-slate-400 text-base font-semibold">of {v.job} pcs</span></div>
          <div className="mt-2 h-3 rounded-full bg-slate-800 overflow-hidden"><div className={`${f ? (FCHIP[f] ?? 'bg-slate-500') : 'bg-green-500'} h-3 rounded-full`} style={{ width: `${v.pct ?? 0}%` }}/></div>
          <div className="mt-2 text-sm text-slate-400">{v.job ? `${v.left} pcs still to make · ` : ''}{v.note}{v.rush ? <span className="text-red-400 font-semibold"> · 🔴 {v.rush} rush waiting</span> : ''}</div></div>; })}</div>
      <p className="text-xs text-slate-500 mt-2">{jobTab === 'today'
        ? 'Only orders placed today: pieces made so far ÷ pieces ordered. Older pending orders are under Overall performance. Pieces the toolroom closed short are not counted.'
        : 'All pending work: pieces made today ÷ (made today + still waiting), older pending orders included. Pieces the toolroom closed short are not counted.'}</p></section>

    <section><h2 className="text-xl font-bold mb-3">Toolings completed · {period}</h2>
      <div className="space-y-2 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <button aria-label="Previous year" onClick={() => setFy(fy - 1)} className={chip(false)}>‹</button>
          <span className="text-lg font-bold px-2">FY {fy}-{String(fy + 1).slice(2)} <span className="text-slate-400 font-normal text-sm">(1 Apr {fy} – 31 Mar {fy + 1})</span></span>
          <button aria-label="Next year" onClick={() => setFy(fy + 1)} className={chip(false)}>›</button>
          <label className="ml-auto text-slate-400 flex items-center gap-2">Jump to date <input type="date" onChange={e => { const v = e.target.value; if (!v) return; const d = new Date(v + 'T00:00:00'); setFy(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1); setMi((d.getMonth() + 9) % 12); setFocus(v); }} className="bg-slate-800 rounded-lg p-2 text-slate-100"/></label></div>
        <div className="flex gap-2 flex-wrap">{(['year', ...MONTHS.map((_, i) => i)] as (number | 'year')[]).map(m =>
          <button key={String(m)} onClick={() => { setMi(m); setFocus(null); }} className={chip(mi === m)}>{m === 'year' ? 'Full year' : MONTHS[m]}</button>)}</div></div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className={`${card} border-amber-500`}><div className="text-slate-400">Total Toolings Completed (all units)</div><div className="text-6xl font-extrabold mt-1">{total.made}</div><div className="text-sm text-slate-400 mt-1">received at plants: {total.recd}</div></div>
        {FACTORIES.map(f => { const r = rowFor(f); return <div key={f} className={card}><div className="text-slate-400 flex items-center gap-2">Toolings Completed · <FTag f={f}/></div><div className="text-6xl font-extrabold mt-1">{r.made}</div><div className="text-sm text-slate-400 mt-1">received at plant: {r.recd}</div></div>; })}</div>
      <p className="text-xs text-slate-500 mt-2">“Completed” means pieces the CNC operator confirmed as made. Each batch is counted on the day it was confirmed.</p></section>

    <section className={card}><h2 className="text-xl font-bold mb-3">Factories at a glance</h2>
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-slate-400"><th className="py-1">Factory</th><th>Orders today</th><th>Pcs still to make</th><th>In progress</th><th>Pcs at CNC, not received</th><th>Made ({period})</th><th>Received ({period})</th></tr></thead>
        <tbody>{[...FACTORIES.map(f => [f, rowFor(f)] as const), ['Total', total] as const].map(([f, r]) => <tr key={f} className={`border-t border-slate-800 ${f === 'Total' ? 'font-bold' : ''}`}>
          <td className="py-2">{f === 'Total' ? 'Total' : <FTag f={f}/>}</td><td>{r.today}</td><td>{r.toMake}</td><td>{r.lathe}</td><td>{r.atCnc}</td><td>{r.made}</td><td>{r.recd}</td></tr>)}</tbody></table></div></section>

    <div className="flex gap-2 flex-wrap items-center"><span className="text-slate-400">Show:</span>{[null, ...FACTORIES].map(f => <button key={f ?? 'all'} onClick={() => setFsel(f)} className={chip(fsel === f)}>{f ?? 'All factories'}</button>)}</div>

    <section className={card}><h2 className="text-xl font-bold mb-3">Toolings made day by day · {period}</h2>
      <DailyProduction data={allD} from={rs} to={re} mode={mi === 'year' ? 'year' : 'month'} fsel={fsel} focus={focus}/></section>

    <section className={card}><h2 className="text-xl font-bold mb-3">In progress on the CNC lathe</h2>
      {!lathe.length && <p className="text-slate-500">Lathe is idle.</p>}
      <div className="grid md:grid-cols-2 gap-3">{lathe.map(o => <div key={o.id} className="bg-slate-800 rounded-lg p-3">
        <div className="text-lg font-bold">{rollerLabel(o.factory_id, o.roller?.roller_size ?? '—')} <span className="text-slate-400 font-normal">Header {mcode(o.machine_id)} · Drg {o.roller?.customer_drg ?? '—'}</span></div>
        <div className="text-amber-300 text-lg">{tname(o)} · {rem(o)} to make <span className="text-slate-400">(ordered {o.quantity})</span></div>
        <div className="text-sm text-slate-400">Requested {dt(o.created_at)}{o.started_lathe_at ? ` · started ${dt(o.started_lathe_at)}` : ''}</div></div>)}</div></section>

    <section className={card}><h2 className="text-xl font-bold mb-3">Lathe runtime · {period}</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <div className="bg-slate-800 rounded-lg p-4"><div className="text-slate-400">Total runtime</div><div className="text-4xl font-extrabold">{dur(totalSecs)}</div><div className="text-sm text-slate-400">{logs.length} cycles</div></div>
        {FACTORIES.map(f => { const sec = secsOf(f); const pct = totalSecs ? Math.round((sec / totalSecs) * 100) : 0;
          return <div key={f} className="bg-slate-800 rounded-lg p-4"><FTag f={f}/><div className="text-3xl font-bold mt-1">{dur(sec)}</div>
            <div className="mt-1 h-2 rounded bg-slate-700"><div className={`${FCHIP[f] ?? 'bg-slate-500'} h-2 rounded`} style={{ width: `${pct}%` }}/></div>
            <div className="text-sm text-slate-400 mt-1">{pct}% of lathe time</div></div>; })}</div>
      {!logs.length && <p className="text-slate-500">No lathe cycles in this period.</p>}
      {logs.length > 0 && <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-slate-400"><th className="py-1">Time</th><th>Factory</th><th>Roller size</th><th>Tool</th><th>Duration</th><th>Action</th></tr></thead>
        <tbody>{logs.slice(0, 20).map(l => <tr key={l.id} className="border-t border-slate-800"><td className="py-1">{fd(l.ended_at)}</td><td><FTag f={l.factory_id}/></td><td>{l.roller_size ?? '—'}</td>
          <td>{l.tool_type && l.tool_type in TOOL_LABEL ? TOOL_LABEL[l.tool_type as keyof typeof TOOL_LABEL] : l.tool_type ?? '—'}</td><td>{dur(l.duration_seconds)}</td>
          <td className={l.action === 'COMPLETED' ? 'text-green-400' : 'text-amber-400'}>{l.action === 'COMPLETED' ? 'Completed' : 'Stopped'}{l.qty_made != null ? ` · ${l.qty_made} pcs` : ''}</td></tr>)}</tbody></table></div>}
      <p className="text-xs text-slate-500 mt-2">Runtime runs from Start to Completed or Stop. The table shows the latest 20 cycles. When a factory is chosen above, only that factory's cycles are counted.</p></section>

    <section className={card}><h2 className="text-xl font-bold mb-3">Toolings made by roller size · {period}</h2>
      <label className="block mb-3"><span className="block text-sm font-semibold text-slate-300 mb-1">Search roller size</span>
        <input className="h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full" placeholder="e.g. 31309 or PEW" value={rsq} onChange={e => setRsq(e.target.value)}/></label>
      {!grpList.length && <p className="text-slate-500">{Object.keys(grp).length ? 'No roller size matches your search.' : 'Nothing made in this period.'}</p>}
      <table className="w-full"><tbody>{grpList.map(g => <tr key={`${g.f}|${g.size}`} className="border-t border-slate-800">
        <td className="py-2 font-bold">{rollerLabel(g.f, g.size)}</td><td className="text-slate-400">{g.drg ?? ''}</td>
        <td>{Object.entries(g.tools).map(([k, n]) => `${n} ${k}`).join(' · ')}</td><td className="text-right font-bold">{g.made}</td><td className="text-right text-sky-400">{g.recd}</td></tr>)}</tbody></table>
      <p className="text-xs text-slate-500 mt-2">Columns: factory - roller size, drawing, tools made, total made, total received at plant.</p></section>
            <section className={card}><h2 className="text-xl font-bold mb-1">Tooling consumption · {period}</h2>
      <p className="text-slate-400 text-sm mb-3">Tools made (confirmed by CNC) against rollers forged, from your month-end entries.</p>
      <label className="block mb-3"><span className="block text-sm font-semibold text-slate-300 mb-1">Search roller size</span>
        <input className="h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full" value={csq} onChange={e => setCsq(e.target.value)}/></label>
      <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full min-w-[700px] text-left">
        <thead className="bg-slate-800 text-slate-300 text-sm"><tr>{['Roller size', 'Tool', 'Tools made', 'Rollers forged', 'Tools per 10,000 rollers', 'Rollers per tool'].map(h => <th key={h} className="px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>{consCalc.map(r => <tr key={`${r.f}|${r.rid}|${r.kind}`} className="border-t border-slate-800">
          <td className="px-3 py-2 font-bold whitespace-nowrap">{rollerLabel(r.f, r.size)}</td><td className="px-3 py-2">{r.kind}</td>
          <td className="px-3 py-2">{r.made.toLocaleString('en-IN')}</td>
          <td className="px-3 py-2">{r.rollers ? r.rollers.toLocaleString('en-IN') : '—'}</td>
          <td className="px-3 py-2 font-extrabold text-amber-300">{r.rollers ? (r.made / r.rollers * 10000).toFixed(1) : '—'}</td>
          <td className="px-3 py-2 font-bold">{r.rollers && r.made ? Math.round(r.rollers / r.made).toLocaleString('en-IN') : '—'}</td></tr>)}
          {!consCalc.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">No tools made in this period.</td></tr>}</tbody></table></div>
      <p className="text-xs text-slate-500 mt-2">{consMissing ? `${consMissing} line${consMissing === 1 ? '' : 's'} show “—” because no rollers-forged figure is entered for that size in this period (use the month-end entry just below). ` : ''}Tools are made some days before they are used, so read a quarter or the whole year rather than a single month.</p></section>
          <Planner dels={allD} />
              <ShiftReports rs={rs} re={re} fsel={fsel} period={period} />
              <StockFreshness />
        <MonthlyEntry />

    <section className={card}><h2 className="text-xl font-bold mb-3">Export (CSV, opens in Excel)</h2>
      <div className="flex gap-3 items-center flex-wrap mb-4"><label className="text-slate-400">From <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="bg-slate-800 rounded-lg p-2 text-slate-100"/></label>
        <label className="text-slate-400">To <input type="date" value={to} onChange={e => setTo(e.target.value)} className="bg-slate-800 rounded-lg p-2 text-slate-100"/></label>
        <span className="text-slate-500 text-sm">Leave dates empty for everything.</span></div>
      <div className="font-semibold mb-2">Toolings completed (one row per batch the CNC confirmed)</div>
      <div className="flex gap-2 flex-wrap mb-4"><button onClick={() => exportMade(null)} className="px-5 rounded-lg bg-amber-500 text-slate-950 font-bold">⬇ All Toolings Completed</button>
        {FACTORIES.map(f => <button key={f} onClick={() => exportMade(f)} className="px-5 rounded-lg bg-slate-800">⬇ Download {f}</button>)}</div>
      <div className="font-semibold mb-2">All orders, including pending (with every batch)</div>
      <div className="flex gap-2 flex-wrap"><button onClick={() => exportOrders(null)} className="px-5 rounded-lg bg-amber-500 text-slate-950 font-bold">⬇ All Orders</button>
        {FACTORIES.map(f => <button key={f} onClick={() => exportOrders(f)} className="px-5 rounded-lg bg-slate-800">⬇ Download {f}</button>)}</div></section>

    <section><div className="flex items-center gap-4 mb-3 flex-wrap"><h2 className="text-xl font-bold">Monthly orders by roller size</h2>
      <input type="month" value={month} onChange={e => setMonth(e.target.value)} className="bg-slate-800 rounded-lg p-2"/></div>
      {!Object.keys(rep).length && <p className="text-slate-500">No orders this month.</p>}
      <div className="grid xl:grid-cols-2 gap-4">{Object.entries(rep).sort().map(([key, list]) => <div key={key} className={card}>
        <div className="text-lg font-bold">{rollerLabel(list[0].factory_id, list[0].roller?.roller_size ?? '—')} <span className="text-slate-400 font-normal">Drg {list[0].roller?.customer_drg ?? '—'} · ordered {list.reduce((a, o) => a + o.quantity, 0)} · made {list.reduce((a, o) => a + (o.qty_made ?? 0), 0)} · received {list.reduce((a, o) => a + (o.qty_received ?? 0), 0)}</span></div>
        <table className="w-full mt-2 text-sm"><tbody>{[...list].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)).map(o => <tr key={o.id} className="border-t border-slate-800">
          <td className="py-1">{dt(o.created_at)}</td><td>{mcode(o.machine_id)}</td><td>{tname(o)}</td><td className="text-right">{o.quantity}</td>
          <td className="text-right text-green-400">{o.qty_made ?? '—'}</td><td className="text-right text-sky-400">{o.qty_received ?? '—'}</td><td className="text-right text-slate-400">{stText(o)}</td></tr>)}</tbody></table></div>)}</div>
      <p className="text-xs text-slate-500 mt-2">Columns: requested, header, tool, ordered, made, received, status.</p></section>
  </div>);
}

const URGENCY_LABEL: Record<string, string> = { URGENT_MACHINE_DOWN: 'Breakdown / Line Down', URGENT: 'Urgent', BUFFER_NEXT_SHIFT: 'Normal' };
export default function Page() { return <Guard allow={['owner']}><Dashboard/></Guard>; }
function MonthlyEntry() {
  const now = new Date(Date.now() + 330 * 60000);
  const months = Array.from({ length: 18 }, (_, i) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); return { v: d.toISOString().slice(0, 10), t: d.toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }; });
  const [fac, setFac] = useState<string>(FACTORIES[0]); const [mon, setMon] = useState(months[1].v);   // starts on last month, the one you usually enter
  const [rs, setRs] = useState<RollerMaster[]>([]); const [vals, setVals] = useState<Record<string, string>>({});
  const [q, setQ] = useState(''); const [msg, setMsg] = useState('');
  useEffect(() => { (async () => {
    const [r, m] = await Promise.all([
      supabase.from('roller_master').select('*').eq('factory_id', fac),
      supabase.from('monthly_production').select('*').eq('factory_id', fac).eq('month', mon)]);
    setRs(((r.data ?? []) as unknown as RollerMaster[]).sort((a, b) => a.roller_size.localeCompare(b.roller_size, undefined, { numeric: true })));
    const v: Record<string, string> = {}; ((m.data ?? []) as unknown as MonthlyProduction[]).forEach(x => { v[x.roller_id] = String(x.rollers_forged); });
    setVals(v); setMsg('');
  })(); }, [fac, mon]);
  const save = async () => {
    const rows = Object.entries(vals).filter(([, n]) => n.trim() !== '').map(([roller_id, n]) => ({ factory_id: fac, roller_id, month: mon, rollers_forged: Math.max(0, Math.round(+n.replace(/,/g, '') || 0)), updated_at: new Date().toISOString() }));
    if (!rows.length) { setMsg('Nothing to save.'); return; }
    const { error } = await supabase.from('monthly_production').upsert(rows, { onConflict: 'factory_id,roller_id,month' });
    setMsg(error ? `Could not save: ${error.message}` : `Saved ${rows.length} size${rows.length === 1 ? '' : 's'}.`);
  };
  const s = q.trim().toLowerCase(); const shown = rs.filter(r => !s || r.roller_size.toLowerCase().includes(s));
  const total = Object.values(vals).reduce((a, n) => a + (Math.round(+n.replace(/,/g, '')) || 0), 0);
  const lbl = 'block text-sm font-semibold text-slate-300 mb-1', fld = 'h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full';
  return (<section className={card}><h2 className="text-xl font-bold mb-1">Rollers forged · month-end entry</h2>
    <p className="text-slate-400 text-sm mb-3">Copy the month total for each roller size from the daily production sheet. Leave blank if that size did not run. To remove a saved figure, type 0.</p>
    <div className="grid sm:grid-cols-3 gap-3 mb-3">
      <label className="block"><span className={lbl}>Factory</span><select className={fld} value={fac} onChange={e => setFac(e.target.value)}>{FACTORIES.map(f => <option key={f}>{f}</option>)}</select></label>
      <label className="block"><span className={lbl}>Month</span><select className={fld} value={mon} onChange={e => setMon(e.target.value)}>{months.map(m => <option key={m.v} value={m.v}>{m.t}</option>)}</select></label>
      <label className="block"><span className={lbl}>Search roller size</span><input className={fld} value={q} onChange={e => setQ(e.target.value)}/></label></div>
    <div className="rounded-xl border border-slate-800 divide-y divide-slate-800 max-h-[60vh] overflow-y-auto">
      {shown.map(r => <label key={r.id} className="flex items-center gap-3 px-3 py-2">
        <span className="font-bold text-lg w-40 shrink-0">{rollerLabel(fac, r.roller_size)}</span>
        <input inputMode="numeric" className={fld + ' text-right'} placeholder="0" value={vals[r.id] ?? ''} onChange={e => setVals({ ...vals, [r.id]: e.target.value })}/></label>)}
      {!shown.length && <div className="p-4 text-slate-500">No roller sizes found.</div>}</div>
    <div className="flex items-center gap-4 mt-3 flex-wrap"><button onClick={save} className="min-h-14 px-8 rounded-xl bg-green-600 text-white text-xl font-bold">Save month</button>
      <span className="text-slate-400">Total rollers: <b className="text-slate-100">{total.toLocaleString('en-IN')}</b></span><span className="text-amber-300">{msg}</span></div>
  </section>);
}

function Planner({ dels }: { dels: DeliveryFull[] }) {
  const [mp, setMp] = useState<MonthlyProduction[]>([]); const [rolls, setRolls] = useState<RollerMaster[]>([]);
  const [fac, setFac] = useState<string>(FACTORIES[0]); const [rid, setRid] = useState(''); const [plan, setPlan] = useState('');
  useEffect(() => { (async () => setMp(await pageAll<MonthlyProduction>((a, b) => supabase.from('monthly_production').select('*').order('month').range(a, b))))(); }, []);
  useEffect(() => { (async () => {
    const { data } = await supabase.from('roller_master').select('*').eq('factory_id', fac);
    setRolls(((data ?? []) as unknown as RollerMaster[]).sort((a, b) => a.roller_size.localeCompare(b.roller_size, undefined, { numeric: true }))); setRid('');
  })(); }, [fac]);
  const planned = Math.round(+plan.replace(/,/g, '') || 0);
  const res = (() => {
    if (!rid) return null;
        const last = mp.filter(m => m.factory_id === fac && m.roller_id === rid && m.rollers_forged > 0).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 3);   // latest 3 months with an entry
    const mons = new Set(last.map(m => m.month.slice(0, 7))); const forged = last.reduce((a, m) => a + m.rollers_forged, 0);
    if (!forged) return { forged: 0, months: 0, rows: [] as { kind: string; made: number; per: number; need: number }[] };
    const made: Record<string, number> = {};
    dels.filter(d => d.factory_id === fac && d.ord?.roller_id === rid && mons.has(new Date(+new Date(d.made_at) + 330 * 60000).toISOString().slice(0, 7))).forEach(d => {
      const o = d.ord!, kind = o.tooling ? TOOL_LABEL[o.tooling.tool_type] : o.custom_tool_name || 'Other tool'; made[kind] = (made[kind] ?? 0) + d.qty_made; });
    return { forged, months: mons.size, rows: Object.entries(made).filter(([, n]) => n > 0).sort((a, b) => a[0].localeCompare(b[0])).map(([kind, n]) => ({ kind, made: n, per: forged / n, need: Math.ceil(planned * n / forged) })) };
  })();
  const lbl = 'block text-sm font-semibold text-slate-300 mb-1', fld = 'h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full';
  return (<section className={card}><h2 className="text-xl font-bold mb-1">Plan tooling for a roller size</h2>
    <p className="text-slate-400 text-sm mb-3">Uses your past records, only the months where you entered rollers forged for that size.</p>
    <div className="grid sm:grid-cols-3 gap-3 mb-4">
      <label className="block"><span className={lbl}>Factory</span><select className={fld} value={fac} onChange={e => setFac(e.target.value)}>{FACTORIES.map(f => <option key={f}>{f}</option>)}</select></label>
      <label className="block"><span className={lbl}>Roller size</span><select className={fld} value={rid} onChange={e => setRid(e.target.value)}><option value="">Choose roller size</option>{rolls.map(r => <option key={r.id} value={r.id}>{r.roller_size}</option>)}</select></label>
      <label className="block"><span className={lbl}>Rollers planned</span><input inputMode="numeric" className={fld} placeholder="e.g. 1,00,000" value={plan} onChange={e => setPlan(e.target.value)}/></label></div>
    {res && (res.rows.length ? <div className="space-y-2">{res.rows.map(r => <div key={r.kind} className="flex items-center justify-between gap-4 rounded-xl bg-slate-800 px-4 py-3 flex-wrap">
        <span className="font-bold text-lg">{r.kind}</span>
        <span className="text-slate-400 text-sm">1 tool per {Math.round(r.per).toLocaleString('en-IN')} rollers</span>
        <span className="text-2xl font-extrabold text-amber-300">{planned ? `${r.need.toLocaleString('en-IN')} tools` : '—'}</span></div>)}
      <p className="text-xs text-slate-500 pt-1">Based on latest {res.months} month{res.months === 1 ? '' : 's'} of records ({res.forged.toLocaleString('en-IN')} rollers forged). {res.months < 3 ? 'Only a few months of history, so treat this as a rough guide. ' : ''}This is total tools consumed; it is not reduced by tools already in stock at the plant.</p></div>
      : <div className="text-slate-500">No history yet for this size. Enter rollers forged at month-end, and make sure tools were made in those months.</div>)}
  </section>);
}
