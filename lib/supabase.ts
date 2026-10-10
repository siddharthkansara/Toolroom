import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
export const supabase = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
// Calls a database function (typed loosely on purpose)
export const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase.rpc as unknown as (f: string, a: object) => Promise<{ error: { message: string } | null }>).call(supabase, fn, args);
