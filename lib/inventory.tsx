'use client';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { supabase, rpc } from '@/lib/supabase';
import { uuid } from '@/lib/useOrders';
import { CheckLines } from '@/lib/checkView';
import { rollerLabel, sizeParty, mname, FACTORIES } from '@/lib/factories';
import { TOOL_LABEL, STOCK_ONLY_LABEL, OTHER_PREFIX, stockToolName, type RollerMaster, type InventoryStock, type InventoryLocation, type InventoryMove, type InventoryTakedown, type InventoryRequest, type HeaderMachine, type ToolType, type ToolingMaster, type DimCheck } from '@/types/database';
import { useVisibleInterval } from '@/lib/useVisibleInterval';
import { Err, enterTo, ring, Toast, useFormErrors, type Errs } from '@/lib/formErrors';

const inp = 'h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full';
const lbl = 'block text-sm font-semibold text-slate-300 mb-1';
const btn = 'min-h-14 px-6 rounded-xl bg-green-600 text-white text-xl font-bold disabled:opacity-50';
const btnRed = 'min-h-14 px-6 rounded-xl bg-red-600 text-white text-xl font-bold disabled:opacity-50';
const btn2 = 'min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold';
const tn = stockToolName;
const btnSm = (on: boolean) => `min-h-10 px-3 rounded-lg border-2 text-sm font-bold whitespace-nowrap ${on ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`;   // row buttons in the stock table
const cell = 'px-3 py-2 align-middle';
const detOf = (k: ToolingMaster) => k.tool_type === 'DIE_TOP' ? (k.batta_code ? `Batta ${k.batta_code}` : '')
  : k.tool_type === 'BOTTOM' || k.tool_type === 'FACING_PUNCH' ? `OD ${k.od_dim ?? '—'}`
  : k.od_dim != null || k.length_dim != null ? `OD ${k.od_dim ?? '—'} × L ${k.length_dim ?? '—'}` : '';
const Tag = ({ s }: { s: string }) => <span className={`rounded-lg px-2 py-0.5 text-sm font-extrabold text-white ${s === 'HARD' ? 'bg-green-600' : 'bg-slate-600'}`}>{s}</span>;
const num = (v: string) => Math.round(+v.replace(/,/g, '') || 0);
export const istDate = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
export const istHour = () => new Date(Date.now() + 330 * 60000).getUTCHours();
const tm = (t: string) => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
// Stock "added": received from a CNC order, added by hand (Add stock), or received from another factory
type Added = { roller_id: string; tool_type: string; dim_key: string; kind: string; reason: string | null; qty: number; created_at: string };
const ADD_KINDS = ['RECEIPT', 'OPENING', 'TRANSFER_IN'];
const addedHow = (a: Added) => a.kind === 'RECEIPT' ? 'Received from CNC order' : a.kind === 'OPENING' ? 'Added by hand' : `Received ${a.reason ? a.reason.toLowerCase() : 'from another factory'}`;

