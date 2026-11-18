'use client';
import { TOOL_LIFE, TRACKED, OUTCOME_LABEL, startRows, rowsFromUse, addRow, removeRow, outcomes, assigned, problem, toolPayload, kgOf, type Outcome, type TRow, type OnTool, type UseRow } from '@/lib/toolLife';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { rollerLabel, mname } from '@/lib/factories';
import { ProductionTable, UtilGrid } from '@/lib/production';
import { RollerRates } from '@/lib/rollerRates';
import { ToolsUsed } from '@/lib/toolsUsed';
import { ToolLifeReport } from '@/lib/toolLifeReport';
import { Err, enterTo, ring, Toast, useFormErrors, type Errs } from '@/lib/formErrors';
import { TOOL_LABEL, type ToolType,type InventoryStock,type ToolLife, type RollerMaster, type HeaderMachine, type HeaderOperator, type ShiftEntry, type ShiftTool, type ShiftSettings, type ShiftSheet as SheetRow } from '@/types/database';
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
type Init = { id?: string; picks?: Record<string, Record<string, string>>; toolRows?: Record<string, TRow[]>; roller?: string; operator?: string; tools?: Record<string, string>; note?: string; weight?: string; batch?: string; heat?: string; rate?: string };

// A numbered step of the entry form
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (<section className="rounded-xl bg-slate-900 p-3 sm:p-4 space-y-3">
    <h5 className="flex items-center gap-2 text-lg font-bold"><span className="w-8 h-8 shrink-0 rounded-full bg-amber-400 text-slate-950 flex items-center justify-center font-extrabold">{n}</span>{title}</h5>
    {children}</section>);
}
// Rows the simple tool view can show: one tool for the whole line, or an old tool taken off with 0 kg and one new tool
const simpleShape = (rs: TRow[]) => rs.length === 1 || (rs.length === 2 && !!rs[0].tool_id && kgOf(rs[0]) === 0 && rs[0].outcome !== 'ON' && !rs[1].tool_id);
const SIMPLE_OUT: [Outcome, string][] = [['ON', 'Still on'], ['WORN_OUT', 'Worn out'], ['REMOVED', 'Taken off (still usable)']];
const rLabel = (r: RollerMaster) => (r.party_name ? `${r.roller_size} · ${r.party_name}` : r.roller_size);
const lower = (v: string) => v.trim().toLowerCase();

