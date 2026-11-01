'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { rollerLabel, mname, FCHIP, FACTORIES } from '@/lib/factories';
import { ProductionTable, UtilGrid, CapacityEditor } from '@/lib/production';
import { TOOL_LABEL, type ToolType } from '@/types/database';

const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const tn = (t: string) => TOOL_LABEL[t as ToolType] ?? t;
const n0 = (n: number) => Math.round(n).toLocaleString('en-IN');
const rpcData = <T,>(fn: string, args: object) => (supabase.rpc as unknown as (f: string, a: object) => Promise<{ data: T | null; error: { message: string } | null }>).call(supabase, fn, args);
const Fac = ({ f }: { f: string }) => <span className={`${FCHIP[f] ?? 'bg-slate-600'} text-white rounded-lg px-2 py-0.5 text-sm font-extrabold`}>{f}</span>;
const th = 'px-3 py-2 whitespace-nowrap';

type ShiftRow = { factory_id: string; work_date: string; shift: 'DAY' | 'NIGHT'; rollers: number; lines: number; headers: number; not_running: number; completed: boolean };
type HeadRow = { factory_id: string; machine_id: string; rollers: number; ran_shifts: number; idle_shifts: number; capacity: number | null };
type OpRow = { factory_id: string; operator_id: string | null; operator_name: string; roller_id: string | null; roller_size: string | null; rollers: number; op_shifts: number };
type SizeRow = { factory_id: string; roller_id: string; roller_size: string; rollers: number; shifts: number; tool_type: string | null; tools: number };
type Tab = 'shifts' | 'headers' | 'operators' | 'tools' | 'table' | 'util';
const U = ({ v }: { v: number | null }) => v == null ? <span className="text-slate-500">—</span> : <span className={v >= 85 ? 'text-green-400 font-bold' : v >= 60 ? 'text-amber-300 font-bold' : 'text-red-400 font-bold'}>{v.toFixed(1)}%</span>;

