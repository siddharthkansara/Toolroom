'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { SEL, DSEL } from '@/lib/useOrders';
import { FACTORIES, sizeParty } from '@/lib/factories';
import { enterTo } from '@/lib/formErrors';
import { TOOL_LABEL, type ToolType, type OrderFull, type DeliveryFull, type RollerMaster, type InventoryStock } from '@/types/database';

// Tool Plan: tools needed for a roller schedule = rollers planned × (tools used ÷ rollers forged on the shift sheet, per size + party),
// minus tools in stock, minus tools already on order. Uses the same numbers as Shift Sheet → Records → Tools used (report_sizes), not tool life.
const TOOLS: ToolType[] = ['DIE_TOP', 'BOTTOM', 'FACING_PUNCH', 'SHORT_PIN'];
const LOW = 20000;   // fewer rollers than this in the window = low confidence
type SizeRow = { roller_id: string; roller_size: string; rollers: number; tool_type: string | null; tools: number };
type Cell = { need: number | null; have: number; onOrd: number; order: number | null; basis: 'size' | 'avg' | 'none'; low: boolean; rollers: number; zero: boolean };
type Res = { key: string; size: string; party: string; qty: number; exists: boolean; cells: Record<string, Cell> };
type Row = { id: string; text: string; qty: string };
const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dd = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const n0 = (n: number) => Math.round(n).toLocaleString('en-IN');
const low = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const newRow = (text = '', qty = ''): Row => ({ id: Math.random().toString(36).slice(2), text, qty });
const qtyOf = (s: string) => { const x = s.replace(/[,\s]/g, ''); return /^\d+$/.test(x) && +x > 0 ? +x : NaN; };
const rpcData = <T,>(fn: string, args: object) => (supabase.rpc as unknown as (f: string, a: object) => Promise<{ data: T | null; error: { message: string } | null }>).call(supabase, fn, args);
const inp = 'h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full';
const lbl = 'block text-sm font-semibold text-slate-300 mb-1';
const head = 'block text-sm font-semibold text-slate-300';   // column headings above the schedule lines
const chip = (on: boolean) => `min-h-12 px-5 rounded-xl border-2 text-lg font-bold ${on ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`;
const Step = ({ n, title, children }: { n: number; title: string; children: ReactNode }) => (
  <div className="space-y-3"><h3 className="text-lg font-bold"><span className="inline-flex items-center justify-center w-8 h-8 mr-2 rounded-full bg-amber-400 text-slate-950">{n}</span>{title}</h3>{children}</div>);

// One pasted line -> size, party (optional), quantity. Excel gives tabs: "size<TAB>qty" or "size<TAB>party<TAB>qty".
// Typed: "31309 100000", "31309 ABC Bearings 1,00,000", "31309, 100000".
const parseLine = (raw: string): { size: string; party: string; qty: number } | null => {
  const l = raw.trim(); if (!l) return null;
  let size = '', party = '', rest = '';
  if (l.includes('\t')) { const p = l.split('\t').map(x => x.trim()).filter(Boolean); if (p.length < 2) return null; size = p[0]; rest = p[p.length - 1]; party = p.slice(1, -1).join(' '); }
  else { const m = l.match(/^(\S+?)[,\s]+(?:(.*?)[,\s]+)?([\d,]+)$/); if (!m) return null; size = m[1]; party = m[2] ?? ''; rest = m[3]; }
  const qty = parseInt(rest.replace(/[^\d]/g, ''), 10);
  return size && qty > 0 ? { size, party: party.trim(), qty } : null;
};

// Which roller a typed line means. A bare size counts only when one party has it.
const resolve = (text: string, rolls: RollerMaster[]): { r?: RollerMaster; many?: number } => {
  const v = low(text); if (!v) return {};
  const ex = rolls.find(r => low(sizeParty(r)) === v); if (ex) return { r: ex };
  const bySize = rolls.filter(r => low(r.roller_size) === v);
  return bySize.length === 1 ? { r: bySize[0] } : bySize.length > 1 ? { many: bySize.length } : {};
};

