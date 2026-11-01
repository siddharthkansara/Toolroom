-- 22_shift_sheet.sql
-- Shift sheet: one line = one header machine running one roller size in one shift.
-- Records rollers forged, tools used and the operator. Saving a line deducts the tools used from stock;
-- editing or deleting a line puts the stock back first. Usage is ALWAYS recorded, even when stock is short.
-- Shifts: DAY 7:30 am - 7:30 pm, NIGHT 7:30 pm - 7:30 am. A night shift belongs to the date it STARTED.
-- Entry windows (IST, editable in shift_settings): DAY until 7:30 pm same day, NIGHT until 11:49 am next day.
-- After the window only the owner can change a line. Safe to re-run.

-- ---------- stock ledger: allow the two new kinds ----------
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'inventory_moves'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%kind%' loop
    execute format('alter table inventory_moves drop constraint %I', c);
  end loop;
end $$;
alter table inventory_moves add constraint inventory_moves_kind_check check (kind in
  ('RECEIPT','HARDEN','TAKE_OUT','MOVE','TRANSFER_OUT','TRANSFER_IN','OPENING','CORRECTION','RETURN','USED','USED_UNDO'));

-- ---------- settings (one row) ----------
create table if not exists shift_settings (
  id int primary key default 1 check (id = 1),
  day_start time not null default '07:30',
  day_deadline time not null default '19:30',
  night_start time not null default '19:30',
  night_deadline time not null default '11:49');          -- next morning
insert into shift_settings (id) values (1) on conflict do nothing;
alter table shift_settings enable row level security;
drop policy if exists shift_settings_read on shift_settings;
drop policy if exists shift_settings_write on shift_settings;
create policy shift_settings_read on shift_settings for select using (auth.uid() is not null);
create policy shift_settings_write on shift_settings for update using (my_role() = 'owner') with check (my_role() = 'owner');

-- ---------- operators (added once, then picked from a list) ----------
create table if not exists header_operators (
  id uuid primary key default gen_random_uuid(),
  factory_id text not null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now());
create unique index if not exists header_operators_unique on header_operators (factory_id, lower(name));
alter table header_operators enable row level security;
drop policy if exists hop_read on header_operators;
drop policy if exists hop_add on header_operators;
drop policy if exists hop_edit on header_operators;
create policy hop_read on header_operators for select using (can_see(factory_id));
create policy hop_add on header_operators for insert with check (can_write(factory_id));
create policy hop_edit on header_operators for update using (my_role() = 'owner') with check (my_role() = 'owner');

-- ---------- the shift lines ----------
create table if not exists shift_entries (
  id uuid primary key default gen_random_uuid(),
  factory_id text not null,
  work_date date not null,                                  -- date the shift started
  shift text not null check (shift in ('DAY','NIGHT')),
  machine_id text not null,                                 -- header machine id
  status text not null default 'RAN' check (status in ('RAN','NOT_RUNNING')),
  roller_id uuid references roller_master(id),
  operator_id uuid references header_operators(id),
  rollers_forged integer not null default 0 check (rollers_forged >= 0),
  note text,
  short jsonb not null default '{}'::jsonb,                 -- tools used beyond what stock had, e.g. {"BOTTOM": 1}
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_by uuid, updated_at timestamptz,
  deleted_by uuid, deleted_at timestamptz);                 -- deleted lines are kept for the record
create index if not exists shift_entries_sheet on shift_entries (factory_id, work_date, shift);
create index if not exists shift_entries_roller on shift_entries (roller_id);
create index if not exists shift_entries_operator on shift_entries (operator_id);
alter table shift_entries enable row level security;
drop policy if exists shift_entries_read on shift_entries;
create policy shift_entries_read on shift_entries for select using (can_see(factory_id));
-- no direct insert / update / delete: lines are saved through shift_entry_save / shift_entry_delete

create table if not exists shift_tools (
  entry_id uuid not null references shift_entries(id) on delete cascade,
  tool_type text not null,
  qty integer not null check (qty > 0),
  primary key (entry_id, tool_type));
alter table shift_tools enable row level security;
drop policy if exists shift_tools_read on shift_tools;
create policy shift_tools_read on shift_tools for select using (
  exists (select 1 from shift_entries e where e.id = entry_id and can_see(e.factory_id)));

-- "all headers done" marker for a shift
create table if not exists shift_sheets (
  factory_id text not null,
  work_date date not null,
  shift text not null check (shift in ('DAY','NIGHT')),
  completed_at timestamptz,
  completed_by uuid,
  primary key (factory_id, work_date, shift));
