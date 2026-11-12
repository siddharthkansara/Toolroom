-- 37_stock_dim_functions.sql
-- Stock by dimension, step 2: every function that writes or reads stock now carries the dimension label (dim_key).
-- Behaviour is unchanged today because every ledger row still has an empty label. Needs 36 first.
-- Old function versions with a different argument list are dropped so the API never sees two versions.

alter table inventory_requests add column if not exists dim_key text not null default '';

drop function if exists inventory_transfer(text, text, uuid, text, text, integer, uuid, text);
drop function if exists inventory_request_create(text, text, text, text, text, integer, text);
drop function if exists inventory_search(text);

-- Transfers carry the dimension
create or replace function inventory_transfer(
  p_from text, p_to text, p_roller uuid, p_tool_type text, p_state text, p_qty integer, p_from_location uuid, p_note text, p_dim_key text default '')
returns void language plpgsql security definer set search_path = public as $$
declare v_size text; v_to_roller uuid; v_group uuid := gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not can_write(p_from) then raise exception 'You cannot give stock from %', p_from; end if;
  if p_from = p_to then raise exception 'Choose a different factory'; end if;
  if not exists (select 1 from header_machines where factory_id = p_to) then raise exception 'Unknown factory %', p_to; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Enter a quantity of 1 or more'; end if;
  if p_state not in ('SOFT','HARD') then raise exception 'Bad condition'; end if;
  select roller_size into v_size from roller_master where id = p_roller and factory_id = p_from;
  if v_size is null then raise exception 'Roller not found in %', p_from; end if;
  select id into v_to_roller from roller_master where factory_id = p_to and roller_size = v_size;
  if v_to_roller is null then   -- the receiving factory has never used this size: add it to their list (size only)
    insert into roller_master (roller_size, factory_id) values (v_size, p_to) returning id into v_to_roller;
  end if;
  insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, note, move_group, dim_key)
  values (p_from, p_roller, p_tool_type, p_state, -p_qty, p_from_location, 'TRANSFER_OUT', 'To ' || p_to, nullif(trim(p_note), ''), v_group, coalesce(p_dim_key, '')),
         (p_to, v_to_roller, p_tool_type, p_state, p_qty, null, 'TRANSFER_IN', 'From ' || p_from, nullif(trim(p_note), ''), v_group, coalesce(p_dim_key, ''));
end $$;

