-- 29: shift lines are entered by WEIGHT. The database works out the roller count from the weight and the
-- owner's "rollers per kg" (migration 28), and every running line carries a batch number and a heat number.
-- Run migration 28 first. Safe to run more than once. Old lines are not changed.

alter table shift_entries add column if not exists rollers_per_kg numeric(12,4);   -- the rate this line was entered with (kept, so later rate changes never alter it)
alter table shift_entries add column if not exists batch_no text;
alter table shift_entries add column if not exists heat_no text;
create or replace view shift_entries_live with (security_invoker = true) as select * from shift_entries where deleted_at is null;

-- save a shift line (replaces the version from migration 25). p_rollers is still accepted but IGNORED.
drop function if exists shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text, numeric);
create or replace function shift_entry_save(
  p_id uuid, p_factory text, p_date date, p_shift text, p_machine text, p_status text,
  p_roller uuid, p_operator uuid, p_rollers integer, p_tools jsonb, p_note text,
  p_weight numeric default null, p_batch text default null, p_heat text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid()); prev shift_entries;
  k text; q integer; remaining integer; take integer; ln record; v_short jsonb := '{}'::jsonb;
  v_rate numeric; v_rollers integer := 0;
  v_batch text := upper(nullif(trim(p_batch), '')); v_heat text := upper(nullif(trim(p_heat), ''));
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
    if p_weight is null or p_weight <= 0 then raise exception 'Enter the weight of the rollers forged (kg)'; end if;
    if v_batch is null then raise exception 'Enter the batch number'; end if;
    if v_heat is null then raise exception 'Enter the heat number'; end if;
    if length(v_batch) > 40 or length(v_heat) > 40 then raise exception 'Batch and heat numbers can be at most 40 characters'; end if;
    if p_operator is not null and not exists (select 1 from header_operators where id = p_operator and factory_id = p_factory) then raise exception 'Operator not found'; end if;
    -- rollers per kg: an edited line keeps the rate it was first entered with (if the roller size is unchanged); otherwise the owner's current rate
    if p_id is not null then select e.rollers_per_kg into v_rate from shift_entries e where e.id = p_id and e.roller_id = p_roller; end if;
    if v_rate is null then
      select h.rollers_per_kg into v_rate from roller_rate_history h where h.roller_id = p_roller order by h.set_at desc, h.id desc limit 1;
    end if;
    if v_rate is null then raise exception 'Rollers per kg is not set for this roller size. Ask the owner to set it.'; end if;
    if p_weight * v_rate > 100000000 then raise exception 'That weight looks too large. Please check it.'; end if;
    v_rollers := round(p_weight * v_rate)::integer;
  end if;

  if p_id is null then
    insert into shift_entries (id, factory_id, work_date, shift, machine_id, status, roller_id, operator_id, rollers_forged, note, weight_kg, rollers_per_kg, batch_no, heat_no)
    values (v_id, p_factory, p_date, p_shift, p_machine, p_status,
            case when p_status = 'RAN' then p_roller end, case when p_status = 'RAN' then p_operator end,
            case when p_status = 'RAN' then v_rollers else 0 end, nullif(trim(p_note), ''),
            case when p_status = 'RAN' then p_weight end, case when p_status = 'RAN' then v_rate end,
            case when p_status = 'RAN' then v_batch end, case when p_status = 'RAN' then v_heat end);
  else
    select * into prev from shift_entries where id = p_id for update;
    if not found or prev.deleted_at is not null then raise exception 'Entry not found'; end if;
    if prev.factory_id <> p_factory then raise exception 'Wrong factory'; end if;
    perform shift_check_open(prev.work_date, prev.shift);     -- the line's original shift must still be open too
    perform shift_return_stock(p_id, 'Entry changed');
    delete from shift_tools where entry_id = p_id;
    update shift_entries set work_date = p_date, shift = p_shift, machine_id = p_machine, status = p_status,
           roller_id = case when p_status = 'RAN' then p_roller end, operator_id = case when p_status = 'RAN' then p_operator end,
           rollers_forged = case when p_status = 'RAN' then v_rollers else 0 end, note = nullif(trim(p_note), ''),
           weight_kg = case when p_status = 'RAN' then p_weight end, rollers_per_kg = case when p_status = 'RAN' then v_rate end,
           batch_no = case when p_status = 'RAN' then v_batch end, heat_no = case when p_status = 'RAN' then v_heat end,
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
revoke all on function shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text, numeric, text, text) from public, anon;
grant execute on function shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text, numeric, text, text) to authenticated;