alter table shift_sheets enable row level security;
drop policy if exists shift_sheets_read on shift_sheets;
create policy shift_sheets_read on shift_sheets for select using (can_see(factory_id));

-- ---------- views for the screens and reports ----------
create or replace view shift_entries_live with (security_invoker = true) as
  select * from shift_entries where deleted_at is null;

create or replace view shift_totals with (security_invoker = true) as
  select e.factory_id, e.work_date, e.shift,
         sum(e.rollers_forged)::bigint as rollers,
         count(*)::bigint as lines,
         count(distinct e.machine_id)::bigint as headers,
         (select s.completed_at from shift_sheets s where s.factory_id = e.factory_id and s.work_date = e.work_date and s.shift = e.shift) as completed_at
    from shift_entries e where e.deleted_at is null
   group by e.factory_id, e.work_date, e.shift;

-- ---------- time rules ----------
create or replace function shift_window(p_date date, p_shift text, out starts timestamptz, out deadline timestamptz)
language plpgsql stable as $$
declare s shift_settings;
begin
  select * into s from shift_settings where id = 1;
  if p_shift = 'DAY' then
    starts := ((p_date + s.day_start)::timestamp) at time zone 'Asia/Kolkata';
    deadline := ((p_date + s.day_deadline)::timestamp) at time zone 'Asia/Kolkata';
  else
    starts := ((p_date + s.night_start)::timestamp) at time zone 'Asia/Kolkata';
    deadline := (((p_date + 1) + s.night_deadline)::timestamp) at time zone 'Asia/Kolkata';
  end if;
end $$;

create or replace function shift_check_open(p_date date, p_shift text) returns void
language plpgsql stable as $$
declare w record;
begin
  select * into w from shift_window(p_date, p_shift);
  if now() < w.starts then raise exception 'That shift has not started yet'; end if;
  if now() > w.deadline and my_role() is distinct from 'owner' then
    raise exception 'This shift is locked (entry closed %). Ask the owner to correct it.', to_char(w.deadline at time zone 'Asia/Kolkata', 'DD Mon HH12:MI AM');
  end if;
end $$;

-- ---------- put back whatever a line took from stock ----------
create or replace function shift_return_stock(p_entry uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, move_group)
  select m.factory_id, m.roller_id, m.tool_type, m.state, (-sum(m.qty))::integer, m.location_id, 'USED_UNDO', p_reason, p_entry
    from inventory_moves m
   where m.move_group = p_entry and m.kind in ('USED','USED_UNDO')
   group by m.factory_id, m.roller_id, m.tool_type, m.state, m.location_id
  having sum(m.qty) <> 0;
end $$;
revoke all on function shift_return_stock(uuid, text) from public, anon, authenticated;