export function ToolPlanner({ fsel }: { fsel?: string | null }) {
  const [tf, setTf] = useState<string>(fsel || 'NIC'); const fac = fsel || tf;
  const [rolls, setRolls] = useState<RollerMaster[]>([]);
  const [rows, setRows] = useState<Row[]>(() => [newRow()]);
  const [pasting, setPasting] = useState(false); const [paste, setPaste] = useState(''); const [pasteMsg, setPasteMsg] = useState('');
  const [months, setMonths] = useState(3); const [buf, setBuf] = useState('0');
  const [res, setRes] = useState<Res[] | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [rowErr, setRowErr] = useState<Record<string, string>>({}); const [basis, setBasis] = useState('');

  useEffect(() => { setRes(null); supabase.from('roller_master').select('*').eq('factory_id', fac).then(({ data }) => setRolls((data ?? []) as unknown as RollerMaster[])); }, [fac]);
  const sorted = [...rolls].sort((a, b) => sizeParty(a).localeCompare(sizeParty(b), undefined, { numeric: true }));

  const setRow = (id: string, k: 'text' | 'qty', v: string) => { setRows(rows.map(r => r.id === id ? { ...r, [k]: v } : r)); if (rowErr[id]) { const { [id]: _x, ...rest } = rowErr; setRowErr(rest); } };
  const removeRow = (id: string) => setRows(rows.length > 1 ? rows.filter(r => r.id !== id) : [newRow()]);

  const addPasted = () => {
    const lines = paste.split('\n').filter(l => l.trim()); const got = lines.map(parseLine);
    const ok = got.filter((x): x is NonNullable<typeof x> => !!x);
    const bad = lines.filter((_, i) => !got[i]);
    if (!ok.length) { setPasteMsg('Could not read any line. Each line needs a roller size and a quantity.'); return; }
    setRows([...rows.filter(r => r.text.trim() || r.qty.trim()), ...ok.map(x => newRow(x.party ? `${x.size} · ${x.party}` : x.size, String(x.qty)))]);
    setPaste(''); setPasting(false); setRes(null);
    setPasteMsg(bad.length ? `Added ${ok.length} lines. Could not read ${bad.length}: ${bad.slice(0, 3).join(' | ')}${bad.length > 3 ? ' …' : ''}` : '');
  };

  const calc = async () => {
    const E: Record<string, string> = {}; const sched: Record<string, { size: string; party: string; qty: number; roller?: RollerMaster }> = {};
    rows.forEach(r => {
      if (!r.text.trim() && !r.qty.trim()) return;   // empty row: ignored
      const q = qtyOf(r.qty); const { r: roller, many } = resolve(r.text, rolls);
      if (!r.text.trim()) E[r.id] = 'Choose the roller size.';
      else if (many) E[r.id] = `${many} parties have this size. Pick the party from the list.`;
      else if (Number.isNaN(q)) E[r.id] = 'Type how many rollers (a whole number).';
      if (E[r.id]) return;
      const k = roller ? roller.id : 'new:' + low(r.text);   // the same size + party typed twice is added together
      (sched[k] ??= { size: roller?.roller_size ?? r.text.trim(), party: roller?.party_name ?? '', qty: 0, roller }).qty += q;
    });
    setRowErr(E);
    if (Object.keys(E).length) { setErr('Please fix the lines marked in red.'); setRes(null); return; }
    if (!Object.keys(sched).length) { setErr('Add at least one roller size and how many rollers you plan to make.'); setRes(null); return; }
    setBusy(true); setErr('');
    const from = new Date(); from.setMonth(from.getMonth() - months); const to = new Date(Date.now() + 86400000);
    const [z, st, od, dv] = await Promise.all([
      rpcData<SizeRow[]>('report_sizes', { p_from: ymd(from), p_to: ymd(to), p_factory: fac }),
      supabase.from('inventory_stock').select('*').eq('factory_id', fac),
      supabase.from('tool_orders').select(SEL).eq('factory_id', fac).neq('status', 'CLOSED').limit(1000),
      supabase.from('deliveries').select(DSEL).eq('factory_id', fac).eq('status', 'READY').limit(1000)]);
    setBusy(false);
    if (z.error) { setErr(z.error.message); return; }

    // usage from the shift sheet, per roller (size + party); the factory average is the fallback
    const rate = new Map<string, { rollers: number; tools: Record<string, number> }>(); let fbRollers = 0; const fbTools: Record<string, number> = {};
    (z.data ?? []).forEach(r => { let e = rate.get(r.roller_id); if (!e) { e = { rollers: r.rollers, tools: {} }; rate.set(r.roller_id, e); fbRollers += r.rollers; }
      if (r.tool_type) { e.tools[r.tool_type] = (e.tools[r.tool_type] ?? 0) + r.tools; fbTools[r.tool_type] = (fbTools[r.tool_type] ?? 0) + r.tools; } });
    // stock in hand (soft + heat treated)
    const have: Record<string, number> = {};
    ((st.data ?? []) as unknown as InventoryStock[]).forEach(s => { const k = `${s.roller_id}|${s.tool_type}`; have[k] = (have[k] ?? 0) + s.qty; });
    // coming: still to be made at the CNC + made but not yet received
    const onOrder: Record<string, number> = {};
    const add = (rid: string | null | undefined, tool: string | undefined, q: number) => { if (!rid || !tool || q <= 0) return; const k = `${rid}|${tool}`; onOrder[k] = (onOrder[k] ?? 0) + q; };
    ((od.data ?? []) as unknown as OrderFull[]).forEach(o => add(o.roller_id, o.tooling?.tool_type, o.quantity - (o.qty_made ?? 0)));
    ((dv.data ?? []) as unknown as DeliveryFull[]).forEach(d => add(d.ord?.roller_id, d.ord?.tooling?.tool_type, d.qty_made));

    const b = Math.max(0, +buf || 0);
    setBasis(`Based on shift sheet history from ${dd(from)} to ${dd(new Date())}${b ? ` · plus ${b}% extra safety` : ''} · ${fac}`);
    setRes(Object.entries(sched).map(([key, s]) => {
      const rid = s.roller?.id ?? ''; const r = rid ? rate.get(rid) : undefined; const cells: Record<string, Cell> = {};
      TOOLS.forEach(t => {
        const h = have[`${rid}|${t}`] ?? 0; const oo = onOrder[`${rid}|${t}`] ?? 0;
        let basisT: Cell['basis'] = 'none'; let per = 0; let rollers = 0; let zero = false;
        if (r && r.rollers > 0) { basisT = 'size'; per = (r.tools[t] ?? 0) / r.rollers; rollers = r.rollers; zero = (r.tools[t] ?? 0) === 0; }
        else if (fbRollers > 0) { basisT = 'avg'; per = (fbTools[t] ?? 0) / fbRollers; rollers = fbRollers; }
        const need = basisT === 'none' ? null : Math.ceil(s.qty * per * (1 + b / 100) - 1e-9);
        cells[t] = { need, have: h, onOrd: oo, order: need == null ? null : Math.max(0, need - h - oo), basis: basisT, low: basisT === 'size' && rollers < LOW, rollers, zero };
      });
      return { key, size: s.size, party: s.party, qty: s.qty, exists: !!s.roller, cells };
    }));
  };

  const csv = () => {
    if (!res) return; const out = [['Roller size', 'Party', 'Planned rollers', 'Tool', 'Needed', 'In stock', 'Coming (on order)', 'To order']];
    res.forEach(r => TOOLS.forEach(t => { const c = r.cells[t]; out.push([r.size, r.party, String(r.qty), TOOL_LABEL[t], String(c.need ?? ''), String(c.have), String(c.onOrd), String(c.order ?? '')]); }));
    const blob = new Blob(['﻿' + out.map(r => r.map(x => `"${x.replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `tool-plan-${fac}.csv`; a.click();
  };

  const total = (t: string) => (res ?? []).reduce((a, r) => a + (r.cells[t].order ?? 0), 0);
  const bufChoices = ['0', '10', '20'];

  return (<section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-6">
    <div><h2 className="text-xl font-bold">Tool Plan</h2>
      <p className="text-sm text-slate-400">Tell it what you plan to make. It works out how many tools you will need and how many to order.</p></div>
    {!fsel && <div className="flex gap-2 flex-wrap">{FACTORIES.map(f => <button key={f} onClick={() => setTf(f)} className={chip(fac === f)}>{f}</button>)}</div>}

    <Step n={1} title="What do you plan to make?">
      <datalist id="plan-sizes">{sorted.map(r => <option key={r.id} value={sizeParty(r)}/>)}</datalist>
      <div className="space-y-2" onKeyDown={enterTo(calc, busy)}>
        <div className="hidden sm:grid grid-cols-[1fr_12rem_3.5rem] gap-2"><span className={head}>Roller size · Party</span><span className={head}>Rollers to make</span><span/></div>
        {rows.map(r => { const { r: roller } = resolve(r.text, rolls); return (<div key={r.id}>
          <div className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_12rem_3.5rem] gap-2 items-start">
            <label className="block col-span-2 sm:col-span-1"><span className={lbl + ' sm:sr-only'}>Roller size · Party</span>
              <input list="plan-sizes" className={inp + (rowErr[r.id] ? ' !border-red-500' : '')} placeholder="Type to search, then pick" value={r.text} onChange={e => setRow(r.id, 'text', e.target.value)}/></label>
            <label className="block"><span className={lbl + ' sm:sr-only'}>Rollers to make</span>
              <input inputMode="numeric" className={inp + ' text-right'} placeholder="e.g. 1,00,000" value={r.qty} onChange={e => setRow(r.id, 'qty', e.target.value)}/></label>
            <button aria-label="Remove this line" title="Remove this line" className="h-14 w-14 self-end rounded-xl border-2 border-slate-700 bg-slate-900 text-xl font-bold" onClick={() => removeRow(r.id)}>✖</button></div>
          {rowErr[r.id] ? <div className="mt-1 text-sm font-semibold text-red-400">⚠ {rowErr[r.id]}</div>
            : roller && low(r.text) !== low(sizeParty(roller)) ? <div className="mt-1 text-sm font-semibold text-green-400">✓ {sizeParty(roller)}</div>
            : r.text.trim() && !roller && !resolve(r.text, rolls).many ? <div className="mt-1 text-sm text-amber-300">Not in the roller list: it will be estimated from the factory average.</div> : null}</div>); })}
      </div>
      <div className="flex gap-2 flex-wrap">
        <button className={chip(false)} onClick={() => setRows([...rows, newRow()])}>＋ Add another size</button>
        <button className={chip(pasting)} onClick={() => { setPasting(!pasting); setPasteMsg(''); }}>📋 Paste a list from Excel</button></div>
      {pasting && <div className="rounded-xl border-2 border-slate-700 p-3 space-y-2">
        <label className="block"><span className={lbl}>Paste here: one line per size. Columns: roller size, party (optional), quantity</span>
          <textarea rows={5} className="rounded-xl bg-slate-900 border-2 border-slate-700 px-3 py-2 text-lg w-full" placeholder={'31309\tABC Bearings\t100000\n31310\t250000'} value={paste} onChange={e => setPaste(e.target.value)}/></label>
        <div className="flex gap-2 flex-wrap"><button className="min-h-12 px-5 rounded-xl bg-green-600 text-white text-lg font-bold" onClick={addPasted}>Add these lines</button>
          <button className={chip(false)} onClick={() => { setPasting(false); setPaste(''); }}>Cancel</button></div></div>}
      {pasteMsg && <p className="text-amber-300 text-sm font-semibold">{pasteMsg}</p>}
    </Step>

    <Step n={2} title="Settings">
      <div className="space-y-3">
        <div><span className={lbl}>Use shift sheet history of</span><div className="flex gap-2 flex-wrap">{[3, 6, 12].map(m => <button key={m} className={chip(months === m)} onClick={() => setMonths(m)}>Last {m} months</button>)}</div></div>
        <div><span className={lbl}>Extra safety (more tools, in case usage is higher)</span><div className="flex gap-2 flex-wrap items-center">
          {bufChoices.map(v => <button key={v} className={chip(buf === v)} onClick={() => setBuf(v)}>{v}%</button>)}
          <label className="flex items-center gap-2"><span className="text-slate-300">Other</span><input inputMode="numeric" aria-label="Other extra safety percent" className={'h-12 w-24 rounded-xl bg-slate-900 border-2 px-3 text-lg text-right ' + (bufChoices.includes(buf) ? 'border-slate-700' : 'border-amber-400')} value={bufChoices.includes(buf) ? '' : buf} onChange={e => setBuf(e.target.value.replace(/[^\d.]/g, '') || '0')}/><span>%</span></label></div></div></div>
    </Step>

    <Step n={3} title="Work it out">
      <button className="min-h-14 px-8 rounded-xl bg-green-600 text-white text-xl font-bold disabled:opacity-50" disabled={busy} onClick={calc}>{busy ? 'Working it out…' : 'Work out tools needed'}</button>
      {err && <p className="text-red-400 font-semibold">⚠ {err}</p>}
    </Step>

    {res && !busy && <div className="space-y-3 border-t-2 border-slate-700 pt-4">
      <div className="rounded-xl border-2 border-amber-400 bg-amber-400/20 p-4"><div className="text-sm font-semibold text-slate-300">To order in total</div>
        <div className="flex gap-x-8 gap-y-2 flex-wrap mt-1">{TOOLS.map(t => <div key={t} className="text-xl"><span className="text-slate-300">{TOOL_LABEL[t]}</span> <b className={`text-2xl ${total(t) > 0 ? 'text-amber-300' : 'text-green-400'}`}>{n0(total(t))}</b></div>)}</div></div>
      <p className="text-sm text-slate-400">{basis}</p>
      <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full min-w-[860px] text-left">
        <thead className="bg-slate-800 text-slate-300 text-sm"><tr><th className="px-3 py-2">Roller size · Party</th><th className="px-3 py-2 text-right">Rollers to make</th>{TOOLS.map(t => <th key={t} className="px-3 py-2">{TOOL_LABEL[t]}</th>)}</tr></thead>
        <tbody>{res.map(r => <tr key={r.key} className="border-t border-slate-800 align-top">
          <td className="px-3 py-2 font-bold">{fac} - {r.size}{r.party && <span className="font-normal text-slate-300"> · {r.party}</span>}{!r.exists && <div className="text-xs text-amber-300 font-normal">not in roller list yet</div>}</td>
          <td className="px-3 py-2 text-right whitespace-nowrap">{n0(r.qty)}</td>
          {TOOLS.map(t => { const c = r.cells[t]; return (<td key={t} className="px-3 py-2">{c.order == null ? <span className="text-slate-500">no history</span> : <>
            <div className={`text-xl font-extrabold ${c.order > 0 ? 'text-amber-300' : 'text-green-400'}`}>{c.order > 0 ? `ORDER ${n0(c.order)}` : '✓ Enough'}</div>
            <div className="text-sm text-slate-300 leading-snug">need {n0(c.need ?? 0)}<br/>in stock {n0(c.have)}<br/>coming {n0(c.onOrd)}</div>
            {c.basis === 'avg' && <div className="text-xs text-amber-300">estimated (factory average)</div>}
            {c.low && <div className="text-xs text-amber-300">little history ({n0(c.rollers)} rollers)</div>}
            {c.zero && !c.low && <div className="text-xs text-slate-400">none used in this period</div>}</>}</td>); })}</tr>)}</tbody></table></div>
      <button className={chip(false)} onClick={csv}>⬇ Download CSV</button>
      <details className="rounded-xl border border-slate-800 p-3 text-sm text-slate-300"><summary className="cursor-pointer font-bold text-base min-h-8">How is this worked out?</summary>
        <ul className="mt-2 space-y-1 list-disc pl-5">
          <li><b>Need</b> = rollers to make × (tools used ÷ rollers forged) for that roller size and party, rounded up, plus the extra safety. Tools used and rollers forged come from the shift sheet for the period you chose (the same numbers as Shift Sheet → Records → Tools used).</li>
          <li><b>In stock</b> = soft and heat treated tools in this factory’s stock for that size and party. It includes tools on the headers, because a tool leaves stock only when the shift sheet records it as used.</li>
          <li><b>Coming</b> = tools ordered and still to be made at the CNC, plus tools made but not yet received.</li>
          <li><b>Order</b> = need − in stock − coming. “✓ Enough” means nothing more is needed.</li>
          <li><b>Estimated (factory average)</b>: this size and party has no shift sheet history in the period, so the average of all sizes in this factory was used.</li>
          <li><b>Little history</b>: fewer than {n0(LOW)} rollers forged in the period, so the number is less certain.</li>
        </ul></details>
    </div>}
  </section>);
}