// ---- Move stock to a location ----
function Mover({ line, locs, def, label, onDone, setMsg }: { line: InventoryStock; locs: InventoryLocation[]; def?: string; label: string; onDone: () => void; setMsg: (m: string) => void }) {
  const [n, setN] = useState(String(line.qty)); const [to, setTo] = useState(def ?? ''); const [busy, setBusy] = useState(false);
  const { errs, fail, root, onFieldChange } = useFormErrors();
  if (!locs.length) return <p className="text-amber-300 font-semibold">Add a location first (tap “Locations” at the top).</p>;
  const go = async () => {
    const qty = num(n); const E: Errs = {};
    if (qty < 1 || qty > line.qty) E.qty = `Enter a number from 1 to ${line.qty}.`;
    if (!to) E.to = 'Choose a location.';
    else if (to === line.location_id) E.to = 'It is already in that location. Choose another one.';
    fail(E); if (Object.keys(E).length) return;
    setBusy(true);
    const base = { factory_id: line.factory_id, roller_id: line.roller_id, tool_type: line.tool_type, state: line.state, kind: 'MOVE', move_group: uuid(), dim_key: line.dim_key };
    const { error } = await supabase.from('inventory_moves').insert([{ ...base, qty: -qty, location_id: line.location_id }, { ...base, qty, location_id: to }]);
    setBusy(false);
    if (error) { fail({ form: `Could not save: ${error.message}` }); return; }
    setMsg(`Moved ${qty} pcs to ${locs.find(l => l.id === to)?.name}.`); onDone();
  };
  return (<div ref={root} onChange={onFieldChange} onKeyDown={enterTo(go, busy)} className="space-y-2"><div className="flex gap-2 flex-wrap items-start">
    <label className="block" data-k="qty"><span className={lbl}>How many</span><input inputMode="numeric" className={'h-14 w-28 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl text-right' + ring(errs, 'qty')} value={n} onChange={e => setN(e.target.value)}/><Err errs={errs} k="qty"/></label>
    <label className="block flex-1 min-w-[12rem]" data-k="to"><span className={lbl}>Location</span>
      <select className={inp + ring(errs, 'to')} value={to} onChange={e => setTo(e.target.value)}><option value="">Choose location</option>{locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select><Err errs={errs} k="to"/></label>
    <button className={btn + ' mt-6'} disabled={busy} onClick={go}>{label}</button></div><Err errs={errs} k="form"/></div>);
}

// ---- Mark hardened (soft -> hard) or take out of stock ----
const WHY = ['Damaged / scrapped in stock', 'Other'];   // tools used on a header are recorded on the Shift Sheet instead
function ActionForm({ line, type, onDone, setMsg }: { line: InventoryStock; type: 'harden' | 'out'; onDone: () => void; setMsg: (m: string) => void }) {
  const [n, setN] = useState(String(line.qty)); const [why, setWhy] = useState(WHY[0]); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const { errs, fail, root, onFieldChange } = useFormErrors();
  const go = async () => {
    const qty = num(n);
    if (qty < 1 || qty > line.qty) { fail({ qty: `Enter a number from 1 to ${line.qty}.` }); return; }
    fail({}); setBusy(true);
    const base = { factory_id: line.factory_id, roller_id: line.roller_id, tool_type: line.tool_type, location_id: line.location_id, dim_key: line.dim_key };
    const g = uuid();
    const rows: Partial<InventoryMove>[] = type === 'harden'
      ? [{ ...base, state: 'SOFT', qty: -qty, kind: 'HARDEN', move_group: g }, { ...base, state: 'HARD', qty, kind: 'HARDEN', move_group: g }]
      : [{ ...base, state: line.state, qty: -qty, kind: 'TAKE_OUT', reason: why, note: note.trim() || null }];
    const { error } = await supabase.from('inventory_moves').insert(rows);
    setBusy(false);
    if (error) { fail({ form: `Could not save: ${error.message}` }); return; }
    setMsg(type === 'harden' ? `Marked ${qty} × ${tn(line.tool_type)} as heat treated.` : `Took out ${qty} × ${tn(line.tool_type)} (${why.toLowerCase()}).`); onDone();
  };
  return (<div ref={root} onChange={onFieldChange} onKeyDown={enterTo(go, busy)} className="space-y-2"><div className="flex gap-2 flex-wrap items-start">
    <label className="block" data-k="qty"><span className={lbl}>How many</span><input inputMode="numeric" className={'h-14 w-28 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl text-right' + ring(errs, 'qty')} value={n} onChange={e => setN(e.target.value)}/><Err errs={errs} k="qty"/></label>
    {type === 'out' && <><label className="block flex-1 min-w-[12rem]"><span className={lbl}>Reason</span><select className={inp} value={why} onChange={e => setWhy(e.target.value)}>{WHY.map(w => <option key={w}>{w}</option>)}</select></label>
      <label className="block flex-1 min-w-[10rem]"><span className={lbl}>Note (optional)</span><input className={inp} value={note} onChange={e => setNote(e.target.value)}/></label></>}
    <button className={(type === 'out' ? btnRed : btn) + ' mt-6'} disabled={busy} onClick={go}>{type === 'harden' ? 'Mark as Heat Treated' : 'Take out'}</button></div><Err errs={errs} k="form"/></div>);
}

// ---- Size values for one tool type ----
type DimVals = { batta: string; od: string; len: string; od2: string; step: string };
const noDims: DimVals = { batta: '', od: '', len: '', od2: '', step: '' };
const dimsFrom = (m?: ToolingMaster): DimVals => ({ batta: m?.batta_code ?? '', od: m?.od_dim != null ? String(m.od_dim) : '', len: m?.length_dim != null ? String(m.length_dim) : '', od2: m?.od2_dim != null ? String(m.od2_dim) : '', step: m?.step_depth_dim != null ? String(m.step_depth_dim) : '' });
const dn = (s: string) => { const t = s.trim(); if (!t) return null; const x = Number(t); return Number.isFinite(x) && x >= 0 ? x : NaN; };   // empty = not applicable, NaN = not a number
// The tools offered in Add stock, in this order. The STOCK_ONLY ones have no size and are not used anywhere else yet.
const ADD_TOOLS = ['DIE_TOP', 'BOTTOM', 'FACING_PUNCH', 'SHORT_PIN', ...Object.keys(STOCK_ONLY_LABEL)];   // then one or more named "Other tool" rows (ids OTHER#0, OTHER#1, ...)
const typeOf = (row: string) => row.split('#')[0];
const cleanName = (v: string) => v.trim().replace(/\s+/g, ' ');
// Size boxes per tool: the same fields the database function dim_label uses to build the stock label
const dimFields = (tt: string): [keyof DimVals, string][] => tt === 'DIE_TOP' ? [['batta', 'Batta code']]
  : tt === 'BOTTOM' || tt === 'FACING_PUNCH' ? [['od', 'OD']]   // OD only (migration 43)
  : tt in STOCK_ONLY_LABEL ? [] : [['od', 'OD'], ['len', 'Length']];
const pcs = (v: string) => { const x = v.replace(/,/g, '').trim(); return x === '' ? 0 : /^\d+$/.test(x) ? +x : NaN; };   // blank = 0, NaN = not a whole number
const smBox = 'h-11 rounded-lg bg-slate-900 border-2 border-slate-700 px-2 text-lg w-full';

// ---- Add stock you already have (opening stock): every tool for one roller size in one go ----
function AddStock({ factory, rolls, master, locs, otherNames, onDone, onReload, setMsg }: { factory: string; rolls: RollerMaster[]; master: ToolingMaster[]; otherNames: string[]; onReload: () => void; locs: InventoryLocation[]; onDone: () => void; setMsg: (m: string) => void }) {
  const [f, setF] = useState(''); const [rid, setRid] = useState(''); const [loc, setLoc] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const [qty, setQty] = useState<Record<string, { soft: string; hard: string }>>({});
  const [dims, setDims] = useState<Record<string, DimVals>>({});
  const [nOther, setNOther] = useState(1); const [names, setNames] = useState<Record<string, string>>({});   // named "Other tool" rows
  const sameAs = (v: string) => otherNames.find(n => n.toLowerCase() === v.toLowerCase()) ?? v;   // "spring" joins the existing "Spring" stock line
  const rowIds = [...ADD_TOOLS, ...Array.from({ length: nOther }, (_, i) => `OTHER#${i}`)];
  const list = rolls.filter(r => !f.trim() || sizeParty(r).toLowerCase().includes(f.trim().toLowerCase())).sort((a, b) => sizeParty(a).localeCompare(sizeParty(b), undefined, { numeric: true }));
  const chosen = rid && list.some(r => r.id === rid) ? rid : list.length === 1 ? list[0].id : '';
  useEffect(() => { setDims(Object.fromEntries(ADD_TOOLS.map(t => [t, dimsFrom(master.find(x => x.roller_id === chosen && x.tool_type === t))]))); }, [chosen, master]);   // start from the roller's current values
  const [addingSize, setAddingSize] = useState(false); const [newSize, setNewSize] = useState(''); const [newParty, setNewParty] = useState('');
  const otherParties = newSize.trim() ? rolls.filter(r => r.roller_size.toLowerCase() === newSize.trim().toLowerCase()).map(r => r.party_name || 'no party name') : [];   // same size already there for these parties
  const { errs, fail, put, root, onFieldChange } = useFormErrors();
  const nFix = Object.keys(errs).filter(k => k !== 'form' && !k.startsWith('info:')).length;

  const q = (t: string, s: 'soft' | 'hard') => qty[t]?.[s] ?? '';
  const setQ = (t: string, s: 'soft' | 'hard', v: string) => setQty({ ...qty, [t]: { soft: q(t, 'soft'), hard: q(t, 'hard'), [s]: v } });
  const setDim = (t: string, k: keyof DimVals, v: string) => setDims({ ...dims, [t]: { ...(dims[t] ?? noDims), [k]: v } });
  const used = rowIds.filter(t => (pcs(q(t, 'soft')) || 0) > 0 || (pcs(q(t, 'hard')) || 0) > 0);
  const sumOf = (s: 'soft' | 'hard') => rowIds.reduce((a, t) => a + (pcs(q(t, s)) || 0), 0);
  const total = sumOf('soft') + sumOf('hard');

  const addSize = async () => {   // any roller size can be added, even if no tools were ever ordered for it
    const name = cleanName(newSize); const party = cleanName(newParty);
    const E: Errs = {};
    if (!name) E.newsize = 'Type the roller size.';
    if (!party) E.newparty = 'Type the party name. The same size can be for different parties.';
    fail(E); if (Object.keys(E).length) return;
    const have = rolls.find(r => r.roller_size.toLowerCase() === name.toLowerCase() && (r.party_name ?? '').toLowerCase() === party.toLowerCase());
    const close = () => { setNewSize(''); setNewParty(''); setAddingSize(false); setF(''); };
    if (have) { setRid(have.id); close(); put('info:roller', `“${sizeParty(have)}” is already in the list, so it is now selected.`); return; }
    const { data, error } = await supabase.from('roller_master').insert({ roller_size: name, party_name: party, factory_id: factory }).select('*').maybeSingle();
    if (error) { put('newsize', error.code === '23505' ? 'This size for this party already exists. Search for it in the list.' : `Could not add: ${error.message}`); return; }
    put('info:roller', `Added roller size “${name} · ${party}” and selected it.`); close(); onReload();
    if (data) setRid((data as unknown as RollerMaster).id);
  };
  const save = async () => {
    const E: Errs = {};   // every problem is shown at once, each next to its own box
    if (!chosen) E.roller = 'Choose a roller size.';
    rowIds.forEach(t => { if (Number.isNaN(pcs(q(t, 'soft'))) || Number.isNaN(pcs(q(t, 'hard')))) E[`qty:${t}`] = 'Whole numbers only.'; });
    const lines = used.map(t => { const d = dimFields(typeOf(t)).length ? dims[t] ?? noDims : noDims; return { t, d, nums: [d.od, d.len, d.od2, d.step].map(dn), name: typeOf(t) === 'OTHER' ? sameAs(cleanName(names[t] ?? '')) : '' }; });
    rowIds.forEach(t => { if (typeOf(t) === 'OTHER' && !used.includes(t) && cleanName(names[t] ?? '') && !E[`qty:${t}`]) E[`qty:${t}`] = 'Enter how many pieces of this tool.'; });
    lines.forEach(l => { if (typeOf(l.t) !== 'OTHER') return; if (!l.name) E[`name:${l.t}`] = 'Type the name of this tool.'; else if (l.name.length > 40) E[`name:${l.t}`] = 'Keep the name under 40 letters.'; });
    lines.forEach(l => { if (l.nums.some(x => Number.isNaN(x))) E[`dim:${l.t}`] = 'Sizes must be numbers. Leave a box empty if it does not apply.'; });
    if (!used.length && !Object.keys(E).some(k => k.startsWith('qty:'))) E.none = 'Enter how many pieces for at least one tool.';
    fail(E); if (Object.keys(E).length) return;
    setBusy(true);
    const labels = await Promise.all(lines.map(l => rpcData<string>('dim_label', { p_type: typeOf(l.t), p_batta: l.d.batta.trim() || null, p_od: l.nums[0], p_len: l.nums[1], p_od2: l.nums[2], p_step: l.nums[3] })));
    const bad = labels.find(x => x.error);
    if (bad) { fail({ form: `Could not save: ${bad.error?.message}` }); setBusy(false); return; }
    const g = uuid();   // one group for everything saved together
    const rows: Partial<InventoryMove>[] = lines.flatMap((l, i) => (['SOFT', 'HARD'] as const)
      .map(st => ({ st, n: pcs(q(l.t, st === 'SOFT' ? 'soft' : 'hard')) || 0 })).filter(x => x.n > 0)
      .map(x => ({ factory_id: factory, roller_id: chosen, tool_type: typeOf(l.t) === 'OTHER' ? OTHER_PREFIX + l.name : l.t, state: x.st, qty: x.n, location_id: loc || null, kind: 'OPENING', note: note.trim() || null, dim_key: labels[i].data ?? '', move_group: g })));
    const { error } = await supabase.from('inventory_moves').insert(rows);   // all lines or none
    setBusy(false);
    if (error) { fail({ form: `Could not save: ${error.message}` }); return; }
    setMsg(`Added ${total} pcs to ${rollerLabel(factory, sizeParty(rolls.find(r => r.id === chosen)))} (${used.length} ${used.length === 1 ? 'tool' : 'tools'}).`); setQty({}); setNames({}); setNOther(1); setNote(''); onDone();
  };

  const th = 'px-3 py-2 font-semibold';
  return (<section ref={root} onChange={onFieldChange} onKeyDown={enterTo(save, busy)} className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-4">
    <div><h3 className="text-xl font-bold">Add stock you already have</h3>
      <p className="text-slate-400 text-sm">For tools that are in the toolroom but were not received through the app. Fill in every tool you have for this roller size, then save once. Tools received through the app are added automatically.</p></div>
    <div className="grid sm:grid-cols-3 gap-3">
      <label className="block"><span className={lbl}>Find roller size or party</span><input className={inp} placeholder="Type to search" value={f} onChange={e => setF(e.target.value)}/></label>
      <div data-k="roller"><label className="block"><span className={lbl}>Roller size · Party</span><select className={inp + ring(errs, 'roller')} value={chosen} onChange={e => setRid(e.target.value)}><option value="">Choose roller size</option>{list.map(r => <option key={r.id} value={r.id}>{sizeParty(r)}</option>)}</select></label>
        <Err errs={errs} k="roller"/><Err errs={errs} k="info:roller" tone="info"/></div>
      <label className="block"><span className={lbl}>Location for all of these (optional)</span><select className={inp} value={loc} onChange={e => setLoc(e.target.value)}><option value="">Not placed yet</option>{locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      <div className="sm:col-span-3">{addingSize
        ? <div className="space-y-2" onKeyDown={enterTo(addSize)}><div className="flex gap-2 flex-wrap items-start"><label className="block flex-1 min-w-[12rem]" data-k="newsize"><span className={lbl}>New roller size</span><input className={inp + ring(errs, 'newsize')} placeholder="Type the new roller size" value={newSize} onChange={e => setNewSize(e.target.value)}/><Err errs={errs} k="newsize"/></label>
            <label className="block flex-1 min-w-[12rem]" data-k="newparty"><span className={lbl}>Party name</span><input list="party-names" className={inp + ring(errs, 'newparty')} placeholder="Type the party name" value={newParty} onChange={e => setNewParty(e.target.value)}/><Err errs={errs} k="newparty"/></label>
            <datalist id="party-names">{Array.from(new Set(rolls.map(r => r.party_name).filter((p): p is string => !!p))).sort().map(p => <option key={p} value={p}/>)}</datalist>
            <button className={btn + ' mt-6'} onClick={addSize}>Add size</button><button className={btn2 + ' mt-6'} onClick={() => { setAddingSize(false); setNewSize(''); setNewParty(''); fail({}); }}>Cancel</button></div>
            {otherParties.length > 0 && <p className="text-amber-300 text-sm font-semibold">This size is already in the list for: {otherParties.join(', ')}. Add it again only for a different party.</p>}</div>
        : <button className={btn2} onClick={() => setAddingSize(true)}>＋ Roller size not in the list? Add it</button>}</div></div>

    <div className="overflow-x-auto rounded-xl border border-slate-700"><table className="w-full text-left">
      <thead><tr className="bg-slate-800 text-sm text-slate-400"><th className={th}>Tool</th><th className={th}>Size</th><th className={th + ' text-right w-32'}>Soft pcs</th><th className={th + ' text-right w-32'}>Heat treated pcs</th></tr></thead>
      <tbody>{rowIds.map(t => { const on = used.includes(t); const isOther = typeOf(t) === 'OTHER'; const fields = dimFields(typeOf(t)); const d = dims[t] ?? noDims;
        return (<tr key={t} data-k={`qty:${t}`} className={`border-t border-slate-800 ${on ? 'bg-amber-400/10' : ''}`}>
          <td className="px-3 py-2 align-top">{isOther
            ? <div data-k={`name:${t}`} className="min-w-[12rem]"><label className="block"><span className="block text-xs font-semibold text-slate-400 mb-0.5">Other tool: name</span>
                <input list="other-tool-names" className={smBox + ring(errs, `name:${t}`)} placeholder="e.g. Spring" value={names[t] ?? ''} onChange={e => setNames({ ...names, [t]: e.target.value })}/></label>
                <Err errs={errs} k={`name:${t}`}/>
                {t !== 'OTHER#0' && t === `OTHER#${nOther - 1}` && <button className="min-h-9 text-sm font-bold text-red-400 underline" onClick={() => { setNOther(nOther - 1); const { [t]: _n, ...rn } = names; setNames(rn); const { [t]: _q, ...rq } = qty; setQty(rq); }}>Remove this row</button>}</div>
            : <div className="text-lg font-bold whitespace-nowrap pt-2">{tn(t)}</div>}<Err errs={errs} k={`qty:${t}`}/></td>
          <td className="px-3 py-2 align-top">{!fields.length ? <div className="pt-2.5 text-slate-500">No size needed</div>
            : on ? <div data-k={`dim:${t}`}><div className="flex gap-2 flex-wrap">{fields.map(([k, label]) => <label key={k} className={'block ' + (k === 'batta' ? 'w-40' : 'w-24')}><span className="block text-xs font-semibold text-slate-400 mb-0.5">{label}</span>
                <input inputMode={k === 'batta' ? 'text' : 'decimal'} aria-label={`${tn(t)} ${label}`} className={smBox + (errs[`dim:${t}`] && k !== 'batta' && Number.isNaN(dn(d[k])) ? ' !border-red-500' : '')} value={d[k]} onChange={e => setDim(t, k, e.target.value)}/></label>)}</div>
                <Err errs={errs} k={`dim:${t}`}/></div>
            : <div className="pt-2.5 text-slate-500 text-sm">{fields.filter(([k]) => d[k]).map(([k, label]) => `${label} ${d[k]}`).join(' · ') || 'Size not on file'}</div>}</td>
          {(['soft', 'hard'] as const).map(s => <td key={s} className="px-3 py-2 align-top"><input inputMode="numeric" aria-label={`${tn(t)} ${s === 'soft' ? 'soft' : 'heat treated'} pieces`} className={smBox + ' text-right' + (Number.isNaN(pcs(q(t, s))) ? ' !border-red-500' : '')} value={q(t, s)} onChange={e => setQ(t, s, e.target.value)}/></td>)}
        </tr>); })}
        <tr className="border-t border-slate-800"><td colSpan={4} className="px-3 py-2"><button className="min-h-10 px-4 rounded-lg border-2 border-slate-700 bg-slate-900 text-sm font-bold" onClick={() => setNOther(nOther + 1)}>＋ Another other tool</button>
          <datalist id="other-tool-names">{otherNames.map(n => <option key={n} value={n}/>)}</datalist></td></tr></tbody>
      <tfoot><tr className="border-t-2 border-slate-700 bg-slate-800 font-bold"><td className="px-3 py-2" colSpan={2}>Total {total > 0 ? `· ${total} pcs` : ''}</td><td className="px-3 py-2 text-right">{sumOf('soft') || ''}</td><td className="px-3 py-2 text-right">{sumOf('hard') || ''}</td></tr></tfoot>
    </table></div>

    <label className="block"><span className={lbl}>Note (optional)</span><input className={inp} value={note} onChange={e => setNote(e.target.value)}/></label>
    <Err errs={errs} k="none"/><Err errs={errs} k="form"/>
    {nFix > 0 && <div className="text-red-400 font-bold">⚠ Not saved yet. Please fix the {nFix} {nFix === 1 ? 'place' : 'places'} marked in red above.</div>}
    <div className="flex gap-2 flex-wrap"><button className={btn} disabled={busy} onClick={save}>{busy ? 'Saving…' : total > 0 ? `Save stock (${total} pcs)` : 'Save stock'}</button>
      {total > 0 && <button className={btn2} onClick={() => { setQty({}); fail({}); }}>Clear quantities</button>}</div></section>);
}

// ---- Locations ----
function Locs({ factory, locs, onDone, setMsg }: { factory: string; locs: InventoryLocation[]; onDone: () => void; setMsg: (m: string) => void }) {
  const [name, setName] = useState('');
  const { errs, fail, root, onFieldChange } = useFormErrors();
  const add = async () => {
    if (!name.trim()) { fail({ name: 'Type a location name.' }); return; }
    const { error } = await supabase.from('inventory_locations').insert({ factory_id: factory, name: name.trim() });
    if (error) { fail({ name: error.code === '23505' ? 'That location already exists.' : `Could not save: ${error.message}` }); return; }
    fail({}); setMsg(`Added location “${name.trim()}”.`); setName(''); onDone();
  };
  const hide = async (l: InventoryLocation) => {
    const { error } = await supabase.from('inventory_locations').update({ active: false }).eq('id', l.id);
    if (error) { fail({ [`loc:${l.id}`]: `Could not remove: ${error.message}` }); return; }
    fail({}); setMsg(`Removed “${l.name}” from the list.`); onDone();
  };
  return (<section ref={root} onChange={onFieldChange} className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-3">
    <h3 className="text-xl font-bold">Locations</h3>
    <p className="text-slate-400 text-sm">Name each almirah or cupboard once, for example “Almirah 2 – Shelf 3”. You will pick from this list.</p>
    <div className="flex gap-2 flex-wrap items-start" onKeyDown={enterTo(add)}><label className="block flex-1 min-w-[12rem]" data-k="name"><span className={lbl}>New location name</span><input className={inp + ring(errs, 'name')} value={name} onChange={e => setName(e.target.value)}/><Err errs={errs} k="name"/></label><button className={btn + ' mt-6'} onClick={add}>Add</button></div>
    <div className="divide-y divide-slate-800 rounded-xl border border-slate-800">{locs.map(l => <div key={l.id} className="px-3 py-2"><div className="flex items-center gap-3"><span className="text-lg font-semibold flex-1">{l.name}</span><button className={btn2} onClick={() => hide(l)}>Remove</button></div><Err errs={errs} k={`loc:${l.id}`}/></div>)}
      {!locs.length && <p className="p-3 text-slate-500">No locations yet.</p>}</div></section>);
}

// ---- History of changes ----
const KIND: Record<string, string> = { RECEIPT: 'Received', HARDEN: 'Heat treated', TAKE_OUT: 'Taken out', MOVE: 'Moved', OPENING: 'Added', CORRECTION: 'Corrected', RETURN: 'Returned', USED: 'Used', USED_UNDO: 'Used (undone)', TRANSFER_IN: 'Transferred in', TRANSFER_OUT: 'Transferred out' };
function History({ factory, sizeOf, locName }: { factory: string; sizeOf: Map<string, string>; locName: Map<string, string> }) {
    const [rows, setRows] = useState<InventoryMove[]>([]);
  const [chk, setChk] = useState<Record<string, { cnc_check: DimCheck | null; plant_check: DimCheck | null }>>({});
  useEffect(() => { (async () => {
    const { data } = await supabase.from('inventory_moves').select('*').eq('factory_id', factory).order('created_at', { ascending: false }).limit(150);
    const moves = (data ?? []) as unknown as InventoryMove[];
    setRows(moves);
    const ids = moves.filter(m => m.kind === 'RECEIPT' && m.delivery_id).map(m => m.delivery_id as string);   // dimension checks live on the delivery
    const out: Record<string, { cnc_check: DimCheck | null; plant_check: DimCheck | null }> = {};
    for (let i = 0; i < ids.length; i += 60) {
      const { data: dl } = await supabase.from('deliveries').select('id, cnc_check, plant_check').in('id', ids.slice(i, i + 60));
      ((dl ?? []) as unknown as { id: string; cnc_check: DimCheck | null; plant_check: DimCheck | null }[]).forEach(x => { out[x.id] = x; });
    }
    setChk(out);
  })(); }, [factory]);
  const shown = rows.filter(r => !((r.kind === 'HARDEN' || r.kind === 'MOVE') && r.qty < 0));   // show one line per harden / move
  return (<section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-2">
    <h3 className="text-xl font-bold">Recent changes</h3>
    {shown.map(r => <div key={r.id} className="rounded-xl bg-slate-800 px-3 py-2 flex items-center gap-2 flex-wrap">
      <span className="text-sm text-slate-400 w-32">{tm(r.created_at)}</span><b>{KIND[r.kind] ?? r.kind}</b>
      <span>{rollerLabel(factory, sizeOf.get(r.roller_id) ?? '—')} · {tn(r.tool_type)}</span><Tag s={r.state}/>
            {r.dim_key && <span className="text-slate-400 text-sm">{r.dim_key}</span>}
      {r.location_id && <span className="text-slate-400 text-sm">{locName.get(r.location_id) ?? ''}</span>}
      {(r.reason || r.note) && <span className="text-slate-400 text-sm">{[r.reason, r.note].filter(Boolean).join(' · ')}</span>}
      <span className={`ml-auto text-xl font-extrabold ${r.qty < 0 ? 'text-red-400' : 'text-green-400'}`}>{r.qty > 0 ? '+' : ''}{r.qty}</span>
      {r.delivery_id && chk[r.delivery_id] && <CheckLines d={chk[r.delivery_id]}/>}</div>)}
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
  const list = rolls.filter(r => !f.trim() || sizeParty(r).toLowerCase().includes(f.trim().toLowerCase())).sort((a, b) => sizeParty(a).localeCompare(sizeParty(b), undefined, { numeric: true }));
  const chosen = rid && list.some(r => r.id === rid) ? rid : list.length === 1 ? list[0].id : '';
  const pickMachine = (id: string) => { setMid(id); const cr = machines.find(m => m.id === id)?.current_roller_id; if (cr) { setF(''); setRid(cr); } };   // roller currently on that machine
  const { errs, fail, root, onFieldChange } = useFormErrors();
  const save = async () => {
    const E: Errs = {};
    if (!chosen) E.roller = 'Choose the roller size.';
    if (!date) E.date = 'Choose the date.';
    fail(E); if (Object.keys(E).length) return;
    setBusy(true);
    const { error } = await rpc('inventory_take_down', { p_factory: factory, p_roller: chosen, p_machine: mid, p_date: date, p_wire: wire, p_batta: batta, p_extra: extra, p_note: note, p_location: null, p_tools: [] });
    setBusy(false);
    if (error) { fail({ form: `Could not save: ${error.message}` }); return; }
    setMsg('Recorded.'); onDone();
  };
  return (<div className="space-y-4">
    <section ref={root} onChange={onFieldChange} onKeyDown={enterTo(save, busy)} className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-3">
      <h3 className="text-xl font-bold">Roller taken off the header machine</h3>
      <p className="text-slate-400 text-sm">This is the run notebook: wire size and batta details for a size. Tools used and rollers forged go on the Shift Sheet.</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block"><span className={lbl}>Header machine</span><select className={inp} value={mid} onChange={e => pickMachine(e.target.value)}><option value="">Choose machine</option>{machines.map(m => <option key={m.id} value={m.id}>{mname(m.id)}</option>)}</select></label>
        <label className="block" data-k="date"><span className={lbl}>Date taken down</span><input type="date" className={inp + ring(errs, 'date')} value={date} onChange={e => setDate(e.target.value)}/><Err errs={errs} k="date"/></label>
        <label className="block"><span className={lbl}>Find roller size or party</span><input className={inp} placeholder="Type to search" value={f} onChange={e => setF(e.target.value)}/></label>
        <label className="block" data-k="roller"><span className={lbl}>Roller size · Party</span><select className={inp + ring(errs, 'roller')} value={chosen} onChange={e => setRid(e.target.value)}><option value="">Choose roller size</option>{list.map(r => <option key={r.id} value={r.id}>{sizeParty(r)}</option>)}</select><Err errs={errs} k="roller"/></label>
        <label className="block"><span className={lbl}>Wire size</span><input className={inp} value={wire} onChange={e => setWire(e.target.value)}/></label>
        <label className="block"><span className={lbl}>Last batta number running</span><input className={inp} value={batta} onChange={e => setBatta(e.target.value)}/></label>
        <label className="block"><span className={lbl}>Extra batta available (optional)</span><input className={inp} value={extra} onChange={e => setExtra(e.target.value)}/></label>
        <label className="block"><span className={lbl}>Note (optional)</span><input className={inp} value={note} onChange={e => setNote(e.target.value)}/></label></div>
      <Err errs={errs} k="form"/>
      <button className={btn} disabled={busy} onClick={save}>Save record</button></section>
    {recent.length > 0 && <section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-2"><h3 className="text-xl font-bold">Recent records</h3>
      {recent.map(r => <div key={r.id} className="rounded-xl bg-slate-800 px-3 py-2"><b>{rollerLabel(factory, sizeParty(rolls.find(x => x.id === r.roller_id)))}</b> · {dd(r.taken_down_on)}{r.machine_id ? ` · ${mname(r.machine_id)}` : ''}{r.wire_size ? ` · Wire ${r.wire_size}` : ''}{r.last_batta ? ` · Batta ${r.last_batta}` : ''}{r.extra_batta ? ` + ${r.extra_batta}` : ''}</div>)}</section>}
  </div>);
}

// ---- Find a roller size in all factories, and ask for tools ----
type SearchRow = { factory_id: string; roller_size: string; party_name: string | null; tool_type: string; state: string; qty: number; location: string | null; last_move: string; dim_key: string };
const rpcData = <T,>(fn: string, args: object) => (supabase.rpc as unknown as (f: string, a: object) => Promise<{ data: T | null; error: { message: string } | null }>).call(supabase, fn, args);
const agoTxt = (t: string) => { const days = Math.floor((+new Date(istDate()) - +new Date(new Date(+new Date(t) + 330 * 60000).toISOString().slice(0, 10))) / 86400000); return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`; };
function OtherFactories({ factory, setMsg, onRequested }: { factory: string; setMsg: (m: string) => void; onRequested: () => void }) {
  const [q, setQ] = useState(''); const [rows, setRows] = useState<SearchRow[] | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [ask, setAsk] = useState(''); const [n, setN] = useState('1'); const [note, setNote] = useState(''); const [sending, setSending] = useState(false);
  const { errs, fail, root, onFieldChange } = useFormErrors();
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true); setErr(''); setAsk('');
    const { data, error } = await rpcData<SearchRow[]>('inventory_search', { p_size: q.trim() });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setRows(data ?? []);
  };
  const send = async (f: string, sz: string, tool: string, st: string, max: number, dim: string) => {
    const qty = num(n);
    if (qty < 1 || qty > max) { fail({ qty: `Enter a number from 1 to ${max}.` }); return; }
    fail({}); setSending(true);
    const one = (rows ?? []).find(r => sizeParty(r) === sz);   // sz is "size · party": send both separately
    const { error } = await rpc('inventory_request_create', { p_source: f, p_requester: factory, p_roller_size: one?.roller_size ?? sz, p_tool_type: tool, p_state: st, p_qty: qty, p_note: note, p_dim_key: dim, p_party: one?.party_name ?? null });
    setSending(false);
    if (error) { fail({ form: `Could not send: ${error.message}` }); return; }
    setMsg(`Request sent to ${f}.`); setAsk(''); setNote(''); onRequested();
  };
  const sizes = Array.from(new Set((rows ?? []).map(r => sizeParty(r)))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return (<div ref={root} onChange={onFieldChange} className="space-y-4">
    <section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-3">
      <h3 className="text-xl font-bold">Find a roller size in all factories</h3>
      <p className="text-slate-400 text-sm">Shows which factory has tools in stock. Tap “Request” to ask that factory for them. They will approve and move the tool, and you confirm when it arrives.</p>
      <div className="flex gap-2 flex-wrap items-end"><label className="block flex-1 min-w-[12rem]"><span className={lbl}>Roller size or party</span>
        <input className={inp} placeholder="Type roller size or party" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search(); }}/></label>
        <button className={btn} disabled={busy || !q.trim()} onClick={search}>Search</button></div>
      {err && <p className="text-red-400 font-semibold">{err}</p>}</section>
    {rows && sizes.map(sz => <section key={sz} className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-3"><h3 className="text-2xl font-extrabold">{sz}</h3>
      {FACTORIES.map(f => { const mine = rows.filter(r => sizeParty(r) === sz && r.factory_id === f); if (!mine.length) return null; const last = mine.map(r => r.last_move).sort().slice(-1)[0];
        const lines = Object.values(mine.reduce((a, r) => { const k = r.tool_type + '|' + r.state + '|' + r.dim_key; const g = (a[k] ??= { tool: r.tool_type, state: r.state, dim: r.dim_key, qty: 0, locs: [] as string[] }); g.qty += r.qty; if (r.location) g.locs.push(`${r.location} (${r.qty})`); return a; }, {} as Record<string, { tool: string; state: string; dim: string; qty: number; locs: string[] }>));
        return (<div key={f} className="rounded-xl bg-slate-800 p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap"><span className="text-xl font-extrabold">{f}</span>{f === factory && <span className="text-slate-400 text-sm">(your factory)</span>}<span className="ml-auto text-sm text-slate-400">last change {agoTxt(last)}</span></div>
          {lines.map(l => { const key = `${f}|${sz}|${l.tool}|${l.state}|${l.dim}`; return (<div key={key} className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap"><span className="text-lg">{tn(l.tool)}</span><Tag s={l.state}/>{l.dim && <span className="text-slate-400 text-sm">{l.dim}</span>}{l.locs.length > 0 && <span className="text-slate-400 text-sm">{l.locs.join(', ')}</span>}<span className="ml-auto text-xl font-extrabold">{l.qty} pcs</span>
              {f !== factory && <button className={btn2} onClick={() => { setAsk(ask === key ? '' : key); setN('1'); fail({}); }}>Request</button>}</div>
            {ask === key && <div className="space-y-2" onKeyDown={enterTo(() => send(f, sz, l.tool, l.state, l.qty, l.dim), sending)}><div className="flex gap-2 flex-wrap items-start">
              <label className="block" data-k="qty"><span className={lbl}>How many</span><input inputMode="numeric" className={'h-14 w-28 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl text-right' + ring(errs, 'qty')} value={n} onChange={e => setN(e.target.value)}/><Err errs={errs} k="qty"/></label>
              <label className="block flex-1 min-w-[10rem]"><span className={lbl}>Note (optional)</span><input className={inp} value={note} onChange={e => setNote(e.target.value)}/></label>
              <button className={btn + ' mt-6'} disabled={sending} onClick={() => send(f, sz, l.tool, l.state, l.qty, l.dim)}>Send request</button></div><Err errs={errs} k="form"/></div>}</div>); })}</div>); })}
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
  const total = pick.reduce((a, x) => a + x.qty, 0); const over = pick.find(x => x.qty > x.max); const bad = pick.some(x => x.qty < 0 || x.qty > x.max) || total < 1 || total > r.qty_requested;
  const why = over ? `Only ${over.max} available in ${over.location_id ? locName.get(over.location_id) ?? 'that location' : '“Not placed”'}.` : total > r.qty_requested ? `That is ${total}, more than the ${r.qty_requested} asked for.` : total < 1 ? 'Type how many you are taking from each place.' : '';
  const goMove = () => { if (!bad) onGo(pick.filter(x => x.qty > 0).map(x => ({ location_id: x.location_id, qty: x.qty }))); };
  return (<div className="space-y-2" onKeyDown={enterTo(goMove, busy)}><p className="text-slate-300 text-sm">Take the tools from where they are kept (up to {r.qty_requested} in total).</p>
    {lines.map(l => <div key={l.location_id ?? 'none'} className="flex items-center gap-3 flex-wrap rounded-xl bg-slate-800 px-3 py-2">
      <span className="flex-1 min-w-[8rem] font-semibold">{l.location_id ? locName.get(l.location_id) ?? 'Location' : 'Not placed'} <span className="text-slate-400 font-normal">({l.qty} available)</span></span>
      <input inputMode="numeric" aria-label="How many" className={'h-14 w-24 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl text-right' + (num(q[l.location_id ?? 'none'] ?? '') > l.qty ? ' !border-red-500' : '')} value={q[l.location_id ?? 'none'] ?? ''} onChange={e => setQ({ ...q, [l.location_id ?? 'none']: e.target.value })}/></div>)}
    {why && <div className="text-red-400 font-semibold text-sm">⚠ {why}</div>}
    <button className={btn} disabled={busy || bad} onClick={goMove}>Move tool ({total})</button></div>);
}

function ReqCard({ r, factory, stock, sizeOf, locName, reload, setMsg }: { r: InventoryRequest; factory: string; stock: InventoryStock[]; sizeOf: Map<string, string>; locName: Map<string, string>; reload: () => void; setMsg: (m: string) => void }) {
  const isSource = r.source_factory === factory; const [mode, setMode] = useState<'' | 'reject' | 'move' | 'no'>(''); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const { errs, fail } = useFormErrors();   // a failed action shows its message at the bottom of this card
  const act = async (fn: string, args: Record<string, unknown>, ok: string) => {
    setBusy(true); const { error } = await rpc(fn, args); setBusy(false);
    if (error) { fail({ form: `Could not save: ${error.message}` }); return; }
    fail({}); setMsg(ok); setMode(''); setText(''); reload();
  };
  const lines = stock.filter(x => sizeOf.get(x.roller_id) === sizeParty(r) &&x.tool_type === r.tool_type && x.state === r.state && x.dim_key === r.dim_key);
  const reason = (label: string, go: () => void, red: boolean) => (<div className="flex gap-2 flex-wrap items-end" onKeyDown={enterTo(go, busy)}>
    <label className="block flex-1 min-w-[12rem]"><span className={lbl}>Reason (optional)</span><input className={inp} value={text} onChange={e => setText(e.target.value)}/></label>
    <button className={red ? btnRed : btn} disabled={busy} onClick={go}>{label}</button></div>);
  return (<div className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-2">
    <div className="flex items-center gap-2 flex-wrap"><ReqTag r={r} src={isSource}/><span className="text-sm text-slate-400">{isSource ? `Request from ${r.requester_factory}` : `Request to ${r.source_factory}`}</span></div>
    <p className="text-xl font-bold">{reqHead(r, isSource)} <Tag s={r.state}/> · size {sizeParty(r)}</p>
    {r.dim_key && <p className="text-slate-300">{r.dim_key}</p>}
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
    <Err errs={errs} k="form"/>
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
      const dimsLoaded = useRef('');
    const [lastRun, setLastRun] = useState<Record<string, InventoryTakedown>>({});
  const [reqs, setReqs] = useState<InventoryRequest[]>([]); const [master, setMaster] = useState<ToolingMaster[]>([]);
  const [origin, setOrigin] = useState<Record<string, { kind: string; reason: string | null; created_at: string }>>({});
  const [added, setAdded] = useState<Added[]>([]);   // newest first
  const load = useCallback(async () => {
    if (!factory) return;
    const [s, r, l, m, g, td, rq, om, hm, ad] = await Promise.all([
      supabase.from('inventory_stock').select('*').eq('factory_id', factory),
      supabase.from('roller_master').select('*').eq('factory_id', factory),
      supabase.from('inventory_locations').select('*').eq('factory_id', factory).order('name'),
      supabase.from('inventory_moves').select('roller_id, location_id, created_at').eq('factory_id', factory).not('location_id', 'is', null).order('created_at', { ascending: false }).limit(500),
      supabase.from('inventory_settings').select('go_live').eq('id', 1).maybeSingle(),
      supabase.from('inventory_takedowns').select('*').eq('factory_id', factory).order('taken_down_on', { ascending: false }).order('created_at', { ascending: false }).limit(300),
      supabase.from('inventory_requests').select('*').or(`source_factory.eq.${factory},requester_factory.eq.${factory}`).order('requested_at', { ascending: false }).limit(100),
      supabase.from('inventory_moves').select('roller_id, tool_type, state, kind, reason, created_at').eq('factory_id', factory).is('location_id', null).gt('qty', 0).order('created_at', { ascending: false }).limit(200),
      supabase.from('header_machines').select('*').eq('factory_id', factory),
      supabase.from('inventory_moves').select('roller_id, tool_type, dim_key, kind, reason, qty, created_at').eq('factory_id', factory).in('kind', ADD_KINDS).gt('qty', 0).order('created_at', { ascending: false }).limit(2000)]);
    setAdded((ad.data ?? []) as unknown as Added[]);
    setStock((s.data ?? []) as unknown as InventoryStock[]); setRolls((r.data ?? []) as unknown as RollerMaster[]); setLocs((l.data ?? []) as unknown as InventoryLocation[]);
    const ll: Record<string, string> = {};
    ((m.data ?? []) as unknown as { roller_id: string; location_id: string }[]).forEach(x => { if (!ll[x.roller_id]) ll[x.roller_id] = x.location_id; });
    setLastLoc(ll); setGoLive((g.data as unknown as { go_live: string } | null)?.go_live ?? '');
    const lr: Record<string, InventoryTakedown> = {}; ((td.data ?? []) as unknown as InventoryTakedown[]).forEach(x => { if (!lr[x.roller_id]) lr[x.roller_id] = x; }); setLastRun(lr); setReqs((rq.data ?? []) as unknown as InventoryRequest[]);
    const og: Record<string, { kind: string; reason: string | null; created_at: string }> = {};
    ((om.data ?? []) as unknown as { roller_id: string; tool_type: string; state: string; kind: string; reason: string | null; created_at: string }[]).forEach(x => { const k = `${x.roller_id}|${x.tool_type}|${x.state}`; if (!og[k]) og[k] = x; });
    setOrigin(og); setHeads((hm.data ?? []) as unknown as HeaderMachine[]);
        if (dimsLoaded.current !== factory) {   // tool dimensions rarely change: fetch once per factory, not every minute    
    const tm: ToolingMaster[] = []; for (let i = 0; i < 20000; i += 1000) { const t = await supabase.from('tooling_master').select('*').range(i, i + 999); const d = (t.data ?? []) as unknown as ToolingMaster[]; tm.push(...d); if (d.length < 1000) break; }
    const dm: Record<string, string[]> = {}; tm.forEach(k => { const x = detOf(k); if (x) { const kk = `${k.roller_id}|${k.tool_type}`; if (!(dm[kk] ??= []).includes(x)) dm[kk].push(x); } });
    setDimMap(Object.fromEntries(Object.entries(dm).map(([k, v]) => [k, v.join(' / ')])));setMaster(tm);
          dimsLoaded.current = factory; }
  }, [factory]);
  useEffect(() => { setView(startView ?? 'stock'); setOp(null); setMsg(''); load(); }, [load, startView]);
  /* useEffect(() => { const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);   // picks up tools the plant has just received */
    useVisibleInterval(load, 60000);   // picks up tools the plant has just received
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(''), 5000); return () => clearTimeout(t); }, [msg]);   // messages fade away
  const go = (v: View) => { setView(v); setOp(null); setMsg(''); };
  const done = () => { setOp(null); load(); };

  const sizeOf = new Map(rolls.map(r => [r.id, sizeParty(r)])); /* "size · party" everywhere on this tab */ const act = locs.filter(l => l.active); const locName = new Map(locs.map(l => [l.id, l.name])); const runOn = (id: string) => heads.filter(h => h.current_roller_id === id).map(h => mname(h.id));
  const unplaced = stock.filter(x => !x.location_id);
  const lastAdd = new Map<string, Added>(); added.forEach(a => { const k = `${a.roller_id}|${a.tool_type}|${a.dim_key}`; if (!lastAdd.has(k)) lastAdd.set(k, a); });   // per tool + size
  const lastAddRoll = new Map<string, Added>(); added.forEach(a => { if (!lastAddRoll.has(a.roller_id)) lastAddRoll.set(a.roller_id, a); });
  const newest = added[0];
  const key = (x: InventoryStock) => `${x.roller_id}|${x.tool_type}|${x.state}|${x.location_id ?? ''}|${x.dim_key}`;
  const soft = stock.filter(x => x.state === 'SOFT').reduce((a, x) => a + x.qty, 0), hard = stock.filter(x => x.state === 'HARD').reduce((a, x) => a + x.qty, 0);
  const s = q.trim().toLowerCase();
  const stockGroups = Object.values(stock.reduce((a, x) => { (a[x.roller_id] ??= []).push(x); return a; }, {} as Record<string, InventoryStock[]>))
    .map(items => ({ id: items[0].roller_id, size: sizeOf.get(items[0].roller_id) ?? '—', items: items.sort((a, b) => a.tool_type.localeCompare(b.tool_type) || a.dim_key.localeCompare(b.dim_key) || a.state.localeCompare(b.state)) }))
    .filter(g => !s || g.size.toLowerCase().includes(s)).sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }));
  const extra = s ? Object.keys(lastRun).filter(id => !stock.some(x => x.roller_id === id) && (sizeOf.get(id) ?? '').toLowerCase().includes(s)).map(id => ({ id, size: sizeOf.get(id) ?? '—', items: [] as InventoryStock[] })) : [];   // rollers with a last-run note but no stock, shown when searching
  const groups = [...stockGroups, ...extra].sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }));
  const allOpen = groups.length > 0 && groups.every(g => open[g.id]);
  const reqNeeds = reqs.filter(r => needsAction(r, factory)).length;
  const nav: [View, string][] = [['stock', '📦 Stock'], ['add', '➕ Add stock'], ['down', '🔧 Off machine'], ['other', '🔎 Other factories'], ['req', `📨 Requests${reqNeeds ? ` (${reqNeeds})` : ''}`], ['locs', '📍 Locations'], ['hist', '🕘 History']];

  return (<div className="space-y-5">
    <h2 className="text-2xl font-bold">Inventory · {factory}</h2>
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">{nav.map(([v, t]) => <button key={v} onClick={() => go(v)} className={`min-h-14 rounded-xl border-2 text-lg font-bold ${view === v ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{t}</button>)}</div>
    <Toast msg={msg}/>
    {view === 'add' && <AddStock factory={factory} rolls={rolls} master={master} otherNames={Array.from(new Set(stock.filter(x => x.tool_type.startsWith(OTHER_PREFIX)).map(x => tn(x.tool_type)))).sort()} onReload={load} locs={act} onDone={() => { load(); go('stock'); }} setMsg={setMsg}/>}
    {view === 'down' && <TakeDown factory={factory} rolls={rolls} locs={act} onDone={() => { load(); go('stock'); }} setMsg={setMsg}/>}
    {view === 'other' && <OtherFactories factory={factory} setMsg={setMsg} onRequested={() => { setView('req'); load(); }}/>}
    {view === 'req' && <RequestsView factory={factory} reqs={reqs} stock={stock} sizeOf={sizeOf} locName={locName} reload={load} setMsg={setMsg}/>}
    {view === 'locs' && <Locs factory={factory} locs={act} onDone={done} setMsg={setMsg}/>}
    {view === 'hist' && <History factory={factory} sizeOf={sizeOf} locName={locName}/>}
    {view === 'stock' && <>
      {newest && <div className="rounded-xl border-2 border-slate-700 bg-slate-900 px-4 py-3 flex items-center gap-x-3 gap-y-1 flex-wrap">
        <span className="text-slate-400 font-semibold">Last added to stock</span>
        <span className="text-xl font-extrabold">{rollerLabel(factory, sizeOf.get(newest.roller_id) ?? '—')}</span>
        <span className="text-lg font-bold">{tn(newest.tool_type)}</span>
        {newest.dim_key && <span className="text-slate-300">{newest.dim_key}</span>}
        <span className="font-semibold">{newest.qty} pcs</span>
        <span className={`rounded-lg px-2 py-0.5 text-sm font-bold ${newest.kind === 'RECEIPT' ? 'bg-sky-700 text-white' : newest.kind === 'OPENING' ? 'bg-slate-600 text-white' : 'bg-violet-700 text-white'}`}>{addedHow(newest)}</span>
        <span className="ml-auto text-slate-300">{tm(newest.created_at)}</span></div>}
      <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 flex flex-wrap gap-x-8 gap-y-1 text-xl">
        <span><b className="text-3xl text-amber-300">{(soft + hard).toLocaleString('en-IN')}</b> pcs in stock</span><span className="text-slate-300">Soft {soft.toLocaleString('en-IN')}</span><span className="text-slate-300">Hard {hard.toLocaleString('en-IN')}</span></div>
      {unplaced.length > 0 && <section className="rounded-2xl border-2 border-amber-400 bg-slate-900 p-4 space-y-3">
        <h3 className="text-xl font-bold">📥 To put away ({unplaced.length})</h3>
        <p className="text-slate-400 text-sm">These have no location yet. Choose where you kept them.</p>
        {unplaced.map(l => <div key={key(l) + l.qty} className="rounded-xl bg-slate-800 p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap"><span className="text-xl font-extrabold">{rollerLabel(factory, sizeOf.get(l.roller_id) ?? '—')}</span><span className="text-lg">{tn(l.tool_type)}</span><Tag s={l.state}/><span className="ml-auto text-2xl font-extrabold text-amber-300">{l.qty} pcs</span></div>          {(l.dim_key || dimMap[`${l.roller_id}|${l.tool_type}`]) && <div className="text-sm text-slate-400">{l.dim_key || dimMap[`${l.roller_id}|${l.tool_type}`]}</div>}
          {origin[`${l.roller_id}|${l.tool_type}|${l.state}`]?.kind === 'TRANSFER_IN' && <p className="text-amber-300 text-sm font-semibold">📨 Received from {(origin[`${l.roller_id}|${l.tool_type}|${l.state}`].reason ?? '').replace(/^From /, '') || 'another factory'} · {tm(origin[`${l.roller_id}|${l.tool_type}|${l.state}`].created_at)}</p>}
          <Mover line={l} locs={act} def={act.some(a => a.id === lastLoc[l.roller_id]) ? lastLoc[l.roller_id] : undefined} label="Put away" onDone={done} setMsg={setMsg}/></div>)}</section>}
      <div className="flex gap-2 items-end flex-wrap"><label className="block flex-1 min-w-[12rem]"><span className={lbl}>Search roller size or party</span><input className={inp} placeholder="Type roller size or party" value={q} onChange={e => setQ(e.target.value)}/></label>
        <button className={btn2 + ' h-14'} onClick={() => setOpen(allOpen ? {} : Object.fromEntries(groups.map(g => [g.id, true])))}>{allOpen ? 'Collapse all' : 'Expand all'}</button>
        <button className={btn2 + ' h-14'} onClick={load}>↻</button></div>
      <div className="space-y-2">{groups.map(g => { const isOpen = !!open[g.id]; const gs = g.items.filter(x => x.state === 'SOFT').reduce((a, x) => a + x.qty, 0), gh = g.items.filter(x => x.state === 'HARD').reduce((a, x) => a + x.qty, 0);
        return (<div key={g.id} className="rounded-lg bg-slate-800">
          <button onClick={() => setOpen({ ...open, [g.id]: !isOpen })} aria-expanded={isOpen} className="w-full min-h-16 px-3 py-2 flex items-center gap-3 text-left">
                        <span className="text-xl font-extrabold">{rollerLabel(factory, g.size)}</span>{lastAddRoll.get(g.id) && <span className="text-sm text-slate-400">Last added {tm(lastAddRoll.get(g.id)!.created_at)}</span>}<span className="ml-auto text-sm text-slate-300">{g.items.length ? `Soft ${gs} · Hard ${gh}` : 'No stock'}</span><span>{isOpen ? '▲' : '▼'}</span></button>
          {isOpen && <div className="px-3 pb-3 space-y-2">{lastRun[g.id] && <RunNote r={lastRun[g.id]}/>}
            {g.items.length > 0 && <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-900"><table className="w-full text-left">
              <thead><tr className="bg-slate-800 text-sm text-slate-400"><th className={cell + ' font-semibold'}>Tool</th><th className={cell + ' font-semibold'}>Size</th><th className={cell + ' font-semibold'}>Condition</th><th className={cell + ' font-semibold'}>Location</th><th className={cell + ' font-semibold'}>Last added</th><th className={cell + ' font-semibold text-right'}>Pcs</th><th className={cell + ' font-semibold text-right'}>Actions</th></tr></thead>
              <tbody>{g.items.map((x, i) => { const k = key(x); const first = i === 0 || g.items[i - 1].tool_type !== x.tool_type; const sel = (t: 'move' | 'harden' | 'out') => setOp(op?.k === k && op.t === t ? null : { k, t }); const isOp = op?.k === k;
                return (<Fragment key={k}><tr className={`border-t ${first ? 'border-slate-700' : 'border-slate-800'} ${isOp ? 'bg-slate-800' : ''}`}>
                  <td className={cell + ' font-bold whitespace-nowrap'}><span className={first ? '' : 'sr-only'}>{tn(x.tool_type)}</span></td>
                  <td className={cell + ' text-slate-300'}>{x.dim_key || dimMap[`${x.roller_id}|${x.tool_type}`] || '—'}</td>
                  <td className={cell}><Tag s={x.state}/></td>
                  <td className={cell + (x.location_id ? ' text-slate-300' : ' text-amber-300 font-semibold')}>{x.location_id ? locName.get(x.location_id) ?? 'Location' : 'Not placed'}</td>
                  <td className={cell + ' text-sm text-slate-300 whitespace-nowrap'}>{(() => { const a = lastAdd.get(`${x.roller_id}|${x.tool_type}|${x.dim_key}`); return a ? <>{tm(a.created_at)}<span className="block text-xs text-slate-500">{a.kind === 'RECEIPT' ? 'CNC order' : a.kind === 'OPENING' ? 'By hand' : (a.reason ?? 'Other factory')}</span></> : '—'; })()}</td>
                  <td className={cell + ' text-right text-xl font-extrabold'}>{x.qty}</td>
                  <td className={cell}><div className="flex gap-1.5 justify-end">
                    {x.state === 'SOFT' && <button className={btnSm(isOp && op.t === 'harden')} onClick={() => sel('harden')}>Mark as Heat Treated</button>}
                    <button className={btnSm(isOp && op.t === 'out')} onClick={() => sel('out')}>Take out</button>
                    {x.location_id && <button className={btnSm(isOp && op.t === 'move')} onClick={() => sel('move')}>Move</button>}</div></td></tr>
                  {isOp && <tr className="bg-slate-800"><td colSpan={7} className="px-3 pb-3 pt-1">
                    {op.t === 'move' ? <Mover line={x} locs={act} label="Move" onDone={done} setMsg={setMsg}/> : <ActionForm line={x} type={op.t} onDone={done} setMsg={setMsg}/>}</td></tr>}
                </Fragment>); })}</tbody></table></div>}</div>}
        </div>); })}
        {!groups.length && <p className="text-slate-500 py-6 text-center">{stock.length ? 'No roller size matches your search.' : 'No stock yet. Tools appear here automatically when a plant confirms receipt of a batch, or use “Add stock” for tools you already have.'}</p>}</div>
      <p className="text-xs text-slate-500">Automatic stock starts from {goLive ? new Date(goLive).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : 'the go-live date'}. Batches received before that are not counted. Every tool received arrives as soft.</p>
    </>}
  </div>);
}
