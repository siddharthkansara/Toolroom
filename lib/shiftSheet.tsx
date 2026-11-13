'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { rollerLabel, mname } from '@/lib/factories';
import { ProductionTable, UtilGrid } from '@/lib/production';
import { RollerRates } from '@/lib/rollerRates';
import { ToolsUsed } from '@/lib/toolsUsed';
import { TOOL_LABEL, type ToolType,type InventoryStock, type RollerMaster, type HeaderMachine, type HeaderOperator, type ShiftEntry, type ShiftTool, type ShiftSettings, type ShiftSheet as SheetRow } from '@/types/database';
import { SheetDownload } from '@/lib/sheetDownload';

const inp = 'h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full';
const lbl = 'block text-sm font-semibold text-slate-300 mb-1';
const btn = 'min-h-14 px-6 rounded-xl bg-green-600 text-white text-xl font-bold disabled:opacity-50';
const btnRed = 'min-h-12 px-5 rounded-xl bg-red-600 text-white text-lg font-bold disabled:opacity-50';
const btn2 = 'min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold disabled:opacity-50';
const num = (v: string) => Math.round(+v.replace(/,/g, '') || 0);
const tn = (t: string) => TOOL_LABEL[t as ToolType] ?? t;
const TOOLS: ToolType[] = ['DIE_TOP', 'BOTTOM', 'FACING_PUNCH', 'SHORT_PIN'];
const NR_REASONS = ['Breakdown', 'No order / no wire', 'Power cut', 'Maintenance', 'Die change', 'Other'];
type Shift = 'DAY' | 'NIGHT';
const rpcData = <T,>(fn: string, args: object) => (supabase.rpc as unknown as (f: string, a: object) => Promise<{ data: T | null; error: { message: string } | null }>).call(supabase, fn, args);

// ---- IST dates and shift windows ----
const ist = () => new Date(Date.now() + 330 * 60000);
const istDay = (offset = 0) => new Date(+ist() + offset * 86400000).toISOString().slice(0, 10);
const defaultShift = (): { date: string; shift: Shift } => {   // the shift most likely being entered right now
  const n = ist(); const m = n.getUTCHours() * 60 + n.getUTCMinutes();
  return m < 11 * 60 + 49 ? { date: istDay(-1), shift: 'NIGHT' } : m < 19 * 60 + 30 ? { date: istDay(), shift: 'DAY' } : { date: istDay(), shift: 'NIGHT' };
};
const at = (date: string, time: string, plusDays = 0) => Date.parse(`${date}T${time.slice(0, 8)}+05:30`) + plusDays * 86400000;
const FALLBACK: ShiftSettings = { id: 1, day_start: '07:30:00', day_deadline: '19:30:00', night_start: '19:30:00', night_deadline: '11:49:00' };
const win = (date: string, shift: Shift, s: ShiftSettings) => shift === 'DAY' ? { starts: at(date, s.day_start), deadline: at(date, s.day_deadline) } : { starts: at(date, s.night_start), deadline: at(date, s.night_deadline, 1) };
const fmt = (ms: number | string) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// A line can hold several rows for one tool (one per size): add them up for the count box, and keep the sizes as choices
const sumTools = (rows: ShiftTool[] = []) => { const o: Record<string, number> = {}; rows.forEach(x => { o[x.tool_type] = (o[x.tool_type] ?? 0) + x.qty; }); return Object.fromEntries(Object.entries(o).map(([k, n]) => [k, String(n)])); };
const picksOf = (rows: ShiftTool[] = []) => { const o: Record<string, Record<string, string>> = {}; rows.forEach(x => { (o[x.tool_type] ??= {})[x.dim_key] = String(x.qty); }); return o; };
type Init = { id?: string; picks?: Record<string, Record<string, string>>; roller?: string; operator?: string; tools?: Record<string, string>; note?: string; weight?: string; batch?: string; heat?: string; rate?: string };

