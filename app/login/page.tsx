'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { HOME, type Role } from '@/lib/auth';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState(''); const [pw, setPw] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);

  async function roleOf(uid: string) {
    const { data } = await supabase.from('profiles').select('role').eq('id', uid).maybeSingle();
    return (data?.role as Role | undefined) ?? null;
  }
  useEffect(() => { (async () => {   // already signed in on this device? go straight to your page
    const { data: { session } } = await supabase.auth.getSession();
    const r = session ? await roleOf(session.user.id) : null;
    if (r) router.replace(HOME[r]);
  })(); }, [router]);

  async function go() {
    if (busy) return; setBusy(true); setErr('');
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
    if (error || !data.user) { setBusy(false); return setErr('Wrong email or password.'); }
    const r = await roleOf(data.user.id);
    if (!r) { await supabase.auth.signOut(); setBusy(false); return setErr('This account has no role yet. Ask the owner.'); }
    router.replace(HOME[r]);
  }
  const inp = 'h-16 rounded-xl bg-slate-900 border-2 border-slate-700 px-4 text-xl w-full';
  return (<div className="min-h-screen flex items-center justify-center p-6"><div className="w-full max-w-sm space-y-4">
    <h1 className="text-3xl font-bold text-center">Toolroom Login</h1>
    <input className={inp} type="email" autoComplete="username" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}/>
    <input className={inp} type="password" autoComplete="current-password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()}/>
    {err && <p className="text-red-400 text-lg text-center">{err}</p>}
    <button onClick={go} disabled={busy} className="w-full h-20 rounded-2xl bg-green-600 disabled:bg-slate-800 text-2xl font-extrabold">{busy ? 'Signing in…' : 'Log in'}</button>
  </div></div>);
}
