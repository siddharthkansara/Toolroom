import type { CheckItem, DimCheck, OrderFull, ToolingMaster } from '@/types/database';

const f = (n: number | null | undefined) => (n == null ? '' : String(n));

// The tool as ordered: its type from the roller's tool record, its dimensions from the order itself
export function orderTool(o: OrderFull): ToolingMaster | null {
  return o.tooling ? { ...o.tooling, batta_code: o.batta_code, od_dim: o.od_dim, length_dim: o.length_dim, od2_dim: o.od2_dim, step_id_dim: o.step_id_dim, step_depth_dim: o.step_depth_dim } : null;
}

// The lines to check for one tool. Mirrors the dimensions the screens already show.
export function checkLines(o: OrderFull): { k: string; spec: string }[] {
  const t = orderTool(o);
  if (!t) return [{ k: 'Dimensions', spec: o.custom_dimensions ?? '' }];
  if (t.tool_type === 'DIE_TOP') return [{ k: 'Batta', spec: t.batta_code ?? '' }];
  if (t.tool_type === 'BOTTOM') return [
    { k: 'OD', spec: f(t.od_dim) }, { k: 'Length', spec: f(t.length_dim) },
    { k: 'OD 2', spec: f(t.od2_dim) }, { k: 'Step depth', spec: f(t.step_depth_dim) }];
  if (t.od_dim != null || t.length_dim != null) return [{ k: 'OD', spec: f(t.od_dim) }, { k: 'Length', spec: f(t.length_dim) }];
  return [{ k: 'Dimensions', spec: '' }];
}

// Empty checklist for a tool, ready to be filled in
export const blankCheck = (o: OrderFull): CheckItem[] => checkLines(o).map(l => ({ ...l, v: '' }));

// The lines that must be real numbers (the same rule the database enforces)
const NUM = /^[0-9]+([.][0-9]+)?$/;
const NUM_KEYS = ['OD', 'Length', 'OD 2', 'Step depth'];
// True when a number line has something typed that is not a number
export const itemBad = (i: CheckItem) => NUM_KEYS.includes(i.k) && i.v.trim() !== '' && !NUM.test(i.v.trim());

// What to tell the person, or '' when the checklist is ready
export function checkProblem(items: CheckItem[]): string {
  if (!items.length) return 'Write down the measured dimensions first';
  const empty = items.find(i => i.v.trim() === '');
  if (empty) return `Write the measured value for ${empty.k}`;
  const bad = items.find(itemBad);
  return bad ? `Enter a number for ${bad.k} (for example 25.4)` : '';
}

// True once every line is filled and every number line is a number
export const checkDone = (items: CheckItem[]) => checkProblem(items) === '';

// One line of text for lists and exports, e.g. "OD 25.38 (spec 25.4) · Length 80"
export function checkText(c: DimCheck | null | undefined): string {
  if (!c || !Array.isArray(c.items)) return '';
  return c.items.map(i => `${i.k} ${i.v}${i.spec && i.spec !== i.v ? ` (spec ${i.spec})` : ''}`).join(' · ');
}

// Did the plant flag a mismatch?
export const checkMismatch = (c: DimCheck | null | undefined) => c?.match === false;
// Result word for the plant's check, for exports
export const checkResult = (c: DimCheck | null | undefined) => (!c ? '' : c.match === false ? 'Does not match' : 'Matches');

// Both checks as one piece of text, for the "Batches" cell of an export
export function checkNote(d: { cnc_check?: DimCheck | null; plant_check?: DimCheck | null }): string {
  const c = checkText(d.cnc_check), p = checkText(d.plant_check);
  return `${c ? ` [CNC check: ${c}]` : ''}${p ? ` [Plant check: ${checkMismatch(d.plant_check) ? 'DOES NOT MATCH' : 'matches'}: ${p}${d.plant_check?.note ? ` - ${d.plant_check.note}` : ''}]` : ''}`;
}