// Reports built from the Shift Sheet. rs = period start, re = period end (exclusive), as on the dashboard.
export function ShiftReports({ rs, re, fsel, period }: { rs: Date; re: Date; fsel?: string | null; period: string }) {
  const [tab, setTab] = useState<Tab>('shifts'); const [shifts, setShifts] = useState<ShiftRow[]>([]); const [heads, setHeads] = useState<HeadRow[]>([]);
  const [ops, setOps] = useState<OpRow[]>([]); const [sizes, setSizes] = useState<SizeRow[]>([]);
  const [busy, setBusy] = useState(true); const [err, setErr] = useState(''); const [all, setAll] = useState(false); const [q, setQ] = useState(''); const [tf, setTf] = useState<string>(fsel || 'NIC'); const fac = fsel || tf;
  useEffect(() => { (async () => {
    setBusy(true); setErr('');
    const a = { p_from: ymd(rs), p_to: ymd(re), p_factory: fsel || null };
    const [s, h, o, z] = await Promise.all([rpcData<ShiftRow[]>('report_shift_totals', a), rpcData<HeadRow[]>('report_headers', a), rpcData<OpRow[]>('report_operators', a), rpcData<SizeRow[]>('report_sizes', a)]);
    setBusy(false);
    const bad = [s, h, o, z].find(x => x.error); if (bad?.error) { setErr(bad.error.message); return; }
    setShifts(s.data ?? []); setHeads(h.data ?? []); setOps(o.data ?? []); setSizes(z.data ?? []);
  })(); }, [rs.getTime(), re.getTime(), fsel]);

  // summary
  const total = shifts.reduce((a, x) => a + x.rollers, 0); const done = shifts.filter(x => x.completed).length;
  const byFac: Record<string, number> = {}; shifts.forEach(x => { byFac[x.factory_id] = (byFac[x.factory_id] ?? 0) + x.rollers; });

  // shifts tab: one row per factory and date, Day and Night side by side
  const days = Object.values(shifts.reduce((a, x) => { const k = `${x.factory_id}|${x.work_date}`; (a[k] ??= { f: x.factory_id, d: x.work_date, day: undefined as ShiftRow | undefined, night: undefined as ShiftRow | undefined }); if (x.shift === 'DAY') a[k].day = x; else a[k].night = x; return a; }, {} as Record<string, { f: string; d: string; day?: ShiftRow; night?: ShiftRow }>))
    .sort((x, y) => y.d.localeCompare(x.d) || x.f.localeCompare(y.f));
  const cell = (r?: ShiftRow) => r ? <span>{n0(r.rollers)} <span className={r.completed ? 'text-green-400' : 'text-amber-300'} title={r.completed ? 'Sheet complete' : 'Sheet not marked complete'}>{r.completed ? '✔' : '⚠'}</span></span> : <span className="text-slate-500">—</span>;

  // operators tab: one row per operator, with main sizes
  const opList = Object.values(ops.reduce((a, x) => { const k = `${x.factory_id}|${x.operator_id ?? 'none'}`; (a[k] ??= { f: x.factory_id, name: x.operator_name, shifts: x.op_shifts, rollers: 0, sizes: [] as { size: string; n: number }[] }); a[k].rollers += x.rollers; a[k].sizes.push({ size: x.roller_size ?? '—', n: x.rollers }); return a; }, {} as Record<string, { f: string; name: string; shifts: number; rollers: number; sizes: { size: string; n: number }[] }>))
    .sort((x, y) => y.rollers - x.rollers);

  // tools tab: per roller size and tool type
  const s = q.trim().toLowerCase(); const toolRows = sizes.filter(x => !s || x.roller_size.toLowerCase().includes(s)).sort((x, y) => x.factory_id.localeCompare(y.factory_id) || x.roller_size.localeCompare(y.roller_size, undefined, { numeric: true }) || (x.tool_type ?? '').localeCompare(y.tool_type ?? ''));
  const tabs: [Tab, string][] = [['shifts', 'Shifts'], ['headers', 'Headers'], ['operators', 'Operators'], ['tools', 'Tool use'], ['table', 'Production table'], ['util', 'Utilisation']];

  return (<section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 space-y-4">
    <h2 className="text-xl font-bold">Shift sheet reports · {period}</h2>
    <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-xl"><span><b className="text-3xl text-amber-300">{n0(total)}</b> rollers forged</span><span className="text-slate-300">{shifts.length} shift sheets · {done} complete</span>
      {Object.entries(byFac).map(([f, n]) => <span key={f} className="flex items-center gap-2"><Fac f={f}/><b>{n0(n)}</b></span>)}</div>
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">{tabs.map(([t, l]) => <button key={t} onClick={() => setTab(t)} className={`min-h-12 rounded-xl border-2 text-lg font-bold ${tab === t ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{l}</button>)}</div>
    {err && tab !== 'table' && tab !== 'util' && <p className="text-red-400 font-semibold">Could not load reports: {err}</p>}
    {busy && tab !== 'table' && tab !== 'util' && <p className="text-slate-400">Loading…</p>}
    {!busy && !err && tab === 'shifts' && <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full min-w-[560px] text-left"><thead className="bg-slate-800 text-slate-300 text-sm"><tr>{['Date', 'Factory', 'Day shift', 'Night shift', 'Day total'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
        <tbody>{(all ? days : days.slice(0, 31)).map(d => <tr key={d.f + d.d} className="border-t border-slate-800"><td className="px-3 py-2 whitespace-nowrap font-bold">{new Date(d.d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</td><td className="px-3 py-2"><Fac f={d.f}/></td><td className="px-3 py-2">{cell(d.day)}</td><td className="px-3 py-2">{cell(d.night)}</td><td className="px-3 py-2 font-extrabold text-amber-300">{n0((d.day?.rollers ?? 0) + (d.night?.rollers ?? 0))}</td></tr>)}
          {!days.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">No shift sheets in this period.</td></tr>}</tbody></table></div>
      <p className="text-xs text-slate-500">✔ = sheet marked complete, ⚠ = entries exist but the sheet was not marked complete.</p>
      {days.length > 31 && <button className="min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold" onClick={() => setAll(!all)}>{all ? 'Show fewer days' : `Show all ${days.length} days`}</button>}</div>}
    {!busy && !err && tab === 'headers' && <div className="space-y-4"><div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full min-w-[760px] text-left"><thead className="bg-slate-800 text-slate-300 text-sm"><tr>{['Factory', 'Header', 'Rollers forged', 'Shifts run', 'Not running', 'Average per shift run', 'Capacity per day', 'Utilisation'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
      <tbody>{[...heads].sort((x, y) => y.rollers - x.rollers).map(x => { const sh = x.ran_shifts + x.idle_shifts; return <tr key={x.factory_id + x.machine_id} className="border-t border-slate-800"><td className="px-3 py-2"><Fac f={x.factory_id}/></td><td className="px-3 py-2 font-bold">{mname(x.machine_id)}</td><td className="px-3 py-2 font-extrabold text-amber-300">{n0(x.rollers)}</td><td className="px-3 py-2">{x.ran_shifts}</td><td className="px-3 py-2">{x.idle_shifts}</td><td className="px-3 py-2">{x.ran_shifts ? n0(x.rollers / x.ran_shifts) : '—'}</td><td className="px-3 py-2">{x.capacity ? n0(x.capacity) : '—'}</td><td className="px-3 py-2"><U v={x.capacity && sh ? x.rollers / (sh * x.capacity / 2) * 100 : null}/></td></tr>; })}
        {!heads.length && <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">No data in this period.</td></tr>}</tbody></table></div>
      <p className="text-xs text-slate-500">Utilisation = rollers forged ÷ (shifts entered × half the daily capacity). Not-running shifts count as 0%.</p>
      <CapacityEditor/></div>}
    {!busy && !err && tab === 'operators' && <div className="space-y-2"><div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full min-w-[640px] text-left"><thead className="bg-slate-800 text-slate-300 text-sm"><tr>{['Operator', 'Factory', 'Rollers forged', 'Shifts', 'Average per shift', 'Main sizes'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
      <tbody>{opList.map(o => <tr key={o.f + o.name} className="border-t border-slate-800"><td className="px-3 py-2 font-bold">{o.name}</td><td className="px-3 py-2"><Fac f={o.f}/></td><td className="px-3 py-2 font-extrabold text-amber-300">{n0(o.rollers)}</td><td className="px-3 py-2">{o.shifts}</td><td className="px-3 py-2">{o.shifts ? n0(o.rollers / o.shifts) : '—'}</td>
        <td className="px-3 py-2 text-sm text-slate-300">{o.sizes.slice(0, 3).map(z => `${z.size} (${Math.round(z.n / o.rollers * 100)}%)`).join(' · ')}</td></tr>)}
        {!opList.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">No data in this period.</td></tr>}</tbody></table></div>
      <p className="text-xs text-slate-500">Compare operators only when they ran similar sizes. Different sizes run at different speeds, so look at “Main sizes” before reading the averages.</p></div>}
    {!busy && !err && tab === 'tools' && <div className="space-y-3">
      <label className="block"><span className="block text-sm font-semibold text-slate-300 mb-1">Search roller size</span><input className="h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full" placeholder="e.g. 31309" value={q} onChange={e => setQ(e.target.value)}/></label>
      <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full min-w-[700px] text-left"><thead className="bg-slate-800 text-slate-300 text-sm"><tr>{['Roller size', 'Tool', 'Tools used', 'Rollers forged', 'Tools per 10,000 rollers', 'Rollers per tool'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
        <tbody>{toolRows.map(x => <tr key={x.factory_id + x.roller_id + (x.tool_type ?? '')} className="border-t border-slate-800"><td className="px-3 py-2 font-bold whitespace-nowrap">{rollerLabel(x.factory_id, x.roller_size)}</td><td className="px-3 py-2">{x.tool_type ? tn(x.tool_type) : <span className="text-slate-500">none recorded</span>}</td>
          <td className="px-3 py-2">{n0(x.tools)}</td><td className="px-3 py-2">{n0(x.rollers)}</td>
          <td className="px-3 py-2 font-extrabold text-amber-300">{x.tool_type && x.rollers ? (x.tools / x.rollers * 10000).toFixed(1) : '—'}</td>
          <td className="px-3 py-2 font-bold">{x.tool_type && x.tools ? n0(x.rollers / x.tools) : '—'}</td></tr>)}
          {!toolRows.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">No data in this period.</td></tr>}</tbody></table></div>
      <p className="text-xs text-slate-500">Tools used and rollers forged come from the same shift lines, so they match exactly. Rollers forged is the same figure for every tool of a size. Read a quarter or a year for the steadiest numbers.</p></div>}
    {(tab === 'table' || tab === 'util') && <div className="space-y-3">
      {!fsel && <div className="flex gap-2 flex-wrap">{FACTORIES.map(f => <button key={f} onClick={() => setTf(f)} className={`min-h-12 px-5 rounded-xl border-2 text-lg font-bold ${fac === f ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{f}</button>)}</div>}
      {tab === 'table' ? <ProductionTable factory={fac} from={ymd(rs)} to={ymd(re)}/> : <UtilGrid factory={fac} from={ymd(rs)} to={ymd(re)}/>}</div>}
  </section>);
}
