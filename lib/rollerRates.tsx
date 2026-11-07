'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { FACTORIES } from '@/lib/factories';

// Owner only: rollers per kg for every roller size. Every change is kept as history in the database.
// The shift sheet will use these numbers to turn weight (kg) into a roller count.

type Rate = { roller_id: string; roller_size: string; party_name: string | null; customer_drg: string | null; rollers_per_kg: number | null; set_at: string | null };
type Hist = { rollers_per_kg: number; set_at: string };
const rpcData = <T,>(fn: string, args: object) => (supabase.rpc as unknown as (f: string, a: object) => Promise<{ data: T | null; error: { message: string } | null }>).call(supabase, fn, args);
const inp = 'h-12 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full text-right';
const lbl = 'block text-sm font-semibold text-slate-300 mb-1';
const btnGreen = 'min-h-14 px-6 rounded-xl bg-green-600 text-white text-xl font-bold disabled:opacity-50';
const chip = (on: boolean) => `px-5 min-h-12 rounded-xl border-2 text-lg font-bold ${on ? 'border-amber-400 bg-amber-400/20' : 'border-slate-700 bg-slate-900'}`;
const fmtRate = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 4 });
const fmtDate = (x: string) => new Date(x).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
const parse = (v: string): number | null => { const s = v.trim().replace(/,/g, ''); if (!/^\d+(\.\d{1,4})?$/.test(s)) return null; const n = +s; return n > 0 && n <= 100000 ? n : null; };

