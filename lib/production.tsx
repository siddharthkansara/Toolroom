'use client';
import { useEffect, useState, type ReactElement } from 'react';
import { supabase, rpc } from '@/lib/supabase';
import { mname, FACTORIES } from '@/lib/factories';


type Line = { work_date: string; shift: 'DAY' | 'NIGHT'; factory_id: string; machine_id: string; status: string; operator_name: string | null; roller_size: string | null; rollers: number; weight_kg: number | null; note: string | null };
type DayRow = { work_date: string; shift: 'DAY' | 'NIGHT'; rollers: number; weight_kg: number | null; rollers_cap: number; capacity: number };
type Head = { id: string; factory_id: string; daily_capacity: number | null };

const rpcData = <T,>(fn: string, args: object) => (supabase.rpc as unknown as (f: string, a: object) => Promise<{ data: T | null; error: { message: string } | null }>).call(supabase, fn, args);
const n0 = (n: number) => Math.round(n).toLocaleString('en-IN');
const kg = (w: number | null | undefined) => (w ? w.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : '—');
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);
const P = ({ v }: { v: number | null }) => v == null ? <span className="text-slate-500">—</span> : <span className={v >= 85 ? 'text-green-400 font-bold' : v >= 60 ? 'text-amber-300 font-bold' : 'text-red-400 font-bold'}>{v.toFixed(1)}%</span>;
const dayLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const spanDays = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const nat = (a: string, b: string) => mname(a).localeCompare(mname(b), undefined, { numeric: true });
const th = 'px-3 py-2 whitespace-nowrap'; const td = 'px-3 py-2 whitespace-nowrap';

