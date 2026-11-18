'use client';
import { Fragment, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { rollerLabel, sizeParty, mname } from '@/lib/factories';
import { TOOL_LABEL, type ToolLife, type ToolType } from '@/types/database';
import { TRACKED, lifeStats } from '@/lib/toolLife';

// Tool life: how many rollers each die top and bottom forged before it was worn out.
// Source: the tool_life view (one row per physical tool, built from the shift sheet). Part of the tool-life feature.

const n0 = (n: number) => Math.round(n).toLocaleString('en-IN');
const th = 'px-3 py-2 whitespace-nowrap text-left';
const td = 'px-3 py-2 whitespace-nowrap';
const inp = 'h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full';
const lbl = 'block text-sm font-semibold text-slate-300 mb-1';
const tn = (t: string) => TOOL_LABEL[t as ToolType] ?? t;
const OUT: Record<string, string> = { ON: 'Still on', WORN_OUT: 'Worn out', REMOVED: 'Taken off' };
const OUT_CLS: Record<string, string> = { ON: 'text-sky-400', WORN_OUT: 'text-red-400 font-bold', REMOVED: 'text-slate-300' };
const dd = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

// One use of one physical tool in one sheet line (from shift_tool_use, with its line and its tool)
type Use = { kg: number; outcome: string; seq: number; tool_type: string; machine_tool_id: string;
  entry: { work_date: string; shift: 'DAY' | 'NIGHT'; machine_id: string; roller_id: string; rollers_per_kg: number | null };
  tool: { dim_key: string; mounted_on: string; status: string } | null };
const rollersOf = (u: Use) => Math.round(Number(u.kg) * Number(u.entry.rollers_per_kg ?? 0));
type ToolSum = { id: string; tool_type: string; no: number; dim: string; machines: string[]; first: string; last: string; lines: number; kg: number; rollers: number; status: string };

// The tools used for one roller size, numbered per type in the order they were put on (Die Top 1, Die Top 2, ...)
function toolSums(uses: Use[]) {
  const tools: Record<string, ToolSum> = {};
  uses.forEach(u => { const t = (tools[u.machine_tool_id] ??= { id: u.machine_tool_id, tool_type: u.tool_type, no: 0, dim: u.tool?.dim_key ?? '', machines: [], first: u.entry.work_date, last: u.entry.work_date, lines: 0, kg: 0, rollers: 0, status: u.tool?.status ?? '' });
    if (!t.machines.includes(u.entry.machine_id)) t.machines.push(u.entry.machine_id);
    if (u.entry.work_date < t.first) t.first = u.entry.work_date; if (u.entry.work_date > t.last) t.last = u.entry.work_date;
    t.lines++; t.kg += Number(u.kg); t.rollers += rollersOf(u); });
  // Number the tools of each type in the order they were put on (Die Top 1, Die Top 2, ...)
  const list = Object.values(tools).sort((a, b) => a.tool_type.localeCompare(b.tool_type) || a.first.localeCompare(b.first) || a.id.localeCompare(b.id));
  const seen: Record<string, number> = {}; list.forEach(t => { t.no = (seen[t.tool_type] = (seen[t.tool_type] ?? 0) + 1); });
  const name = (id: string) => { const t = tools[id]; return t ? `${tn(t.tool_type)} ${t.no}` : '—'; };
  const days = [...uses].sort((a, b) => a.entry.work_date.localeCompare(b.entry.work_date) || a.entry.shift.localeCompare(b.entry.shift) || a.entry.machine_id.localeCompare(b.entry.machine_id, undefined, { numeric: true }) || a.tool_type.localeCompare(b.tool_type) || a.seq - b.seq);
  return { list, name, days };
}

// CSV in the same style as the other downloads: UTF-8 with BOM (opens in Excel), quoted text, plain numbers
const csv = (rows: (string | number)[][]) => '﻿' + rows.map(r => r.map(c => (typeof c === 'number' ? String(c) : `"${c.replace(/"/g, '""')}"`)).join(',')).join('\r\n');
const download = (text: string, file: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = file; a.click(); };

// Every die and bottom used for one roller size this month: the tool list, and every sheet line day by day
function SizeDetail({ uses, life }: { uses: Use[]; life: Record<string, ToolLife> }) {
  const { list, name, days } = toolSums(uses);
  return (<div className="space-y-4 p-3">
    <div className="space-y-1"><h4 className="font-bold text-amber-300">Each tool</h4>
      <div className="overflow-x-auto rounded-lg border border-slate-700"><table className="w-full text-left"><thead className="bg-slate-800 text-sm text-slate-400"><tr>
        <th className={th}>Tool</th><th className={th}>Size</th><th className={th}>Header</th><th className={th}>Used on</th><th className={th + ' text-right'}>Lines</th><th className={th + ' text-right'}>kg</th><th className={th + ' text-right'}>Rollers</th><th className={th + ' text-right'}>Whole life</th><th className={th}>Now</th></tr></thead>
        <tbody>{list.map((t, i) => <tr key={t.id} className={`border-t ${i > 0 && list[i - 1].tool_type !== t.tool_type ? 'border-slate-600' : 'border-slate-800'}`}>
          <td className={td + ' font-bold'}>{tn(t.tool_type)} {t.no}</td><td className={td + ' text-slate-300'}>{t.dim || '—'}</td><td className={td}>{t.machines.map(mname).join(', ')}</td>
          <td className={td}>{t.first === t.last ? dd(t.first) : `${dd(t.first)} → ${dd(t.last)}`}</td><td className={td + ' text-right'}>{t.lines}</td>
          <td className={td + ' text-right'}>{n0(t.kg)}</td><td className={td + ' text-right font-bold text-amber-300'}>{n0(t.rollers)}</td>
          <td className={td + ' text-right text-slate-300'}>{life[t.id] ? `${n0(Number(life[t.id].rollers))}` : '—'}</td>
          <td className={td + ' ' + (OUT_CLS[t.status] ?? '')}>{OUT[t.status] ?? '—'}</td></tr>)}</tbody></table></div>
      <p className="text-xs text-slate-500">kg and rollers are for this month. “Whole life” is every roller the tool has forged so far, in any month.</p></div>

    <div className="space-y-1"><h4 className="font-bold text-amber-300">Day by day</h4>
      <div className="overflow-x-auto rounded-lg border border-slate-700"><table className="w-full text-left"><thead className="bg-slate-800 text-sm text-slate-400"><tr>
        <th className={th}>Date</th><th className={th}>Shift</th><th className={th}>Header</th><th className={th}>Tool</th><th className={th}>Size</th><th className={th + ' text-right'}>kg</th><th className={th + ' text-right'}>Rollers</th><th className={th}>At the end of the line</th></tr></thead>
        <tbody>{days.map((u, i) => { const newDay = i === 0 || days[i - 1].entry.work_date !== u.entry.work_date;
          return (<tr key={`${u.machine_tool_id}|${u.entry.work_date}|${u.entry.shift}|${u.seq}|${i}`} className={`border-t ${newDay ? 'border-slate-600' : 'border-slate-800'}`}>
            <td className={td + ' font-semibold'}>{newDay ? dd(u.entry.work_date) : ''}</td><td className={td}>{u.entry.shift === 'DAY' ? 'Day' : 'Night'}</td><td className={td}>{mname(u.entry.machine_id)}</td>
            <td className={td + ' font-bold'}>{name(u.machine_tool_id)}</td><td className={td + ' text-slate-400 text-sm'}>{u.tool?.dim_key || '—'}</td>
            <td className={td + ' text-right'}>{n0(Number(u.kg))}</td><td className={td + ' text-right font-bold'}>{n0(rollersOf(u))}</td><td className={td + ' ' + (OUT_CLS[u.outcome] ?? '')}>{OUT[u.outcome] ?? u.outcome}</td></tr>); })}</tbody></table></div></div>
  </div>);
}

export function ToolLifeReport({ factory, from, to }: { factory: string; from: string; to: string }) {
  const [done, setDone] = useState<ToolLife[]>([]); const [onNow, setOnNow] = useState<ToolLife[]>([]);
  const [sizeOf, setSizeOf] = useState<Record<string, string>>({});   // roller id -> "size · party"
  const [rawOf, setRawOf] = useState<Record<string, { size: string; party: string }>>({});   // separate columns for the CSVs
  const [busy, setBusy] = useState(true); const [err, setErr] = useState('');
  const [tt, setTt] = useState(''); const [q, setQ] = useState(''); const [all, setAll] = useState(false);
  const [uses, setUses] = useState<Use[]>([]); const [life, setLife] = useState<Record<string, ToolLife>>({}); const [openSize, setOpenSize] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let live = true; setBusy(true); setErr('');
    Promise.all([
      supabase.from('tool_life').select('*').eq('factory_id', factory).eq('status', 'WORN_OUT').gte('ended_on', from).lt('ended_on', to),
      supabase.from('tool_life').select('*').eq('factory_id', factory).eq('status', 'ON'),
      supabase.from('roller_master').select('id, roller_size, party_name').eq('factory_id', factory),
    ]).then(([a, b, r]) => {
      if (!live) return;
      const e = a.error ?? b.error ?? r.error; setErr(e ? e.message : '');
      setDone((a.data ?? []) as unknown as ToolLife[]); setOnNow((b.data ?? []) as unknown as ToolLife[]);
      const rr = (r.data ?? []) as unknown as { id: string; roller_size: string; party_name: string | null }[];
      setSizeOf(Object.fromEntries(rr.map(x => [x.id, sizeParty(x)]))); setRawOf(Object.fromEntries(rr.map(x => [x.id, { size: x.roller_size, party: x.party_name ?? '' }])));
      setBusy(false);
    });
    return () => { live = false; };
  }, [factory, from, to]);
  // Every die / bottom use in this month's sheet lines, with the line and the tool, plus each tool's whole-life total
  useEffect(() => {
    let live = true;
    (async () => {
      const out: Use[] = [];
      for (let i = 0; i < 50000; i += 1000) {
        const { data, error } = await supabase.from('shift_tool_use')
          .select('kg, outcome, seq, tool_type, machine_tool_id, entry:shift_entries!inner(work_date, shift, machine_id, roller_id, rollers_per_kg, factory_id, deleted_at), tool:machine_tools(dim_key, mounted_on, status)')
          .eq('entry.factory_id', factory).is('entry.deleted_at', null).gte('entry.work_date', from).lt('entry.work_date', to)
          .order('entry_id').order('tool_type').order('seq').range(i, i + 999);
        if (error) { if (live) setErr(error.message); return; }
        const d = (data ?? []) as unknown as Use[]; out.push(...d); if (d.length < 1000) break;
      }
      const ids = Array.from(new Set(out.map(u => u.machine_tool_id))); const lf: Record<string, ToolLife> = {};
      for (let i = 0; i < ids.length; i += 100) {
        const { data } = await supabase.from('tool_life').select('*').in('id', ids.slice(i, i + 100));
        ((data ?? []) as unknown as ToolLife[]).forEach(t => { lf[t.id] = t; });
      }
      if (live) { setUses(out); setLife(lf); }
    })();
    return () => { live = false; };
  }, [factory, from, to]);

  const size = (id: string) => sizeOf[id] ?? '—';
  const match = (t: ToolLife) => (!tt || t.tool_type === tt) && (!q.trim() || size(t.roller_id).toLowerCase().includes(q.trim().toLowerCase()));
  const fd = done.filter(match), fo = onNow.filter(match);
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const bySize = lifeStats(fd, t => `${t.roller_id}|${t.tool_type}|${t.dim_key}`).sort((a, b) => cmp(size(a.sample.roller_id), size(b.sample.roller_id)) || cmp(a.sample.tool_type, b.sample.tool_type) || cmp(a.sample.dim_key, b.sample.dim_key));
  const fu = uses.filter(u => (!tt || u.tool_type === tt) && (!q.trim() || size(u.entry.roller_id).toLowerCase().includes(q.trim().toLowerCase())));
  const sizes = Object.entries(fu.reduce((a, u) => { (a[u.entry.roller_id] ??= []).push(u); return a; }, {} as Record<string, Use[]>)).sort(([a], [b]) => cmp(size(a), size(b)));
  // CSV of this section, following the Tool and roller-size filters. Tool numbers match the screen.
  const fileBase = `tool-life_${factory}_${from.slice(0, 7)}${tt ? `_${tn(tt).toLowerCase().replace(/\s+/g, '-')}` : ''}`;
  const csvDays = () => {
    const out: (string | number)[][] = [['Roller size', 'Party', 'Date', 'Shift', 'Header', 'Tool', 'Tool size', 'kg', 'Rollers per kg', 'Rollers', 'At the end of the line']];
    sizes.forEach(([rid, us]) => { const { name, days } = toolSums(us);
      days.forEach(u => out.push([rawOf[rid]?.size ?? '—', rawOf[rid]?.party ?? '', u.entry.work_date, u.entry.shift === 'DAY' ? 'Day' : 'Night', mname(u.entry.machine_id), name(u.machine_tool_id), u.tool?.dim_key ?? '', Number(u.kg), Number(u.entry.rollers_per_kg ?? 0), rollersOf(u), OUT[u.outcome] ?? u.outcome])); });
    download(csv(out), `${fileBase}_day-by-day.csv`);
  };
  const csvTools = () => {
    const out: (string | number)[][] = [['Roller size', 'Party', 'Tool', 'Tool size', 'Header', 'First used', 'Last used', 'Lines', 'kg this month', 'Rollers this month', 'Rollers whole life', 'Now']];
    sizes.forEach(([rid, us]) => toolSums(us).list.forEach(t => out.push([rawOf[rid]?.size ?? '—', rawOf[rid]?.party ?? '', `${tn(t.tool_type)} ${t.no}`, t.dim, t.machines.map(mname).join(', '), t.first, t.last, t.lines, Math.round(t.kg * 100) / 100, t.rollers, life[t.id] ? Number(life[t.id].rollers) : '', OUT[t.status] ?? ''])));
    download(csv(out), `${fileBase}_each-tool.csv`);
  };
  const totals = (us: Use[], k: string) => { const x = us.filter(u => u.tool_type === k); const n = new Set(x.map(u => u.machine_tool_id)).size; const kg = x.reduce((a, u) => a + Number(u.kg), 0); const r = x.reduce((a, u) => a + rollersOf(u), 0); return { n, kg, r }; };
  const byMachine = lifeStats(fd, t => `${t.machine_id}|${t.tool_type}`).sort((a, b) => cmp(a.sample.machine_id, b.sample.machine_id) || cmp(a.sample.tool_type, b.sample.tool_type));

  return (<div className="space-y-4">
    <div className="grid sm:grid-cols-3 gap-3">
      <label className="block"><span className={lbl}>Tool</span><select className={inp} value={tt} onChange={e => setTt(e.target.value)}><option value="">All tools</option>{TRACKED.map(k => <option key={k} value={k}>{tn(k)}</option>)}</select></label>
      <label className="block sm:col-span-2"><span className={lbl}>Find roller size or party</span><input className={inp} value={q} onChange={e => setQ(e.target.value)} placeholder="Type part of a roller size or party"/></label></div>
    {err && <div className="rounded-xl border-2 border-red-700 p-3 text-red-400">Could not load: {err}</div>}
    {busy ? <div className="text-slate-400">Loading…</div> : <>
      <div className="space-y-2"><h3 className="text-xl font-bold">What each die and bottom produced, by roller size</h3>
        <p className="text-slate-400 text-sm">Tap a roller size to see every tool, and every sheet line day by day. Rollers = kg × that line’s rollers per kg.</p>
        {sizes.length > 0 && <div className="flex gap-2 flex-wrap">
          <button className="min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold" onClick={csvDays}>⬇ Day by day (CSV)</button>
          <button className="min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold" onClick={csvTools}>⬇ Each tool (CSV)</button></div>}
        {sizes.length === 0 ? <div className="text-slate-400">No die or bottom was recorded on the shift sheet in this month.</div> :
        <div className="space-y-2">{sizes.map(([rid, us]) => { const isOpen = !!openSize[rid]; const nd = new Set(us.map(u => u.entry.work_date)).size;
          return (<div key={rid} className="rounded-xl border border-slate-700 bg-slate-900">
            <button onClick={() => setOpenSize({ ...openSize, [rid]: !isOpen })} aria-expanded={isOpen} className="w-full min-h-16 px-3 py-2 text-left flex items-center gap-x-6 gap-y-1 flex-wrap">
              <span className="text-xl font-extrabold min-w-[8rem]">{rollerLabel(factory, size(rid))}</span><span className="text-slate-400">{nd} {nd === 1 ? 'day' : 'days'}</span>
              {TRACKED.filter(k => !tt || k === tt).map(k => { const x = totals(us, k); return x.n ? <span key={k}><b>{tn(k)}</b>: {x.n} {x.n === 1 ? 'tool' : 'tools'} · {n0(x.kg)} kg · <b className="text-amber-300">{n0(x.r)}</b> rollers <span className="text-slate-400 text-sm">(≈ {n0(x.r / x.n)} per tool)</span></span> : null; })}
              <span className="ml-auto">{isOpen ? '▲' : '▼'}</span></button>
            {isOpen && <SizeDetail uses={us} life={life}/>}</div>); })}</div>}
      </div>

      <div className="text-slate-300">{fd.length} {fd.length === 1 ? 'tool was' : 'tools were'} worn out in this month. Rollers are worked out from the kg forged and each line’s rollers-per-kg rate.</div>

      <div className="space-y-2"><h3 className="text-xl font-bold">How long tools lasted, by roller size</h3>
        {bySize.length === 0 ? <div className="text-slate-400">No worn-out tools to show yet.</div> :
        <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full text-left"><thead className="text-slate-400"><tr>
          <th className={th}>Roller size</th><th className={th}>Tool</th><th className={th}>Size</th><th className={th}>Tools worn out</th><th className={th}>Average rollers</th><th className={th}>Best</th><th className={th}>Worst</th><th className={th}>Average kg</th></tr></thead>
          <tbody>{bySize.map(s => <tr key={s.key} className="border-t border-slate-800">
            <td className={td}>{rollerLabel(factory, size(s.sample.roller_id))}</td><td className={td}>{tn(s.sample.tool_type)}</td><td className={td}>{s.sample.dim_key || '—'}</td>
            <td className={td}>{s.tools}</td><td className={`${td} font-bold text-amber-300`}>{n0(s.avgRollers)}</td><td className={td}>{n0(s.bestRollers)}</td><td className={td}>{n0(s.worstRollers)}</td><td className={td}>{n0(s.avgKg)}</td></tr>)}</tbody></table></div>}
      </div>

      <div className="space-y-2"><h3 className="text-xl font-bold">By header machine</h3>
        {byMachine.length === 0 ? <div className="text-slate-400">Nothing to compare yet.</div> :
        <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full text-left"><thead className="text-slate-400"><tr>
          <th className={th}>Machine</th><th className={th}>Tool</th><th className={th}>Tools worn out</th><th className={th}>Average rollers</th><th className={th}>Best</th><th className={th}>Worst</th></tr></thead>
          <tbody>{byMachine.map(s => <tr key={s.key} className="border-t border-slate-800">
            <td className={td}>{mname(s.sample.machine_id)}</td><td className={td}>{tn(s.sample.tool_type)}</td><td className={td}>{s.tools}</td>
            <td className={`${td} font-bold text-amber-300`}>{n0(s.avgRollers)}</td><td className={td}>{n0(s.bestRollers)}</td><td className={td}>{n0(s.worstRollers)}</td></tr>)}</tbody></table></div>}
      </div>

      <div className="space-y-2"><h3 className="text-xl font-bold">On the machines now</h3>
        {fo.length === 0 ? <div className="text-slate-400">No tool is being tracked on a machine right now.</div> :
        <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full text-left"><thead className="text-slate-400"><tr>
          <th className={th}>Machine</th><th className={th}>Tool</th><th className={th}>Roller size</th><th className={th}>Size</th><th className={th}>Since</th><th className={th}>kg so far</th><th className={th}>Rollers so far</th></tr></thead>
          <tbody>{[...fo].sort((a, b) => cmp(a.machine_id, b.machine_id) || cmp(a.tool_type, b.tool_type)).map(t => <tr key={t.id} className="border-t border-slate-800">
            <td className={td}>{mname(t.machine_id)}</td><td className={td}>{tn(t.tool_type)}</td><td className={td}>{rollerLabel(factory, size(t.roller_id))}</td><td className={td}>{t.dim_key || '—'}</td>
            <td className={td}>{t.mounted_on}</td><td className={td}>{n0(Number(t.kg))}</td><td className={`${td} font-bold text-amber-300`}>{n0(Number(t.rollers))}</td></tr>)}</tbody></table></div>}
      </div>

      <div className="space-y-2">
        <button className="min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold" onClick={() => setAll(!all)}>{all ? 'Hide' : 'Show'} every tool worn out this month ({fd.length})</button>
        {all && fd.length > 0 && <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full text-left"><thead className="text-slate-400"><tr>
          <th className={th}>On → off</th><th className={th}>Machine</th><th className={th}>Tool</th><th className={th}>Roller size</th><th className={th}>Size</th><th className={th}>Lines</th><th className={th}>kg</th><th className={th}>Rollers</th></tr></thead>
          <tbody>{[...fd].sort((a, b) => cmp(b.ended_on ?? '', a.ended_on ?? '')).map(t => <tr key={t.id} className="border-t border-slate-800">
            <td className={td}>{t.mounted_on} → {t.ended_on}</td><td className={td}>{mname(t.machine_id)}</td><td className={td}>{tn(t.tool_type)}</td><td className={td}>{rollerLabel(factory, size(t.roller_id))}</td>
            <td className={td}>{t.dim_key || '—'}</td><td className={td}>{t.lines}</td><td className={td}>{n0(Number(t.kg))}</td><td className={`${td} font-bold`}>{n0(Number(t.rollers))}</td></tr>)}</tbody></table></div>}
      </div></>}
  </div>);
}