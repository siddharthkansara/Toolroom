'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { ThemeToggle } from '@/lib/theme';

export type Role = 'toolroom' | 'cnc' | 'owner';
export const HOME: Record<Role, string> = { toolroom: '/', cnc: '/cnc', owner: '/dashboard' };
type St = { status: 'loading' } | { status: 'ready'; email: string; role: Role | null };

// UX guard only: the real protection is the database rules (07_auth_roles.sql)
export function Guard({ allow, children }: { allow: Role[]; children: React.ReactNode }) {
  const router = useRouter();
  const [st, setSt] = useState<St>({ status: 'loading' });
  const key = allow.join(',');

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.replace('/login'); return; }
      const { data } = await supabase.from('profiles').select('role').eq('id', session.user.id).maybeSingle();
      if (alive) setSt({ status: 'ready', email: session.user.email ?? '', role: (data?.role as Role) ?? null });
    })();
    const { data: sub } = supabase.auth.onAuthStateChange(e => { if (e === 'SIGNED_OUT') router.replace('/login'); });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [router]);

  useEffect(() => {
    if (st.status === 'ready' && st.role && !key.split(',').includes(st.role)) router.replace(HOME[st.role]);
  }, [st, key, router]);

  const signOut = async () => { await supabase.auth.signOut(); router.replace('/login'); };
  const centre = 'min-h-screen flex flex-col gap-4 items-center justify-center text-xl text-slate-400 p-6 text-center';
  if (st.status === 'loading') return <div className={centre}>Loading…</div>;
  if (!st.role) return <div className={centre}>This account has no role yet. Ask the owner.<button onClick={signOut} className="px-6 rounded-xl bg-slate-800 text-slate-100">Log out</button></div>;
  if (!key.split(',').includes(st.role)) return <div className={centre}>Redirecting…</div>;

  return (<>
    <div className="flex items-center justify-between gap-3 bg-slate-900 border-b border-slate-800 px-4 py-2 text-sm">
      <div className="flex gap-3 items-center flex-wrap"><span className="text-slate-400">{st.email} · {st.role}</span>
        {st.role === 'owner' && (['/', '/cnc', '/dashboard'] as const).map((h, i) =>
          <Link key={h} href={h} className="px-3 py-1 rounded-lg bg-slate-800">{['Toolroom', 'CNC', 'Dashboard'][i]}</Link>)}</div>
      <div className="flex gap-2"><ThemeToggle/><button onClick={signOut} className="px-4 min-h-10 rounded-lg bg-slate-800">Log out</button></div></div>
    {children}</>);
}
