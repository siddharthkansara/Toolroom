'use client';
import { useCallback, useEffect, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import { supabase, rpc } from '@/lib/supabase';
import { Guard } from '@/lib/auth';
import { useOrders, chime, dt, SEL, gkey, uuid } from '@/lib/useOrders';
import { TOOL_LABEL, type HeaderMachine, type ProductionRun, type RollerMaster, type ToolingMaster, type ToolType, type Priority, type OrderFull } from '@/types/database';

type Rec = { code: string; od: string; len: string; od2: string; step: string };
type Other = { name: string; dims: string; qty: number };
const STD: ToolType[] = ['DIE_TOP', 'BOTTOM', 'FACING_PUNCH', 'SHORT_PIN'];
// Detail boxes per tool: each inner array is one line
const LAYOUT: Record<string, [keyof Rec, string][][]> = {
  DIE_TOP: [[['code', 'Batta no.']]],
  BOTTOM: [[['od', 'OD'], ['len', 'L (length)']], [['od2', 'OD (2nd)']], [['step', 'Step']]],
  FACING_PUNCH: [[['od', 'OD'], ['len', 'L (length)']]], SHORT_PIN: [] };
const ST: Record<string, string> = { QUEUED: 'Queued', ON_LATHE: 'On lathe', IN_TRANSIT: 'Ready to dispatch', RECEIVED: 'Received', HEAT_TREAT: 'Heat treat', READY: 'Ready', CLOSED: 'Closed' };
const ACTIVE = ['QUEUED', 'ON_LATHE'];
const COLS = [['QUEUED', 'Queued', 'border-slate-500'], ['ON_LATHE', 'On lathe (10 km)', 'border-blue-500'],
  ['READY', 'Ready to Dispatch', 'border-amber-500'], ['RECEIVED', 'Received (last 7 days)', 'border-green-500']] as const;
const num = (s?: string) => (s ? parseFloat(s) : null);
const big = 'rounded-2xl border-2 text-2xl font-bold p-4 transition-colors';
const on = 'border-amber-400 bg-amber-400/20', off = 'border-slate-700 bg-slate-900';
const inp = 'h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full';
const Lbl = ({ t, children }: { t: string; children: React.ReactNode }) => (<label className="block"><span className="block text-sm font-semibold text-slate-300 mb-1">{t}</span>{children}</label>);
const tname = (o: OrderFull) => (o.tooling ? `${TOOL_LABEL[o.tooling.tool_type]} ${o.tooling.batta_code ?? ''}` : o.custom_tool_name || 'Other tool');
const stOf = (o: OrderFull) => o.status === 'CLOSED' ? ((o.qty_made ?? 0) >= o.quantity ? 'Completed' : `Closed (${o.qty_made ?? 0} of ${o.quantity})`)
  : o.status === 'QUEUED' && (o.qty_made ?? 0) > 0 ? 'Partly made' : ST[o.status];
const det = (k: ToolingMaster) => k.tool_type === 'DIE_TOP' ? (k.batta_code ? `Batta ${k.batta_code}` : '')
  : k.tool_type === 'BOTTOM' ? `OD ${k.od_dim ?? '—'} × L ${k.length_dim ?? '—'} · OD ${k.od2_dim ?? '—'} · Step ${k.step_depth_dim ?? '—'}`
  : k.tool_type === 'FACING_PUNCH' ? `OD ${k.od_dim ?? '—'} × L ${k.length_dim ?? '—'}` : '';
const Stepper = ({ n, set }: { n: number; set: (v: number) => void }) => (<div className="flex items-center gap-2">
  <button aria-label="Less" onClick={() => set(n <= 1 ? 0 : n - 1)} className="w-16 rounded-xl bg-slate-800"><Minus className="mx-auto"/></button>
  <span className="text-4xl font-bold w-14 text-center">{n}</span>
  <button aria-label="More" onClick={() => set(n === 0 ? 5 : n + 1)} className="w-16 rounded-xl bg-slate-800"><Plus className="mx-auto"/></button></div>);

function Kiosk() {
  const [tab, setTab] = useState<'new' | 'track' | 'all'>('new');
  const [machines, setMachines] = useState<HeaderMachine[]>([]);
  const [rollers, setRollers] = useState<RollerMaster[]>([]);
  const [runs, setRuns] = useState<ProductionRun[]>([]);
  const [tools, setTools] = useState<ToolingMaster[]>([]);
  const [mid, setMid] = useState<string | null>(null);
  const [rid, setRid] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [form, setForm] = useState(false);
  const [fname, setFname] = useState(''); const [drg, setDrg] = useState(''); const [party, setParty] = useState('');
  const [tf, setTf] = useState<Record<string, Rec>>({});
  const [rq, setRq] = useState<number | null>(null);
  const [qtys, setQtys] = useState<Partial<Record<ToolType, number>>>({});
  const [others, setOthers] = useState<Other[]>([]);
  const [prio, setPrio] = useState<Priority | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false); const [mname, setMname] = useState('');
  const [sq, setSq] = useState(''); const [year, setYear] = useState<OrderFull[]>([]); const [open, setOpen] = useState<string | null>(null); const [view, setView] = useState<string | null>(null); const [recv, setRecv] = useState<{ id: string; qty: number } | null>(null);
  const { orders, deliveries, reload } = useOrders();

  const load = useCallback(async () => {
    const [m, r, p, t] = await Promise.all([supabase.from('header_machines').select('*').order('id'),
      supabase.from('roller_master').select('*').order('roller_size'),
      supabase.from('production_runs').select('*').eq('status', 'ACTIVE'), supabase.from('tooling_master').select('*')]);
    setMachines(m.data ?? []); setRollers(r.data ?? []); setRuns(p.data ?? []); setTools(t.data ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const roller = rollers.find(r => r.id === rid);
  const has = (t: ToolType) => tools.find(x => x.roller_id === rid && x.tool_type === t);
  const qq = q.trim().toLowerCase();
  const shown = rollers.filter(r => r.roller_size.toLowerCase().includes(qq));
  const canNew = !!qq && !rollers.some(r => r.roller_size.toLowerCase() === qq);
  const mine = orders.filter(o => o.machine_id === mid && Date.now() - +new Date(o.created_at) < 7 * 864e5);
  const pending = (t: ToolType) => mine.filter(o => ACTIVE.includes(o.status) && o.tooling?.tool_type === t && o.roller_id === rid).reduce((a, o) => a + o.quantity - (o.qty_made ?? 0), 0);
  const picked = STD.filter(t => (qtys[t] ?? 0) > 0), otherPicked = others.filter(o => o.qty > 0);
  const lines = picked.length + otherPicked.length;
  useEffect(() => {   // last 365 days of orders for the All Orders tab (paged: Supabase returns max 1000 rows per request)
    if (tab !== 'all') return;
    (async () => {
      const since = new Date(Date.now() - 365 * 864e5).toISOString(); let all: OrderFull[] = [];
      for (let i = 0; ; i += 1000) {
        const { data } = await supabase.from('tool_orders').select(SEL).gte('created_at', since).order('created_at', { ascending: false }).range(i, i + 999);
        if (!data?.length) break; all = all.concat(data as unknown as OrderFull[]); if (data.length < 1000) break;
      }
      setYear(all);
    })();
  }, [tab, orders.length]);
  const kindOf = (o: OrderFull) => (o.tooling ? TOOL_LABEL[o.tooling.tool_type] : o.custom_tool_name || 'Other tool');
  const dy = (d: string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const byRoller: Record<string, OrderFull[]> = {};
  year.forEach(o => (byRoller[o.roller?.roller_size ?? '—'] ??= []).push(o));
  const groups = Object.entries(byRoller).filter(([s]) => s.toLowerCase().includes(sq.trim().toLowerCase()))
    .sort((a, b) => +new Date(b[1][0].created_at) - +new Date(a[1][0].created_at));
  const allTotals: Record<string, number> = {};
  groups.forEach(([, l]) => l.forEach(o => { allTotals[kindOf(o)] = (allTotals[kindOf(o)] ?? 0) + o.quantity; }));
  const viewItems = view ? orders.filter(o => gkey(o) === view).sort((a, b) => a.slip_no - b.slip_no) : [];
  const batches = Object.values(mine.reduce((a, o) => { (a[gkey(o)] ??= []).push(o); return a; }, {} as Record<string, OrderFull[]>));
  const reset = () => { setQtys({}); setOthers([]); setPrio(null); };

  function pickMachine(id: string) { setMid(id); setRid(machines.find(m => m.id === id)?.current_roller_id ?? null); setQ(''); setForm(false); setRq(null); reset(); }
  async function addMachine() {
    const id = mname.trim().toUpperCase(); if (!id) return;
    const { error } = await supabase.from('header_machines').insert({ id });
    if (error) return alert('Could not add machine: ' + error.message);
    await load(); setAdding(false); setMname(''); setMid(id); setRid(null); setQ(''); setForm(false); setRq(null); reset();
  }
  async function del(ids: string[]) {   // only rows still QUEUED are removed (checked in the database too)
    if (!confirm('Delete this from the order? This cannot be undone.')) return;
    const { error } = await supabase.from('tool_orders').delete().in('id', ids).eq('status', 'QUEUED');
    if (error) alert('Could not delete: ' + error.message); reload();
  }
  function openNew() { setRid(null); setFname(q.trim()); setDrg(''); setParty(''); setTf({}); reset(); setForm(true); }
  function openEdit() {
    const t: Record<string, Rec> = {};
    STD.forEach(x => { const k = has(x); if (k) t[x] = { code: k.batta_code ?? '', od: k.od_dim?.toString() ?? '', len: k.length_dim?.toString() ?? '', od2: k.od2_dim?.toString() ?? '', step: k.step_depth_dim?.toString() ?? '' }; });
    setTf(t); setFname(roller?.roller_size ?? ''); setDrg(roller?.customer_drg ?? ''); setParty(roller?.party_name ?? ''); setForm(true);
  }
  const setF = (t: string, k: keyof Rec, v: string) => setTf({ ...tf, [t]: { ...(tf[t] ?? { code: '', od: '', len: '', od2: '', step: '' }), [k]: v } });

  async function saveForm() {   // ignore repeat taps while a save is running
    if (busy) return; setBusy(true);
    try { await saveFormInner(); } finally { setBusy(false); }
  }
  async function saveFormInner() {
    if (!fname.trim()) return alert('Enter roller size');
    const rec = { roller_size: fname.trim(), customer_drg: drg.trim() || null, party_name: party.trim() || null };
    let id = rid;
    if (!id) {
      const { data, error } = await supabase.from('roller_master').insert(rec).select().single();
      if (data) id = data.id;
      else if (error?.code === '23505') {   // size already exists (e.g. an earlier save went through): use it instead of failing
        const { data: ex } = await supabase.from('roller_master').select('id').eq('roller_size', rec.roller_size).maybeSingle();
        if (!ex) return alert('Save failed: ' + error.message);
        id = ex.id;
        await supabase.from('roller_master').update(rec).eq('id', id);
      } else return alert('Save failed: ' + error?.message);
    } else {
      const { error } = await supabase.from('roller_master').update(rec).eq('id', id);
      if (error) return alert('Save failed: ' + error.message);
    }
    const { data: cur } = await supabase.from('tooling_master').select('id, tool_type').eq('roller_id', id!);   // fresh, not the page's cached list
    for (const t of STD) {   // every tool gets a row (Forging Pin has no details but must exist to be ordered)
      const f = tf[t];
      const row = { batta_code: f?.code || null, od_dim: num(f?.od), length_dim: num(f?.len), od2_dim: num(f?.od2), step_depth_dim: num(f?.step) };
      const ex = cur?.find(x => x.tool_type === t);
      if (ex) await supabase.from('tooling_master').update(row).eq('id', ex.id);
      else await supabase.from('tooling_master').insert({ roller_id: id!, tool_type: t, ...row });
    }
    await load(); reload(); setRid(id); setQ(''); setForm(false);
  }

  async function send() {
    if (!mid || !rid || !prio || !lines || busy) return;
    if (picked.some(t => !has(t))) { alert('Add roller details first (tap Edit)'); return openEdit(); }
    setBusy(true);
    const m = machines.find(x => x.id === mid)!;
    let runId = runs.find(r => r.machine_id === mid)?.id ?? null;
    if (m.current_roller_id !== rid) {   // different roller size on this header = new production run
      await supabase.from('production_runs').update({ status: 'COMPLETED', ended_at: new Date().toISOString() }).eq('machine_id', mid).eq('status', 'ACTIVE');
      const { data } = await supabase.from('production_runs').insert({ machine_id: mid, roller_id: rid }).select().single();
      runId = data?.id ?? null;
      await supabase.from('header_machines').update({ current_roller_id: rid }).eq('id', mid);
    }
    const gid = uuid();
    const base = { order_group: gid, machine_id: mid, run_id: runId, roller_id: rid, roller_qty: rq, priority: prio };
    const rows = [...picked.map(t => ({ ...base, quantity: qtys[t]!, tooling_id: has(t)!.id })),
      ...otherPicked.map(o => ({ ...base, quantity: o.qty, custom_tool_name: o.name || null, custom_dimensions: o.dims || null }))];
    const { error } = await supabase.from('tool_orders').insert(rows);
    setBusy(false);
    if (error) return alert('Order failed: ' + error.message);
    chime(); setSent(true); load();
    setTimeout(() => { setSent(false); reset(); setView(gid); }, 1800);
  }
  async function confirmReceived() {   // plant confirms the quantity received for one batch
    if (!recv) return;
    const { error } = await rpc('receive_delivery', { p_delivery: recv.id, p_qty: recv.qty });
    if (error) alert('Could not save: ' + error.message);
    setRecv(null); reload();
  }
  async function closeRest(o: OrderFull) {   // toolroom closes the balance; the order stays on record at what was delivered
    if (!confirm(`Close the remaining ${o.quantity - (o.qty_made ?? 0)} pcs of ${tname(o)}? It will count as ${o.qty_made ?? 0} delivered.`)) return;
    const { error } = await rpc('close_order', { p_order: o.id });
    if (error) alert('Could not close: ' + error.message); reload();
  }

  return (<div className="p-4 max-w-7xl mx-auto">
    <header className="flex items-center justify-between mb-4">
      <h1 className="text-xl text-slate-400">Toolroom · Plant kiosk</h1>
    </header>
    <div className="grid grid-cols-3 gap-3 mb-5">
      <button className={`${big} h-20 ${tab === 'new' ? on : off}`} onClick={() => setTab('new')}>➕ New Order</button>
      <button className={`${big} h-20 ${tab === 'track' ? on : off}`} onClick={() => setTab('track')}>📍 Where is my tool?</button>
      <button className={`${big} h-20 ${tab === 'all' ? on : off}`} onClick={() => setTab('all')}>📋 All Orders</button>
    </div>

    {tab === 'new' ? (<div className="grid lg:grid-cols-3 gap-6"><div className="lg:col-span-2 space-y-6">
      <section><h2 className="text-lg text-slate-400 mb-2">1. Machine</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{machines.map(m =>
          <button key={m.id} onClick={() => pickMachine(m.id)} className={`${big} h-24 ${mid === m.id ? on : off}`}>{m.id}</button>)}
          <button onClick={() => setAdding(!adding)} className={`${big} h-24 border-dashed border-green-600 text-green-400`}>➕ Add machine</button></div>
        {adding && <div className="flex gap-2 mt-3"><input className={inp} placeholder="New machine code, e.g. HD-22" value={mname} onChange={e => setMname(e.target.value)}/>
          <button onClick={addMachine} className="px-8 rounded-xl bg-green-600 text-xl font-bold">Save</button></div>}</section>

      {mid && <section><h2 className="text-lg text-slate-400 mb-2">2. Roller size</h2>
        <Lbl t="Roller size: type, or pick below"><input className={inp} placeholder="e.g. 31309" value={q} onChange={e => { setQ(e.target.value); setForm(false); }}/></Lbl>
        <div className="flex flex-wrap gap-2 mt-3">
          {shown.map(r => <button key={r.id} onClick={() => { setRid(r.id); setQ(''); setForm(false); reset(); }} className={`${big} py-3 px-6 ${rid === r.id && !qq ? on : off}`}>{r.roller_size}</button>)}
          {canNew && <button onClick={openNew} className={`${big} py-3 px-6 border-green-500 bg-green-600/20`}>➕ New size “{q.trim()}”</button>}</div>
        {roller && !form && <div className="mt-3 bg-slate-900 rounded-xl p-4 border border-slate-800">
          <div className="flex justify-between items-start gap-2"><div><div className="text-xl font-bold">{roller.roller_size} <span className="text-slate-400 font-normal">Drg: {roller.customer_drg ?? '—'}</span></div>
            <div className="text-slate-400">Party: {roller.party_name ?? '—'}</div></div>
            <button onClick={openEdit} className="px-4 rounded-xl bg-slate-800 min-h-12 text-base">✏️ Edit details</button></div>
          <div className="grid sm:grid-cols-2 gap-1 mt-2 text-slate-300">{STD.filter(t => t !== 'SHORT_PIN').map(t => { const k = has(t);
            return <div key={t}>{TOOL_LABEL[t]}: {k ? det(k) || '—' : <span className="text-slate-500">not added</span>}</div>; })}</div></div>}
        {form && <div className="mt-3 bg-slate-900 rounded-xl p-4 border-2 border-green-600 space-y-3">
          <div className="text-xl font-bold">{rid ? 'Edit roller details' : 'New roller size: enter details'}</div>
          <div className="grid md:grid-cols-3 gap-2">
            <Lbl t="Roller size"><input className={inp} value={fname} onChange={e => setFname(e.target.value)}/></Lbl>
            <Lbl t="Drawing no."><input className={inp} value={drg} onChange={e => setDrg(e.target.value)}/></Lbl>
            <Lbl t="Party name"><input className={inp} value={party} onChange={e => setParty(e.target.value)}/></Lbl></div>
          {STD.map(t => <div key={t} className="rounded-xl border border-slate-700 p-3"><div className="mb-2 font-semibold text-lg">{TOOL_LABEL[t]}</div>
            {LAYOUT[t].map((row, i) => <div key={i} className={`grid gap-2 mb-2 ${row.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>{row.map(([k, p]) =>
              <Lbl key={k} t={p}><input className={inp} inputMode={k === 'code' ? 'text' : 'decimal'} value={tf[t]?.[k] ?? ''} onChange={e => setF(t, k, e.target.value)}/></Lbl>)}</div>)}</div>)}
          <div className="flex gap-3"><button onClick={saveForm} disabled={busy} className="flex-1 rounded-xl bg-green-600 disabled:bg-slate-700 text-xl font-bold">{busy ? 'Saving…' : '💾 Save'}</button>
            <button onClick={() => setForm(false)} className="px-6 rounded-xl bg-slate-800 text-xl">Cancel</button></div></div>}
      </section>}

      {mid && rid && !form && <section><h2 className="text-lg text-slate-400 mb-2">3. Rollers to forge (optional)</h2>
        <div className="flex flex-wrap gap-2 items-end">{[25000, 50000, 100000, 200000].map(n =>
          <button key={n} onClick={() => setRq(n)} className={`${big} py-3 px-5 ${rq === n ? on : off}`}>{n.toLocaleString('en-IN')}</button>)}
          <Lbl t="Other quantity"><input className={`${inp} !w-48`} inputMode="numeric" value={rq ?? ''} onChange={e => setRq(e.target.value ? parseInt(e.target.value.replace(/\D/g, '')) || null : null)}/></Lbl></div></section>}

      {mid && rid && !form && <section><h2 className="text-lg text-slate-400 mb-2">4. Tools needed: set quantity</h2>
        <div className="space-y-2">{STD.map(t => { const k = has(t), n = qtys[t] ?? 0, p = pending(t);
          return <div key={t} className={`flex items-center gap-3 rounded-xl p-3 border-2 ${n ? on : off}`}>
            <div className="flex-1"><div className="text-xl font-bold">{TOOL_LABEL[t]}</div>
              <div className="text-sm text-slate-400">{k ? det(k) : '+ details not added (tap Edit details)'}{p ? ` · ⚠ Already ordered · ${p} pcs pending` : ''}</div></div>
            <Stepper n={n} set={v => setQtys({ ...qtys, [t]: v })}/></div>; })}
          {others.map((o, i) => <div key={i} className={`flex items-center gap-3 rounded-xl p-3 border-2 ${on}`}>
            <div className="flex-1 grid grid-cols-2 gap-2"><Lbl t="Tool name"><input className={inp} value={o.name} onChange={e => setOthers(others.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}/></Lbl>
              <Lbl t="Size (OD x L ...)"><input className={inp} value={o.dims} onChange={e => setOthers(others.map((x, j) => j === i ? { ...x, dims: e.target.value } : x))}/></Lbl></div>
            <Stepper n={o.qty} set={v => setOthers(others.map((x, j) => j === i ? { ...x, qty: v } : x))}/>
            <button aria-label="Remove" onClick={() => setOthers(others.filter((_, j) => j !== i))} className="w-14 rounded-xl bg-red-900/50"><X className="mx-auto"/></button></div>)}
          <button onClick={() => setOthers([...others, { name: '', dims: '', qty: 5 }])} className="px-5 rounded-xl bg-slate-800 text-lg">+ Other tool</button></div></section>}

      {lines > 0 && !form && <section>
        <h2 className="text-lg text-slate-400 mb-2">5. Priority</h2>
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => setPrio('URGENT_MACHINE_DOWN')} className={`${big} h-24 ${prio === 'URGENT_MACHINE_DOWN' ? 'border-red-500 bg-red-600/30' : off}`}>🔴 URGENT (machine down)</button>
          <button onClick={() => setPrio('BUFFER_NEXT_SHIFT')} className={`${big} h-24 ${prio === 'BUFFER_NEXT_SHIFT' ? 'border-yellow-400 bg-yellow-400/20' : off}`}>🟡 Next morning (buffer stock)</button></div>
        <button disabled={!prio || busy} onClick={send} className="mt-4 w-full h-24 rounded-2xl bg-green-600 disabled:bg-slate-800 disabled:text-slate-500 text-3xl font-extrabold">
          {sent ? '✅ Order sent!' : `✅ SEND ORDER (${lines} tools)`}</button></section>}
    </div>

    <aside className="bg-slate-900 rounded-xl p-4 border border-slate-800 h-fit lg:sticky lg:top-4">
      <h2 className="text-xl font-bold mb-2">{mid ? `${mid} orders` : 'Select a machine'} <span className="text-sm text-slate-500 font-normal">last 7 days</span></h2>
      {mid && !mine.length && <p className="text-slate-500">No orders yet.</p>}
      <div className="space-y-2 max-h-[70vh] overflow-y-auto">{batches.map(b => { const k = gkey(b[0]); return <button key={k} onClick={() => setView(k)} className="w-full text-left rounded-lg bg-slate-800 p-3 min-h-16 active:bg-slate-700">
        <div className="flex justify-between gap-2"><span className="font-bold text-lg">{b[0].roller?.roller_size ?? '—'}</span><span className="text-sm text-slate-400">{dt(b[0].created_at)}</span></div>
        <div className="text-slate-300">{b.map(o => `${kindOf(o)} ×${o.quantity}`).join(', ')}</div>
        <div className="text-xs text-amber-400">{[...new Set(b.map(o => stOf(o)))].join(' · ')} · tap to view</div></button>; })}</div>
    </aside></div>) : tab === 'all' ? (<div className="space-y-4">
      <div className="bg-slate-900 rounded-xl p-4 border border-slate-800">
        <div className="text-slate-400 mb-1">Tools ordered, last 12 months{sq.trim() ? ` · size “${sq.trim()}”` : ' · all roller sizes'}</div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xl">{Object.entries(allTotals).map(([k, n]) => <span key={k}><b className="text-3xl text-amber-300">{n}</b> {k}</span>)}
          {!groups.length && <span className="text-slate-500">No orders found.</span>}</div></div>
      <input className={inp} placeholder="Search by roller size" value={sq} onChange={e => setSq(e.target.value)}/>
      <div className="grid md:grid-cols-2 gap-3">{groups.map(([size, list]) => { const per: Record<string, { n: number; last: OrderFull }> = {};
        list.forEach(o => { const k = kindOf(o); per[k] = { n: (per[k]?.n ?? 0) + o.quantity, last: per[k]?.last ?? o }; });
        return <div key={size} className="bg-slate-900 rounded-xl p-4 border border-slate-800">
          <button onClick={() => setOpen(open === size ? null : size)} className="w-full text-left min-h-12">
            <div className="text-2xl font-bold">{size} <span className="text-slate-400 text-base font-normal">Drg {list[0].roller?.customer_drg ?? '—'}{list[0].roller?.party_name ? ` · ${list[0].roller.party_name}` : ''}</span></div>
            <div className="text-slate-400 text-sm">Last order {dy(list[0].created_at)} · {list.length} orders</div></button>
          <div className="mt-2 space-y-1">{Object.entries(per).map(([k, v]) => <div key={k} className="flex justify-between gap-2">
            <span className="font-semibold">{k}</span><span className="text-slate-300 text-right">last {dy(v.last.created_at)} · {v.last.quantity} pcs <span className="text-slate-500">(total {v.n})</span></span></div>)}</div>
          {open === size && <div className="mt-3 border-t border-slate-800 pt-2 space-y-1 text-sm max-h-72 overflow-y-auto">{list.map(o => <div key={o.id} className="flex justify-between gap-2">
            <span>{dy(o.created_at)} · {tname(o)}</span><span>{o.quantity} pcs{o.qty_made != null ? ` · made ${o.qty_made}` : ''}{o.qty_received != null ? ` · received ${o.qty_received}` : ''} · {stOf(o)}</span></div>)}</div>}</div>; })}</div>
    </div>) : (<div>
      <div className="flex gap-2 overflow-x-auto pb-3">{[null, ...machines.map(m => m.id)].map(id =>
        <button key={id ?? 'all'} onClick={() => setFilter(id)} className={`px-6 rounded-full border-2 text-xl whitespace-nowrap ${filter === id ? on : off}`}>{id ?? 'All'}</button>)}</div>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">{COLS.map(([st, label, bc]) => {
        const isOrd = st === 'QUEUED' || st === 'ON_LATHE';
        const olist = isOrd ? orders.filter(o => o.status === st && (!filter || o.machine_id === filter)) : [];
        const dlist = isOrd ? [] : deliveries.filter(d => d.status === st && d.ord && (!filter || d.ord.machine_id === filter) && (st === 'READY' || Date.now() - +new Date(d.received_at ?? d.made_at) < 7 * 864e5));
        return <div key={st} className={`border-t-4 ${bc} bg-slate-900 rounded-xl p-3 min-h-40`}>
          <h3 className="text-xl font-bold mb-2">{label} <span className="text-slate-500">{olist.length + dlist.length}</span></h3>
          <div className="space-y-2">
            {olist.map(o => <div key={o.id} className={`rounded-lg bg-slate-800 p-3 ${o.priority === 'URGENT_MACHINE_DOWN' ? 'border-l-4 border-red-500' : ''}`}>
              <div className="text-xl font-bold">{o.machine_id} · {o.roller?.roller_size ?? ''}</div>
              <div className="text-slate-300">{tname(o)} × {o.quantity}{(o.qty_made ?? 0) > 0 ? ` · made ${o.qty_made}, ${o.quantity - o.qty_made!} to go` : ''}</div>
              <div className="text-xs text-slate-500">Slip #{o.slip_no} · {dt(o.created_at)}</div>
              {st === 'QUEUED' && (o.qty_made ?? 0) > 0 && <button onClick={() => closeRest(o)} className="mt-2 w-full rounded-lg bg-amber-700 font-bold">Close remaining</button>}</div>)}
            {dlist.map(d => { const o = d.ord!; return <div key={d.id} className="rounded-lg bg-slate-800 p-3">
              <div className="text-xl font-bold">{o.machine_id} · {o.roller?.roller_size ?? ''}</div>
              <div className="text-slate-300">{tname(o)} · batch of {d.qty_made}{st === 'RECEIVED' ? ` · got ${d.qty_received}` : ''}</div>
              <div className="text-xs text-slate-500">Order {o.quantity}, made so far {o.qty_made ?? 0} · {dt(st === 'READY' ? d.made_at : d.received_at ?? d.made_at)}</div>
              {st === 'READY' && (recv?.id === d.id
                ? <div className="mt-2 rounded-lg bg-slate-900 p-3 text-center space-y-2">
                    <div>How many did you receive? <span className="text-slate-400">(CNC sent {d.qty_made})</span></div>
                    <div className="flex items-center justify-center gap-3">
                      <button aria-label="Less" onClick={() => setRecv({ id: d.id, qty: Math.max(0, recv.qty - 1) })} className="w-16 rounded-xl bg-slate-700"><Minus className="mx-auto"/></button>
                      <span className="text-5xl font-bold w-20">{recv.qty}</span>
                      <button aria-label="More" onClick={() => setRecv({ id: d.id, qty: recv.qty + 1 })} className="w-16 rounded-xl bg-slate-700"><Plus className="mx-auto"/></button></div>
                    <div className="flex gap-2"><button onClick={confirmReceived} className="flex-1 rounded-lg bg-green-600 font-bold">✔ Confirm received</button>
                      <button onClick={() => setRecv(null)} className="px-4 rounded-lg bg-slate-700">Cancel</button></div></div>
                : <button onClick={() => setRecv({ id: d.id, qty: d.qty_made })} className="mt-2 w-full rounded-lg bg-green-600 font-bold">✔ Received in plant</button>)}</div>; })}</div></div>; })}</div>
    </div>)}
  {viewItems.length > 0 && (() => { const f = viewItems[0]; const queued = viewItems.filter(o => o.status === 'QUEUED' && !o.qty_made); return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setView(null)}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5 w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-start gap-3"><div>
          <div className="text-2xl font-bold">{f.roller?.roller_size ?? '—'} <span className="text-slate-400 text-base font-normal">Drg {f.roller?.customer_drg ?? '—'}</span></div>
          <div className="text-slate-400">{f.roller?.party_name ? `Party: ${f.roller.party_name} · ` : ''}{f.machine_id}</div>
          <div className="text-slate-400 text-sm">Ordered {dt(f.created_at)} · {f.priority === 'URGENT_MACHINE_DOWN' ? '🔴 Urgent' : '🟡 Next morning'}{f.roller_qty ? ` · ${f.roller_qty.toLocaleString('en-IN')} rollers to forge` : ''}</div></div>
          <button aria-label="Close" onClick={() => setView(null)} className="w-14 rounded-xl bg-slate-800"><X className="mx-auto"/></button></div>
        <div className="mt-4 space-y-2">{viewItems.map(o => <div key={o.id} className="rounded-xl bg-slate-800 p-3">
          <div className="flex items-center gap-3"><div className="flex-1"><div className="text-lg font-bold">{tname(o)} × {o.quantity}</div>
            <div className="text-sm text-slate-400">{stOf(o)}{(o.qty_made ?? 0) > 0 ? ` · made ${o.qty_made} · remaining ${Math.max(0, o.quantity - o.qty_made!)}` : ''}</div></div>
            {o.status === 'QUEUED' && !o.qty_made && <button onClick={() => del([o.id])} className="px-4 rounded-xl bg-red-800 min-h-12">🗑 Delete</button>}
            {o.status === 'QUEUED' && (o.qty_made ?? 0) > 0 && <button onClick={() => closeRest(o)} className="px-4 rounded-xl bg-amber-700 min-h-12">Close remaining</button>}</div>
          {deliveries.filter(d => d.order_id === o.id).sort((a, b) => +new Date(a.made_at) - +new Date(b.made_at)).map((d, i) =>
            <div key={d.id} className="text-sm text-slate-300 mt-1">Batch {i + 1}: made {d.qty_made} · {dt(d.made_at)} · {d.status === 'RECEIVED' ? `received ${d.qty_received}` : 'at CNC, not received yet'}</div>)}</div>)}</div>
        {queued.length > 1 && <button onClick={() => del(queued.map(o => o.id))} className="mt-3 w-full rounded-xl bg-red-900 min-h-14 text-lg">🗑 Delete all waiting tools in this order</button>}
        <p className="text-xs text-slate-500 mt-3">Only tools still waiting in the queue can be deleted. Once a tool is on the lathe, ask the CNC operator to stop the job.</p>
      </div></div>); })()}
  </div>);
}

export default function Page() { return <Guard allow={['toolroom', 'owner']}><Kiosk/></Guard>; }
