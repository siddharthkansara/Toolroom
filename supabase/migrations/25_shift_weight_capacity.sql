-- 25_shift_weight_capacity.sql
-- 1) weight (kg) on each shift line  2) header capacity (rollers per day at 100%)  3) reports for the table and utilisation views.
-- Utilisation = rollers forged / capacity. A shift's capacity is half the daily capacity (two 12-hour shifts).
-- Safe to re-run.

alter table header_machines add column if not exists daily_capacity integer check (daily_capacity is null or daily_capacity > 0);
alter table shift_entries add column if not exists weight_kg numeric(12,2) check (weight_kg is null or weight_kg >= 0);
create or replace view shift_entries_live with (security_invoker = true) as select * from shift_entries where deleted_at is null;

-- NIC header capacities (rollers per day at 100%). Matches HD-20, HD-16 ... with or without a factory prefix.
update header_machines set daily_capacity = v.cap
  from (values ('HD-20', 71550), ('HD-16', 72900), ('HD-15', 72900), ('HD-14', 81000), ('HD-13', 81000), ('HD-12', 95760), ('HD-09', 121500), ('HD-08', 122850)) as v(code, cap)
 where header_machines.factory_id = 'NIC' and upper(regexp_replace(header_machines.id, '^.*:', '')) = v.code;

-- owner sets capacity from the dashboard
create or replace function set_header_capacity(p_id text, p_capacity integer) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or my_role() is distinct from 'owner' then raise exception 'Only the owner can change this'; end if;
  if p_capacity is not null and p_capacity <= 0 then raise exception 'Capacity must be more than 0'; end if;
  update header_machines set daily_capacity = p_capacity where id = p_id;
end $$;
revoke all on function set_header_capacity(text, integer) from public, anon;
grant execute on function set_header_capacity(text, integer) to authenticated;

-- save a shift line, now with weight (replaces the earlier version)
drop function if exists shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text);
create or replace function shift_entry_save(
  p_id uuid, p_factory text, p_date date, p_shift text, p_machine text, p_status text,
  p_roller uuid, p_operator uuid, p_rollers integer, p_tools jsonb, p_note text, p_weight numeric default null)
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
    if p_weight is not null and p_weight < 0 then raise exception 'Weight cannot be negative'; end if;
    if p_operator is not null and not exists (select 1 from header_operators where id = p_operator and factory_id = p_factory) then raise exception 'Operator not found'; end if;
  end if;

  if p_id is null then
    insert into shift_entries (id, factory_id, work_date, shift, machine_id, status, roller_id, operator_id, rollers_forged, note, weight_kg)
    values (v_id, p_factory, p_date, p_shift, p_machine, p_status,
            case when p_status = 'RAN' then p_roller end, case when p_status = 'RAN' then p_operator end,
            case when p_status = 'RAN' then p_rollers else 0 end, nullif(trim(p_note), ''),
            case when p_status = 'RAN' then p_weight end);
  else
    select * into prev from shift_entries where id = p_id for update;
    if not found or prev.deleted_at is not null then raise exception 'Entry not found'; end if;
    if prev.factory_id <> p_factory then raise exception 'Wrong factory'; end if;
    perform shift_check_open(prev.work_date, prev.shift);     -- the line's original shift must still be open too
    perform shift_return_stock(p_id, 'Entry changed');
    delete from shift_tools where entry_id = p_id;
    update shift_entries set work_date = p_date, shift = p_shift, machine_id = p_machine, status = p_status,
           roller_id = case when p_status = 'RAN' then p_roller end, operator_id = case when p_status = 'RAN' then p_operator end,
           rollers_forged = case when p_status = 'RAN' then p_rollers else 0 end, note = nullif(trim(p_note), ''), weight_kg = case when p_status = 'RAN' then p_weight end,
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

revoke all on function shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text, numeric) from public, anon;
grant execute on function shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text, numeric) to authenticated;

-- every line in a date range (for the table and the utilisation grid)
create or replace function report_lines(p_from date, p_to date, p_factory text)
returns table (work_date date, shift text, factory_id text, machine_id text, status text, operator_name text, roller_size text, rollers integer, weight_kg numeric, note text)
language sql stable as $$
  select e.work_date, e.shift, e.factory_id, e.machine_id, e.status, o.name, r.roller_size, e.rollers_forged, e.weight_kg, e.note
    from shift_entries e
    left join header_operators o on o.id = e.operator_id
    left join roller_master r on r.id = e.roller_id
   where e.deleted_at is null and e.work_date >= p_from and e.work_date < p_to and e.factory_id = p_factory
   order by e.work_date, e.shift, e.machine_id, e.created_at;
$$;

-- one row per shift with capacity, for long periods (utilisation = rollers_cap / capacity)
create or replace function report_util_days(p_from date, p_to date, p_factory text)
returns table (work_date date, shift text, rollers bigint, weight_kg numeric, rollers_cap bigint, capacity bigint)
language sql stable as $$
  select e.work_date, e.shift,
         coalesce(sum(e.rollers_forged), 0)::bigint,
         coalesce(sum(e.weight_kg), 0),
         coalesce(sum(e.rollers_forged) filter (where h.daily_capacity is not null), 0)::bigint,
         ((select coalesce(sum(h2.daily_capacity), 0) from header_machines h2 where h2.factory_id = p_factory) / 2)::bigint
    from shift_entries e
    left join header_machines h on h.id = e.machine_id
   where e.deleted_at is null and e.factory_id = p_factory and e.work_date >= p_from and e.work_date < p_to
   group by e.work_date, e.shift
   order by e.work_date, e.shift;
$$;

-- header report now carries capacity (return shape changed, so drop first)
drop function if exists report_headers(date, date, text);
create or replace function report_headers(p_from date, p_to date, p_factory text default null)
returns table (factory_id text, machine_id text, rollers bigint, ran_shifts bigint, idle_shifts bigint, capacity integer)
language sql stable as $$
  select e.factory_id, e.machine_id,
         coalesce(sum(e.rollers_forged) filter (where e.status = 'RAN'), 0)::bigint,
         (count(distinct (e.work_date, e.shift)) filter (where e.status = 'RAN'))::bigint,
         (count(distinct (e.work_date, e.shift)) filter (where e.status = 'NOT_RUNNING'))::bigint,
         max(h.daily_capacity)
    from shift_entries e
    left join header_machines h on h.id = e.machine_id
   where e.deleted_at is null and e.work_date >= p_from and e.work_date < p_to and (p_factory is null or e.factory_id = p_factory)
   group by e.factory_id, e.machine_id
   order by e.factory_id, e.machine_id;
$$;
revoke all on function report_lines(date, date, text) from public, anon;
revoke all on function report_util_days(date, date, text) from public, anon;
revoke all on function report_headers(date, date, text) from public, anon;
grant execute on function report_lines(date, date, text) to authenticated;
grant execute on function report_util_days(date, date, text) to authenticated;
grant execute on function report_headers(date, date, text) to authenticated;

-- check: every NIC header should show a capacity
select id, daily_capacity from header_machines where factory_id = 'NIC' order by id;