export function RollerRates({ factory }: { factory: string }) {
  const [fac, setFac] = useState(factory); const [rows, setRows] = useState<Rate[]>([]); const [busy, setBusy] = useState(true); const [err, setErr] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({}); const [q, setQ] = useState(''); const [onlyUnset, setOnlyUnset] = useState(false);
  const [msg, setMsg] = useState(''); const [saving, setSaving] = useState(false); const [hist, setHist] = useState<{ id: string; list: Hist[] } | null>(null);

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    const { data, error } = await rpcData<Rate[]>('roller_rates_list', { p_factory: fac });
    if (error) setErr(error.message);
    setRows(error ? [] : data ?? []); setBusy(false);
  }, [fac]);
  useEffect(() => { setEdits({}); setHist(null); setMsg(''); load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 5000); };
  const unset = rows.filter(r => r.rollers_per_kg == null).length;
  const list = rows
    .filter(r => (!onlyUnset || r.rollers_per_kg == null) && `${r.roller_size} ${r.party_name ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (a.rollers_per_kg == null ? 0 : 1) - (b.rollers_per_kg == null ? 0 : 1) || a.roller_size.localeCompare(b.roller_size, undefined, { numeric: true }));

  // changes = typed values that are valid and different from the current rate
  const changes = rows.flatMap(r => { const v = edits[r.roller_id]; if (v == null || v.trim() === '') return []; const n = parse(v); return n != null && n !== r.rollers_per_kg ? [{ r, n }] : []; });
  const invalid = rows.filter(r => { const v = edits[r.roller_id]; return v != null && v.trim() !== '' && parse(v) == null; }).length;

  const save = async () => {
    if (!changes.length || invalid) return;
    const big = changes.filter(c => c.r.rollers_per_kg != null && Math.abs(c.n - c.r.rollers_per_kg) / c.r.rollers_per_kg > 0.25);
    if (big.length && !window.confirm(`${big.length} rate${big.length === 1 ? '' : 's'} change by more than 25%:\n${big.slice(0, 6).map(c => `${c.r.roller_size}: ${fmtRate(c.r.rollers_per_kg as number)} to ${fmtRate(c.n)}`).join('\n')}\n\nSave anyway?`)) return;
    setSaving(true);
    const { data, error } = await rpcData<number>('set_roller_rates', { p_rows: changes.map(c => ({ roller_id: c.r.roller_id, rate: c.n })) });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setErr(''); setEdits({}); flash(`Saved ${data ?? changes.length} rate${(data ?? changes.length) === 1 ? '' : 's'}.`); load();
  };

  const openHist = async (id: string) => {
    if (hist?.id === id) { setHist(null); return; }
    const { data } = await rpcData<Hist[]>('roller_rate_history_of', { p_roller: id });
    setHist({ id, list: data ?? [] });
  };

  return (<div className="space-y-4">
    <div><h2 className="text-2xl font-bold">Rollers per kg</h2>
      <p className="text-sm text-slate-400">Only the owner can change these numbers. The shift sheet uses them to work out how many rollers were forged from the weight. A roller size with no number cannot be entered on the shift sheet.</p></div>
    <div className="flex gap-2 flex-wrap">{FACTORIES.map(f => <button key={f} onClick={() => setFac(f)} className={chip(fac === f)}>{f}</button>)}</div>
    <div className="grid sm:grid-cols-3 gap-3 items-end">
      <label className="block sm:col-span-2"><span className={lbl}>Search roller size or party</span><input className="h-12 rounded-xl bg-slate-900 border-2 border-slate-700 px-3 text-xl w-full" placeholder="Type to search" value={q} onChange={e => setQ(e.target.value)}/></label>
      <button onClick={() => setOnlyUnset(!onlyUnset)} className={chip(onlyUnset)}>Not set yet ({unset})</button></div>
    {busy && <p className="text-slate-400">Loading…</p>}
    {err && <p className="text-red-400 font-semibold">{err}</p>}
    {msg && <p className="text-green-400 font-semibold">{msg}</p>}
    {!busy && !err && !list.length && <p className="text-slate-500 py-4 text-center">{rows.length ? 'No roller size matches.' : `No roller sizes in ${fac} yet.`}</p>}
    {list.length > 0 && <div className="rounded-xl border border-slate-700 bg-slate-900 divide-y divide-slate-800">
      <div className="hidden sm:grid grid-cols-[1fr_9rem_10rem_5rem] gap-3 px-4 py-2 text-sm font-semibold text-slate-400"><span>Roller size · Party</span><span className="text-right">Current</span><span className="text-right">New rollers per kg</span><span/></div>
      {list.map(r => { const v = edits[r.roller_id] ?? ''; const bad = v.trim() !== '' && parse(v) == null; const changed = changes.some(c => c.r.roller_id === r.roller_id);
        return (<div key={r.roller_id} className={changed ? 'bg-amber-400/10' : ''}>
          <div className="grid grid-cols-2 sm:grid-cols-[1fr_9rem_10rem_5rem] gap-x-3 gap-y-1 px-4 py-2 items-center">
            <div className="col-span-2 sm:col-span-1"><div className="text-lg font-extrabold">{r.roller_size}</div><div className="text-sm text-slate-400">{r.party_name ?? 'No party name'}{r.customer_drg ? ` · Drg ${r.customer_drg}` : ''}</div></div>
            <div className="sm:text-right">{r.rollers_per_kg == null ? <span className="text-red-400 font-bold">Not set</span> : <><div className="text-xl font-bold">{fmtRate(r.rollers_per_kg)}</div>{r.set_at && <div className="text-xs text-slate-500">set {fmtDate(r.set_at)}</div>}</>}</div>
            <label className="block"><span className="block text-xs font-semibold text-slate-400 mb-0.5 sm:hidden">New rollers per kg</span>
              <input inputMode="decimal" aria-label={`New rollers per kg for ${r.roller_size}`} className={`${inp} ${bad ? 'border-red-500' : ''}`} value={v} onChange={e => setEdits({ ...edits, [r.roller_id]: e.target.value })} placeholder={r.rollers_per_kg == null ? 'Enter' : ''}/></label>
            <button onClick={() => openHist(r.roller_id)} disabled={r.rollers_per_kg == null} className="min-h-10 text-sm font-bold text-sky-400 disabled:opacity-30 text-right">{hist?.id === r.roller_id ? 'Hide' : 'History'}</button></div>
          {hist?.id === r.roller_id && <div className="px-4 pb-3 text-sm text-slate-300">{hist.list.length ? hist.list.map((h, i) => <div key={i} className="flex gap-4"><span className="w-28 text-slate-400">{fmtDate(h.set_at)}</span><b>{fmtRate(h.rollers_per_kg)}</b>{i === 0 && <span className="text-slate-500">current</span>}</div>) : 'No changes yet.'}</div>}
        </div>); })}</div>}
    {(changes.length > 0 || invalid > 0) && <div className="sticky bottom-3 rounded-2xl border-2 border-amber-400 bg-slate-900 p-3 flex items-center gap-3 flex-wrap">
      <div className="flex-1 text-lg font-bold">{invalid > 0 ? <span className="text-red-400">{invalid} number{invalid === 1 ? ' is' : 's are'} not valid (use a number above 0, up to 4 decimals)</span> : `${changes.length} change${changes.length === 1 ? '' : 's'} to save`}</div>
      <button onClick={() => setEdits({})} className="min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold">Clear</button>
      <button onClick={save} disabled={saving || invalid > 0 || !changes.length} className={btnGreen}>{saving ? 'Saving…' : 'Save'}</button></div>}
  </div>);
}
