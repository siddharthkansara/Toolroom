-- 42_roller_party.sql
-- The same roller size can now exist once per PARTY in a factory (e.g. "8x12 · ABC" and "8x12 · XYZ"),
-- each with its own stock, orders and rollers per kg. Party name is how users tell them apart.
-- Needs 37 first (it replaces 37's versions of the transfer, request and search functions).
--
-- Before: unique (factory_id, roller_size)                      -- from migration 12
-- After:  unique (factory_id, roller_size, party_name or '')    -- a size with no party counts as party ''
--
-- Moving stock between factories and requests used to find the roller by SIZE only. With two parties on one
-- size that could pick the wrong one, so they now match size AND party. A request stores the party it is for.
-- inventory_request_create gets a new last argument p_party (old version dropped first).
-- inventory_search now also returns party_name and also finds a size by party name.

-- 1. Uniqueness: size + party per factory
alter table roller_master drop constraint if exists roller_master_factory_size_key;
create unique index if not exists roller_master_factory_size_party_key
  on roller_master (factory_id, roller_size, coalesce(party_name, ''));

-- 2. A request remembers which party's size it is for
alter table inventory_requests add column if not exists party_name text;

drop function if exists inventory_request_create(text, text, text, text, text, integer, text, text);
drop function if exists inventory_search(text);

-- 3. Transfers: the receiving factory gets the same size AND party
create or replace function inventory_transfer(
  p_from text, p_to text, p_roller uuid, p_tool_type text, p_state text, p_qty integer, p_from_location uuid, p_note text, p_dim_key text default '')
returns void language plpgsql security definer set search_path = public as $$
declare v_size text; v_party text; v_to_roller uuid; v_group uuid := gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not can_write(p_from) then raise exception 'You cannot give stock from %', p_from; end if;
  if p_from = p_to then raise exception 'Choose a different factory'; end if;
  if not exists (select 1 from header_machines where factory_id = p_to) then raise exception 'Unknown factory %', p_to; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Enter a quantity of 1 or more'; end if;
  if p_state not in ('SOFT','HARD') then raise exception 'Bad condition'; end if;
  select roller_size, party_name into v_size, v_party from roller_master where id = p_roller and factory_id = p_from;
  if v_size is null then raise exception 'Roller not found in %', p_from; end if;
  select id into v_to_roller from roller_master
   where factory_id = p_to and roller_size = v_size and coalesce(party_name, '') = coalesce(v_party, '');
  if v_to_roller is null then   -- the receiving factory has never used this size for this party: add it to their list
    insert into roller_master (roller_size, party_name, factory_id) values (v_size, v_party, p_to) returning id into v_to_roller;
  end if;
  insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, note, move_group, dim_key)
  values (p_from, p_roller, p_tool_type, p_state, -p_qty, p_from_location, 'TRANSFER_OUT', 'To ' || p_to, nullif(trim(p_note), ''), v_group, coalesce(p_dim_key, '')),
         (p_to, v_to_roller, p_tool_type, p_state, p_qty, null, 'TRANSFER_IN', 'From ' || p_from, nullif(trim(p_note), ''), v_group, coalesce(p_dim_key, ''));
end $$;