-- Asking for stock names the exact dimension
create or replace function inventory_request_create(
  p_source text, p_requester text, p_roller_size text, p_tool_type text, p_state text, p_qty integer, p_note text, p_dim_key text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_avail bigint; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not can_write(p_requester) then raise exception 'You cannot ask on behalf of %', p_requester; end if;
  if p_source = p_requester then raise exception 'Choose a different factory'; end if;
  if not exists (select 1 from header_machines where factory_id = p_source) then raise exception 'Unknown factory %', p_source; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Enter a quantity of 1 or more'; end if;
  if p_state not in ('SOFT','HARD') then raise exception 'Bad condition'; end if;
  select coalesce(sum(m.qty), 0) into v_avail
    from inventory_moves m join roller_master r on r.id = m.roller_id
   where m.factory_id = p_source and r.roller_size = p_roller_size and m.tool_type = p_tool_type and m.state = p_state
     and m.dim_key = coalesce(p_dim_key, '');
  if v_avail < p_qty then raise exception 'Only % available at %', v_avail, p_source; end if;
  insert into inventory_requests (source_factory, requester_factory, roller_size, tool_type, state, qty_requested, note, dim_key)
  values (p_source, p_requester, p_roller_size, p_tool_type, p_state, p_qty, nullif(trim(p_note), ''), coalesce(p_dim_key, ''))
  returning id into v_id;
  return v_id;
end $$;

-- Sending, receiving and returning keep the dimension
create or replace function inventory_request_send(p_id uuid, p_lines jsonb, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare r inventory_requests; v_roller uuid; v_total integer := 0; e jsonb; v_q integer;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into r from inventory_requests where id = p_id for update;
  if not found then raise exception 'Request not found'; end if;
  if not can_write(r.source_factory) then raise exception 'Only % can move this tool', r.source_factory; end if;
  if r.status <> 'APPROVED' then raise exception 'Approve the request first (it is %)', r.status; end if;
  select id into v_roller from roller_master where factory_id = r.source_factory and roller_size = r.roller_size;
  if v_roller is null then raise exception 'Roller size % not found in %', r.roller_size, r.source_factory; end if;
  for e in select x from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as x loop
    v_q := coalesce((e->>'qty')::integer, 0);
    if v_q < 0 then raise exception 'Quantity cannot be negative'; end if;
    v_total := v_total + v_q;
  end loop;
  if v_total < 1 then raise exception 'Enter how many to send'; end if;
  if v_total > r.qty_requested then raise exception 'You can send at most % (what was asked for)', r.qty_requested; end if;
  for e in select x from jsonb_array_elements(p_lines) as x loop
    v_q := coalesce((e->>'qty')::integer, 0);
    if v_q > 0 then
      insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, note, move_group, dim_key)
      values (r.source_factory, v_roller, r.tool_type, r.state, -v_q, nullif(e->>'location_id', '')::uuid, 'TRANSFER_OUT',
              'To ' || r.requester_factory, nullif(trim(p_note), ''), r.id, r.dim_key);       -- blocked if there is not enough stock
    end if;
  end loop;
  update inventory_requests set status = 'IN_TRANSIT', qty_sent = v_total, sent_lines = p_lines, send_note = nullif(trim(p_note), ''),
         source_roller_id = v_roller, sent_at = now(), sent_by = auth.uid() where id = p_id;
end $$;

create or replace function inventory_request_receive(p_id uuid, p_received boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare r inventory_requests; v_roller uuid; e jsonb; v_q integer;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into r from inventory_requests where id = p_id for update;
  if not found then raise exception 'Request not found'; end if;
  if not can_write(r.requester_factory) then raise exception 'Only % can answer this', r.requester_factory; end if;
  if r.status <> 'IN_TRANSIT' then raise exception 'Nothing to confirm (request is %)', r.status; end if;
  if p_received then
    select id into v_roller from roller_master where factory_id = r.requester_factory and roller_size = r.roller_size;
    if v_roller is null then   -- this factory has never used the size: add it to their list (size only)
      insert into roller_master (roller_size, factory_id) values (r.roller_size, r.requester_factory) returning id into v_roller;
    end if;
    insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, note, move_group, dim_key)
    values (r.requester_factory, v_roller, r.tool_type, r.state, r.qty_sent, null, 'TRANSFER_IN',
            'From ' || r.source_factory, nullif(trim(p_note), ''), r.id, r.dim_key);
    update inventory_requests set status = 'RECEIVED', receive_note = nullif(trim(p_note), ''), closed_at = now(), closed_by = auth.uid() where id = p_id;
  else
    for e in select x from jsonb_array_elements(coalesce(r.sent_lines, '[]'::jsonb)) as x loop
      v_q := coalesce((e->>'qty')::integer, 0);
      if v_q > 0 then
        insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, note, move_group, dim_key)
        values (r.source_factory, r.source_roller_id, r.tool_type, r.state, v_q, nullif(e->>'location_id', '')::uuid, 'RETURN',
                'Not received by ' || r.requester_factory, nullif(trim(p_note), ''), r.id, r.dim_key);
      end if;
    end loop;
    update inventory_requests set status = 'NOT_RECEIVED', receive_note = nullif(trim(p_note), ''), closed_at = now(), closed_by = auth.uid() where id = p_id;
  end if;
end $$;

-- Tools taken off a machine come back with a dimension label (the screen will send it)
create or replace function inventory_take_down(
  p_factory text, p_roller uuid, p_machine text, p_date date, p_wire text, p_batta text, p_extra text,
  p_note text, p_location uuid, p_tools jsonb)
