'use client';
import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { SEL, DSEL } from '@/lib/useOrders';
import { FACTORIES } from '@/lib/factories';
import { TOOL_LABEL, type ToolType, type OrderFull, type DeliveryFull, type RollerMaster, type InventoryStock } from '@/types/database';

const TOOLS: ToolType[] = ['DIE_TOP', 'BOTTOM', 'FACING_PUNCH', 'SHORT_PIN'];
const LOW = 20000;   // fewer rollers than this in the window = low confidence
type SizeRow = { roller_size: string; rollers: number; tool_type: string | null; tools: number };
type Cell = { need: number | null; have: number; hard: number; onOrd: number; order: number | null; basis: 'size' | 'avg' | 'none'; low: boolean; rollers: number; zero: boolean };
type Res = { size: string; qty: number; exists: boolean; cells: Record<string, Cell> };
const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const n0 = (n: number) => Math.round(n).toLocaleString('en-IN');
const rpcData = <T,>(fn: string, args: object) => (supabase.rpc as unknown as (f: string, a: object) => Promise<{ data: T | null; error: { message: string } | null }>).call(supabase, fn, args);
const inp = 'h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full';
const lbl = 'block text-sm font-semibold text-slate-300 mb-1';

// "31309 100000", "31309<TAB>1,00,000", "31309, 100000" ... -> { size, qty }
const parseLine = (raw: string): { size: string; qty: number } | null => {
  const l = raw.trim(); if (!l) return null;
  let size = '', rest = '';
  if (l.includes('\t')) { const [a, ...b] = l.split('\t'); size = a; rest = b.join(''); }
  else if (/\s/.test(l)) { const m = l.match(/^(\S+)\s+(.*)$/); if (!m) return null; size = m[1]; rest = m[2]; }
  else if (l.includes(',')) { const i = l.indexOf(','); size = l.slice(0, i); rest = l.slice(i + 1); }
  else return null;
  size = size.replace(/[,;]+$/, '').trim(); const qty = parseInt(rest.replace(/[^\d]/g, ''), 10);
  return size && qty > 0 ? { size, qty } : null;
};