// ---- One line: a header running one roller size ----
function EntryForm({ factory, date, shift, machine, rolls, ops, init, onSaved, onCancel, setMsg, reloadOps, reloadRolls }: {
  factory: string; date: string; shift: Shift; machine: HeaderMachine; rolls: RollerMaster[]; ops: HeaderOperator[]; init: Init;
  onSaved: () => void; onCancel: () => void; setMsg: (m: string) => void; reloadOps: () => void; reloadRolls: () => void }) {
  const [f, setF] = useState(''); const [rid, setRid] = useState(init.roller ?? ''); const [op, setOp] = useState(init.operator ?? '');
  const [t, setT] = useState<Record<string, string>>(init.tools ?? {}); const [note, setNote] = useState(init.note ?? ''); const [wt, setWt] = useState(init.weight ?? '');
  const [batch, setBatch] = useState(init.batch ?? ''); const [heat, setHeat] = useState(init.heat ?? ''); const [rates, setRates] = useState<Record<string, number>>({});
  useEffect(() => { rpcData<{ roller_id: string; rollers_per_kg: number | null }[]>('roller_rates_list', { p_factory: factory }).then(({ data }) => { const m: Record<string, number> = {}; (data ?? []).forEach(x => { if (x.rollers_per_kg != null) m[x.roller_id] = Number(x.rollers_per_kg); }); setRates(m); }); }, [factory]);
  const [addingSize, setAddingSize] = useState(false); const [newSize, setNewSize] = useState('');
  const [adding, setAdding] = useState(false); const [newOp, setNewOp] = useState(''); const [busy, setBusy] = useState(false);
  const list = rolls.filter(r => !f.trim() || r.roller_size.toLowerCase().includes(f.trim().toLowerCase())).sort((a, b) => a.roller_size.localeCompare(b.roller_size, undefined, { numeric: true }));
  const chosen = rid && list.some(r => r.id === rid) ? rid : list.length === 1 ? list[0].id : '';
    const rate = chosen && init.rate && chosen === init.roller ? Number(init.rate) : chosen ? rates[chosen] : undefined;   // an edited line keeps the rate it was entered with
  const kg = parseFloat(wt.replace(/,/g, '')); const calc = rate && kg > 0 ? Math.round(kg * rate) : null;
    const [stock, setStock] = useState<InventoryStock[]>([]); const [pk, setPk] = useState<Record<string, Record<string, string>>>(init.picks ?? {});
  useEffect(() => { if (!chosen) { setStock([]); return; } supabase.from('inventory_stock').select('*').eq('factory_id', factory).eq('roller_id', chosen).then(({ data }) => setStock((data ?? []) as unknown as InventoryStock[])); }, [factory, chosen]);
  // Sizes in stock for this roller and tool. An entry being edited gets back what it used, so that counts as available too.
  const sizes = (k: string): [string, number][] => { const a: Record<string, number> = {}; stock.filter(x => x.tool_type === k).forEach(x => { a[x.dim_key] = (a[x.dim_key] ?? 0) + Number(x.qty); });
    if (chosen === init.roller) Object.entries(init.picks?.[k] ?? {}).forEach(([d, q]) => { a[d] = (a[d] ?? 0) + num(q); });
    return Object.entries(a).filter(([, n]) => n > 0).sort(([x], [y]) => x.localeCompare(y)); };
  const ambiguous = (k: string) => num(t[k] ?? '') > 0 && sizes(k).length > 1;   // only ask when there is a real choice
  const pv = (k: string, d: string) => pk[k]?.[d] ?? '';
  const setPv = (k: string, d: string, v: string) => setPk({ ...pk, [k]: { ...(pk[k] ?? {}), [d]: v } });
  const pickedSum = (k: string) => sizes(k).reduce((a, [d]) => a + num(pv(k, d)), 0);
  const need = (k: string) => Math.min(num(t[k] ?? ''), sizes(k).reduce((a, [, n]) => a + n, 0));   // stock that cannot cover the count is recorded as short
  
  const addSize = async () => {   // any roller size can be entered, even if no tools were ever ordered for it
    const name = newSize.trim();
    if (!name) { setMsg('Type the roller size.'); return; }
    const have = rolls.find(r => r.roller_size.toLowerCase() === name.toLowerCase());
    if (have) { setRid(have.id); setF(''); setAddingSize(false); setNewSize(''); setMsg(`“${have.roller_size}” is already in the list. Selected it.`); return; }
    const { data, error } = await supabase.from('roller_master').insert({ roller_size: name, factory_id: factory }).select('*').maybeSingle();
    if (error) { setMsg(error.code === '23505' ? 'That roller size already exists. Search for it in the list.' : `Could not add: ${error.message}`); return; }
    setMsg(`Added roller size “${name}”.`); setNewSize(''); setAddingSize(false); setF(''); reloadRolls();
    if (data) setRid((data as unknown as RollerMaster).id);
  };
  const addOp = async () => {
    if (!newOp.trim()) { setMsg('Type the operator’s name.'); return; }
    const { data, error } = await supabase.from('header_operators').insert({ factory_id: factory, name: newOp.trim() }).select('*').maybeSingle();
    if (error) { setMsg(error.code === '23505' ? 'That operator is already in the list.' : `Could not save: ${error.message}`); return; }
    setMsg(`Added operator “${newOp.trim()}”.`); setNewOp(''); setAdding(false); reloadOps();
    if (data) setOp((data as unknown as HeaderOperator).id);
  };
  const save = async () => {
    if (!chosen) { setMsg('Choose the roller size.'); return; }
    if (!op) { setMsg('Choose the operator, or add a new one.'); return; }
        if (!(kg > 0)) { setMsg('Enter the weight of the rollers forged, in kg.'); return; }
    if (!rate) { setMsg('Rollers per kg is not set for this roller size. Ask the owner to set it.'); return; }
    if (!batch.trim()) { setMsg('Enter the batch number.'); return; }
    if (!heat.trim()) { setMsg('Enter the heat number.'); return; }

    const tools: Record<string, number> = {}; TOOLS.forEach(k => { const q = num(t[k] ?? ''); if (q > 0) tools[k] = q; });
        for (const k of TOOLS) {
      if (!ambiguous(k)) continue;
      const over = sizes(k).find(([d, n]) => num(pv(k, d)) > n);
      if (over) { setMsg(`Only ${over[1]} of that ${tn(k)} size in stock.`); return; }
      if (pickedSum(k) !== need(k)) { setMsg(`Choose which size of ${tn(k)} was used. The numbers must add up to ${need(k)}.`); return; }
    }
    const picks: Record<string, { dim_key: string; qty: number }[]> = {};
    TOOLS.forEach(k => { if (ambiguous(k)) picks[k] = sizes(k).map(([d]) => ({ dim_key: d, qty: num(pv(k, d)) })).filter(x => x.qty > 0); });
    setBusy(true);
    const { data, error } = await rpcData<{ id: string; short: Record<string, number> }>('shift_entry_save', { p_id: init.id ?? null, p_factory: factory, p_date: date, p_shift: shift, p_machine: machine.id, p_status: 'RAN', p_roller: chosen, p_operator: op, p_rollers: null, p_tools: tools, p_note: note, p_weight: kg, p_batch: batch.trim(), p_heat: heat.trim(), p_picks: picks });
    setBusy(false);
    if (error) { setMsg(`Could not save: ${error.message}`); return; }
    const short = Object.entries(data?.short ?? {});
    setMsg(short.length ? `Saved. Stock was short for ${short.map(([k, q]) => `${tn(k)} (${q})`).join(', ')}. Please check your stock.` : 'Saved.');
    window.dispatchEvent(new Event('stock-check')); onSaved();
  };
  return (<div className="rounded-xl bg-slate-800 p-3 space-y-3">
    <h4 className="text-lg font-bold">{init.id ? 'Edit entry' : 'New entry'} · {mname(machine.id)}</h4>
    <div className="grid sm:grid-cols-2 gap-3">
      <label className="block"><span className={lbl}>Find roller size</span><input className={inp} placeholder="Type to search" value={f} onChange={e => setF(e.target.value)}/></label>
      <div><label className="block"><span className={lbl}>Roller size that ran</span><select className={inp} value={chosen} onChange={e => setRid(e.target.value)}><option value="">Choose roller size</option>{list.map(r => <option key={r.id} value={r.id}>{r.roller_size}{r.party_name ? ` · ${r.party_name}` : ''}</option>)}</select></label>
        <button className="mt-1 text-amber-300 font-bold underline min-h-10" onClick={() => setAddingSize(!addingSize)}>+ New roller size</button></div>
      <div><label className="block"><span className={lbl}>Operator</span><select className={inp} value={op} onChange={e => setOp(e.target.value)}><option value="">Choose operator</option>{ops.filter(o => o.active || o.id === op).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        <button className="mt-1 text-amber-300 font-bold underline min-h-10" onClick={() => setAdding(!adding)}>+ New operator</button></div>
           <label className="block"><span className={lbl}>Weight of rollers forged, kg</span><input inputMode="decimal" className={inp} value={wt} onChange={e => setWt(e.target.value)}/></label>
      <div><span className={lbl}>Rollers forged (calculated)</span>
        <div className={`${inp} flex items-center font-extrabold`}>{calc != null ? <span className="text-amber-300">{calc.toLocaleString('en-IN')} <span className="text-sm font-normal text-slate-400">rollers at {rate} per kg</span></span>
          : !chosen ? <span className="text-sm font-normal text-slate-400">Choose the roller size first</span>
          : !rate ? <span className="text-sm font-bold text-red-400">Rollers per kg not set. Ask the owner.</span>
          : <span className="text-sm font-normal text-slate-400">Enter the weight</span>}</div></div>
      <label className="block"><span className={lbl}>Batch number</span><input autoCapitalize="characters" className={inp} value={batch} onChange={e => setBatch(e.target.value)}/></label>
      <label className="block"><span className={lbl}>Heat number</span><input autoCapitalize="characters" className={inp} value={heat} onChange={e => setHeat(e.target.value)}/></label></div>
    {addingSize && <div className="flex gap-2 flex-wrap items-end"><label className="block flex-1 min-w-[12rem]"><span className={lbl}>New roller size</span><input className={inp} value={newSize} onChange={e => setNewSize(e.target.value)}/></label><button className={btn} onClick={addSize}>Add</button></div>}
    {adding && <div className="flex gap-2 flex-wrap items-end"><label className="block flex-1 min-w-[12rem]"><span className={lbl}>New operator’s name</span><input className={inp} value={newOp} onChange={e => setNewOp(e.target.value)}/></label><button className={btn} onClick={addOp}>Add</button></div>}
    <div><div className="text-sm font-semibold text-slate-300 mb-1">Tools used (worn out)</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">{TOOLS.map(k => <label key={k} className="block"><span className="block text-sm text-slate-300 mb-1">{tn(k)}</span><input inputMode="numeric" className={inp} value={t[k] ?? ''} onChange={e => setT({ ...t, [k]: e.target.value })}/></label>)}</div></div>
        {TOOLS.filter(ambiguous).map(k => (<div key={k} className="rounded-xl bg-slate-900 p-3 space-y-2">
      <div className="font-bold text-amber-300">Which size of {tn(k)} was used? <span className="font-normal text-slate-300">Chosen {pickedSum(k)} of {need(k)}</span></div>
      {sizes(k).map(([d, n]) => (<div key={d} className="flex items-center gap-2 flex-wrap">
        <span className="flex-1 min-w-[12rem]"><span className="block">{d || '(no size recorded)'}</span><span className="block text-sm text-slate-400">{n} in stock</span></span>
        <button className={btn2} onClick={() => setPv(k, d, String(Math.max(0, Math.min(n, need(k) - (pickedSum(k) - num(pv(k, d)))))))}>All</button>
        <input aria-label={`${tn(k)} ${d || 'size'} used`} inputMode="numeric" className={`${inp} !w-24`} value={pv(k, d)} onChange={e => setPv(k, d, e.target.value)}/></div>))}
    </div>))}
    <label className="block"><span className={lbl}>Remarks (optional)</span><input className={inp} value={note} onChange={e => setNote(e.target.value)}/></label>
    <div className="flex gap-2 flex-wrap"><button className={btn} disabled={busy} onClick={save}>Save entry</button><button className={btn2} onClick={onCancel}>Cancel</button></div></div>);
}

// ---- The Shift Sheet screen ----
function EnterSheet({ factory, isOwner }: { factory: string; isOwner: boolean }) {
  const d0 = defaultShift();
  const [date, setDate] = useState(d0.date); const [shift, setShift] = useState<Shift>(d0.shift);
  const [machines, setMachines] = useState<HeaderMachine[]>([]); const [rolls, setRolls] = useState<RollerMaster[]>([]); const [ops, setOps] = useState<HeaderOperator[]>([]);
  const [entries, setEntries] = useState<ShiftEntry[]>([]); const [tools, setTools] = useState<Record<string, ShiftTool[]>>({});
  const [sheet, setSheet] = useState<SheetRow | null>(null); const [settings, setSettings] = useState<ShiftSettings>(FALLBACK);
  const [defs, setDefs] = useState<Record<string, { roller?: string; operator?: string }>>({});
    const [form, setForm] = useState<{ machine: string; init: Init } | null>(null); const [msg, setMsg] = useState(''); const [del, setDel] = useState(''); const [busy, setBusy] = useState(false); const [nr, setNr] = useState<string | null>(null); const [nrText, setNrText] = useState('');
  const loadOps = useCallback(async () => {
    const { data } = await supabase.from('header_operators').select('*').eq('factory_id', factory).order('name');
    setOps((data ?? []) as unknown as HeaderOperator[]);
  }, [factory]);
  const loadRolls = useCallback(async () => {
    const { data } = await supabase.from('roller_master').select('*').eq('factory_id', factory);
    setRolls(((data ?? []) as unknown as RollerMaster[]).sort((a, b) => a.roller_size.localeCompare(b.roller_size, undefined, { numeric: true })));
  }, [factory]);
  const load = useCallback(async () => {
    if (!factory) return;
    const [m, r, e, sh, st, rc] = await Promise.all([
      supabase.from('header_machines').select('*').eq('factory_id', factory),
      supabase.from('roller_master').select('*').eq('factory_id', factory),
      supabase.from('shift_entries_live').select('*').eq('factory_id', factory).eq('work_date', date).eq('shift', shift).order('created_at'),
      supabase.from('shift_sheets').select('*').eq('factory_id', factory).eq('work_date', date).eq('shift', shift).maybeSingle(),
      supabase.from('shift_settings').select('*').eq('id', 1).maybeSingle(),
      supabase.from('shift_entries_live').select('machine_id, roller_id, operator_id, created_at').eq('factory_id', factory).eq('status', 'RAN').order('created_at', { ascending: false }).limit(150)]);
    setMachines(((m.data ?? []) as unknown as HeaderMachine[]).sort((a, b) => mname(a.id).localeCompare(mname(b.id), undefined, { numeric: true })));
    setRolls(((r.data ?? []) as unknown as RollerMaster[]).sort((a, b) => a.roller_size.localeCompare(b.roller_size, undefined, { numeric: true })));
    const ent = (e.data ?? []) as unknown as ShiftEntry[]; setEntries(ent);
    setSheet((sh.data as unknown as SheetRow | null) ?? null); if (st.data) setSettings(st.data as unknown as ShiftSettings);
    const d: Record<string, { roller?: string; operator?: string }> = {};
    ((rc.data ?? []) as unknown as { machine_id: string; roller_id: string | null; operator_id: string | null }[]).forEach(x => { if (!d[x.machine_id]) d[x.machine_id] = { roller: x.roller_id ?? undefined, operator: x.operator_id ?? undefined }; });
    setDefs(d);
    const tl: Record<string, ShiftTool[]> = {};
    if (ent.length) { const { data } = await supabase.from('shift_tools').select('*').in('entry_id', ent.map(x => x.id)); ((data ?? []) as unknown as ShiftTool[]).forEach(x => (tl[x.entry_id] ??= []).push(x)); }
    setTools(tl);
  }, [factory, date, shift]);
   useEffect(() => { setForm(null); setDel(''); setMsg(''); setNr(null); load(); }, [load]);
  useEffect(() => { loadOps(); }, [loadOps]);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(''), 7000); return () => clearTimeout(t); }, [msg]);

    const sizeOf = new Map(rolls.map(r => [r.id, r.roller_size])); const partyOf = new Map(rolls.map(r => [r.id, r.party_name])); const opName = new Map(ops.map(o => [o.id, o.name]));
  const w = win(date, shift, settings); const nowMs = Date.now();
  const notStarted = nowMs < w.starts; const open = nowMs <= w.deadline; const canEdit = !notStarted && (open || isOwner);
  const total = entries.reduce((a, e) => a + e.rollers_forged, 0);
  const done = machines.filter(m => entries.some(e => e.machine_id === m.id)).length; const allDone = machines.length > 0 && done === machines.length;

  const after = () => { setForm(null); setDel(''); load(); };
  const notRunning = async (m: HeaderMachine, reason: string) => {
    if (!reason.trim()) { setMsg('Please tap or type the reason first.'); return; }
    setBusy(true);
    const { error } = await rpcData('shift_entry_save', { p_id: null, p_factory: factory, p_date: date, p_shift: shift, p_machine: m.id, p_status: 'NOT_RUNNING', p_roller: null, p_operator: null, p_rollers: 0, p_tools: {}, p_note: reason.trim() });
    setBusy(false);
    if (error) { setMsg(`Could not save: ${error.message}`); return; }
    setNr(null); setNrText('');
    setMsg(`${mname(m.id)} marked not running.`); window.dispatchEvent(new Event('stock-check')); after();
  };
  const remove = async (id: string) => {
    setBusy(true); const { error } = await rpcData('shift_entry_delete', { p_id: id }); setBusy(false);
    if (error) { setMsg(`Could not delete: ${error.message}`); return; }
    setMsg('Entry deleted. Any tools it used went back to stock.'); window.dispatchEvent(new Event('stock-check')); after();
  };
  const complete = async (yes: boolean) => {
    setBusy(true); const { error } = await rpcData('shift_sheet_complete', { p_factory: factory, p_date: date, p_shift: shift, p_complete: yes }); setBusy(false);
    if (error) { setMsg(`Could not save: ${error.message}`); return; }
    setMsg(yes ? 'Shift sheet marked complete. Thank you.' : 'Shift sheet reopened.'); window.dispatchEvent(new Event('stock-check')); load();
  };
  
  const openForm = (m: HeaderMachine, e?: ShiftEntry) => setForm({ machine: m.id, init: e
  ? { id: e.id, roller: e.roller_id ?? undefined, operator: e.operator_id ?? undefined, weight: e.weight_kg != null ? String(e.weight_kg) : '', batch: e.batch_no ?? '', heat: e.heat_no ?? '', rate: e.rollers_per_kg != null ? String(e.rollers_per_kg) : undefined, note: e.note ?? '', tools: sumTools(tools[e.id]), picks: picksOf(tools[e.id]) }
  : { roller: m.current_roller_id ?? defs[m.id]?.roller, operator: defs[m.id]?.operator } });

  
  return (<div className="space-y-5">
    <h2 className="text-2xl font-bold">Shift Sheet · {factory}</h2>
    <div className="grid sm:grid-cols-3 gap-3 items-end">
      <label className="block"><span className={lbl}>Date the shift started</span><input type="date" className={inp} value={date} onChange={e => e.target.value && setDate(e.target.value)}/></label>
      <button onClick={() => setShift('DAY')} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${shift === 'DAY' ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>☀ Day · 7:30 am – 7:30 pm</button>
      <button onClick={() => setShift('NIGHT')} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${shift === 'NIGHT' ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>🌙 Night · 7:30 pm – 7:30 am</button></div>
    <p className={`text-sm font-semibold ${notStarted || (!open && !isOwner) ? 'text-red-400' : 'text-slate-400'}`}>
      {notStarted ? 'This shift has not started yet.' : open ? `Entries open until ${fmt(w.deadline)}.` : isOwner ? `Entry window closed ${fmt(w.deadline)}. You can still edit as owner.` : `🔒 Locked. Entry closed ${fmt(w.deadline)}. Ask the owner to correct it.`}</p>
    {msg && <div className="rounded-xl bg-slate-800 px-4 py-3 text-amber-300 font-semibold">{msg}</div>}

    <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 space-y-3">
      <div className="flex flex-wrap gap-x-8 gap-y-1 text-xl"><span><b className="text-3xl text-amber-300">{total.toLocaleString('en-IN')}</b> rollers this shift</span><span className="text-slate-300">{done} of {machines.length} headers done</span></div>
      {sheet?.completed_at
        ? <div className="flex gap-3 items-center flex-wrap"><span className="text-green-400 text-xl font-bold">✔ Sheet complete · {fmt(sheet.completed_at)}</span>{canEdit && <button className={btn2} disabled={busy} onClick={() => complete(false)}>Reopen</button>}</div>
        : <div className="space-y-1"><button className={btn} disabled={busy || !allDone || !canEdit} onClick={() => complete(true)}>✔ Mark sheet complete</button>
            {!allDone && machines.length > 0 && <p className="text-slate-400 text-sm">Every header needs an entry or “Not running” first ({machines.length - done} left).</p>}</div>}</div>

    <div className="space-y-3">{machines.map(m => { const list = entries.filter(e => e.machine_id === m.id); const showForm = form?.machine === m.id;
      return (<div key={m.id} className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap"><span className="text-2xl font-extrabold">{mname(m.id)}</span>
          <span className={`rounded-lg px-2 py-0.5 text-sm font-extrabold ${list.length ? 'bg-green-600 text-white' : 'bg-amber-500 text-slate-950'}`}>{list.length ? '✔ entered' : 'nothing yet'}</span>
                   {canEdit && !showForm && nr !== m.id && <div className="ml-auto flex gap-2 flex-wrap"><button className={btn2} disabled={busy} onClick={() => openForm(m)}>＋ Add entry</button>{!list.length && <button className={btn2} disabled={busy} onClick={() => { setNr(m.id); setNrText(''); setForm(null); }}>Not running</button>}</div>}</div>
        {list.map(e => <div key={e.id} className="rounded-xl bg-slate-800 px-3 py-2 space-y-1">
                   {e.status === 'NOT_RUNNING' ? <div><div className="font-bold text-slate-300">Not running this shift</div>{e.note && <div className="text-amber-300 text-sm font-semibold">Reason: {e.note}</div>}</div>
                        : <><div className="flex items-center gap-2 flex-wrap"><span className="text-lg font-extrabold">{rollerLabel(factory, sizeOf.get(e.roller_id ?? '') ?? '—')}</span>{partyOf.get(e.roller_id ?? '') && <span className="text-slate-400 text-sm">{partyOf.get(e.roller_id ?? '')}</span>}<span className="text-slate-300">{e.operator_id ? opName.get(e.operator_id) ?? 'Operator' : 'No operator'}</span><span className="ml-auto text-xl font-extrabold text-amber-300">{e.rollers_forged.toLocaleString('en-IN')} rollers{e.weight_kg != null ? ` · ${Number(e.weight_kg).toLocaleString('en-IN')} kg` : ''}</span></div>
                            {(e.batch_no || e.heat_no) && <div className="text-slate-300 text-sm">Batch {e.batch_no ?? '—'} · Heat {e.heat_no ?? '—'}{e.rollers_per_kg != null ? ` · ${e.rollers_per_kg} rollers per kg` : ''}</div>}
              {(tools[e.id]?.length ?? 0) > 0 && <div className="text-slate-300">Tools used: {tools[e.id].map(x => `${tn(x.tool_type)}${x.dim_key ? ` (${x.dim_key})` : ''} × ${x.qty}`).join(' · ')}</div>}
              {Object.keys(e.short ?? {}).length > 0 && <div className="text-amber-300 text-sm font-semibold">⚠ Stock was short: {Object.entries(e.short).map(([k, q]) => `${tn(k)} (${q})`).join(', ')}</div>}
                            {e.note && <div className="text-slate-400 text-sm">Remarks: {e.note}</div>}</>}
          {canEdit && <div className="flex gap-2 flex-wrap pt-1">
            {e.status === 'RAN' && <button className={btn2} disabled={busy} onClick={() => openForm(m, e)}>Edit</button>}
            {del === e.id ? <><button className={btnRed} disabled={busy} onClick={() => remove(e.id)}>Yes, delete</button><button className={btn2} onClick={() => setDel('')}>Keep</button></> : <button className={btn2} onClick={() => setDel(e.id)}>Delete</button>}</div>}
        </div>)}
                {nr === m.id && <div className="rounded-xl bg-slate-800 p-3 space-y-3">
          <div className="text-lg font-bold">Why is {mname(m.id)} not running?</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{NR_REASONS.map(r => <button key={r} onClick={() => setNrText(r === 'Other' ? '' : r)} className={`min-h-12 rounded-xl border-2 text-lg font-bold ${nrText === r ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{r}</button>)}</div>
          <label className="block"><span className={lbl}>Remarks (tap a reason above, or type)</span><input className={inp} value={nrText} onChange={e => setNrText(e.target.value)}/></label>
          <div className="flex gap-2 flex-wrap"><button className={btn} disabled={busy || !nrText.trim()} onClick={() => notRunning(m, nrText)}>Save</button><button className={btn2} onClick={() => setNr(null)}>Cancel</button></div></div>}
        {showForm && form && <EntryForm key={form.init.id ?? 'new'} factory={factory} date={date} shift={shift} machine={m} rolls={rolls} ops={ops} init={form.init} onSaved={after} onCancel={() => setForm(null)} setMsg={setMsg} reloadOps={loadOps} reloadRolls={loadRolls}/>}
      </div>); })}
      {!machines.length && <p className="text-slate-500 text-center py-6">No header machines found for {factory}.</p>}</div>
  </div>);
}

// ---- Records: the sheet as a table for any month, with totals and header utilisation ----
function Records({ factory }: { factory: string }) {
  const now = ist(); const months = Array.from({ length: 24 }, (_, i) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); return { v: d.toISOString().slice(0, 10), t: d.toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }; });
  const [m, setM] = useState(months[0].v); const [view, setView] = useState<'tools' | 'table' | 'util'>('tools');
  const next = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)).toISOString().slice(0, 10);   // first day of the next month
  return (<div className="space-y-4">
    <h2 className="text-2xl font-bold">Shift records · {factory}</h2>
    <div className="grid sm:grid-cols-4 gap-3 items-end">
      <label className="block"><span className={lbl}>Month</span><select className={inp} value={m} onChange={e => setM(e.target.value)}>{months.map(x => <option key={x.v} value={x.v}>{x.t}</option>)}</select></label>
            <button onClick={() => setView('tools')} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${view === 'tools' ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>🔧 Tools used</button>
      <button onClick={() => setView('table')} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${view === 'table' ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>📋 Production table</button>
      <button onClick={() => setView('util')} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${view === 'util' ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>📊 Header utilisation</button></div>
            <SheetDownload factory={factory} from={m} to={next}/>
        {view === 'tools' ? <ToolsUsed factory={factory} from={m} to={next}/> : view === 'table' ? <ProductionTable factory={factory} from={m} to={next}/> : <UtilGrid factory={factory} from={m} to={next}/>}
  </div>);
}

export function ShiftSheet({ factory, isOwner }: { factory: string; isOwner: boolean }) {
  const [sub, setSub] = useState<'enter' | 'records' | 'rates'>('enter');
  const tabs: [typeof sub, string][] = [['enter', '📝 Enter sheet'], ['records', '📊 Records']];
  if (isOwner) tabs.push(['rates', '⚖ Rollers per kg']);
  return (<div className="space-y-4">
    <div className={`grid gap-2 ${isOwner ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2'}`}>{tabs.map(([v, l]) => <button key={v} onClick={() => setSub(v)} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${sub === v ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{l}</button>)}</div>
    {sub === 'enter' ? <EnterSheet factory={factory} isOwner={isOwner}/> : sub === 'records' ? <Records factory={factory}/> : <RollerRates factory={factory}/>}
  </div>);
}