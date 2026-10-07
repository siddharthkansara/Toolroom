'use client';
import { useEffect, useState, useCallback } from 'react';
import { supabase } from './supabase';
import type { OrderFull } from '@/types/database';

export const SEL = '*, roller:roller_master(roller_size, customer_drg, party_name), tooling:tooling_master(*)';
export function useOrders() {
  const [orders, setOrders] = useState<OrderFull[]>([]);
  const load = useCallback(async () => {
    const { data } = await supabase.from('tool_orders').select(SEL).order('created_at', { ascending: false }).limit(1000);
    if (data) setOrders(data as unknown as OrderFull[]);
  }, []);
  useEffect(() => {
    load();
    const ch = supabase.channel('orders-' + Math.random()).on('postgres_changes',
      { event: '*', schema: 'public', table: 'tool_orders' }, load).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);
  return { orders, reload: load };
}
export const chime = () => { try {
  const c = new (window.AudioContext || (window as any).webkitAudioContext)();
  [660, 880].forEach((f, i) => { const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = f; o.connect(g); g.connect(c.destination);
    g.gain.setValueAtTime(0.25, c.currentTime + i * 0.18); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + i * 0.18 + 0.4);
    o.start(c.currentTime + i * 0.18); o.stop(c.currentTime + i * 0.18 + 0.45); });
} catch {} };
export const dt = (d: string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
export const gkey = (o: OrderFull) => o.order_group ?? `${o.machine_id}|${o.roller_id}|${o.created_at.slice(0, 16)}`;   // one key per order placed together
export const uuid = () => (globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