function useHeads(factory: string) {
  const [h, setH] = useState<Head[]>([]);
  useEffect(() => { (async () => {
    const { data } = await supabase.from('header_machines').select('id, factory_id, daily_capacity').eq('factory_id', factory);
    setH((data ?? []) as unknown as Head[]);
  })(); }, [factory]);
  return h;
}
function useRpc<T>(fn: string, factory: string, from: string, to: string, on: boolean) {
  const [data, setData] = useState<T[]>([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => {
    if (!on) return; let ok = true;
    (async () => {
      setBusy(true); setErr('');
      const r = await rpcData<T[]>(fn, { p_from: from, p_to: to, p_factory: factory });
      if (!ok) return; setBusy(false);
      if (r.error) { setErr(r.error.message); return; }
      setData(r.data ?? []);
    })();
    return () => { ok = false; };
  }, [fn, factory, from, to, on]);
  return { data, busy, err };
}

// ---- Production table: date wise, with shift totals, day totals and a period total at the end ----
// from / to are dates (YYYY-MM-DD), to is exclusive. Utilisation = rollers / (header capacity); a shift is half a day.
export function ProductionTable({ factory, from, to }: { factory: string; from: string; to: string }) {
  const long = spanDays(from, to) > 62;
  const [mode, setMode] = useState<'lines' | 'days'>(long ? 'days' : 'lines');
  useEffect(() => { setMode(long ? 'days' : 'lines'); }, [long]);
  const heads = useHeads(factory); const capOf = new Map(heads.map(h => [h.id, h.daily_capacity]));
  const sc = heads.reduce((a, h) => a + (h.daily_capacity ?? 0), 0) / 2;       // capacity of all headers for one shift
  const L = useRpc<Line>('report_lines', factory, from, to, mode === 'lines'); const D = useRpc<DayRow>('report_util_days', factory, from, to, mode === 'days');
  const busy = mode === 'lines' ? L.busy : D.busy; const err = mode === 'lines' ? L.err : D.err;
  const sub = 'bg-slate-800 font-bold', tot = 'bg-amber-400/20 font-extrabold';
    const rows: ReactElement[] = []; let tR = 0, tW = 0, tRc = 0, tS = 0;

  if (mode === 'lines') {
    Array.from(new Set(L.data.map(x => x.work_date))).sort().forEach(d => {
      let dR = 0, dW = 0, dRc = 0, dS = 0;
      (['DAY', 'NIGHT'] as const).forEach(sh => {
        const ls = L.data.filter(x => x.work_date === d && x.shift === sh).sort((a, b) => nat(a.machine_id, b.machine_id)); if (!ls.length) return;
        let sR = 0, sW = 0, sRc = 0;
        ls.forEach((x, i) => {
          const cap = capOf.get(x.machine_id) ?? null; sR += x.rollers; sW += x.weight_kg ?? 0; if (cap) sRc += x.rollers;
          rows.push(<tr key={`${d}${sh}${i}`} className="border-t border-slate-800"><td className={td}>{dayLabel(d)}</td><td className={td}>{sh === 'DAY' ? '☀ Day' : '🌙 Night'}</td><td className={td + ' font-bold'}>{mname(x.machine_id)}</td>
            <td className={td}>{x.status === 'NOT_RUNNING' ? <span className="text-slate-400">Not running</span> : x.operator_name ?? '—'}</td><td className={td + ' font-bold'}>{x.roller_size ?? '—'}</td>
            <td className={td}>{n0(x.rollers)}</td><td className={td}>{kg(x.weight_kg)}</td><td className={td}><P v={cap ? pct(x.rollers, cap / 2) : null}/></td></tr>);
        });
        rows.push(<tr key={`${d}${sh}s`} className={`border-t border-slate-700 ${sub}`}><td className={td} colSpan={5}>{sh === 'DAY' ? '☀ Day shift total' : '🌙 Night shift total'} · {dayLabel(d)}</td><td className={td}>{n0(sR)}</td><td className={td}>{kg(sW)}</td><td className={td}><P v={pct(sRc, sc)}/></td></tr>);
        dR += sR; dW += sW; dRc += sRc; dS++;
      });
      rows.push(<tr key={`${d}t`} className={`border-t border-slate-700 ${tot}`}><td className={td} colSpan={5}>Day total · {dayLabel(d)}</td><td className={td}>{n0(dR)}</td><td className={td}>{kg(dW)}</td><td className={td}><P v={pct(dRc, sc * dS)}/></td></tr>);
      tR += dR; tW += dW; tRc += dRc; tS += dS;
    });
  } else {
    Array.from(new Set(D.data.map(x => x.work_date))).sort().forEach(d => {
      const a = D.data.find(x => x.work_date === d && x.shift === 'DAY'), b = D.data.find(x => x.work_date === d && x.shift === 'NIGHT');
      const r = (a?.rollers ?? 0) + (b?.rollers ?? 0), w = Number(a?.weight_kg ?? 0) + Number(b?.weight_kg ?? 0), rc = (a?.rollers_cap ?? 0) + (b?.rollers_cap ?? 0), cp = (a?.capacity ?? 0) + (b?.capacity ?? 0);
      const c = (x?: DayRow) => x ? <span>{n0(x.rollers)} · <P v={pct(x.rollers_cap, x.capacity)}/></span> : <span className="text-slate-500">—</span>;
      rows.push(<tr key={d} className="border-t border-slate-800"><td className={td + ' font-bold'}>{dayLabel(d)}</td><td className={td}>{c(a)}</td><td className={td}>{c(b)}</td><td className={td + ' font-extrabold text-amber-300'}>{n0(r)}</td><td className={td}>{kg(w)}</td><td className={td}><P v={pct(rc, cp)}/></td></tr>);
      tR += r; tW += w; tRc += rc; tS += cp;     // in days mode tS holds total capacity
    });
  }
  const totalUtil = mode === 'lines' ? pct(tRc, sc * tS) : pct(tRc, tS);

  return (<div className="space-y-3">
    {long && <p className="text-sm text-slate-400">Long period: showing one row per day. Pick a single month to see every line.</p>}
    {!long && <div className="grid grid-cols-2 gap-2 max-w-sm">{(['lines', 'days'] as const).map(m => <button key={m} onClick={() => setMode(m)} className={`min-h-12 rounded-xl border-2 text-lg font-bold ${mode === m ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{m === 'lines' ? 'All lines' : 'Day summary'}</button>)}</div>}
    {sc === 0 && <p className="text-sm text-amber-300">Utilisation shows once header capacities are set (owner: Dashboard → Shift sheet reports → Headers).</p>}
    {err && <p className="text-red-400 font-semibold">Could not load: {err}</p>}
    {busy && <p className="text-slate-400">Loading…</p>}
    {mode === 'lines' && L.data.length >= 1000 && <p className="text-amber-300 text-sm">Showing the first 1,000 lines only. Use Day summary for this period.</p>}
    <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full text-left" style={{ minWidth: mode === 'lines' ? 760 : 600 }}>
      <thead className="bg-slate-800 text-slate-300 text-sm"><tr>{(mode === 'lines' ? ['Date', 'Shift', 'Header', 'Operator', 'Roller size', 'Rollers', 'Weight (kg)', 'Utilisation'] : ['Date', 'Day shift', 'Night shift', 'Day total rollers', 'Weight (kg)', 'Day utilisation']).map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
      <tbody>{rows}
        {!rows.length && !busy && <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">No shift sheet data in this period.</td></tr>}
        {rows.length > 0 && (mode === 'lines'
          ? <tr className={`border-t-2 border-slate-600 ${tot}`}><td className={td} colSpan={5}>Period total · average utilisation</td><td className={td}>{n0(tR)}</td><td className={td}>{kg(tW)}</td><td className={td}><P v={totalUtil}/></td></tr>
          : <tr className={`border-t-2 border-slate-600 ${tot}`}><td className={td} colSpan={3}>Period total · average utilisation</td><td className={td}>{n0(tR)}</td><td className={td}>{kg(tW)}</td><td className={td}><P v={totalUtil}/></td></tr>)}</tbody></table></div>
    <p className="text-xs text-slate-500">Utilisation = rollers forged ÷ the header’s capacity for the shift (half its daily capacity). Shift and day figures use all headers with a capacity set, so a header that did not run counts as 0%. Weight is what was typed on the sheet.</p>
  </div>);
}

// ---- Header utilisation grid: dates down, headers across ----
export function UtilGrid({ factory, from, to }: { factory: string; from: string; to: string }) {
  const long = spanDays(from, to) > 62; const [view, setView] = useState<'ALL' | 'DAY' | 'NIGHT'>('ALL');
  const heads = useHeads(factory).filter(h => h.daily_capacity).sort((a, b) => nat(a.id, b.id)); const L = useRpc<Line>('report_lines', factory, from, to, !long);
  if (long) return <p className="text-slate-400">The grid shows one month at a time. Pick a single month.</p>;
  const dates = Array.from(new Set(L.data.map(x => x.work_date))).sort();
  const inView = (s: string) => view === 'ALL' || s === view;
  const shiftsOn = (d: string) => new Set(L.data.filter(x => x.work_date === d && inView(x.shift)).map(x => x.shift)).size;
  const cell = (d: string, h: Head) => { const ls = L.data.filter(x => x.work_date === d && x.machine_id === h.id && inView(x.shift)); if (!ls.length) return null; return { r: ls.reduce((a, x) => a + x.rollers, 0), cap: (h.daily_capacity as number) / 2 * shiftsOn(d) }; };
  const totalsByHead = heads.map(h => dates.reduce((a, d) => { const c = cell(d, h); return c ? { r: a.r + c.r, cap: a.cap + c.cap } : a; }, { r: 0, cap: 0 }));
  const dayAvg = (d: string) => { let r = 0, cap = 0; heads.forEach(h => { const c = cell(d, h); r += c?.r ?? 0; cap += ((h.daily_capacity as number) / 2) * shiftsOn(d); }); return pct(r, cap); };
  const allR = totalsByHead.reduce((a, x) => a + x.r, 0), allCap = dates.reduce((a, d) => a + heads.reduce((b, h) => b + ((h.daily_capacity as number) / 2) * shiftsOn(d), 0), 0);
  return (<div className="space-y-3">
    <div className="grid grid-cols-3 gap-2 max-w-xl">{([['ALL', 'Whole day'], ['DAY', '☀ Day shift'], ['NIGHT', '🌙 Night shift']] as const).map(([v, l]) => <button key={v} onClick={() => setView(v)} className={`min-h-12 rounded-xl border-2 text-base font-bold ${view === v ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{l}</button>)}</div>
    {!heads.length && <p className="text-sm text-amber-300">No header capacities are set yet (owner: Dashboard → Shift sheet reports → Headers).</p>}
    {L.err && <p className="text-red-400 font-semibold">Could not load: {L.err}</p>}
    {L.busy && <p className="text-slate-400">Loading…</p>}
    <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full text-left" style={{ minWidth: 120 + heads.length * 80 }}>
      <thead className="bg-slate-800 text-slate-300 text-sm"><tr><th className={th}>Date</th>{heads.map(h => <th key={h.id} className={th}>{mname(h.id)}</th>)}<th className={th}>Average</th></tr></thead>
      <tbody>{dates.filter(d => shiftsOn(d) > 0).map(d => <tr key={d} className="border-t border-slate-800"><td className={td + ' font-bold'}>{dayLabel(d)}</td>
        {heads.map(h => { const c = cell(d, h); return <td key={h.id} className={td}><P v={c ? pct(c.r, c.cap) : null}/></td>; })}<td className={td + ' bg-slate-800'}><P v={dayAvg(d)}/></td></tr>)}
        {!dates.length && !L.busy && <tr><td colSpan={heads.length + 2} className="px-3 py-6 text-center text-slate-500">No shift sheet data in this period.</td></tr>}
        {dates.length > 0 && <tr className="border-t-2 border-slate-600 bg-amber-400/20 font-extrabold"><td className={td}>Average</td>{totalsByHead.map((t, i) => <td key={heads[i].id} className={td}><P v={pct(t.r, t.cap)}/></td>)}<td className={td}><P v={pct(allR, allCap)}/></td></tr>}</tbody></table></div>
    <p className="text-xs text-slate-500">Each cell = rollers forged ÷ that header’s capacity for the chosen shift(s). “—” means no entry for that header. Green 85% and above, amber 60–85%, red below 60%.</p>
  </div>);
}

// ---- Owner: set each header's capacity (rollers per day at 100%) ----
export function CapacityEditor() {
  const [rows, setRows] = useState<Head[]>([]); const [vals, setVals] = useState<Record<string, string>>({}); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false); const [fac, setFac] = useState<string>(FACTORIES[0]);
  const load = async () => {
    const { data } = await supabase.from('header_machines').select('id, factory_id, daily_capacity');
    const r = (data ?? []) as unknown as Head[]; setRows(r); const v: Record<string, string> = {}; r.forEach(x => { v[x.id] = x.daily_capacity ? String(x.daily_capacity) : ''; }); setVals(v);
  };
  useEffect(() => { load(); }, []);
  const mine = rows.filter(r => r.factory_id === fac).sort((a, b) => nat(a.id, b.id));
  const save = async () => {
    setBusy(true); let n = 0;
    for (const r of mine) {
      const now = Math.round(+(vals[r.id] ?? '').replace(/,/g, '') || 0); const was = r.daily_capacity ?? 0;
      if (now === was) continue;
      const { error } = await rpc('set_header_capacity', { p_id: r.id, p_capacity: now > 0 ? now : null });
      if (error) { setMsg(`Could not save ${mname(r.id)}: ${error.message}`); setBusy(false); return; }
      n++;
    }
    setBusy(false); setMsg(n ? `Saved ${n} header${n === 1 ? '' : 's'}.` : 'Nothing changed.'); load();
  };
  return (<div className="rounded-xl bg-slate-800 p-4 space-y-3"><h3 className="text-lg font-bold">Header capacity</h3>
    <p className="text-sm text-slate-400">Rollers a header can forge in a full day at 100%. A shift is half of this. Leave blank if not known yet.</p>
    <div className="flex gap-2 flex-wrap">{FACTORIES.map(f => <button key={f} onClick={() => setFac(f)} className={`min-h-12 px-5 rounded-xl border-2 text-lg font-bold ${fac === f ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`}>{f}</button>)}</div>
    <div className="grid sm:grid-cols-2 gap-3">{mine.map(r => <label key={r.id} className="block"><span className="block text-sm font-semibold text-slate-300 mb-1">{mname(r.id)}</span><input inputMode="numeric" className="h-14 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full" value={vals[r.id] ?? ''} onChange={e => setVals({ ...vals, [r.id]: e.target.value })}/></label>)}
      {!mine.length && <p className="text-slate-500">No headers found for {fac}.</p>}</div>
    <div className="flex items-center gap-3 flex-wrap"><button className="min-h-14 px-6 rounded-xl bg-green-600 text-white text-xl font-bold disabled:opacity-50" disabled={busy} onClick={save}>Save capacities</button><span className="text-amber-300 font-semibold">{msg}</span></div></div>);
}
