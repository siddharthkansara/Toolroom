// ---- Tool life on the shift sheet ----
// Set TOOL_LIFE to false to switch the whole feature off in the app: the sheet then works the old way.
import type { ShiftToolUse, ToolLife } from '@/types/database';

export const TOOL_LIFE = true;
export const TRACKED = ['DIE_TOP', 'BOTTOM'];   // keep in step with the database function

export type Outcome = 'ON' | 'WORN_OUT' | 'REMOVED';
// One tool used in a line. tool_id = a tool already on the machine; null = a new tool. dim_key null = the only size in stock.
export type TRow = { tool_id: string | null; dim_key: string | null; kg: string; outcome: Outcome };
// A tool already on the machine, with its life so far
export type OnTool = { id: string; roller_id: string; dim_key: string; kg: number; rollers: number };

export const OUTCOME_LABEL: Record<Outcome, string> = { ON: 'Still on the machine', WORN_OUT: 'Worn out', REMOVED: 'Taken off (still usable)' };

const n2 = (v: number) => Math.round(v * 100) / 100;
export const kgOf = (r: TRow) => { const x = parseFloat(r.kg.replace(/,/g, '')); return Number.isFinite(x) && x >= 0 ? n2(x) : NaN; };
export const newTool = (): TRow => ({ tool_id: null, dim_key: null, kg: '', outcome: 'ON' });

// The rows a line starts with for one tool type: the tool already on the machine first, otherwise one new tool
export const startRows = (on: OnTool | undefined): TRow[] => on ? [{ tool_id: on.id, dim_key: null, kg: '', outcome: 'ON' }] : [newTool()];

// Adding another tool: the one before it came off. Only the last row can stay on the machine.
export const addRow = (rows: TRow[]): TRow[] => {
  const last = rows[rows.length - 1];
  return [...rows.slice(0, -1), { ...last, outcome: last.outcome === 'ON' ? 'WORN_OUT' : last.outcome }, newTool()];
};
// Removing a tool that was added by mistake (only new tools can be removed, never the one already on the machine)
export const removeRow = (rows: TRow[], i: number): TRow[] => {
  if (rows.length < 2 || rows[i].tool_id) return rows;
  const out = rows.filter((_, j) => j !== i);
  return i === rows.length - 1 ? [...out.slice(0, -1), { ...out[out.length - 1], outcome: 'ON' }] : out;
};
// The choices for one row's status: only the last row can stay on the machine
export const outcomes = (i: number, n: number): Outcome[] => i === n - 1 ? ['ON', 'WORN_OUT', 'REMOVED'] : ['WORN_OUT', 'REMOVED'];

// kg added up across the rows
export const assigned = (rows: TRow[]) => n2(rows.reduce((a, r) => a + (Number.isNaN(kgOf(r)) ? 0 : kgOf(r)), 0));

// What to tell the person, or '' when this tool type is ready to save
export function problem(label: string, rows: TRow[], weight: number, on: OnTool | undefined, roller: string): string {
  if (rows.some(r => Number.isNaN(kgOf(r)))) return `Enter the kg for each ${label} (0 or more).`;
  if (Math.abs(assigned(rows) - weight) > 0.005) return `The ${label} kg add up to ${assigned(rows)}, but the line weight is ${weight} kg.`;
  if (on && on.roller_id !== roller && rows.some(r => r.tool_id === on.id && (kgOf(r) > 0 || r.outcome === 'ON')))
    return `The ${label} on this machine is for another roller size. Take it off, with 0 kg.`;
  return '';
}

// The rows in the shape the database function expects
export const toolPayload = (tt: string, rows: TRow[]) =>
  rows.map(r => ({ tool_type: tt, tool_id: r.tool_id, ...(r.dim_key !== null ? { dim_key: r.dim_key } : {}), kg: kgOf(r), outcome: r.outcome }));


// A saved row of a line, with a few facts about its tool (as loaded for editing)
export type UseRow = ShiftToolUse & { tool: { id: string; roller_id: string; dim_key: string; mounted_entry_id: string } | null };

// The saved rows of a line, ready to edit. The database rolls the line back before saving again, so a tool first put on
// in this line is sent as a new tool with the same size, while a tool that was already on the machine keeps its id.
export function rowsFromUse(use: UseRow[] = [], entryId: string): Record<string, TRow[]> {
  const out: Record<string, TRow[]> = {};
  [...use].sort((a, b) => a.seq - b.seq).forEach(u => {
    const mine = u.tool?.mounted_entry_id === entryId;
    (out[u.tool_type] ??= []).push({ tool_id: mine ? null : u.machine_tool_id, dim_key: mine ? (u.tool?.dim_key ?? '') : null, kg: String(u.kg), outcome: u.outcome });
  });
  return out;
}


// ---- Report helpers ----
export type LifeStat = { key: string; sample: ToolLife; tools: number; avgRollers: number; bestRollers: number; worstRollers: number; avgKg: number; avgLines: number };
// Groups tools (by the key you give) and works out how long they lasted: average, best and worst rollers per tool
export function lifeStats(list: ToolLife[], by: (t: ToolLife) => string): LifeStat[] {
  const g = new Map<string, ToolLife[]>();
  list.forEach(t => { const k = by(t); g.set(k, [...(g.get(k) ?? []), t]); });
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  return Array.from(g.entries()).map(([key, ts]) => {
    const r = ts.map(t => Number(t.rollers));
    return { key, sample: ts[0], tools: ts.length, avgRollers: avg(r), bestRollers: Math.max(...r), worstRollers: Math.min(...r), avgKg: avg(ts.map(t => Number(t.kg))), avgLines: avg(ts.map(t => t.lines)) };
  });
}