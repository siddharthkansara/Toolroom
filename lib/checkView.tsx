import type { DimCheck } from '@/types/database';
import { checkText, checkMismatch } from '@/lib/dimCheck';

// Shows what the CNC wrote down and what the plant found, wherever a batch is listed
export function CheckLines({ d }: { d: { cnc_check?: DimCheck | null; plant_check?: DimCheck | null } }) {
  const c = d.cnc_check, p = d.plant_check;
  if (!c && !p) return null;
  return (<div className="w-full text-sm space-y-0.5">
    {c && <div className="text-sky-400">📏 CNC checked: {checkText(c)}</div>}
    {p && <div className={checkMismatch(p) ? 'text-red-400 font-semibold' : 'text-green-400'}>{checkMismatch(p) ? '⚠ Plant says NOT matching' : '✔ Plant checked, matches'}: {checkText(p)}{p.note ? ` · ${p.note}` : ''}</div>}
  </div>);
}
// Tiny marker for a batch row: 📏 = CNC wrote a check, ⚠ = the plant says it does not match
export function CheckBadge({ d }: { d: { cnc_check?: DimCheck | null; plant_check?: DimCheck | null } }) {
  if (!d.cnc_check && !d.plant_check) return null;
  const bad = checkMismatch(d.plant_check);
  return <span title={checkText(d.cnc_check)} className={bad ? 'text-red-400 font-bold' : 'text-sky-400'}>{bad ? ' ⚠ check' : ' 📏'}</span>;
}

// Short summary for a list of batches, e.g. in the dashboard's monthly orders table
export function CheckSummary({ ds }: { ds: { cnc_check?: DimCheck | null; plant_check?: DimCheck | null }[] }) {
  if (!ds.length) return null;
  const checked = ds.filter(d => d.cnc_check).length, bad = ds.filter(d => checkMismatch(d.plant_check)).length;
  return <span className={bad ? 'text-red-400 font-semibold' : 'text-slate-400'}>{bad ? `⚠ ${bad} mismatch · ` : ''}📏 {checked}/{ds.length}</span>;
}