// ---- One line: a header running one roller size ----
function EntryForm({ factory, date, shift, machine, rolls, ops, init, onSaved, onCancel, setMsg, reloadOps, reloadRolls }: {
  factory: string; date: string; shift: Shift; machine: HeaderMachine; rolls: RollerMaster[]; ops: HeaderOperator[]; init: Init;
  onSaved: () => void; onCancel: () => void; setMsg: (m: string) => void; reloadOps: () => void; reloadRolls: () => void }) {
  const [rtext, setRtext] = useState(() => { const r = rolls.find(x => x.id === init.roller); return r ? rLabel(r) : ''; }); const [op, setOp] = useState(init.operator ?? '');
  const [t, setT] = useState<Record<string, string>>(init.tools ?? {}); const [note, setNote] = useState(init.note ?? ''); const [wt, setWt] = useState(init.weight ?? '');
  const [batch, setBatch] = useState(init.batch ?? ''); const [heat, setHeat] = useState(init.heat ?? ''); const [rates, setRates] = useState<Record<string, number>>({});
  useEffect(() => { rpcData<{ roller_id: string; rollers_per_kg: number | null }[]>('roller_rates_list', { p_factory: factory }).then(({ data }) => { const m: Record<string, number> = {}; (data ?? []).forEach(x => { if (x.rollers_per_kg != null) m[x.roller_id] = Number(x.rollers_per_kg); }); setRates(m); }); }, [factory]);
  const [addingSize, setAddingSize] = useState(false); const [newSize, setNewSize] = useState('');
  const [adding, setAdding] = useState(false); const [newOp, setNewOp] = useState(''); const [busy, setBusy] = useState(false);
  const sorted = [...rolls].sort((a, b) => a.roller_size.localeCompare(b.roller_size, undefined, { numeric: true }));
  const exact = rolls.find(r => lower(rLabel(r)) === lower(rtext) || lower(r.roller_size) === lower(rtext));   // typed or picked from the list
  const matches = lower(rtext) ? sorted.filter(r => lower(rLabel(r)).includes(lower(rtext))) : [];
  const chosen = exact?.id ?? (matches.length === 1 ? matches[0].id : '');
  const chosenRoll = rolls.find(r => r.id === chosen);
    const rate = chosen && init.rate && chosen === init.roller ? Number(init.rate) : chosen ? rates[chosen] : undefined;   // an edited line keeps the rate it was entered with
  const kg = parseFloat(wt.replace(/,/g, '')); const calc = rate && kg > 0 ? Math.round(kg * rate) : null;
    const [stock, setStock] = useState<InventoryStock[]>([]); const [pk, setPk] = useState<Record<string, Record<string, string>>>(init.picks ?? {});
  useEffect(() => { if (!chosen) { setStock([]); return; } supabase.from('inventory_stock').select('*').eq('factory_id', factory).eq('roller_id', chosen).then(({ data }) => setStock((data ?? []) as unknown as InventoryStock[])); }, [factory, chosen]);
  // Sizes in stock for this roller and tool. An entry being edited gets back what it used, so that counts as available too.
  const sizes = (k: string): [string, number][] => { const a: Record<string, number> = {}; stock.filter(x => x.tool_type === k).forEach(x => { a[x.dim_key] = (a[x.dim_key] ?? 0) + Number(x.qty); });
    if (chosen === init.roller) Object.entries(init.picks?.[k] ?? {}).forEach(([d, q]) => { a[d] = (a[d] ?? 0) + num(q); });
    return Object.entries(a).filter(([, n]) => n > 0).sort(([x], [y]) => x.localeCompare(y)); };
const ambiguous = (k: string) => num(t[k] ?? '') > 0 && sizes(k).length > 1 && !(TOOL_LIFE && TRACKED.includes(k));   // only ask when there is a real choice
  const pv = (k: string, d: string) => pk[k]?.[d] ?? '';
  const setPv = (k: string, d: string, v: string) => setPk({ ...pk, [k]: { ...(pk[k] ?? {}), [d]: v } });
  const pickedSum = (k: string) => sizes(k).reduce((a, [d]) => a + num(pv(k, d)), 0);
  const need = (k: string) => Math.min(num(t[k] ?? ''), sizes(k).reduce((a, [, n]) => a + n, 0));   // stock that cannot cover the count is recorded as short
  
    // Tool life: the tools already on this machine, and the rows of this line (an edited line starts from what was saved)
  const [onTools, setOnTools] = useState<Record<string, OnTool>>({}); const [loadedOn, setLoadedOn] = useState(false);
  const [trows, setTrows] = useState<Record<string, TRow[]>>(init.toolRows ?? {});
  // Simple view (default): one tool takes the whole line weight; only its outcome (and size, if new) is chosen. 'detail' = the full editor.
  const [mode, setMode] = useState<Record<string, 'simple' | 'detail'>>(() => Object.fromEntries(TRACKED.map(tt => { const rs = init.toolRows?.[tt]; return [tt, !rs || simpleShape(rs) ? 'simple' : 'detail']; })));
  const [simp, setSimp] = useState<Record<string, { outcome: Outcome; dim: string | null }>>(() => Object.fromEntries(TRACKED.map(tt => { const rs = init.toolRows?.[tt]; const last = rs?.[rs.length - 1];
    return [tt, { outcome: last?.outcome ?? 'ON', dim: last && !last.tool_id ? last.dim_key : null }]; })));
  useEffect(() => { if (!TOOL_LIFE) return; setLoadedOn(false);
    supabase.from('tool_life').select('*').eq('factory_id', factory).eq('machine_id', machine.id).eq('status', 'ON').then(({ data }) => {
      const o: Record<string, OnTool> = {};
      ((data ?? []) as unknown as ToolLife[]).forEach(x => { o[x.tool_type] = { id: x.id, roller_id: x.roller_id, dim_key: x.dim_key, kg: Number(x.kg), rollers: Number(x.rollers) }; });
      setOnTools(o); setLoadedOn(true); }); }, [factory, machine.id]);
  useEffect(() => { if (!TOOL_LIFE || !loadedOn) return;
    setTrows(cur => { const n = { ...cur }; TRACKED.forEach(tt => { if (!n[tt]) n[tt] = startRows(onTools[tt]); }); return n; }); }, [loadedOn, onTools]);
    const setRows = (tt: string, r: TRow[]) => setTrows({ ...trows, [tt]: r });
  const setRow = (tt: string, i: number, patch: Partial<TRow>) => setRows(tt, (trows[tt] ?? []).map((r, j) => j === i ? { ...r, ...patch } : r));
  // Which tool the simple view is about. Editing: the tools this entry saved. New entry: the tool on the machine now.
  const simpleBase = (tt: string): { lead: TRow | null; mainId: string | null; otherSize: string | null } | null => {
    const rs = init.toolRows?.[tt];
    if (rs) return simpleShape(rs) ? { lead: rs.length === 2 ? rs[0] : null, mainId: rs[rs.length - 1].tool_id, otherSize: null } : null;
    if (!loadedOn) return null;
    const on = onTools[tt];
    if (!on) return { lead: null, mainId: null, otherSize: null };
    if (chosen && on.roller_id !== chosen)   // left on from another roller size: take it off with 0 kg, a new one goes on
      return { lead: { tool_id: on.id, dim_key: null, kg: '0', outcome: 'REMOVED' }, mainId: null, otherSize: rolls.find(r => r.id === on.roller_id)?.roller_size ?? 'another size' };
    return { lead: null, mainId: on.id, otherSize: null };
  };
  // The rows that are checked and saved for a tool type
  const effRows = (tt: string): TRow[] => {
    const b = mode[tt] === 'detail' ? null : simpleBase(tt);
    if (!b) return trows[tt] ?? [];
    const sp = simp[tt] ?? { outcome: 'ON' as Outcome, dim: null };
    const main: TRow = { tool_id: b.mainId, dim_key: b.mainId ? null : sp.dim, kg: kg > 0 ? String(kg) : '', outcome: sp.outcome };
    return b.lead ? [b.lead, main] : [main];
  };
  const toDetail = (tt: string) => { setTrows({ ...trows, [tt]: effRows(tt) }); setMode({ ...mode, [tt]: 'detail' }); };
    const addSize = async () => {   // any roller size can be entered, even if no tools were ever ordered for it
    const name = newSize.trim();
   if (!name) { put('newsize', 'Type the roller size.'); return; }
    const have = rolls.find(r => r.roller_size.toLowerCase() === name.toLowerCase());
    if (have) { setRtext(rLabel(have)); setAddingSize(false); setNewSize(''); put('info:roller', `“${have.roller_size}” is already in the list, so it is now selected.`); return; }
    const { data, error } = await supabase.from('roller_master').insert({ roller_size: name, factory_id: factory }).select('*').maybeSingle();
   if (error) { put('newsize', error.code === '23505' ? 'That roller size already exists. Search for it in the list.' : `Could not add: ${error.message}`); return; }
    put('info:roller', `Added roller size “${name}” and selected it.`); setNewSize(''); setAddingSize(false); reloadRolls();
    if (data) setRtext(name);
  };
  const addOp = async () => {
    if (!newOp.trim()) { put('newop', 'Type the operator’s name.'); return; }
    const { data, error } = await supabase.from('header_operators').insert({ factory_id: factory, name: newOp.trim() }).select('*').maybeSingle();
    if (error) { put('newop', error.code === '23505' ? 'That operator is already in the list.' : `Could not save: ${error.message}`); return; }
    put('info:op', `Added operator “${newOp.trim()}” and selected them.`); setNewOp(''); setAdding(false); reloadOps();
    if (data) setOp((data as unknown as HeaderOperator).id);
  };
    const { errs, fail, put, root, onFieldChange } = useFormErrors();
  const nFix = Object.keys(errs).filter(k => k !== 'form').length;
  const save = async () => {
    const E: Errs = {};   // every problem is collected, so all of them show at once, each next to its own box
    if (!chosen) E.roller = rtext.trim() && matches.length > 1 ? 'More than one size matches. Pick one from the list.' : rtext.trim() ? 'No roller size matches. Check it, or add it as a new size.' : 'Choose the roller size.';
    else if (!rate) E.roller = 'Rollers per kg is not set for this roller size. Ask the owner to set it.';
    if (!op) E.op = 'Choose the operator, or add a new one.';
    if (!(kg > 0)) E.weight = 'Enter the weight of the rollers forged, in kg.';
    if (!batch.trim()) E.batch = 'Enter the batch number.';
    if (!heat.trim()) E.heat = 'Enter the heat number.';
    const tools: Record<string, number> = {}; TOOLS.forEach(k => { if (TOOL_LIFE && TRACKED.includes(k)) return; const q = num(t[k] ?? ''); if (q > 0) tools[k] = q; });
    for (const k of TOOLS) {
      if (!ambiguous(k)) continue;
      const over = sizes(k).find(([d, n]) => num(pv(k, d)) > n);
      if (over) E[`pick:${k}`] = `Only ${over[1]} of that ${tn(k)} size in stock.`;
      else if (pickedSum(k) !== need(k)) E[`pick:${k}`] = `Choose which size of ${tn(k)} was used. The numbers must add up to ${need(k)}.`;
    }
    if (TOOL_LIFE && kg > 0) {
      for (const tt of TRACKED) {
        const rows = effRows(tt); const why = problem(tn(tt), rows, kg, onTools[tt], chosen);
        if (why) E[`tool:${tt}`] = why;
        else if (rows.some(r => !r.tool_id && r.dim_key === null && sizes(tt).length > 1)) E[`tool:${tt}`] = `Choose the size of the new ${tn(tt)}.`;
      }
    }
    if (Object.keys(E).length) { fail(E); return; }
    fail({});
    const picks: Record<string, { dim_key: string; qty: number }[]> = {};
    TOOLS.forEach(k => { if (ambiguous(k)) picks[k] = sizes(k).map(([d]) => ({ dim_key: d, qty: num(pv(k, d)) })).filter(x => x.qty > 0); });
    setBusy(true);
    const { data, error } = await rpcData<{ id: string; short: Record<string, number> }>('shift_entry_save', { p_id: init.id ?? null, p_factory: factory, p_date: date, p_shift: shift, p_machine: machine.id, p_status: 'RAN', p_roller: chosen, p_operator: op, p_rollers: null, p_tools: tools, p_note: note, p_weight: kg, p_batch: batch.trim(), p_heat: heat.trim(), p_picks: picks, p_toolrows: TOOL_LIFE ? TRACKED.flatMap(tt => toolPayload(tt, effRows(tt))) : null });
    setBusy(false);
        if (error) { fail({ form: `Could not save: ${error.message}` }); return; }
    const short = Object.entries(data?.short ?? {});
    setMsg(short.length ? `Saved. Stock was short for ${short.map(([k, q]) => `${tn(k)} (${q})`).join(', ')}. Please check your stock.` : 'Saved.');
    window.dispatchEvent(new Event('stock-check')); onSaved();
  };
  const opName = ops.find(o => o.id === op)?.name;
  const toolWords = TOOL_LIFE ? TRACKED.map(tt => { const rs = effRows(tt); const last = rs[rs.length - 1]; return last ? `${tn(tt)} ${rs.length > 1 && !simpleBase(tt)?.lead ? 'changed' : last.outcome === 'ON' ? (last.tool_id ? 'still on' : 'new, still on') : last.outcome === 'WORN_OUT' ? 'worn out' : 'taken off'}` : ''; }).filter(Boolean) : [];
  const summary = [mname(machine.id), chosenRoll ? chosenRoll.roller_size : 'no roller size yet', opName ?? 'no operator yet', kg > 0 ? `${kg} kg` : 'no weight yet'].join(' · ') + (calc != null ? ` = ${calc.toLocaleString('en-IN')} rollers` : '') + (toolWords.length ? ` · ${toolWords.join(' · ')}` : '');
  const others = TOOLS.filter(k => !(TOOL_LIFE && TRACKED.includes(k)));
  return (<div ref={root} onChange={onFieldChange} onKeyDown={enterTo(save, busy)} className="rounded-xl bg-slate-800 p-3 space-y-3">
    <h4 className="text-xl font-extrabold">{init.id ? 'Edit entry' : 'New entry'} · {mname(machine.id)}</h4>

    <Step n={1} title="What ran">
      <div className="grid sm:grid-cols-2 gap-3">
        <div data-k="roller"><label className="block"><span className={lbl}>Roller size</span>
          <input list={`sizes-${machine.id}`} className={inp + ring(errs, 'roller')} placeholder="Type to search, then pick" value={rtext} onChange={e => setRtext(e.target.value)}/></label>
          <datalist id={`sizes-${machine.id}`}>{sorted.map(r => <option key={r.id} value={rLabel(r)}/>)}</datalist>
          {chosenRoll ? <div className="mt-1 text-sm font-semibold text-green-400">✓ {rLabel(chosenRoll)}</div>
            : rtext.trim() && <div className="mt-1 text-sm text-amber-300">{matches.length > 1 ? `${matches.length} sizes match. Pick one from the list.` : 'No size matches.'}</div>}
          <Err errs={errs} k="roller"/><Err errs={errs} k="info:roller" tone="info"/>
          <button className="mt-1 text-amber-300 font-bold underline min-h-10" onClick={() => setAddingSize(!addingSize)}>+ New roller size</button></div>
        <div data-k="op"><label className="block"><span className={lbl}>Operator</span><select className={inp + ring(errs, 'op')} value={op} onChange={e => setOp(e.target.value)}><option value="">Choose operator</option>{ops.filter(o => o.active || o.id === op).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
          <Err errs={errs} k="op"/><Err errs={errs} k="info:op" tone="info"/>
          <button className="mt-1 text-amber-300 font-bold underline min-h-10" onClick={() => setAdding(!adding)}>+ New operator</button></div></div>
      {addingSize && <div className="flex gap-2 flex-wrap items-end" onKeyDown={enterTo(addSize)}><label className="block flex-1 min-w-[12rem]" data-k="newsize"><span className={lbl}>New roller size</span><input className={inp + ring(errs, 'newsize')} value={newSize} onChange={e => setNewSize(e.target.value)}/><Err errs={errs} k="newsize"/></label><button className={btn} onClick={addSize}>Add</button></div>}
      {adding && <div className="flex gap-2 flex-wrap items-end" onKeyDown={enterTo(addOp)}><label className="block flex-1 min-w-[12rem]" data-k="newop"><span className={lbl}>New operator’s name</span><input className={inp + ring(errs, 'newop')} value={newOp} onChange={e => setNewOp(e.target.value)}/><Err errs={errs} k="newop"/></label><button className={btn} onClick={addOp}>Add</button></div>}
    </Step>

    <Step n={2} title="How much">
      <div className="flex gap-4 flex-wrap items-end">
        <label className="block w-48" data-k="weight"><span className={lbl}>Weight forged (kg)</span><input inputMode="decimal" className={inp + ring(errs, 'weight')} value={wt} onChange={e => setWt(e.target.value)}/></label>
        <div className="pb-3 text-lg">{calc != null ? <><span className="text-slate-400">= </span><b className="text-2xl text-amber-300">{calc.toLocaleString('en-IN')}</b> rollers <span className="text-sm text-slate-400">({rate} per kg)</span></>
          : !chosen ? <span className="text-slate-400">Choose the roller size to see the roller count</span>
          : !rate ? <span className="font-bold text-red-400">Rollers per kg not set for this size. Ask the owner.</span>
          : <span className="text-slate-400">Enter the weight to see the roller count</span>}</div></div>
      <Err errs={errs} k="weight"/>
      <div className="grid grid-cols-2 gap-3 max-w-xl">
        <label className="block" data-k="batch"><span className={lbl}>Batch no.</span><input autoCapitalize="characters" className={inp + ring(errs, 'batch')} value={batch} onChange={e => setBatch(e.target.value)}/><Err errs={errs} k="batch"/></label>
        <label className="block" data-k="heat"><span className={lbl}>Heat no.</span><input autoCapitalize="characters" className={inp + ring(errs, 'heat')} value={heat} onChange={e => setHeat(e.target.value)}/><Err errs={errs} k="heat"/></label></div>
    </Step>

    <Step n={3} title="Tools">
      {TOOL_LIFE && TRACKED.map(tt => {
        const on = onTools[tt]; const rows = effRows(tt); const msg = kg > 0 ? problem(tn(tt), rows, kg, on, chosen) : ''; const done = kg > 0 && !msg;
        const b = mode[tt] === 'detail' ? null : simpleBase(tt); const sp = simp[tt] ?? { outcome: 'ON' as Outcome, dim: null };
        const sizePick = (val: string | null, set: (v: string | null) => void) => sizes(tt).length > 1
          ? <label className="block max-w-md"><span className={lbl}>Size of the new {tn(tt)}</span><select className={inp} value={val === null ? '__none' : val} onChange={e => set(e.target.value === '__none' ? null : e.target.value)}><option value="__none">Choose the size</option>{sizes(tt).map(([d, n]) => <option key={d} value={d}>{d || '(no size recorded)'} · {n} in stock</option>)}</select></label>
          : <div className="text-sm text-slate-400">Size: {val ?? (sizes(tt)[0] ? (sizes(tt)[0][0] || '(no size recorded)') : 'no stock recorded')}</div>;
        return (<div key={tt} data-k={`tool:${tt}`} className="rounded-xl border border-slate-700 p-3 space-y-3">
          <div className="flex items-center gap-2 flex-wrap"><div className="font-bold text-amber-300 text-lg">{tn(tt)}</div>
            {mode[tt] === 'detail' && <div className={`ml-auto font-bold ${done ? 'text-green-400' : 'text-slate-400'}`}>{done ? '✓ ' : ''}{assigned(rows)} of {kg > 0 ? kg : 0} kg given</div>}</div>

          {mode[tt] !== 'detail' && !b && <div className="text-slate-400">Loading the tools on this machine…</div>}
          {b && <>
            {b.lead && <div className="rounded-lg bg-amber-400/10 border border-amber-500 px-3 py-2 text-amber-300 font-semibold">The {tn(tt)} on this machine was for size {b.otherSize ?? 'another size'}. It will be taken off (still usable), and a new one put on.</div>}
            {b.mainId
              ? <div className="text-sky-400">{on && on.id === b.mainId ? `On this machine: ${on.dim_key || 'size not recorded'} · ${on.kg} kg and ${on.rollers.toLocaleString('en-IN')} rollers so far` : `The ${tn(tt)} that was on this machine`}</div>
              : <>{!b.lead && <div className="font-semibold">{init.toolRows?.[tt] ? `New ${tn(tt)} put on in this line` : `No ${tn(tt)} was on this machine, so a new one was put on.`}</div>}
                  {sizePick(sp.dim, v => setSimp({ ...simp, [tt]: { ...sp, dim: v } }))}</>}
            <div><div className={lbl}>At the end of this line, this {tn(tt)} is</div>
              <div className="flex gap-2 flex-wrap">{SIMPLE_OUT.map(([o, label]) => <button key={o} aria-pressed={sp.outcome === o} onClick={() => setSimp({ ...simp, [tt]: { ...sp, outcome: o } })}
                className={`min-h-12 px-5 rounded-xl border-2 text-lg font-bold ${sp.outcome === o ? (o === 'WORN_OUT' ? 'border-red-500 bg-red-600/20' : 'border-amber-400 bg-amber-400/20') : 'border-slate-700 bg-slate-900'}`}>{sp.outcome === o ? '✓ ' : ''}{label}</button>)}</div></div>
            <div className="text-sm text-slate-400">{kg > 0 ? `All ${kg} kg of this line is counted on this ${tn(tt)}.` : `The line weight is counted on this ${tn(tt)}.`}</div>
            <button className="text-sky-400 font-bold underline min-h-10" onClick={() => toDetail(tt)}>Changed the {tn(tt)} during this line? Enter each one ›</button>
          </>}

          {mode[tt] === 'detail' && <>
            {rows.map((r, i) => (<div key={i} className="rounded-lg bg-slate-800 p-3 space-y-2">
              {r.tool_id ? <div className="text-sky-400">Already on this machine{on && on.id === r.tool_id ? `: ${on.dim_key || 'size not recorded'} · ${on.kg} kg and ${on.rollers.toLocaleString('en-IN')} rollers so far` : ''}</div>
                : <div className="font-semibold">New {tn(tt)} put on</div>}
              {!r.tool_id && sizePick(r.dim_key, v => setRow(tt, i, { dim_key: v }))}
              <div className="grid grid-cols-2 gap-2">
                <label className="block"><span className={lbl}>kg forged with it</span><input inputMode="decimal" className={inp} value={r.kg} onChange={e => setRow(tt, i, { kg: e.target.value })}/></label>
                <label className="block"><span className={lbl}>What happened to it</span><select className={inp} value={r.outcome} onChange={e => setRow(tt, i, { outcome: e.target.value as Outcome })}>{outcomes(i, rows.length).map(o => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}</select></label></div>
              {!r.tool_id && rows.length > 1 && <button className="text-red-400 font-bold underline min-h-10" onClick={() => setRows(tt, removeRow(rows, i))}>Remove this tool</button>}
            </div>))}
            <div className="flex gap-3 flex-wrap items-center"><button className={btn2} onClick={() => setRows(tt, addRow(rows))}>＋ Another {tn(tt)} was put on</button>
              {(!init.toolRows?.[tt] || simpleShape(init.toolRows[tt])) && <button className="text-sky-400 font-bold underline min-h-10" onClick={() => setMode({ ...mode, [tt]: 'simple' })}>‹ Back to the simple view</button>}</div>
          </>}
          {msg && !errs[`tool:${tt}`] && <div className="text-red-400 text-sm font-semibold">{msg}</div>}
          <Err errs={errs} k={`tool:${tt}`}/>
        </div>);
      })}
      <div><div className="text-sm font-semibold text-slate-300 mb-1">{TOOL_LIFE ? 'Other tools worn out in this line' : 'Tools worn out in this line'}</div>
        <div className="flex gap-3 flex-wrap">{others.map(k => <label key={k} className="block w-36"><span className="block text-sm text-slate-400 mb-1">{tn(k)}</span><input inputMode="numeric" className={inp} placeholder="0" value={t[k] ?? ''} onChange={e => setT({ ...t, [k]: e.target.value })}/></label>)}</div></div>
      {TOOLS.filter(ambiguous).map(k => (<div key={k} data-k={`pick:${k}`} className="rounded-xl border border-slate-700 p-3 space-y-2">
        <div className="font-bold text-amber-300">Which size of {tn(k)} was used? <span className="font-normal text-slate-300">Chosen {pickedSum(k)} of {need(k)}</span></div>
        <Err errs={errs} k={`pick:${k}`}/>
        {sizes(k).map(([d, n]) => (<div key={d} className="flex items-center gap-2 flex-wrap">
          <span className="flex-1 min-w-[12rem]"><span className="block">{d || '(no size recorded)'}</span><span className="block text-sm text-slate-400">{n} in stock</span></span>
          <button className={btn2} onClick={() => setPv(k, d, String(Math.max(0, Math.min(n, need(k) - (pickedSum(k) - num(pv(k, d)))))))}>All</button>
          <input aria-label={`${tn(k)} ${d || 'size'} used`} inputMode="numeric" className={`${inp} !w-24`} value={pv(k, d)} onChange={e => setPv(k, d, e.target.value)}/></div>))}
      </div>))}
    </Step>

    <Step n={4} title="Remarks (optional)">
      <input aria-label="Remarks" className={inp} placeholder="Anything the owner should know" value={note} onChange={e => setNote(e.target.value)}/>
    </Step>

    <div className="rounded-xl border-2 border-slate-700 bg-slate-900 p-3 space-y-3">
      <div className="text-lg"><span className="text-slate-400">Check: </span><b>{summary}</b></div>
      <Err errs={errs} k="form"/>
      {nFix > 0 && <div className="text-red-400 font-bold">⚠ Not saved yet. Please fix the {nFix} {nFix === 1 ? 'box' : 'boxes'} marked in red above.</div>}
      <div className="flex gap-2 flex-wrap"><button className={btn} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save entry'}</button><button className={btn2} onClick={onCancel}>Cancel</button></div></div>
  </div>);
}

// ---- The Shift Sheet screen ----
function EnterSheet({ factory, isOwner }: { factory: string; isOwner: boolean }) {
  const d0 = defaultShift();
  const [date, setDate] = useState(d0.date); const [shift, setShift] = useState<Shift>(d0.shift);
  const [machines, setMachines] = useState<HeaderMachine[]>([]); const [rolls, setRolls] = useState<RollerMaster[]>([]); const [ops, setOps] = useState<HeaderOperator[]>([]);
  const [entries, setEntries] = useState<ShiftEntry[]>([]); const [tools, setTools] = useState<Record<string, ShiftTool[]>>({}); const [toolUse, setToolUse] = useState<Record<string, UseRow[]>>({});
  const [sheet, setSheet] = useState<SheetRow | null>(null); const [settings, setSettings] = useState<ShiftSettings>(FALLBACK);
  const [defs, setDefs] = useState<Record<string, { roller?: string; operator?: string }>>({});
    const [form, setForm] = useState<{ machine: string; init: Init } | null>(null); const [msg, setMsg] = useState(''); const [del, setDel] = useState(''); const [busy, setBusy] = useState(false); const [nr, setNr] = useState<string | null>(null); const [nrText, setNrText] = useState(''); const pe = useFormErrors();
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
    const tu: Record<string, UseRow[]> = {};
    if (TOOL_LIFE && ent.length) {
      const { data } = await supabase.from('shift_tool_use').select('*, tool:machine_tools(id, roller_id, dim_key, mounted_entry_id)').in('entry_id', ent.map(x => x.id)).order('seq');
      ((data ?? []) as unknown as UseRow[]).forEach(x => (tu[x.entry_id] ??= []).push(x));
    }
    setToolUse(tu);
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
    if (!reason.trim()) { pe.fail({ [`nr:${m.id}`]: 'Please tap a reason above, or type one.' }); return; }
    setBusy(true);
    const { error } = await rpcData('shift_entry_save', { p_id: null, p_factory: factory, p_date: date, p_shift: shift, p_machine: m.id, p_status: 'NOT_RUNNING', p_roller: null, p_operator: null, p_rollers: 0, p_tools: {}, p_note: reason.trim() });
    setBusy(false);
        if (error) { pe.fail({ [`nr:${m.id}`]: `Could not save: ${error.message}` }); return; }
    pe.fail({}); setNr(null); setNrText('');
    setMsg(`${mname(m.id)} marked not running.`); window.dispatchEvent(new Event('stock-check')); after();
  };
  const remove = async (id: string) => {
        pe.fail({}); setBusy(true); const { error } = await rpcData('shift_entry_delete', { p_id: id }); setBusy(false);
    if (error) { pe.fail({ [`del:${id}`]: `Could not delete: ${error.message}` }); return; }
    setMsg('Entry deleted. Any tools it used went back to stock.'); window.dispatchEvent(new Event('stock-check')); after();
  };
  const complete = async (yes: boolean) => {
    setBusy(true); const { error } = await rpcData('shift_sheet_complete', { p_factory: factory, p_date: date, p_shift: shift, p_complete: yes }); setBusy(false);
        if (error) { pe.fail({ sheet: `Could not save: ${error.message}` }); return; }
    pe.fail({}); setMsg(yes ? 'Shift sheet marked complete. Thank you.' : 'Shift sheet reopened.'); window.dispatchEvent(new Event('stock-check')); load();
  };
  
  const openForm = (m: HeaderMachine, e?: ShiftEntry) => setForm({ machine: m.id, init: e
  ? { id: e.id, roller: e.roller_id ?? undefined, operator: e.operator_id ?? undefined, weight: e.weight_kg != null ? String(e.weight_kg) : '', batch: e.batch_no ?? '', heat: e.heat_no ?? '', rate: e.rollers_per_kg != null ? String(e.rollers_per_kg) : undefined, note: e.note ?? '', tools: sumTools(tools[e.id]), picks: picksOf(tools[e.id]), toolRows: rowsFromUse(toolUse[e.id], e.id) }
  : { roller: m.current_roller_id ?? defs[m.id]?.roller, operator: defs[m.id]?.operator } });

  
  return (<div ref={pe.root} onChange={pe.onFieldChange} className="space-y-5">
    <h2 className="text-2xl font-bold">Shift Sheet · {factory}</h2>
    <div className="grid sm:grid-cols-3 gap-3 items-end">
      <label className="block"><span className={lbl}>Date the shift started</span><input type="date" className={inp} value={date} onChange={e => e.target.value && setDate(e.target.value)}/></label>
      <button onClick={() => setShift('DAY')} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${shift === 'DAY' ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>☀ Day · 7:30 am – 7:30 pm</button>
      <button onClick={() => setShift('NIGHT')} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${shift === 'NIGHT' ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>🌙 Night · 7:30 pm – 7:30 am</button></div>
    <p className={`text-sm font-semibold ${notStarted || (!open && !isOwner) ? 'text-red-400' : 'text-slate-400'}`}>
      {notStarted ? 'This shift has not started yet.' : open ? `Entries open until ${fmt(w.deadline)}.` : isOwner ? `Entry window closed ${fmt(w.deadline)}. You can still edit as owner.` : `🔒 Locked. Entry closed ${fmt(w.deadline)}. Ask the owner to correct it.`}</p>
    <Toast msg={msg} tone={msg.includes('Stock was short') ? 'warn' : undefined}/>

    <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 space-y-3">
      <div className="flex flex-wrap gap-x-8 gap-y-1 text-xl"><span><b className="text-3xl text-amber-300">{total.toLocaleString('en-IN')}</b> rollers this shift</span><span className="text-slate-300">{done} of {machines.length} headers done</span></div>
      {sheet?.completed_at
        ? <div className="flex gap-3 items-center flex-wrap"><span className="text-green-400 text-xl font-bold">✔ Sheet complete · {fmt(sheet.completed_at)}</span>{canEdit && <button className={btn2} disabled={busy} onClick={() => complete(false)}>Reopen</button>}</div>
        : <div className="space-y-1"><button className={btn} disabled={busy || !allDone || !canEdit} onClick={() => complete(true)}>✔ Mark sheet complete</button>
            {!allDone && machines.length > 0 && <p className="text-slate-400 text-sm">Every header needs an entry or “Not running” first ({machines.length - done} left).</p>}
            <Err errs={pe.errs} k="sheet"/></div>}</div>

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
                            {(toolUse[e.id]?.length ?? 0) > 0 && <div className="space-y-0.5">{toolUse[e.id].map(u => (<div key={u.tool_type + u.seq} className="text-sm text-sky-400">
                {tn(u.tool_type)}{u.tool?.dim_key ? ` (${u.tool.dim_key})` : ''}: {u.kg} kg{e.rollers_per_kg != null ? ` · ${Math.round(u.kg * e.rollers_per_kg).toLocaleString('en-IN')} rollers` : ''} · {OUTCOME_LABEL[u.outcome]}{u.tool && u.tool.mounted_entry_id !== e.id ? ' · continued from an earlier line' : ''}</div>))}</div>}
              {Object.keys(e.short ?? {}).length > 0 && <div className="text-amber-300 text-sm font-semibold">⚠ Stock was short: {Object.entries(e.short).map(([k, q]) => `${tn(k)} (${q})`).join(', ')}</div>}
                            {e.note && <div className="text-slate-400 text-sm">Remarks: {e.note}</div>}</>}
          {canEdit && <div className="flex gap-2 flex-wrap pt-1">
            {e.status === 'RAN' && <button className={btn2} disabled={busy} onClick={() => openForm(m, e)}>Edit</button>}
            {del === e.id ? <><button className={btnRed} disabled={busy} onClick={() => remove(e.id)}>Yes, delete</button><button className={btn2} onClick={() => setDel('')}>Keep</button></> : <button className={btn2} onClick={() => setDel(e.id)}>Delete</button>}</div>}
                      <Err errs={pe.errs} k={`del:${e.id}`}/>
        </div>)}
                {nr === m.id && <div className="rounded-xl bg-slate-800 p-3 space-y-3">
          <div className="text-lg font-bold">Why is {mname(m.id)} not running?</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{NR_REASONS.map(r => <button key={r} onClick={() => setNrText(r === 'Other' ? '' : r)} className={`min-h-12 rounded-xl border-2 text-lg font-bold ${nrText === r ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{r}</button>)}</div>
          <label className="block" data-k={`nr:${m.id}`} onKeyDown={enterTo(() => notRunning(m, nrText), busy)}><span className={lbl}>Remarks (tap a reason above, or type)</span><input className={inp + ring(pe.errs, `nr:${m.id}`)} value={nrText} onChange={e => setNrText(e.target.value)}/><Err errs={pe.errs} k={`nr:${m.id}`}/></label>
          <div className="flex gap-2 flex-wrap"><button className={btn} disabled={busy} onClick={() => notRunning(m, nrText)}>Save</button><button className={btn2} onClick={() => setNr(null)}>Cancel</button></div></div>}
        {showForm && form && <EntryForm key={form.init.id ?? 'new'} factory={factory} date={date} shift={shift} machine={m} rolls={rolls} ops={ops} init={form.init} onSaved={after} onCancel={() => setForm(null)} setMsg={setMsg} reloadOps={loadOps} reloadRolls={loadRolls}/>}
      </div>); })}
      {!machines.length && <p className="text-slate-500 text-center py-6">No header machines found for {factory}.</p>}</div>
  </div>);
}

// ---- Records: the sheet as a table for any month, with totals and header utilisation ----
function Records({ factory }: { factory: string }) {
  const now = ist(); const months = Array.from({ length: 24 }, (_, i) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); return { v: d.toISOString().slice(0, 10), t: d.toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }; });
  const [m, setM] = useState(months[0].v); const [view, setView] = useState<'tools' | 'table' | 'util' | 'life'>('tools');
  const next = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)).toISOString().slice(0, 10);   // first day of the next month
  return (<div className="space-y-4">
    <h2 className="text-2xl font-bold">Shift records · {factory}</h2>
    <div className={`grid ${TOOL_LIFE ? 'sm:grid-cols-5' : 'sm:grid-cols-4'} gap-3 items-end`}>
      <label className="block"><span className={lbl}>Month</span><select className={inp} value={m} onChange={e => setM(e.target.value)}>{months.map(x => <option key={x.v} value={x.v}>{x.t}</option>)}</select></label>
            <button onClick={() => setView('tools')} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${view === 'tools' ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>🔧 Tools used</button>
      <button onClick={() => setView('table')} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${view === 'table' ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>📋 Production table</button>
      <button onClick={() => setView('util')} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${view === 'util' ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>📊 Header utilisation</button>
      {TOOL_LIFE && <button onClick={() => setView('life')} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${view === 'life' ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>🛠 Tool life</button>}</div>
            <SheetDownload factory={factory} from={m} to={next}/>
        {view === 'life' && TOOL_LIFE ? <ToolLifeReport factory={factory} from={m} to={next}/> : view === 'tools' ? <ToolsUsed factory={factory} from={m} to={next}/> : view === 'table' ? <ProductionTable factory={factory} from={m} to={next}/> : <UtilGrid factory={factory} from={m} to={next}/>}
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