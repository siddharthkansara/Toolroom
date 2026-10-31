'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { istDate, needsAction } from '@/lib/inventory';
import { TOOL_LABEL, type InventoryRequest, type ToolType } from '@/types/database';
import { FACTORIES, FCHIP } from '@/lib/factories';

const MORNING_REMINDER = true;     // false = evening reminder only
const OFF_DAYS: number[] = [];     // days with no reminder, 0 = Sunday ... for example [0]

// Banner on the toolroom screen. 7 am: night-shift update. 6 pm: today's update. Red after 8 pm.
export function StockReminder({ factory, onOpen }: { factory: string; onOpen: () => void }) {
  const [has, setHas] = useState(false); const [slots, setSlots] = useState<string[]>([]); const [, setTick] = useState(0);
  const load = useCallback(async () => {
    if (!factory) return;
    const [s, c] = await Promise.all([
      supabase.from('inventory_stock').select('roller_id').eq('factory_id', factory).limit(1),
      supabase.from('inventory_daily_checks').select('slot').eq('factory_id', factory).eq('check_date', istDate())]);
    setHas(!!(s.data && s.data.length)); setSlots(((c.data ?? []) as unknown as { slot: string }[]).map(x => x.slot));
  }, [factory]);
  useEffect(() => {
    load(); const t = setInterval(() => { load(); setTick(n => n + 1); }, 60000); const h = () => load();
    window.addEventListener('stock-check', h); return () => { clearInterval(t); window.removeEventListener('stock-check', h); };
  }, [load]);
  const now = new Date(Date.now() + 330 * 60000); const hr = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (!has || OFF_DAYS.includes(now.getUTCDay())) return null;     // no reminders until the factory has stock
  let kind = '';
  if (hr >= 18 && !slots.includes('EVENING')) kind = hr >= 20 ? 'late' : 'evening';
  else if (MORNING_REMINDER && hr >= 7 && hr < 14 && !slots.includes('MORNING')) kind = 'morning';
  if (!kind) return null;
  return (<button onClick={onOpen} className={`w-full mb-4 rounded-2xl border-2 px-4 py-4 text-left flex items-center gap-3 ${kind === 'late' ? 'border-red-500 bg-red-600/30' : 'border-amber-400 bg-amber-400/20'}`}>
    <span className="text-3xl">📦</span>
    <span className="flex-1"><b className="block text-xl">{kind === 'morning' ? 'Update stock used by the night shift' : 'Update today’s stock'}</b>
      <span className="text-slate-300 text-sm">Mark tools hardened or taken out, then tap “Update done”.</span></span>
    <span className="text-xl font-bold">Open ›</span></button>);
}

// Owner card for the dashboard: who updated when.
export function StockFreshness() {
  const [chk, setChk] = useState<Record<string, string>>({}); const [mv, setMv] = useState<Record<string, string>>({});
  useEffect(() => { (async () => {
    const last = async (table: 'inventory_daily_checks' | 'inventory_moves', f: string) => {
      const { data } = await supabase.from(table).select('created_at').eq('factory_id', f).order('created_at', { ascending: false }).limit(1);
      return ((data ?? []) as unknown as { created_at: string }[])[0]?.created_at ?? '';
    };
    const c: Record<string, string> = {}, m: Record<string, string> = {};
    await Promise.all(FACTORIES.map(async f => { c[f] = await last('inventory_daily_checks', f); m[f] = await last('inventory_moves', f); }));
    setChk(c); setMv(m);
  })(); }, []);
  const ago = (t?: string) => {
    if (!t) return { txt: 'Never', bad: true };
    const days = Math.floor((+new Date(istDate()) - +new Date(new Date(+new Date(t) + 330 * 60000).toISOString().slice(0, 10))) / 86400000);
    return { txt: days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`, bad: days >= 2 };
  };
  return (<section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-4"><h2 className="text-xl font-bold mb-3">Inventory updates by factory</h2>
    <div className="overflow-x-auto"><table className="w-full min-w-[420px] text-left"><thead className="text-slate-400 text-sm"><tr><th className="py-2">Factory</th><th>Last daily update</th><th>Last stock change</th></tr></thead>
      <tbody>{FACTORIES.map(f => { const a = ago(chk[f]), b = ago(mv[f]); return (<tr key={f} className="border-t border-slate-800">
        <td className="py-2"><span className={`${FCHIP[f] ?? 'bg-slate-600'} text-white rounded-lg px-2 py-0.5 font-extrabold`}>{f}</span></td>
        <td className={a.bad ? 'text-red-400 font-bold' : 'text-green-400 font-bold'}>{a.txt}</td>
        <td className={b.bad ? 'text-red-400 font-bold' : 'text-slate-300 font-bold'}>{b.txt}</td></tr>); })}</tbody></table></div></section>);
}

// Banner on the toolroom screens when a request needs this factory's action (answer, move, or confirm receipt).
export function RequestBanner({ factory, onOpen }: { factory: string; onOpen: () => void }) {
  const [reqs, setReqs] = useState<InventoryRequest[]>([]);
  const load = useCallback(async () => {
    if (!factory) return;
    const { data } = await supabase.from('inventory_requests').select('*').or(`source_factory.eq.${factory},requester_factory.eq.${factory}`).in('status', ['REQUESTED', 'APPROVED', 'IN_TRANSIT']);
    setReqs((data ?? []) as unknown as InventoryRequest[]);
  }, [factory]);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  const needs = reqs.filter(x => needsAction(x, factory)); if (!needs.length) return null;
  const arriving = needs.find(x => x.requester_factory === factory && x.status === 'IN_TRANSIT');
  const more = needs.length > 1 ? ` · ${needs.length - 1} more` : '';
  const title = arriving ? `Did you receive tools from ${arriving.source_factory}?` : `${needs.length} tool request${needs.length === 1 ? '' : 's'} need${needs.length === 1 ? 's' : ''} your action`;
  const sub = arriving ? `${arriving.qty_sent} × ${TOOL_LABEL[arriving.tool_type as ToolType] ?? arriving.tool_type} · size ${arriving.roller_size}${more}. Tap to answer.` : `Tap to open Requests.`;
  return (<button onClick={onOpen} className="w-full mb-4 rounded-2xl border-2 border-amber-400 bg-amber-400/20 px-4 py-4 text-left flex items-center gap-3">
    <span className="text-3xl">{arriving ? '📦' : '📨'}</span>
    <span className="flex-1"><b className="block text-xl">{title}</b><span className="text-slate-300 text-sm">{sub}</span></span>
    <span className="text-xl font-bold">Open ›</span></button>);
}