-- ---------- save a line (new when p_id is null, otherwise edit) ----------
-- p_tools = {"DIE_TOP": 2, "BOTTOM": 1, ...}.  Returns {"id": ..., "short": {"BOTTOM": 1}}
create or replace function shift_entry_save(
  p_id uuid, p_factory text, p_date date, p_shift text, p_machine text, p_status text,
  p_roller uuid, p_operator uuid, p_rollers integer, p_tools jsonb, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid()); prev shift_entries;
  k text; q integer; remaining integer; take integer; ln record; v_short jsonb := '{}'::jsonb;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not can_write(p_factory) then raise exception 'You cannot enter data for %', p_factory; end if;
  if p_shift not in ('DAY','NIGHT') then raise exception 'Bad shift'; end if;
  if p_status not in ('RAN','NOT_RUNNING') then raise exception 'Bad status'; end if;
  if not exists (select 1 from header_machines where id = p_machine and factory_id = p_factory) then
    raise exception 'Header machine not found in %', p_factory; end if;
  perform shift_check_open(p_date, p_shift);
  if p_status = 'RAN' then
    if p_roller is null then raise exception 'Choose the roller size'; end if;
    if not exists (select 1 from roller_master where id = p_roller and factory_id = p_factory) then raise exception 'Roller size not found in %', p_factory; end if;
    if p_rollers is null or p_rollers < 0 then raise exception 'Enter rollers forged (0 or more)'; end if;
    if p_operator is not null and not exists (select 1 from header_operators where id = p_operator and factory_id = p_factory) then raise exception 'Operator not found'; end if;
  end if;

  if p_id is null then
    insert into shift_entries (id, factory_id, work_date, shift, machine_id, status, roller_id, operator_id, rollers_forged, note)
    values (v_id, p_factory, p_date, p_shift, p_machine, p_status,
            case when p_status = 'RAN' then p_roller end, case when p_status = 'RAN' then p_operator end,
            case when p_status = 'RAN' then p_rollers else 0 end, nullif(trim(p_note), ''));
  else
    select * into prev from shift_entries where id = p_id for update;
    if not found or prev.deleted_at is not null then raise exception 'Entry not found'; end if;
    if prev.factory_id <> p_factory then raise exception 'Wrong factory'; end if;
    perform shift_check_open(prev.work_date, prev.shift);     -- the line's original shift must still be open too
    perform shift_return_stock(p_id, 'Entry changed');
    delete from shift_tools where entry_id = p_id;
    update shift_entries set work_date = p_date, shift = p_shift, machine_id = p_machine, status = p_status,
           roller_id = case when p_status = 'RAN' then p_roller end, operator_id = case when p_status = 'RAN' then p_operator end,
           rollers_forged = case when p_status = 'RAN' then p_rollers else 0 end, note = nullif(trim(p_note), ''),
           updated_by = auth.uid(), updated_at = now()
     where id = p_id;
  end if;

  if p_status = 'RAN' then
    for k, q in select key, (value #>> '{}')::integer from jsonb_each(coalesce(p_tools, '{}'::jsonb)) loop
      if k not in ('DIE_TOP','BOTTOM','FACING_PUNCH','SHORT_PIN','CUTTER','OTHER') then raise exception 'Unknown tool %', k; end if;
      if q < 0 then raise exception 'Tool counts cannot be negative'; end if;
      if q > 0 then
        insert into shift_tools (entry_id, tool_type, qty) values (v_id, k, q);
        remaining := q;
        for ln in select s.state, s.location_id, s.qty from inventory_stock s      -- hard stock first, biggest pile first
                   where s.factory_id = p_factory and s.roller_id = p_roller and s.tool_type = k
                   order by (s.state = 'HARD') desc, s.qty desc loop
          exit when remaining <= 0;
          take := least(remaining, ln.qty::integer);
          insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, move_group)
          values (p_factory, p_roller, k, ln.state, -take, ln.location_id, 'USED', 'Used on ' || p_machine, v_id);
          remaining := remaining - take;
        end loop;
        if remaining > 0 then v_short := v_short || jsonb_build_object(k, remaining); end if;   -- recorded, not blocked
      end if;
    end loop;
  end if;
  update shift_entries set short = v_short where id = v_id;
  return jsonb_build_object('id', v_id, 'short', v_short);
end $$;

-- ---------- delete a line (kept for the record, stock put back) ----------
create or replace function shift_entry_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e shift_entries;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into e from shift_entries where id = p_id for update;
  if not found then raise exception 'Entry not found'; end if;
  if e.deleted_at is not null then return; end if;
  if not can_write(e.factory_id) then raise exception 'You cannot change data for %', e.factory_id; end if;
  perform shift_check_open(e.work_date, e.shift);
  perform shift_return_stock(p_id, 'Entry deleted');
  update shift_entries set deleted_at = now(), deleted_by = auth.uid() where id = p_id;
end $$;

-- ---------- mark a shift sheet complete / reopen it ----------
create or replace function shift_sheet_complete(p_factory text, p_date date, p_shift text, p_complete boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not can_write(p_factory) then raise exception 'You cannot change data for %', p_factory; end if;
  if p_shift not in ('DAY','NIGHT') then raise exception 'Bad shift'; end if;
  perform shift_check_open(p_date, p_shift);
  insert into shift_sheets (factory_id, work_date, shift, completed_at, completed_by)
  values (p_factory, p_date, p_shift, case when p_complete then now() end, case when p_complete then auth.uid() end)
  on conflict (factory_id, work_date, shift) do update
    set completed_at = case when p_complete then now() end, completed_by = case when p_complete then auth.uid() end;
end $$;

revoke all on function shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text) from public, anon;
revoke all on function shift_entry_delete(uuid) from public, anon;
revoke all on function shift_sheet_complete(text, date, text, boolean) from public, anon;
grant execute on function shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text) to authenticated;
grant execute on function shift_entry_delete(uuid) to authenticated;
grant execute on function shift_sheet_complete(text, date, text, boolean) to authenticated;
