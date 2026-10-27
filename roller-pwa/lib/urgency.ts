import type { Priority } from '@/types/database';

// Database values are kept as they are: Normal = BUFFER_NEXT_SHIFT, Urgent = URGENT, Breakdown / Line Down = URGENT_MACHINE_DOWN
export type UrgencyMeta = { label: string; short: string; rank: number; chip: string; border: string };
export const URGENCY: Record<Priority, UrgencyMeta> = {
  URGENT_MACHINE_DOWN: { label: 'Breakdown / Line Down', short: 'Breakdown', rank: 0, chip: 'bg-red-600 text-white', border: 'border-red-500' },
  URGENT: { label: 'Urgent', short: 'Urgent', rank: 1, chip: 'bg-amber-500 text-slate-950', border: 'border-amber-500' },
  BUFFER_NEXT_SHIFT: { label: 'Normal', short: 'Normal', rank: 2, chip: 'bg-slate-500 text-white', border: 'border-slate-700' } };
export const URGENCY_ORDER: Priority[] = ['URGENT_MACHINE_DOWN', 'URGENT', 'BUFFER_NEXT_SHIFT'];

// Queue order inside a factory column: Breakdown > Urgent > Normal, then oldest request first (FIFO)
export const cmpQueue = (a: { priority: Priority; created_at: string }, b: { priority: Priority; created_at: string }) =>
  URGENCY[a.priority].rank - URGENCY[b.priority].rank || +new Date(a.created_at) - +new Date(b.created_at);
