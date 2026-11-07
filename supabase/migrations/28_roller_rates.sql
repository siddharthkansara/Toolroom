-- 28: rollers per kg (owner sets it, every change is kept as history).
-- Later phases use this to turn the weight on the shift sheet into a roller count.
-- Safe to run more than once. Does not touch any existing data.

create table if not exists roller_rate_history (
  id uuid primary key default gen_random_uuid(),
  roller_id uuid not null references roller_master(id),
  rollers_per_kg numeric(12,4) not null check (rollers_per_kg > 0),
  set_by uuid,
  set_at timestamptz not null default clock_timestamp());   -- clock_timestamp, not now(): two changes inside one transaction must still have different times
create index if not exists roller_rate_history_idx on roller_rate_history (roller_id, set_at desc);
alter table roller_rate_history alter column set_at set default clock_timestamp();   -- also fixes a table created by an earlier run

alter table roller_rate_history enable row level security;
drop policy if exists rrh_read on roller_rate_history;
create policy rrh_read on roller_rate_history for select
  using (exists (select 1 from roller_master r where r.id = roller_id and can_see(r.factory_id)));
-- nobody writes to this table directly; only set_roller_rates() below does
revoke all on roller_rate_history from anon;
revoke insert, update, delete on roller_rate_history from authenticated;
grant select on roller_rate_history to authenticated;

-- every roller size of a factory with its CURRENT rate (null = not set yet)
create or replace function roller_rates_list(p_factory text)
returns table (roller_id uuid, roller_size text, party_name text, customer_drg text, rollers_per_kg numeric, set_at timestamptz)
language sql stable as $$
  select r.id, r.roller_size, r.party_name, r.customer_drg, h.rollers_per_kg, h.set_at
    from roller_master r
    left join lateral (select x.rollers_per_kg, x.set_at from roller_rate_history x
                        where x.roller_id = r.id order by x.set_at desc, x.id desc limit 1) h on true
   where r.factory_id = p_factory
   order by r.roller_size;
$$;
revoke all on function roller_rates_list(text) from public, anon;
grant execute on function roller_rates_list(text) to authenticated;

-- the last 20 changes for one roller size
create or replace function roller_rate_history_of(p_roller uuid)
returns table (rollers_per_kg numeric, set_at timestamptz)
language sql stable as $$
  select h.rollers_per_kg, h.set_at from roller_rate_history h
   where h.roller_id = p_roller order by h.set_at desc, h.id desc limit 20;
$$;
revoke all on function roller_rate_history_of(uuid) from public, anon;
grant execute on function roller_rate_history_of(uuid) to authenticated;

-- owner only: p_rows = [{"roller_id": "...", "rate": 82.5}, ...]. Unchanged rates are skipped. Returns how many changed.
create or replace function set_roller_rates(p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare r jsonb; v_roller uuid; v_rate numeric; v_cur numeric; n integer := 0;
begin
  if auth.uid() is null or my_role() is distinct from 'owner' then raise exception 'Only the owner can change rollers per kg'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'Send a list of rates'; end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    v_roller := (r->>'roller_id')::uuid;
    v_rate := round((r->>'rate')::numeric, 4);
    if v_rate is null or v_rate <= 0 or v_rate > 100000 then raise exception 'Rollers per kg must be more than 0 and at most 100000'; end if;
    if not exists (select 1 from roller_master where id = v_roller) then raise exception 'Roller size not found'; end if;
    select h.rollers_per_kg into v_cur from roller_rate_history h where h.roller_id = v_roller order by h.set_at desc, h.id desc limit 1;
    if v_cur is distinct from v_rate then
      insert into roller_rate_history (roller_id, rollers_per_kg, set_by) values (v_roller, v_rate, auth.uid());
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function set_roller_rates(jsonb) from public, anon;
grant execute on function set_roller_rates(jsonb) to authenticated;
