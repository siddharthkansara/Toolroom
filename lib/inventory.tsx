'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase, rpc } from '@/lib/supabase';
import { uuid } from '@/lib/useOrders';
import { rollerLabel, mname, FACTORIES } from '@/lib/factories';
import { TOOL_LABEL, type RollerMaster, type InventoryStock, type InventoryLocation, type InventoryMove, type InventoryTakedown, type InventoryRequest, type HeaderMachine, type ToolType, type ToolingMaster } from '@/types/database';

const inp = 'h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full';
const lbl = 'block text-sm font-semibold text-slate-300 mb-1';
const btn = 'min-h-14 px-6 rounded-xl bg-green-600 text-white text-xl font-bold disabled:opacity-50';
const btnRed = 'min-h-14 px-6 rounded-xl bg-red-600 text-white text-xl font-bold disabled:opacity-50';
const btn2 = 'min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold';
const tn = (t: string) => TOOL_LABEL[t as ToolType] ?? t;
const detOf = (k: ToolingMaster) => k.tool_type === 'DIE_TOP' ? (k.batta_code ? `Batta ${k.batta_code}` : '')
  : k.tool_type === 'BOTTOM' ? `OD ${k.od_dim ?? '—'} × L ${k.length_dim ?? '—'} · OD ${k.od2_dim ?? '—'} · Step ${k.step_depth_dim ?? '—'}`
  : k.od_dim != null || k.length_dim != null ? `OD ${k.od_dim ?? '—'} × L ${k.length_dim ?? '—'}` : '';