returns uuid language plpgsql as $$
declare v_id uuid; e jsonb; r integer;
begin
  insert into inventory_takedowns (factory_id, roller_id, machine_id, taken_down_on, wire_size, last_batta, extra_batta, note, tools)
  values (p_factory, p_roller, nullif(trim(p_machine), ''), p_date, nullif(trim(p_wire), ''), nullif(trim(p_batta), ''),
          nullif(trim(p_extra), ''), nullif(trim(p_note), ''), coalesce(p_tools, '[]'::jsonb))
  returning id into v_id;
  for e in select x from jsonb_array_elements(coalesce(p_tools, '[]'::jsonb)) as x loop
    r := coalesce((e->>'returned')::integer, 0);
    if r > 0 then
      insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, move_group, dim_key)
      values (p_factory, p_roller, e->>'tool_type', 'HARD', r, p_location, 'RETURN', 'Taken down from machine', v_id, coalesce(e->>'dim_key', ''));
    end if;
  end loop;
  return v_id;
end $$;

-- Shift sheets: using and giving back stock keeps each pile's dimension
create or replace function shift_return_stock(p_entry uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, move_group, dim_key)
  select m.factory_id, m.roller_id, m.tool_type, m.state, (-sum(m.qty))::integer, m.location_id, 'USED_UNDO', p_reason, p_entry, m.dim_key
    from inventory_moves m
   where m.move_group = p_entry and m.kind in ('USED','USED_UNDO')
   group by m.factory_id, m.roller_id, m.tool_type, m.state, m.location_id, m.dim_key
  having sum(m.qty) <> 0;
end $$;

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
        for ln in select s.state, s.location_id, s.dim_key, s.qty from inventory_stock s      -- hard stock first, biggest pile first
                   where s.factory_id = p_factory and s.roller_id = p_roller and s.tool_type = k
                   order by (s.state = 'HARD') desc, s.qty desc loop
          exit when remaining <= 0;
          take := least(remaining, ln.qty::integer);
          insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, move_group, dim_key)
          values (p_factory, p_roller, k, ln.state, -take, ln.location_id, 'USED', 'Used on ' || p_machine, v_id, ln.dim_key);
          remaining := remaining - take;
        end loop;
        if remaining > 0 then v_short := v_short || jsonb_build_object(k, remaining); end if;   -- recorded, not blocked
      end if;
    end loop;
  end if;
  update shift_entries set short = v_short where id = v_id;
  return jsonb_build_object('id', v_id, 'short', v_short);
end $$;

-- Cross-factory search shows the dimension
create or replace function inventory_search(p_size text)
returns table (factory_id text, roller_size text, tool_type text, state text, qty bigint, location text, last_move timestamptz, dim_key text)
language sql stable security definer set search_path = public as $$
  select s.factory_id, r.roller_size, s.tool_type, s.state, sum(s.qty)::bigint,
         case when can_see(s.factory_id) then l.name end, max(s.last_move), s.dim_key
    from (select m.factory_id, m.roller_id, m.tool_type, m.state, m.location_id, sum(m.qty) as qty, max(m.created_at) as last_move, m.dim_key
            from inventory_moves m
           group by m.factory_id, m.roller_id, m.tool_type, m.state, m.location_id, m.dim_key
          having sum(m.qty) <> 0) s
    join roller_master r on r.id = s.roller_id
    left join inventory_locations l on l.id = s.location_id
   where auth.uid() is not null and length(trim(p_size)) >= 1
     and r.roller_size ilike '%' || trim(p_size) || '%'
   group by s.factory_id, r.roller_size, s.tool_type, s.state, case when can_see(s.factory_id) then l.name end, s.dim_key
   order by r.roller_size, s.factory_id, s.tool_type, s.state, s.dim_key
   limit 300;
$$;

revoke all on function inventory_transfer(text, text, uuid, text, text, integer, uuid, text, text) from public, anon;
grant execute on function inventory_transfer(text, text, uuid, text, text, integer, uuid, text, text) to authenticated;
revoke all on function inventory_request_create(text, text, text, text, text, integer, text, text) from public, anon;
grant execute on function inventory_request_create(text, text, text, text, text, integer, text, text) to authenticated;
revoke all on function inventory_search(text) from public, anon;
grant execute on function inventory_search(text) to authenticated;

notify pgrst, 'reload schema';