-- 4. Asking for stock names the size, the party and the exact dimension
create or replace function inventory_request_create(
  p_source text, p_requester text, p_roller_size text, p_tool_type text, p_state text, p_qty integer, p_note text,
  p_dim_key text default '', p_party text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_avail bigint; v_id uuid; v_party text := nullif(trim(p_party), '');
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not can_write(p_requester) then raise exception 'You cannot ask on behalf of %', p_requester; end if;
  if p_source = p_requester then raise exception 'Choose a different factory'; end if;
  if not exists (select 1 from header_machines where factory_id = p_source) then raise exception 'Unknown factory %', p_source; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Enter a quantity of 1 or more'; end if;
  if p_state not in ('SOFT','HARD') then raise exception 'Bad condition'; end if;
  select coalesce(sum(m.qty), 0) into v_avail
    from inventory_moves m join roller_master r on r.id = m.roller_id
   where m.factory_id = p_source and r.roller_size = p_roller_size and coalesce(r.party_name, '') = coalesce(v_party, '')
     and m.tool_type = p_tool_type and m.state = p_state and m.dim_key = coalesce(p_dim_key, '');
  if v_avail < p_qty then raise exception 'Only % available at %', v_avail, p_source; end if;
  insert into inventory_requests (source_factory, requester_factory, roller_size, party_name, tool_type, state, qty_requested, note, dim_key)
  values (p_source, p_requester, p_roller_size, v_party, p_tool_type, p_state, p_qty, nullif(trim(p_note), ''), coalesce(p_dim_key, ''))
  returning id into v_id;
  return v_id;
end $$;

-- 5. Sending takes stock from the right party's size
create or replace function inventory_request_send(p_id uuid, p_lines jsonb, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare r inventory_requests; v_roller uuid; v_total integer := 0; e jsonb; v_q integer;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into r from inventory_requests where id = p_id for update;
  if not found then raise exception 'Request not found'; end if;
  if not can_write(r.source_factory) then raise exception 'Only % can move this tool', r.source_factory; end if;
  if r.status <> 'APPROVED' then raise exception 'Approve the request first (it is %)', r.status; end if;
  select id into v_roller from roller_master
   where factory_id = r.source_factory and roller_size = r.roller_size and coalesce(party_name, '') = coalesce(r.party_name, '');
  if v_roller is null then raise exception 'Roller size % (%) not found in %', r.roller_size, coalesce(r.party_name, 'no party'), r.source_factory; end if;
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

-- 6. Receiving files the stock under the same size AND party
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
    select id into v_roller from roller_master
     where factory_id = r.requester_factory and roller_size = r.roller_size and coalesce(party_name, '') = coalesce(r.party_name, '');
    if v_roller is null then   -- this factory has never used the size for this party: add it to their list
      insert into roller_master (roller_size, party_name, factory_id) values (r.roller_size, r.party_name, r.requester_factory) returning id into v_roller;
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

-- 7. Cross-factory search shows the party and also finds a size by party name
create or replace function inventory_search(p_size text)
returns table (factory_id text, roller_size text, party_name text, tool_type text, state text, qty bigint, location text, last_move timestamptz, dim_key text)
language sql stable security definer set search_path = public as $$
  select s.factory_id, r.roller_size, r.party_name, s.tool_type, s.state, sum(s.qty)::bigint,
         case when can_see(s.factory_id) then l.name end, max(s.last_move), s.dim_key
    from (select m.factory_id, m.roller_id, m.tool_type, m.state, m.location_id, sum(m.qty) as qty, max(m.created_at) as last_move, m.dim_key
            from inventory_moves m
           group by m.factory_id, m.roller_id, m.tool_type, m.state, m.location_id, m.dim_key
          having sum(m.qty) <> 0) s
    join roller_master r on r.id = s.roller_id
    left join inventory_locations l on l.id = s.location_id
   where auth.uid() is not null and length(trim(p_size)) >= 1
     and (r.roller_size ilike '%' || trim(p_size) || '%' or r.party_name ilike '%' || trim(p_size) || '%')
   group by s.factory_id, r.roller_size, r.party_name, s.tool_type, s.state, case when can_see(s.factory_id) then l.name end, s.dim_key
   order by r.roller_size, r.party_name, s.factory_id, s.tool_type, s.state, s.dim_key
   limit 300;
$$;

revoke all on function inventory_transfer(text, text, uuid, text, text, integer, uuid, text, text) from public, anon;
grant execute on function inventory_transfer(text, text, uuid, text, text, integer, uuid, text, text) to authenticated;
revoke all on function inventory_request_create(text, text, text, text, text, integer, text, text, text) from public, anon;
grant execute on function inventory_request_create(text, text, text, text, text, integer, text, text, text) to authenticated;
revoke all on function inventory_request_send(uuid, jsonb, text) from public, anon;
grant execute on function inventory_request_send(uuid, jsonb, text) to authenticated;
revoke all on function inventory_request_receive(uuid, boolean, text) from public, anon;
grant execute on function inventory_request_receive(uuid, boolean, text) to authenticated;
revoke all on function inventory_search(text) from public, anon;
grant execute on function inventory_search(text) to authenticated;

-- Tell the API about the new function shapes
notify pgrst, 'reload schema';
