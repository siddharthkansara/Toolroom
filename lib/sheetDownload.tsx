'use client';
import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { mname } from '@/lib/factories';

// Shift sheet download (CSV for Excel): every line with party, roller size, operator, batch, heat, weight,
// rollers per kg, rollers forged and the tools used, plus a Total row. One month, or all months with data.

type Line = { work_date: string; shift: string; factory_id: string; machine_id: string; status: string; operator_name: string | null; roller_size: string | null;
  rollers: number; weight_kg: number | null; note: string | null; party_name: string | null; batch_no: string | null; heat_no: string | null; rollers_per_kg: number | null;
  die_top: number; bottom: number; facing_punch: number; short_pin: number };
const rpcData = <T,>(fn: string, args: object) => (supabase.rpc as unknown as (f: string, a: object) => Promise<{ data: T | null; error: { message: string } | null }>).call(supabase, fn, args);
const addDays = (day: string, n: number) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monthStart = (day: string) => day.slice(0, 7) + '-01';
const nextMonth = (day: string) => { const d = new Date(monthStart(day) + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); };
const btn = 'min-h-12 px-5 rounded-xl border-2 border-slate-700 bg-slate-900 text-lg font-bold disabled:opacity-50';

// the report returns at most 1000 rows per call, so a busy stretch is split in halves until each part fits
const fetchRange = async (factory: string, from: string, to: string): Promise<{ lines: Line[]; error: string }> => {
  const { data, error } = await rpcData<Line[]>('report_lines', { p_from: from, p_to: to, p_factory: factory });
  if (error) return { lines: [], error: error.message };
  const rows = data ?? [];
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  if (rows.length >= 1000 && days > 1) {
    const mid = addDays(from, Math.floor(days / 2));
    const a = await fetchRange(factory, from, mid); if (a.error) return a;
    const b = await fetchRange(factory, mid, to); if (b.error) return b;
    return { lines: [...a.lines, ...b.lines], error: '' };
  }
  return { lines: rows, error: '' };
};

const HEAD = ['Factory', 'Date', 'Shift', 'Header', 'Party', 'Roller size', 'Operator', 'Batch no.', 'Heat no.', 'Weight (kg)', 'Rollers per kg', 'Rollers forged', 'Die Top', 'Bottom', 'Forging Punch', 'Forging Pin', 'Status', 'Remarks'];
const toCsv = (lines: Line[]): string => {
  const sum = (f: (l: Line) => number) => lines.reduce((a, l) => a + f(l), 0);
  const out: (string | number)[][] = [HEAD, ...lines.map(l => [l.factory_id, l.work_date, l.shift === 'DAY' ? 'Day' : 'Night', mname(l.machine_id), l.party_name ?? '', l.roller_size ?? '',
    l.operator_name ?? '', l.batch_no ?? '', l.heat_no ?? '', l.weight_kg ?? '', l.rollers_per_kg ?? '', l.rollers, l.die_top, l.bottom, l.facing_punch, l.short_pin,
    l.status === 'NOT_RUNNING' ? 'Not running' : 'Ran', l.note ?? ''])];
  out.push(['Total', '', '', '', '', '', '', '', '', sum(l => Number(l.weight_kg ?? 0)), '', sum(l => l.rollers), sum(l => l.die_top), sum(l => l.bottom), sum(l => l.facing_punch), sum(l => l.short_pin), '', '']);
  return '\ufeff' + out.map(r => r.map(c => (typeof c === 'number' ? String(c) : `"${c.replace(/"/g, '""')}"`)).join(',')).join('\r\n');
};
const save = (text: string, name: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = name; a.click(); };

export function SheetDownload({ factory, from, to }: { factory: string; from: string; to: string }) {
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 6000); };

  const month = async () => {
    setBusy(true); setMsg('Preparing…');
    const r = await fetchRange(factory, from, to); setBusy(false);
    if (r.error) { flash(`Could not download: ${r.error}`); return; }
    if (!r.lines.length) { flash('No shift sheet lines in this month.'); return; }
    save(toCsv(r.lines), `shift-sheet_${factory}_${from.slice(0, 7)}.csv`); flash(`Downloaded ${r.lines.length} lines.`);
  };
  const all = async () => {
    setBusy(true); setMsg('Finding the first month with data…');
    const first = await supabase.from('shift_entries_live').select('work_date').eq('factory_id', factory).order('work_date', { ascending: true }).limit(1).maybeSingle();
    const start = (first.data as unknown as { work_date: string } | null)?.work_date;
    if (!start) { setBusy(false); flash('No shift sheet lines yet.'); return; }
    const now = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    let lines: Line[] = []; let m = monthStart(start); const end = nextMonth(now); let n = 0; const total = Math.max(1, Math.round((Date.parse(end) - Date.parse(m)) / (30.5 * 86400000)));
    while (m < end) {
      n++; setMsg(`Preparing… month ${Math.min(n, total)} of about ${total}`);
      const r = await fetchRange(factory, m, nextMonth(m));
      if (r.error) { setBusy(false); flash(`Could not download: ${r.error}`); return; }
      lines = lines.concat(r.lines); m = nextMonth(m);
    }
    setBusy(false);
    if (!lines.length) { flash('No shift sheet lines yet.'); return; }
    save(toCsv(lines), `shift-sheet_${factory}_all-months.csv`); flash(`Downloaded ${lines.length} lines from ${start.slice(0, 7)} to ${now.slice(0, 7)}.`);
  };

  return (<div className="flex gap-3 flex-wrap items-center">
    <button className={btn} disabled={busy} onClick={month}>⬇ Download this month</button>
    <button className={btn} disabled={busy} onClick={all}>⬇ Download all months</button>
    {msg && <span className="text-sm font-semibold text-amber-300">{msg}</span>}
  </div>);
}
