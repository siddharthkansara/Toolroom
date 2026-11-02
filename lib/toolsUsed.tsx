'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { rollerLabel } from '@/lib/factories';
import { TOOL_LABEL, type ToolType } from '@/types/database';

// Tools used in a period, one row per roller size, one column per tool type, with rollers forged beside it.
// Source: the shift sheet (report_sizes), so tools used and rollers forged come from the same lines.

const TOOLS: ToolType[] = ['DIE_TOP', 'BOTTOM', 'FACING_PUNCH', 'SHORT_PIN'];
type Mode = 'used' | 'per' | 'life';
const MODES: [Mode, string][] = [['used', 'Tools used'], ['per', 'Per 10,000 rollers'], ['life', 'Rollers per tool']];
const n0 = (n: number) => Math.round(n).toLocaleString('en-IN');
const rpcData = <T,>(fn: string, args: object) => (supabase.rpc as unknown as (f: string, a: object) => Promise<{ data: T | null; error: { message: string } | null }>).call(supabase, fn, args);
const th = 'px-3 py-2 whitespace-nowrap';
const td = 'px-3 py-2 whitespace-nowrap';

type Row = { factory_id: string; roller_id: string; roller_size: string; rollers: number; shifts: number; tool_type: string | null; tools: number };
type Size = { id: string; size: string; rollers: number; tools: Record<string, number> };

export function ToolsUsed({ factory, from, to }: { factory: string; from: string; to: string }) {
  const [rows, setRows] = useState<Row[]>([]); const [busy, setBusy] = useState(true); const [err, setErr] = useState('');
  const [mode, setMode] = useState<Mode>('used'); const [q, setQ] = useState('');

  useEffect(() => {
    let on = true; setBusy(true); setErr('');
    rpcData<Row[]>('report_sizes', { p_from: from, p_to: to, p_factory: factory }).then(({ data, error }) => {
      if (!on) return; setErr(error ? error.message : ''); setRows(error ? [] : data ?? []); setBusy(false);
    });
    return () => { on = false; };
  }, [factory, from, to]);

  const bySize = new Map<string, Size>();
  rows.forEach(r => {
    const e = bySize.get(r.roller_id) ?? { id: r.roller_id, size: r.roller_size, rollers: r.rollers, tools: {} };
    if (r.tool_type) e.tools[r.tool_type] = (e.tools[r.tool_type] ?? 0) + r.tools;
    bySize.set(r.roller_id, e);
  });
  const list = Array.from(bySize.values()).filter(x => !q.trim() || x.size.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }));
  const tot = { rollers: list.reduce((a, x) => a + x.rollers, 0), tools: {} as Record<string, number> };
  TOOLS.forEach(t => { tot.tools[t] = list.reduce((a, x) => a + (x.tools[t] ?? 0), 0); });

  const cell = (used: number, rollers: number) => {
    if (mode === 'used') return used ? n0(used) : '—';
    if (mode === 'per') return used && rollers ? (used / rollers * 10000).toFixed(1) : '—';
    return used && rollers ? n0(rollers / used) : '—';
  };

  const csv = () => {
    const head = ['Roller size', 'Rollers forged', ...TOOLS.map(t => TOOL_LABEL[t])];
    const lines: (string | number)[][] = list.map(x => [x.size, x.rollers, ...TOOLS.map(t => x.tools[t] ?? 0)]);
    lines.push(['TOTAL', tot.rollers, ...TOOLS.map(t => tot.tools[t])]);
    const text = [head, ...lines].map(l => l.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = `tools-used-${factory}-${from.slice(0, 7)}.csv`; a.click();
  };

  return (<div className="space-y-3">
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">{MODES.map(([m, l]) => <button key={m} onClick={() => setMode(m)} className={`min-h-12 rounded-xl border-2 text-lg font-bold ${mode === m ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{l}</button>)}</div>
    <div className="grid sm:grid-cols-3 gap-2 items-end">
      <label className="block sm:col-span-2"><span className="block text-sm font-semibold text-slate-300 mb-1">Search roller size</span><input className="h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full" placeholder="e.g. 31309" value={q} onChange={e => setQ(e.target.value)}/></label>
      <button disabled={!list.length} onClick={csv} className="min-h-14 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold disabled:opacity-50">⬇ Download CSV</button></div>
    {busy && <p className="text-slate-400">Loading…</p>}
    {err && <p className="text-red-400">Could not load: {err}</p>}
    {!busy && !err && <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full text-left" style={{ minWidth: 640 }}>
      <thead className="bg-slate-800 text-slate-300 text-sm"><tr><th className={th}>Roller size</th><th className={th}>Rollers forged</th>{TOOLS.map(t => <th key={t} className={th}>{TOOL_LABEL[t]}</th>)}</tr></thead>
      <tbody>{list.map(x => <tr key={x.id} className="border-t border-slate-800"><td className={`${td} font-bold`}>{rollerLabel(factory, x.size)}</td><td className={td}>{n0(x.rollers)}</td>
        {TOOLS.map(t => <td key={t} className={`${td} ${mode === 'used' ? 'font-bold' : 'font-extrabold text-amber-300'}`}>{cell(x.tools[t] ?? 0, x.rollers)}</td>)}</tr>)}
        {list.length > 0 && <tr className="border-t-2 border-slate-600 bg-slate-800 font-bold"><td className={td}>Total</td><td className={td}>{n0(tot.rollers)}</td>{TOOLS.map(t => <td key={t} className={td}>{cell(tot.tools[t], tot.rollers)}</td>)}</tr>}
        {!list.length && <tr><td colSpan={2 + TOOLS.length} className="px-3 py-6 text-center text-slate-500">No shift sheet lines with tools in this month yet.</td></tr>}</tbody></table></div>}
    <p className="text-xs text-slate-500">Tools used and rollers forged come from the same shift sheet lines. “—” means none used. Per 10,000 rollers = tools used ÷ rollers forged × 10,000. Rollers per tool = rollers forged ÷ tools used. Different roller sizes are not directly comparable.</p>
  </div>);
}