const Tag = ({ s }: { s: string }) => <span className={`rounded-lg px-2 py-0.5 text-sm font-extrabold text-white ${s === 'HARD' ? 'bg-green-600' : 'bg-slate-600'}`}>{s}</span>;
const num = (v: string) => Math.round(+v.replace(/,/g, '') || 0);
export const istDate = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
export const istHour = () => new Date(Date.now() + 330 * 60000).getUTCHours();
const tm = (t: string) => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// ---- Move stock to a location ----
function Mover({ line, locs, def, label, onDone, setMsg }: { line: InventoryStock; locs: InventoryLocation[]; def?: string; label: string; onDone: () => void; setMsg: (m: string) => void }) {
  const [n, setN] = useState(String(line.qty)); const [to, setTo] = useState(def ?? ''); const [busy, setBusy] = useState(false);
  if (!locs.length) return <p className="text-amber-300 font-semibold">Add a location first (tap “Locations” at the top).</p>;
  const go = async () => {
    const qty = num(n);
    if (!to) { setMsg('Choose a location first.'); return; }
    if (qty < 1 || qty > line.qty) { setMsg(`Enter a quantity from 1 to ${line.qty}.`); return; }
    if (to === line.location_id) { setMsg('It is already in that location.'); return; }
    setBusy(true);
    const base = { factory_id: line.factory_id, roller_id: line.roller_id, tool_type: line.tool_type, state: line.state, kind: 'MOVE', move_group: uuid() };
    const { error } = await supabase.from('inventory_moves').insert([{ ...base, qty: -qty, location_id: line.location_id }, { ...base, qty, location_id: to }]);
    setBusy(false);
    if (error) { setMsg(`Could not save: ${error.message}`); return; }
    setMsg(`Moved ${qty} pcs to ${locs.find(l => l.id === to)?.name}.`); onDone();
  };
  return (<div className="flex gap-2 flex-wrap items-end">
    <label className="block"><span className={lbl}>How many</span><input inputMode="numeric" className="h-14 w-28 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl text-right" value={n} onChange={e => setN(e.target.value)}/></label>
    <label className="block flex-1 min-w-[12rem]"><span className={lbl}>Location</span>
      <select className={inp} value={to} onChange={e => setTo(e.target.value)}><option value="">Choose location</option>{locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
    <button className={btn} disabled={busy} onClick={go}>{label}</button></div>);
}

// ---- Mark hardened (soft -> hard) or take out of stock ----
const WHY = ['Damaged / scrapped in stock', 'Other'];   // tools used on a header are recorded on the Shift Sheet instead
function ActionForm({ line, type, onDone, setMsg }: { line: InventoryStock; type: 'harden' | 'out'; onDone: () => void; setMsg: (m: string) => void }) {
  const [n, setN] = useState(String(line.qty)); const [why, setWhy] = useState(WHY[0]); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const go = async () => {
    const qty = num(n);
    if (qty < 1 || qty > line.qty) { setMsg(`Enter a quantity from 1 to ${line.qty}.`); return; }
    setBusy(true);
    const base = { factory_id: line.factory_id, roller_id: line.roller_id, tool_type: line.tool_type, location_id: line.location_id };
    const g = uuid();
    const rows: Partial<InventoryMove>[] = type === 'harden'
      ? [{ ...base, state: 'SOFT', qty: -qty, kind: 'HARDEN', move_group: g }, { ...base, state: 'HARD', qty, kind: 'HARDEN', move_group: g }]
      : [{ ...base, state: line.state, qty: -qty, kind: 'TAKE_OUT', reason: why, note: note.trim() || null }];
    const { error } = await supabase.from('inventory_moves').insert(rows);
    setBusy(false);
    if (error) { setMsg(`Could not save: ${error.message}`); return; }
    setMsg(type === 'harden' ? `Marked ${qty} × ${tn(line.tool_type)} as hardened.` : `Took out ${qty} × ${tn(line.tool_type)} (${why.toLowerCase()}).`); onDone();
  };
  return (<div className="flex gap-2 flex-wrap items-end">
    <label className="block"><span className={lbl}>How many</span><input inputMode="numeric" className="h-14 w-28 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl text-right" value={n} onChange={e => setN(e.target.value)}/></label>
    {type === 'out' && <><label className="block flex-1 min-w-[12rem]"><span className={lbl}>Reason</span><select className={inp} value={why} onChange={e => setWhy(e.target.value)}>{WHY.map(w => <option key={w}>{w}</option>)}</select></label>
      <label className="block flex-1 min-w-[10rem]"><span className={lbl}>Note (optional)</span><input className={inp} value={note} onChange={e => setNote(e.target.value)}/></label></>}
    <button className={type === 'out' ? btnRed : btn} disabled={busy} onClick={go}>{type === 'harden' ? 'Mark hardened' : 'Take out'}</button></div>);
}

// ---- Add stock you already have (opening stock) ----
function AddStock({ factory, rolls, locs, onDone, setMsg }: { factory: string; rolls: RollerMaster[]; locs: InventoryLocation[]; onDone: () => void; setMsg: (m: string) => void }) {
  const [f, setF] = useState(''); const [rid, setRid] = useState(''); const [tt, setTt] = useState('DIE_TOP'); const [st, setSt] = useState<'SOFT' | 'HARD'>('SOFT');
  const [qty, setQty] = useState(''); const [loc, setLoc] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const list = rolls.filter(r => !f.trim() || r.roller_size.toLowerCase().includes(f.trim().toLowerCase())).sort((a, b) => a.roller_size.localeCompare(b.roller_size, undefined, { numeric: true }));
  const chosen = rid && list.some(r => r.id === rid) ? rid : list.length === 1 ? list[0].id : '';
  const save = async () => {
    if (!chosen) { setMsg('Choose a roller size.'); return; }
    if (num(qty) < 1) { setMsg('Enter how many pieces.'); return; }
    setBusy(true);
    const { error } = await supabase.from('inventory_moves').insert({ factory_id: factory, roller_id: chosen, tool_type: tt, state: st, qty: num(qty), location_id: loc || null, kind: 'OPENING', note: note.trim() || null });
    setBusy(false);
    if (error) { setMsg(`Could not save: ${error.message}`); return; }
    setMsg(`Added ${num(qty)} × ${tn(tt)} (${st.toLowerCase()}).`); setQty(''); setNote(''); onDone();
  };
  return (<section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-3">
    <h3 className="text-xl font-bold">Add stock you already have</h3>
    <p className="text-slate-400 text-sm">Use this for tools that are in the toolroom but were not received through the app. Tools received through the app are added automatically.</p>
    <div className="grid sm:grid-cols-2 gap-3">
      <label className="block"><span className={lbl}>Find roller size</span><input className={inp} placeholder="Type to search" value={f} onChange={e => setF(e.target.value)}/></label>
      <label className="block"><span className={lbl}>Roller size</span><select className={inp} value={chosen} onChange={e => setRid(e.target.value)}><option value="">Choose roller size</option>{list.map(r => <option key={r.id} value={r.id}>{r.roller_size}</option>)}</select></label>
      <label className="block"><span className={lbl}>Tool</span><select className={inp} value={tt} onChange={e => setTt(e.target.value)}>{Object.entries(TOOL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="block"><span className={lbl}>Condition</span><select className={inp} value={st} onChange={e => setSt(e.target.value as 'SOFT' | 'HARD')}><option value="SOFT">Soft (not hardened)</option><option value="HARD">Hard (hardened)</option></select></label>
      <label className="block"><span className={lbl}>How many pieces</span><input inputMode="numeric" className={inp} value={qty} onChange={e => setQty(e.target.value)}/></label>
      <label className="block"><span className={lbl}>Location (optional)</span><select className={inp} value={loc} onChange={e => setLoc(e.target.value)}><option value="">Not placed yet</option>{locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      <label className="block sm:col-span-2"><span className={lbl}>Note (optional)</span><input className={inp} value={note} onChange={e => setNote(e.target.value)}/></label></div>
    <button className={btn} disabled={busy} onClick={save}>Save stock</button></section>);
}

// ---- Locations ----
function Locs({ factory, locs, onDone, setMsg }: { factory: string; locs: InventoryLocation[]; onDone: () => void; setMsg: (m: string) => void }) {
  const [name, setName] = useState('');
  const add = async () => {
    if (!name.trim()) { setMsg('Type a location name.'); return; }
    const { error } = await supabase.from('inventory_locations').insert({ factory_id: factory, name: name.trim() });
    if (error) { setMsg(error.code === '23505' ? 'That location already exists.' : `Could not save: ${error.message}`); return; }
    setMsg(`Added location “${name.trim()}”.`); setName(''); onDone();
  };
  const hide = async (l: InventoryLocation) => {
    const { error } = await supabase.from('inventory_locations').update({ active: false }).eq('id', l.id);
    if (error) { setMsg(`Could not remove: ${error.message}`); return; }
    setMsg(`Removed “${l.name}” from the list.`); onDone();
  };
  return (<section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-3">
    <h3 className="text-xl font-bold">Locations</h3>
    <p className="text-slate-400 text-sm">Name each almirah or cupboard once, for example “Almirah 2 – Shelf 3”. You will pick from this list.</p>
    <div className="flex gap-2 flex-wrap items-end"><label className="block flex-1 min-w-[12rem]"><span className={lbl}>New location name</span><input className={inp} value={name} onChange={e => setName(e.target.value)}/></label><button className={btn} onClick={add}>Add</button></div>
    <div className="divide-y divide-slate-800 rounded-xl border border-slate-800">{locs.map(l => <div key={l.id} className="flex items-center gap-3 px-3 py-2"><span className="text-lg font-semibold flex-1">{l.name}</span><button className={btn2} onClick={() => hide(l)}>Remove</button></div>)}
      {!locs.length && <p className="p-3 text-slate-500">No locations yet.</p>}</div></section>);
}

// ---- History of changes ----
const KIND: Record<string, string> = { RECEIPT: 'Received', HARDEN: 'Hardened', TAKE_OUT: 'Taken out', MOVE: 'Moved', OPENING: 'Added', CORRECTION: 'Corrected', RETURN: 'Returned', USED: 'Used', USED_UNDO: 'Used (undone)', TRANSFER_IN: 'Transferred in', TRANSFER_OUT: 'Transferred out' };
function History({ factory, sizeOf, locName }: { factory: string; sizeOf: Map<string, string>; locName: Map<string, string> }) {
  const [rows, setRows] = useState<InventoryMove[]>([]);
  useEffect(() => { (async () => {
    const { data } = await supabase.from('inventory_moves').select('*').eq('factory_id', factory).order('created_at', { ascending: false }).limit(150);
    setRows((data ?? []) as unknown as InventoryMove[]);
  })(); }, [factory]);
  const shown = rows.filter(r => !((r.kind === 'HARDEN' || r.kind === 'MOVE') && r.qty < 0));   // show one line per harden / move
  return (<section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-2">
    <h3 className="text-xl font-bold">Recent changes</h3>
    {shown.map(r => <div key={r.id} className="rounded-xl bg-slate-800 px-3 py-2 flex items-center gap-2 flex-wrap">
      <span className="text-sm text-slate-400 w-32">{tm(r.created_at)}</span><b>{KIND[r.kind] ?? r.kind}</b>
      <span>{rollerLabel(factory, sizeOf.get(r.roller_id) ?? '—')} · {tn(r.tool_type)}</span><Tag s={r.state}/>
      {r.location_id && <span className="text-slate-400 text-sm">{locName.get(r.location_id) ?? ''}</span>}
      {(r.reason || r.note) && <span className="text-slate-400 text-sm">{[r.reason, r.note].filter(Boolean).join(' · ')}</span>}
      <span className={`ml-auto text-xl font-extrabold ${r.qty < 0 ? 'text-red-400' : 'text-green-400'}`}>{r.qty > 0 ? '+' : ''}{r.qty}</span></div>)}
    {!shown.length && <p className="text-slate-500">No changes yet.</p>}</section>);
}

// ---- Roller taken off the header machine (the notebook entry) ----
const dd = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
function RunNote({ r }: { r: InventoryTakedown }) {
  return (<div className="rounded-xl bg-slate-900 p-3 text-slate-300"><b className="text-slate-100">Last run:</b> off machine {dd(r.taken_down_on)}{r.machine_id ? ` · ${mname(r.machine_id)}` : ''}{r.wire_size ? ` · Wire ${r.wire_size}` : ''}{r.last_batta ? ` · Last batta ${r.last_batta}` : ''}{r.extra_batta ? ` · Extra batta ${r.extra_batta}` : ''}{r.note ? ` · ${r.note}` : ''}</div>);
}
function TakeDown({ factory, rolls, onDone, setMsg }: { factory: string; rolls: RollerMaster[]; locs?: InventoryLocation[]; onDone: () => void; setMsg: (m: string) => void }) {
  const [machines, setMachines] = useState<HeaderMachine[]>([]); const [recent, setRecent] = useState<InventoryTakedown[]>([]);
  const [mid, setMid] = useState(''); const [f, setF] = useState(''); const [rid, setRid] = useState(''); const [date, setDate] = useState(istDate());
  const [wire, setWire] = useState(''); const [batta, setBatta] = useState(''); const [extra, setExtra] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { (async () => {
    const [m, r] = await Promise.all([
      supabase.from('header_machines').select('*').eq('factory_id', factory),
      supabase.from('inventory_takedowns').select('*').eq('factory_id', factory).order('created_at', { ascending: false }).limit(10)]);
    setMachines(((m.data ?? []) as unknown as HeaderMachine[]).sort((a, b) => mname(a.id).localeCompare(mname(b.id), undefined, { numeric: true })));
    setRecent((r.data ?? []) as unknown as InventoryTakedown[]);
  })(); }, [factory]);
  const list = rolls.filter(r => !f.trim() || r.roller_size.toLowerCase().includes(f.trim().toLowerCase())).sort((a, b) => a.roller_size.localeCompare(b.roller_size, undefined, { numeric: true }));
  const chosen = rid && list.some(r => r.id === rid) ? rid : list.length === 1 ? list[0].id : '';
  const pickMachine = (id: string) => { setMid(id); const cr = machines.find(m => m.id === id)?.current_roller_id; if (cr) { setF(''); setRid(cr); } };   // roller currently on that machine
  const save = async () => {
    if (!chosen) { setMsg('Choose the roller size.'); return; }
    if (!date) { setMsg('Choose the date.'); return; }
    setBusy(true);
    const { error } = await rpc('inventory_take_down', { p_factory: factory, p_roller: chosen, p_machine: mid, p_date: date, p_wire: wire, p_batta: batta, p_extra: extra, p_note: note, p_location: null, p_tools: [] });
    setBusy(false);
    if (error) { setMsg(`Could not save: ${error.message}`); return; }
    setMsg('Recorded.'); onDone();
  };
  return (<div className="space-y-4">
    <section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-3">
      <h3 className="text-xl font-bold">Roller taken off the header machine</h3>
      <p className="text-slate-400 text-sm">This is the run notebook: wire size and batta details for a size. Tools used and rollers forged go on the Shift Sheet.</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block"><span className={lbl}>Header machine</span><select className={inp} value={mid} onChange={e => pickMachine(e.target.value)}><option value="">Choose machine</option>{machines.map(m => <option key={m.id} value={m.id}>{mname(m.id)}</option>)}</select></label>
        <label className="block"><span className={lbl}>Date taken down</span><input type="date" className={inp} value={date} onChange={e => setDate(e.target.value)}/></label>
        <label className="block"><span className={lbl}>Find roller size</span><input className={inp} placeholder="Type to search" value={f} onChange={e => setF(e.target.value)}/></label>
        <label className="block"><span className={lbl}>Roller size</span><select className={inp} value={chosen} onChange={e => setRid(e.target.value)}><option value="">Choose roller size</option>{list.map(r => <option key={r.id} value={r.id}>{r.roller_size}</option>)}</select></label>
        <label className="block"><span className={lbl}>Wire size</span><input className={inp} value={wire} onChange={e => setWire(e.target.value)}/></label>
        <label className="block"><span className={lbl}>Last batta number running</span><input className={inp} value={batta} onChange={e => setBatta(e.target.value)}/></label>
        <label className="block"><span className={lbl}>Extra batta available (optional)</span><input className={inp} value={extra} onChange={e => setExtra(e.target.value)}/></label>
        <label className="block"><span className={lbl}>Note (optional)</span><input className={inp} value={note} onChange={e => setNote(e.target.value)}/></label></div>
      <button className={btn} disabled={busy} onClick={save}>Save record</button></section>
    {recent.length > 0 && <section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-2"><h3 className="text-xl font-bold">Recent records</h3>
      {recent.map(r => <div key={r.id} className="rounded-xl bg-slate-800 px-3 py-2"><b>{rollerLabel(factory, rolls.find(x => x.id === r.roller_id)?.roller_size ?? '—')}</b> · {dd(r.taken_down_on)}{r.machine_id ? ` · ${mname(r.machine_id)}` : ''}{r.wire_size ? ` · Wire ${r.wire_size}` : ''}{r.last_batta ? ` · Batta ${r.last_batta}` : ''}{r.extra_batta ? ` + ${r.extra_batta}` : ''}</div>)}</section>}
  </div>);
}

// ---- Find a roller size in all factories, and ask for tools ----
type SearchRow = { factory_id: string; roller_size: string; tool_type: string; state: string; qty: number; location: string | null; last_move: string };
const rpcData = <T,>(fn: string, args: object) => (supabase.rpc as unknown as (f: string, a: object) => Promise<{ data: T | null; error: { message: string } | null }>).call(supabase, fn, args);
const agoTxt = (t: string) => { const days = Math.floor((+new Date(istDate()) - +new Date(new Date(+new Date(t) + 330 * 60000).toISOString().slice(0, 10))) / 86400000); return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`; };
function OtherFactories({ factory, setMsg, onRequested }: { factory: string; setMsg: (m: string) => void; onRequested: () => void }) {
  const [q, setQ] = useState(''); const [rows, setRows] = useState<SearchRow[] | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [ask, setAsk] = useState(''); const [n, setN] = useState('1'); const [note, setNote] = useState(''); const [sending, setSending] = useState(false);
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true); setErr(''); setAsk('');
    const { data, error } = await rpcData<SearchRow[]>('inventory_search', { p_size: q.trim() });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setRows(data ?? []);
  };
  const send = async (f: string, sz: string, tool: string, st: string, max: number) => {
    const qty = num(n);
    if (qty < 1 || qty > max) { setMsg(`Enter a quantity from 1 to ${max}.`); return; }
    setSending(true);
    const { error } = await rpc('inventory_request_create', { p_source: f, p_requester: factory, p_roller_size: sz, p_tool_type: tool, p_state: st, p_qty: qty, p_note: note });
    setSending(false);
    if (error) { setMsg(`Could not send: ${error.message}`); return; }
    setMsg(`Request sent to ${f}.`); setAsk(''); setNote(''); onRequested();
  };
  const sizes = Array.from(new Set((rows ?? []).map(r => r.roller_size))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return (<div className="space-y-4">
    <section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-3">
      <h3 className="text-xl font-bold">Find a roller size in all factories</h3>
      <p className="text-slate-400 text-sm">Shows which factory has tools in stock. Tap “Request” to ask that factory for them. They will approve and move the tool, and you confirm when it arrives.</p>
      <div className="flex gap-2 flex-wrap items-end"><label className="block flex-1 min-w-[12rem]"><span className={lbl}>Roller size</span>
        <input className={inp} placeholder="Type roller size" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search(); }}/></label>
        <button className={btn} disabled={busy || !q.trim()} onClick={search}>Search</button></div>
      {err && <p className="text-red-400 font-semibold">{err}</p>}</section>
    {rows && sizes.map(sz => <section key={sz} className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-3"><h3 className="text-2xl font-extrabold">{sz}</h3>
      {FACTORIES.map(f => { const mine = rows.filter(r => r.roller_size === sz && r.factory_id === f); if (!mine.length) return null; const last = mine.map(r => r.last_move).sort().slice(-1)[0];
        const lines = Object.values(mine.reduce((a, r) => { const k = r.tool_type + '|' + r.state; const g = (a[k] ??= { tool: r.tool_type, state: r.state, qty: 0, locs: [] as string[] }); g.qty += r.qty; if (r.location) g.locs.push(`${r.location} (${r.qty})`); return a; }, {} as Record<string, { tool: string; state: string; qty: number; locs: string[] }>));
        return (<div key={f} className="rounded-xl bg-slate-800 p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap"><span className="text-xl font-extrabold">{f}</span>{f === factory && <span className="text-slate-400 text-sm">(your factory)</span>}<span className="ml-auto text-sm text-slate-400">last change {agoTxt(last)}</span></div>
          {lines.map(l => { const key = `${f}|${sz}|${l.tool}|${l.state}`; return (<div key={key} className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap"><span className="text-lg">{tn(l.tool)}</span><Tag s={l.state}/>{l.locs.length > 0 && <span className="text-slate-400 text-sm">{l.locs.join(', ')}</span>}<span className="ml-auto text-xl font-extrabold">{l.qty} pcs</span>
              {f !== factory && <button className={btn2} onClick={() => { setAsk(ask === key ? '' : key); setN('1'); }}>Request</button>}</div>
            {ask === key && <div className="flex gap-2 flex-wrap items-end">
              <label className="block"><span className={lbl}>How many</span><input inputMode="numeric" className="h-14 w-28 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl text-right" value={n} onChange={e => setN(e.target.value)}/></label>
              <label className="block flex-1 min-w-[10rem]"><span className={lbl}>Note (optional)</span><input className={inp} value={note} onChange={e => setNote(e.target.value)}/></label>
              <button className={btn} disabled={sending} onClick={() => send(f, sz, l.tool, l.state, l.qty)}>Send request</button></div>}</div>); })}</div>); })}
    </section>)}
    {rows && !sizes.length && <p className="text-slate-500 text-center py-6">No factory has stock for that size.</p>}
  </div>);
}

// ---- Requests between factories ----
const REQ_LABEL: Record<string, string> = { REQUESTED: 'Waiting for answer', APPROVED: 'Approved', IN_TRANSIT: 'On the way', RECEIVED: 'Received', REJECTED: 'Rejected', CANCELLED: 'Cancelled', NOT_RECEIVED: 'Not received' };
// What the request means from THIS factory's side (src = this factory is the one giving the tool)
const reqLabel = (r: InventoryRequest, src: boolean) => {
  const o = src ? r.requester_factory : r.source_factory;
  switch (r.status) {
    case 'REQUESTED': return src ? `${o} is asking` : `Waiting for ${o}`;
    case 'APPROVED': return src ? 'Approved · move the tool' : `Approved by ${o}`;
    case 'IN_TRANSIT': return src ? `Sent to ${o} · on the way` : `On the way from ${o}`;
    case 'RECEIVED': return src ? `⬆ GIVEN to ${o}` : `⬇ RECEIVED from ${o}`;
    case 'NOT_RECEIVED': return src ? `Not received by ${o} · back in your stock` : `Not received from ${o}`;
    case 'REJECTED': return src ? 'You rejected' : `Rejected by ${o}`;
    default: return src ? `Cancelled by ${o}` : 'You cancelled';
  }
};
const reqHead = (r: InventoryRequest, src: boolean) => {
  const t = `${r.qty_sent ?? r.qty_requested} × ${tn(r.tool_type)}`;
  if (r.status === 'RECEIVED') return src ? `You gave ${t} to ${r.requester_factory}` : `You received ${t} from ${r.source_factory}`;
  if (r.status === 'NOT_RECEIVED') return src ? `${t} sent to ${r.requester_factory} was not received` : `You reported ${t} from ${r.source_factory} as not received`;
  if (r.status === 'IN_TRANSIT') return src ? `You sent ${t} to ${r.requester_factory}` : `${r.source_factory} sent you ${t}`;
  const a = `${r.qty_requested} × ${tn(r.tool_type)}`;
  return src ? `${r.requester_factory} asks for ${a}` : `You asked ${r.source_factory} for ${a}`;
};
const ReqTag = ({ r, src }: { r: InventoryRequest; src: boolean }) => <span className={`rounded-lg px-2 py-0.5 text-sm font-extrabold ${r.status === 'RECEIVED' ? (src ? 'bg-sky-600 text-white' : 'bg-green-600 text-white') : r.status === 'REJECTED' || r.status === 'NOT_RECEIVED' ? 'bg-red-600 text-white' : r.status === 'CANCELLED' ? 'bg-slate-600 text-white' : 'bg-amber-500 text-slate-950'}`}>{reqLabel(r, src)}</span>;
export const needsAction = (r: InventoryRequest, f: string) => (r.source_factory === f && (r.status === 'REQUESTED' || r.status === 'APPROVED')) || (r.requester_factory === f && r.status === 'IN_TRANSIT');
const timeline = (r: InventoryRequest) => [`Asked ${tm(r.requested_at)}`, r.decided_at && `${r.status === 'REJECTED' ? 'Rejected' : 'Approved'} ${tm(r.decided_at)}`, r.sent_at && `Moved ${tm(r.sent_at)}`, r.closed_at && r.status !== 'REJECTED' && `${REQ_LABEL[r.status]} ${tm(r.closed_at)}`].filter(Boolean).join(' · ');

function MoveTool({ r, lines, locName, busy, onGo }: { r: InventoryRequest; lines: InventoryStock[]; locName: Map<string, string>; busy: boolean; onGo: (l: { location_id: string | null; qty: number }[]) => void }) {
  const [q, setQ] = useState<Record<string, string>>(() => { const o: Record<string, string> = {}; let left = r.qty_requested; lines.forEach(l => { const take = Math.min(l.qty, left); o[l.location_id ?? 'none'] = take ? String(take) : ''; left -= take; }); return o; });
  if (!lines.length) return <p className="text-amber-300 font-semibold">You have none of this in stock now. Reject the request, or add the stock first.</p>;
  const pick = lines.map(l => ({ location_id: l.location_id, qty: num(q[l.location_id ?? 'none'] ?? ''), max: l.qty }));
  const total = pick.reduce((a, x) => a + x.qty, 0); const bad = pick.some(x => x.qty < 0 || x.qty > x.max) || total < 1 || total > r.qty_requested;
  return (<div className="space-y-2"><p className="text-slate-300 text-sm">Take the tools from where they are kept (up to {r.qty_requested} in total).</p>
    {lines.map(l => <div key={l.location_id ?? 'none'} className="flex items-center gap-3 flex-wrap rounded-xl bg-slate-800 px-3 py-2">
      <span className="flex-1 min-w-[8rem] font-semibold">{l.location_id ? locName.get(l.location_id) ?? 'Location' : 'Not placed'} <span className="text-slate-400 font-normal">({l.qty} available)</span></span>
      <input inputMode="numeric" aria-label="How many" className="h-14 w-24 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl text-right" value={q[l.location_id ?? 'none'] ?? ''} onChange={e => setQ({ ...q, [l.location_id ?? 'none']: e.target.value })}/></div>)}
    <button className={btn} disabled={busy || bad} onClick={() => onGo(pick.filter(x => x.qty > 0).map(x => ({ location_id: x.location_id, qty: x.qty })))}>Move tool ({total})</button></div>);
}

function ReqCard({ r, factory, stock, sizeOf, locName, reload, setMsg }: { r: InventoryRequest; factory: string; stock: InventoryStock[]; sizeOf: Map<string, string>; locName: Map<string, string>; reload: () => void; setMsg: (m: string) => void }) {
  const isSource = r.source_factory === factory; const [mode, setMode] = useState<'' | 'reject' | 'move' | 'no'>(''); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const act = async (fn: string, args: Record<string, unknown>, ok: string) => {
    setBusy(true); const { error } = await rpc(fn, args); setBusy(false);
    if (error) { setMsg(`Could not save: ${error.message}`); return; }
    setMsg(ok); setMode(''); setText(''); reload();
  };
  const lines = stock.filter(x => sizeOf.get(x.roller_id) === r.roller_size && x.tool_type === r.tool_type && x.state === r.state);
  const reason = (label: string, go: () => void, red: boolean) => (<div className="flex gap-2 flex-wrap items-end">
    <label className="block flex-1 min-w-[12rem]"><span className={lbl}>Reason (optional)</span><input className={inp} value={text} onChange={e => setText(e.target.value)}/></label>
    <button className={red ? btnRed : btn} disabled={busy} onClick={go}>{label}</button></div>);
  return (<div className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-2">
    <div className="flex items-center gap-2 flex-wrap"><ReqTag r={r} src={isSource}/><span className="text-sm text-slate-400">{isSource ? `Request from ${r.requester_factory}` : `Request to ${r.source_factory}`}</span></div>
    <p className="text-xl font-bold">{reqHead(r, isSource)} <Tag s={r.state}/> · size {r.roller_size}</p>
    {r.qty_sent != null && r.qty_sent !== r.qty_requested && <p className="text-slate-300">Asked for {r.qty_requested}, {r.qty_sent} sent</p>}
    {r.note && <p className="text-slate-300 text-sm">Note from {r.requester_factory}: {r.note}</p>}
    {r.decision_note && <p className="text-slate-300 text-sm">Note from {r.source_factory}: {r.decision_note}</p>}
    {r.send_note && <p className="text-slate-300 text-sm">When moved: {r.send_note}</p>}
    {r.receive_note && <p className="text-slate-300 text-sm">When answered: {r.receive_note}</p>}
    <p className="text-sm text-slate-400">{timeline(r)}</p>
    {isSource && r.status === 'REQUESTED' && <div className="flex gap-2 flex-wrap"><button className={btn} disabled={busy} onClick={() => act('inventory_request_decide', { p_id: r.id, p_approve: true, p_note: '' }, 'Approved. Now move the tool.')}>✔ Approve</button><button className={btn2} onClick={() => setMode(mode === 'reject' ? '' : 'reject')}>✖ Reject</button></div>}
    {isSource && r.status === 'APPROVED' && <div className="flex gap-2 flex-wrap"><button className={btn} onClick={() => setMode(mode === 'move' ? '' : 'move')}>📦 Move tool</button><button className={btn2} onClick={() => setMode(mode === 'reject' ? '' : 'reject')}>✖ Reject</button></div>}
    {isSource && mode === 'move' && <MoveTool r={r} lines={lines} locName={locName} busy={busy} onGo={l => act('inventory_request_send', { p_id: r.id, p_lines: l, p_note: '' }, 'Moved. The tools are on the way. They will confirm when they arrive.')}/>}
    {isSource && mode === 'reject' && reason('Reject request', () => act('inventory_request_decide', { p_id: r.id, p_approve: false, p_note: text }, 'Request rejected.'), true)}
    {!isSource && (r.status === 'REQUESTED' || r.status === 'APPROVED') && <button className={btn2} disabled={busy} onClick={() => act('inventory_request_cancel', { p_id: r.id }, 'Request cancelled.')}>Cancel request</button>}
    {!isSource && r.status === 'IN_TRANSIT' && <div className="space-y-2"><p className="text-lg font-semibold">Did you receive {r.qty_sent} × {tn(r.tool_type)} from {r.source_factory}?</p>
      <div className="flex gap-2 flex-wrap"><button className={btn} disabled={busy} onClick={() => act('inventory_request_receive', { p_id: r.id, p_received: true, p_note: '' }, 'Received. It is now in your stock, under “To put away”.')}>✔ Yes, received</button><button className={btnRed} onClick={() => setMode(mode === 'no' ? '' : 'no')}>✖ No, not received</button></div></div>}
    {!isSource && mode === 'no' && reason('Confirm: not received', () => act('inventory_request_receive', { p_id: r.id, p_received: false, p_note: text }, `Marked not received. The tools were returned to ${r.source_factory}.`), true)}
    {isSource && r.status === 'IN_TRANSIT' && <p className="text-slate-400">Waiting for {r.requester_factory} to confirm they received it.</p>}
  </div>);
}

function RequestsView({ factory, reqs, stock, sizeOf, locName, reload, setMsg }: { factory: string; reqs: InventoryRequest[]; stock: InventoryStock[]; sizeOf: Map<string, string>; locName: Map<string, string>; reload: () => void; setMsg: (m: string) => void }) {
  const needs = reqs.filter(r => needsAction(r, factory));
  const waiting = reqs.filter(r => !needsAction(r, factory) && ['REQUESTED', 'APPROVED', 'IN_TRANSIT'].includes(r.status));
  const past = reqs.filter(r => !['REQUESTED', 'APPROVED', 'IN_TRANSIT'].includes(r.status)).slice(0, 30);
  const card = (r: InventoryRequest) => <ReqCard key={r.id} r={r} factory={factory} stock={stock} sizeOf={sizeOf} locName={locName} reload={reload} setMsg={setMsg}/>;
  return (<div className="space-y-5">
    {needs.length > 0 && <div className="space-y-3"><h3 className="text-xl font-bold text-amber-300">Needs your action ({needs.length})</h3>{needs.map(card)}</div>}
    {waiting.length > 0 && <div className="space-y-3"><h3 className="text-xl font-bold">Waiting on the other factory</h3>{waiting.map(card)}</div>}
    {past.length > 0 && <div className="space-y-3"><h3 className="text-xl font-bold">Past requests</h3>{past.map(card)}</div>}
    {!reqs.length && <p className="text-slate-500 text-center py-8">No requests yet. To ask another factory for a tool, use “Other factories”.</p>}
  </div>);
}

// ---- The Inventory tab: one view at a time (Stock is the default) ----
export type View = 'stock' | 'add' | 'down' | 'other' | 'req' | 'locs' | 'hist';
export function InventoryTab({ factory, startView }: { factory: string; startView?: View }) {
  const [stock, setStock] = useState<InventoryStock[]>([]); const [rolls, setRolls] = useState<RollerMaster[]>([]);
  const [locs, setLocs] = useState<InventoryLocation[]>([]); const [lastLoc, setLastLoc] = useState<Record<string, string>>({});
  const [goLive, setGoLive] = useState(''); const [q, setQ] = useState(''); const [open, setOpen] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<View>('stock'); const [op, setOp] = useState<{ k: string; t: 'move' | 'harden' | 'out' } | null>(null); const [msg, setMsg] = useState('');
    const [heads, setHeads] = useState<HeaderMachine[]>([]); const [dimMap, setDimMap] = useState<Record<string, string>>({});
  const [lastRun, setLastRun] = useState<Record<string, InventoryTakedown>>({});
  const [reqs, setReqs] = useState<InventoryRequest[]>([]);
  const [origin, setOrigin] = useState<Record<string, { kind: string; reason: string | null; created_at: string }>>({});
  const load = useCallback(async () => {
    if (!factory) return;
    const [s, r, l, m, g, td, rq, om, hm] = await Promise.all([
      supabase.from('inventory_stock').select('*').eq('factory_id', factory),
      supabase.from('roller_master').select('*').eq('factory_id', factory),
      supabase.from('inventory_locations').select('*').eq('factory_id', factory).order('name'),
      supabase.from('inventory_moves').select('roller_id, location_id, created_at').eq('factory_id', factory).not('location_id', 'is', null).order('created_at', { ascending: false }).limit(500),
      supabase.from('inventory_settings').select('go_live').eq('id', 1).maybeSingle(),
      supabase.from('inventory_takedowns').select('*').eq('factory_id', factory).order('taken_down_on', { ascending: false }).order('created_at', { ascending: false }).limit(300),
      supabase.from('inventory_requests').select('*').or(`source_factory.eq.${factory},requester_factory.eq.${factory}`).order('requested_at', { ascending: false }).limit(100),
      supabase.from('inventory_moves').select('roller_id, tool_type, state, kind, reason, created_at').eq('factory_id', factory).is('location_id', null).gt('qty', 0).order('created_at', { ascending: false }).limit(200),
      supabase.from('header_machines').select('*').eq('factory_id', factory)]);
    setStock((s.data ?? []) as unknown as InventoryStock[]); setRolls((r.data ?? []) as unknown as RollerMaster[]); setLocs((l.data ?? []) as unknown as InventoryLocation[]);
    const ll: Record<string, string> = {};
    ((m.data ?? []) as unknown as { roller_id: string; location_id: string }[]).forEach(x => { if (!ll[x.roller_id]) ll[x.roller_id] = x.location_id; });
    setLastLoc(ll); setGoLive((g.data as unknown as { go_live: string } | null)?.go_live ?? '');
    const lr: Record<string, InventoryTakedown> = {}; ((td.data ?? []) as unknown as InventoryTakedown[]).forEach(x => { if (!lr[x.roller_id]) lr[x.roller_id] = x; }); setLastRun(lr); setReqs((rq.data ?? []) as unknown as InventoryRequest[]);
    const og: Record<string, { kind: string; reason: string | null; created_at: string }> = {};
    ((om.data ?? []) as unknown as { roller_id: string; tool_type: string; state: string; kind: string; reason: string | null; created_at: string }[]).forEach(x => { const k = `${x.roller_id}|${x.tool_type}|${x.state}`; if (!og[k]) og[k] = x; });
    setOrigin(og); setHeads((hm.data ?? []) as unknown as HeaderMachine[]);
        const tm: ToolingMaster[] = []; for (let i = 0; i < 20000; i += 1000) { const t = await supabase.from('tooling_master').select('*').range(i, i + 999); const d = (t.data ?? []) as unknown as ToolingMaster[]; tm.push(...d); if (d.length < 1000) break; }
    const dm: Record<string, string[]> = {}; tm.forEach(k => { const x = detOf(k); if (x) { const kk = `${k.roller_id}|${k.tool_type}`; if (!(dm[kk] ??= []).includes(x)) dm[kk].push(x); } });
    setDimMap(Object.fromEntries(Object.entries(dm).map(([k, v]) => [k, v.join(' / ')])));
  }, [factory]);
  useEffect(() => { setView(startView ?? 'stock'); setOp(null); setMsg(''); load(); }, [load, startView]);
  useEffect(() => { const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);   // picks up tools the plant has just received
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(''), 5000); return () => clearTimeout(t); }, [msg]);   // messages fade away
  const go = (v: View) => { setView(v); setOp(null); setMsg(''); };
  const done = () => { setOp(null); load(); };

  const sizeOf = new Map(rolls.map(r => [r.id, r.roller_size])); const act = locs.filter(l => l.active); const locName = new Map(locs.map(l => [l.id, l.name])); const runOn = (id: string) => heads.filter(h => h.current_roller_id === id).map(h => mname(h.id));
  const unplaced = stock.filter(x => !x.location_id);
  const key = (x: InventoryStock) => `${x.roller_id}|${x.tool_type}|${x.state}|${x.location_id ?? ''}`;
  const soft = stock.filter(x => x.state === 'SOFT').reduce((a, x) => a + x.qty, 0), hard = stock.filter(x => x.state === 'HARD').reduce((a, x) => a + x.qty, 0);
  const s = q.trim().toLowerCase();
  const stockGroups = Object.values(stock.reduce((a, x) => { (a[x.roller_id] ??= []).push(x); return a; }, {} as Record<string, InventoryStock[]>))
    .map(items => ({ id: items[0].roller_id, size: sizeOf.get(items[0].roller_id) ?? '—', items: items.sort((a, b) => a.tool_type.localeCompare(b.tool_type) || a.state.localeCompare(b.state)) }))
    .filter(g => !s || g.size.toLowerCase().includes(s)).sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }));
  const extra = s ? Object.keys(lastRun).filter(id => !stock.some(x => x.roller_id === id) && (sizeOf.get(id) ?? '').toLowerCase().includes(s)).map(id => ({ id, size: sizeOf.get(id) ?? '—', items: [] as InventoryStock[] })) : [];   // rollers with a last-run note but no stock, shown when searching
  const groups = [...stockGroups, ...extra].sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }));
  const allOpen = groups.length > 0 && groups.every(g => open[g.id]);
  const reqNeeds = reqs.filter(r => needsAction(r, factory)).length;
  const nav: [View, string][] = [['stock', '📦 Stock'], ['add', '➕ Add stock'], ['down', '🔧 Off machine'], ['other', '🔎 Other factories'], ['req', `📨 Requests${reqNeeds ? ` (${reqNeeds})` : ''}`], ['locs', '📍 Locations'], ['hist', '🕘 History']];

  return (<div className="space-y-5">
    <h2 className="text-2xl font-bold">Inventory · {factory}</h2>
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">{nav.map(([v, t]) => <button key={v} onClick={() => go(v)} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${view === v ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{t}</button>)}</div>
    {msg && <div className="rounded-xl bg-slate-800 px-4 py-3 text-amber-300 font-semibold">{msg}</div>}
    {view === 'add' && <AddStock factory={factory} rolls={rolls} locs={act} onDone={() => { load(); go('stock'); }} setMsg={setMsg}/>}
    {view === 'down' && <TakeDown factory={factory} rolls={rolls} locs={act} onDone={() => { load(); go('stock'); }} setMsg={setMsg}/>}
    {view === 'other' && <OtherFactories factory={factory} setMsg={setMsg} onRequested={() => { setView('req'); load(); }}/>}
    {view === 'req' && <RequestsView factory={factory} reqs={reqs} stock={stock} sizeOf={sizeOf} locName={locName} reload={load} setMsg={setMsg}/>}
    {view === 'locs' && <Locs factory={factory} locs={act} onDone={done} setMsg={setMsg}/>}
    {view === 'hist' && <History factory={factory} sizeOf={sizeOf} locName={locName}/>}
    {view === 'stock' && <>
      <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 flex flex-wrap gap-x-8 gap-y-1 text-xl">
        <span><b className="text-3xl text-amber-300">{(soft + hard).toLocaleString('en-IN')}</b> pcs in stock</span><span className="text-slate-300">Soft {soft.toLocaleString('en-IN')}</span><span className="text-slate-300">Hard {hard.toLocaleString('en-IN')}</span></div>
      {unplaced.length > 0 && <section className="rounded-2xl border-2 border-amber-400 bg-slate-900 p-4 space-y-3">
        <h3 className="text-xl font-bold">📥 To put away ({unplaced.length})</h3>
        <p className="text-slate-400 text-sm">These have no location yet. Choose where you kept them.</p>
        {unplaced.map(l => <div key={key(l) + l.qty} className="rounded-xl bg-slate-800 p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap"><span className="text-xl font-extrabold">{rollerLabel(factory, sizeOf.get(l.roller_id) ?? '—')}</span><span className="text-lg">{tn(l.tool_type)}</span><Tag s={l.state}/><span className="ml-auto text-2xl font-extrabold text-amber-300">{l.qty} pcs</span></div>
          {origin[`${l.roller_id}|${l.tool_type}|${l.state}`]?.kind === 'TRANSFER_IN' && <p className="text-amber-300 text-sm font-semibold">📨 Received from {(origin[`${l.roller_id}|${l.tool_type}|${l.state}`].reason ?? '').replace(/^From /, '') || 'another factory'} · {tm(origin[`${l.roller_id}|${l.tool_type}|${l.state}`].created_at)}</p>}
          <Mover line={l} locs={act} def={act.some(a => a.id === lastLoc[l.roller_id]) ? lastLoc[l.roller_id] : undefined} label="Put away" onDone={done} setMsg={setMsg}/></div>)}</section>}
      <div className="flex gap-2 items-end flex-wrap"><label className="block flex-1 min-w-[12rem]"><span className={lbl}>Search roller size</span><input className={inp} placeholder="Type roller size" value={q} onChange={e => setQ(e.target.value)}/></label>
        <button className={btn2 + ' h-14'} onClick={() => setOpen(allOpen ? {} : Object.fromEntries(groups.map(g => [g.id, true])))}>{allOpen ? 'Collapse all' : 'Expand all'}</button>
        <button className={btn2 + ' h-14'} onClick={load}>↻</button></div>
      <div className="space-y-2">{groups.map(g => { const isOpen = !!open[g.id]; const gs = g.items.filter(x => x.state === 'SOFT').reduce((a, x) => a + x.qty, 0), gh = g.items.filter(x => x.state === 'HARD').reduce((a, x) => a + x.qty, 0);
        return (<div key={g.id} className="rounded-lg bg-slate-800">
          <button onClick={() => setOpen({ ...open, [g.id]: !isOpen })} aria-expanded={isOpen} className="w-full min-h-16 px-3 py-2 flex items-center gap-3 text-left">
                        <span className="text-xl font-extrabold">{rollerLabel(factory, g.size)}</span><span className="ml-auto text-sm text-slate-300">{g.items.length ? `Soft ${gs} · Hard ${gh}` : 'No stock'}</span><span>{isOpen ? '▲' : '▼'}</span></button>
          {isOpen && <div className="px-3 pb-3 space-y-2">{lastRun[g.id] && <RunNote r={lastRun[g.id]}/>}{g.items.map(x => { const k = key(x); const sel = (t: 'move' | 'harden' | 'out') => setOp(op?.k === k && op.t === t ? null : { k, t }); return (<div key={k} className="rounded-xl bg-slate-900 p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap"><span className="text-lg font-bold">{tn(x.tool_type)}</span><Tag s={x.state}/>
              <span className={x.location_id ? 'text-slate-300' : 'text-amber-300 font-semibold'}>{x.location_id ? locName.get(x.location_id) ?? 'Location' : 'Not placed'}</span>
              <span className="ml-auto text-2xl font-extrabold">{x.qty} pcs</span></div>
                          {dimMap[`${x.roller_id}|${x.tool_type}`] && <div className="text-sm text-slate-400">{dimMap[`${x.roller_id}|${x.tool_type}`]}</div>}
            <div className="flex gap-2 flex-wrap">
              {x.state === 'SOFT' && <button className={btn2} onClick={() => sel('harden')}>Hardened</button>}
              <button className={btn2} onClick={() => sel('out')}>Take out</button>
              {x.location_id && <button className={btn2} onClick={() => sel('move')}>Move</button>}</div>
            {op?.k === k && op.t === 'move' && <Mover line={x} locs={act} label="Move" onDone={done} setMsg={setMsg}/>}
            {op?.k === k && (op.t === 'harden' || op.t === 'out') && <ActionForm line={x} type={op.t} onDone={done} setMsg={setMsg}/>}</div>); })}</div>}
        </div>); })}
        {!groups.length && <p className="text-slate-500 py-6 text-center">{stock.length ? 'No roller size matches your search.' : 'No stock yet. Tools appear here automatically when a plant confirms receipt of a batch, or use “Add stock” for tools you already have.'}</p>}</div>
      <p className="text-xs text-slate-500">Automatic stock starts from {goLive ? new Date(goLive).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : 'the go-live date'}. Batches received before that are not counted. Every tool received arrives as soft.</p>
    </>}
  </div>);
}