// Plan tooling for a roller schedule: tools needed (from tools used per rollers forged), minus stock, minus tools already on order.
export function ToolPlanner({ fsel }: { fsel?: string | null }) {
  const [tf, setTf] = useState<string>(fsel || 'NIC'); const fac = fsel || tf;
  const [text, setText] = useState(''); const [months, setMonths] = useState(3); const [buf, setBuf] = useState('0');
  const [res, setRes] = useState<Res[] | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [bad, setBad] = useState<string[]>([]);

  const calc = async () => {
    const lines = text.split('\n').map(l => ({ raw: l, p: parseLine(l) })).filter(x => x.raw.trim());
    setBad(lines.filter(x => !x.p).map(x => x.raw.trim()));
    const sched = Object.values(lines.reduce((a, x) => { if (x.p) { const k = x.p.size.toLowerCase(); (a[k] ??= { size: x.p.size, qty: 0 }).qty += x.p.qty; } return a; }, {} as Record<string, { size: string; qty: number }>));
    if (!sched.length) { setErr('Type or paste at least one line: roller size, then quantity.'); setRes(null); return; }
    setBusy(true); setErr('');
    const from = new Date(); from.setMonth(from.getMonth() - months); const to = new Date(Date.now() + 86400000);
    const [z, st, ro, od, dv] = await Promise.all([
      rpcData<SizeRow[]>('report_sizes', { p_from: ymd(from), p_to: ymd(to), p_factory: fac }),
      supabase.from('inventory_stock').select('*').eq('factory_id', fac),
      supabase.from('roller_master').select('*').eq('factory_id', fac),
      supabase.from('tool_orders').select(SEL).eq('factory_id', fac).neq('status', 'CLOSED').limit(1000),
      supabase.from('deliveries').select(DSEL).eq('factory_id', fac).eq('status', 'READY').limit(1000)]);
    setBusy(false);
    if (z.error) { setErr(z.error.message); return; }

    // rates from the shift sheet: tools used per rollers forged, per size
    const rate = new Map<string, { rollers: number; tools: Record<string, number> }>(); const seen = new Set<string>(); let fbRollers = 0; const fbTools: Record<string, number> = {};
    (z.data ?? []).forEach(r => { const k = r.roller_size.toLowerCase(); const e = rate.get(k) ?? { rollers: r.rollers, tools: {} }; if (r.tool_type) { e.tools[r.tool_type] = (e.tools[r.tool_type] ?? 0) + r.tools; fbTools[r.tool_type] = (fbTools[r.tool_type] ?? 0) + r.tools; } rate.set(k, e); if (!seen.has(k)) { seen.add(k); fbRollers += r.rollers; } });
    // stock in hand (soft + hard)
    const sizeById = new Map(((ro.data ?? []) as unknown as RollerMaster[]).map(r => [r.id, r.roller_size.toLowerCase()]));
    const have: Record<string, { tot: number; hard: number }> = {};
    ((st.data ?? []) as unknown as InventoryStock[]).forEach(s => { const k = `${sizeById.get(s.roller_id) ?? ''}|${s.tool_type}`; const h = (have[k] ??= { tot: 0, hard: 0 }); h.tot += s.qty; if (s.state === 'HARD') h.hard += s.qty; });
    // already on order (still to be made) + made but not yet received
    const onOrder: Record<string, number> = {};
    const add = (size: string | undefined, tool: string | undefined, q: number) => { if (!size || !tool || q <= 0) return; const k = `${size.toLowerCase()}|${tool}`; onOrder[k] = (onOrder[k] ?? 0) + q; };
    ((od.data ?? []) as unknown as OrderFull[]).forEach(o => add(o.roller?.roller_size, o.tooling?.tool_type, o.quantity - (o.qty_made ?? 0)));
    ((dv.data ?? []) as unknown as DeliveryFull[]).forEach(d => add(d.ord?.roller?.roller_size, d.ord?.tooling?.tool_type, d.qty_made));

    const b = Math.max(0, +buf || 0);
    setRes(sched.map(s => {
      const k = s.size.toLowerCase(); const r = rate.get(k); const cells: Record<string, Cell> = {};
      TOOLS.forEach(t => {
        const h = have[`${k}|${t}`] ?? { tot: 0, hard: 0 }; const oo = onOrder[`${k}|${t}`] ?? 0;
        let basis: Cell['basis'] = 'none'; let per = 0; let rollers = 0; let zero = false;
        if (r && r.rollers > 0) { basis = 'size'; per = (r.tools[t] ?? 0) / r.rollers; rollers = r.rollers; zero = (r.tools[t] ?? 0) === 0; }
        else if (fbRollers > 0) { basis = 'avg'; per = (fbTools[t] ?? 0) / fbRollers; rollers = fbRollers; }
        const need = basis === 'none' ? null : Math.ceil(s.qty * per * (1 + b / 100) - 1e-9);
        cells[t] = { need, have: h.tot, hard: h.hard, onOrd: oo, order: need == null ? null : Math.max(0, need - h.tot - oo), basis, low: basis === 'size' && rollers < LOW, rollers, zero };
      });
      return { size: s.size, qty: s.qty, exists: Array.from(sizeById.values()).includes(k), cells };
    }));
  };

  const csv = () => {
    if (!res) return; const rows = [['Roller size', 'Planned rollers', 'Tool', 'Needed', 'In stock', 'On order', 'To order']];
    res.forEach(r => TOOLS.forEach(t => { const c = r.cells[t]; rows.push([r.size, String(r.qty), TOOL_LABEL[t], String(c.need ?? ''), String(c.have), String(c.onOrd), String(c.order ?? '')]); }));
    const blob = new Blob([rows.map(r => r.map(x => `"${x.replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `tool-plan-${fac}.csv`; a.click();
  };

  return (<section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-4">
    <h2 className="text-xl font-bold">Tooling plan</h2>
    <p className="text-sm text-slate-400">Paste your roller schedule and see how many tools you need, what you already have, and what to order. Needs are worked out from tools used per rollers forged on the shift sheet.</p>
    {!fsel && <div className="flex gap-2 flex-wrap">{FACTORIES.map(f => <button key={f} onClick={() => setTf(f)} className={`min-h-12 px-5 rounded-xl border-2 text-lg font-bold ${fac === f ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{f}</button>)}</div>}
    <label className="block"><span className={lbl}>Schedule: one roller size per line, then the quantity</span>
      <textarea rows={6} className="rounded-xl bg-slate-900 border-2 border-slate-700 px-3 py-2 text-xl w-full" placeholder={'31309  100000\n31310  250000'} value={text} onChange={e => setText(e.target.value)}/></label>
    <div className="grid sm:grid-cols-3 gap-3 items-end">
      <label className="block"><span className={lbl}>Base the rates on</span><select className={inp} value={months} onChange={e => setMonths(+e.target.value)}><option value={3}>Last 3 months</option><option value={6}>Last 6 months</option><option value={12}>Last 12 months</option></select></label>
      <label className="block"><span className={lbl}>Safety buffer %</span><input inputMode="numeric" className={inp} value={buf} onChange={e => setBuf(e.target.value)}/></label>
      <button className="min-h-14 px-6 rounded-xl bg-green-600 text-white text-xl font-bold disabled:opacity-50" disabled={busy} onClick={calc}>Calculate</button></div>
    {err && <p className="text-red-400 font-semibold">{err}</p>}
    {bad.length > 0 && <p className="text-amber-300 text-sm">Could not read {bad.length} line{bad.length === 1 ? '' : 's'}: {bad.slice(0, 4).join(' | ')}{bad.length > 4 ? ' …' : ''}</p>}
    {busy && <p className="text-slate-400">Calculating…</p>}
    {res && !busy && <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full min-w-[820px] text-left">
        <thead className="bg-slate-800 text-slate-300 text-sm"><tr><th className="px-3 py-2">Roller size</th><th className="px-3 py-2">Planned rollers</th>{TOOLS.map(t => <th key={t} className="px-3 py-2">{TOOL_LABEL[t]}</th>)}</tr></thead>
        <tbody>{res.map(r => <tr key={r.size} className="border-t border-slate-800 align-top">
          <td className="px-3 py-2 font-bold whitespace-nowrap">{r.size}{!r.exists && <div className="text-xs text-amber-300 font-normal">not in roller list yet</div>}</td><td className="px-3 py-2 whitespace-nowrap">{n0(r.qty)}</td>
          {TOOLS.map(t => { const c = r.cells[t]; return (<td key={t} className="px-3 py-2">{c.order == null ? <span className="text-slate-500">no data</span> : <>
            <div className={`text-xl font-extrabold ${c.order > 0 ? 'text-amber-300' : 'text-green-400'}`}>{c.order > 0 ? `Order ${n0(c.order)}` : 'OK'}</div>
            <div className="text-xs text-slate-400">need {n0(c.need ?? 0)} · have {n0(c.have)} · on order {n0(c.onOrd)}</div>
            {c.basis === 'avg' && <div className="text-xs text-amber-300">est. from other sizes</div>}
            {c.low && <div className="text-xs text-amber-300">low data ({n0(c.rollers)} rollers)</div>}
            {c.zero && !c.low && <div className="text-xs text-slate-400">none used in window</div>}</>}</td>); })}</tr>)}
          <tr className="border-t-2 border-slate-600 bg-amber-400/20 font-extrabold"><td className="px-3 py-2" colSpan={2}>Total to order</td>{TOOLS.map(t => <td key={t} className="px-3 py-2">{n0(res.reduce((a, r) => a + (r.cells[t].order ?? 0), 0))}</td>)}</tr></tbody></table></div>
      <button className="min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold" onClick={csv}>⬇ Download as CSV</button>
      <p className="text-xs text-slate-500">Needed = planned rollers × (tools used ÷ rollers forged) for that size, rounded up, plus the buffer. To order = needed − tools in stock − tools already on order (still to be made, or made and not yet received). Stock counts soft and hard, and includes tools currently on the headers, because tools are only deducted when recorded as used. “est. from other sizes” means that size has no shift sheet data in the window, so the factory average was used. “low data” means fewer than {n0(LOW)} rollers of history.</p></div>}
  </section>);
}
