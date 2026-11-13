-- 39_shift_pick_sizes.sql
-- Shift sheets: when more than one size of a tool is in stock, the person says which size was used.
-- With one size (or none) in stock nothing changes. Needs 37 first.

-- Each sheet line can now record several sizes of the same tool
alter table shift_tools add column if not exists dim_key text not null default '';
alter table shift_tools drop constraint if exists shift_tools_pkey;
alter table shift_tools add primary key (entry_id, tool_type, dim_key);

-- Uses up stock for a sheet line. p_dim = null means any size. Returns how many pieces the stock could not cover.
create or replace function shift_use_stock(p_factory text, p_roller uuid, p_tool text, p_dim text, p_want integer, p_entry uuid, p_machine text)
returns integer language plpgsql security definer set search_path = public as $$
declare ln record; remaining integer := p_want; take integer;
begin
  for ln in select s.state, s.location_id, s.dim_key, s.qty from inventory_stock s      -- hard stock first, biggest pile first
             where s.factory_id = p_factory and s.roller_id = p_roller and s.tool_type = p_tool
               and (p_dim is null or s.dim_key = p_dim)
             order by (s.state = 'HARD') desc, s.qty desc loop
    exit when remaining <= 0;
    take := least(remaining, ln.qty::integer);
    insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, move_group, dim_key)
    values (p_factory, p_roller, p_tool, ln.state, -take, ln.location_id, 'USED', 'Used on ' || p_machine, p_entry, ln.dim_key);
    remaining := remaining - take;
  end loop;
  return remaining;
end $$;
revoke all on function shift_use_stock(text, uuid, text, text, integer, uuid, text) from public, anon, authenticated;

-- The sheet-saving function, now taking the chosen sizes (p_picks), e.g. {"BOTTOM": [{"dim_key": "OD 25.4 × L 80 · OD 12 · Step —", "qty": 2}]}
drop function if exists shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text, numeric, text, text);
create or replace function shift_entry_save(
  p_id uuid, p_factory text, p_date date, p_shift text, p_machine text, p_status text,
  p_roller uuid, p_operator uuid, p_rollers integer, p_tools jsonb, p_note text,
  p_weight numeric default null, p_batch text default null, p_heat text default null, p_picks jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid()); prev shift_entries;
  k text; q integer; v_short jsonb := '{}'::jsonb;
  picks jsonb; pk jsonb; want integer; picked integer; shortfall integer; dk text; n_dims integer;
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
        picks := coalesce(p_picks -> k, '[]'::jsonb);
        if jsonb_typeof(picks) <> 'array' then raise exception 'Bad size choice for %', k; end if;
        picked := 0; shortfall := 0;
        if jsonb_array_length(picks) > 0 then
          -- the person chose which size(s) were used: [{"dim_key": "...", "qty": 2}, ...]
          for pk in select x from jsonb_array_elements(picks) x loop
            want := coalesce((pk->>'qty')::integer, 0);
            continue when want <= 0;
            picked := picked + want;
            if picked > q then raise exception 'The sizes chosen for % add up to more than %', k, q; end if;
            dk := coalesce(pk->>'dim_key', '');
            insert into shift_tools (entry_id, tool_type, dim_key, qty) values (v_id, k, dk, want)
              on conflict (entry_id, tool_type, dim_key) do update set qty = shift_tools.qty + excluded.qty;
            shortfall := shortfall + shift_use_stock(p_factory, p_roller, k, dk, want, v_id, p_machine);
          end loop;
          if q > picked then   -- not covered by a chosen size: counted as used, and as short
            insert into shift_tools (entry_id, tool_type, dim_key, qty) values (v_id, k, '', q - picked)
              on conflict (entry_id, tool_type, dim_key) do update set qty = shift_tools.qty + excluded.qty;
            shortfall := shortfall + (q - picked);
          end if;
        else
          -- no choice given: only allowed when there is at most one size in stock for this roller and tool
          select count(distinct s.dim_key), min(s.dim_key) into n_dims, dk from inventory_stock s
           where s.factory_id = p_factory and s.roller_id = p_roller and s.tool_type = k;
          if n_dims > 1 then raise exception 'Choose which size of % was used', k; end if;
          insert into shift_tools (entry_id, tool_type, dim_key, qty) values (v_id, k, coalesce(dk, ''), q)
            on conflict (entry_id, tool_type, dim_key) do update set qty = shift_tools.qty + excluded.qty;
          shortfall := shift_use_stock(p_factory, p_roller, k, null, q, v_id, p_machine);
        end if;
        if shortfall > 0 then v_short := v_short || jsonb_build_object(k, shortfall); end if;   -- recorded, not blocked
      end if;
    end loop;
  end if;
  update shift_entries set short = v_short where id = v_id;
  return jsonb_build_object('id', v_id, 'short', v_short);
end $$;

revoke all on function shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text, numeric, text, text, jsonb) from public, anon;
grant execute on function shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text, numeric, text, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
