-- 20_inventory_requests.sql
-- Inventory: request / approve / move / confirm flow between factories.
-- Status path: REQUESTED -> APPROVED -> IN_TRANSIT -> RECEIVED or NOT_RECEIVED
--              REQUESTED/APPROVED -> REJECTED (by the giving factory) or CANCELLED (by the asking factory)
-- Stock moves only in two places: when the giving factory moves the tool (stock leaves it) and when the asking
-- factory answers (stock lands there, or comes back). While IN_TRANSIT it is counted in neither factory.
-- All changes go through the functions below. Safe to re-run.

create table if not exists inventory_requests (
  id uuid primary key default gen_random_uuid(),
  source_factory text not null,                 -- has the tool, gives it
  requester_factory text not null,              -- asks for it
  roller_size text not null,
  tool_type text not null,
  state text not null check (state in ('SOFT','HARD')),
  qty_requested integer not null check (qty_requested > 0),
  qty_sent integer,
  status text not null default 'REQUESTED'
    check (status in ('REQUESTED','APPROVED','REJECTED','CANCELLED','IN_TRANSIT','RECEIVED','NOT_RECEIVED')),
  note text,                                    -- from the asking factory
  decision_note text,                           -- from the giving factory (approve / reject)
  send_note text,
  receive_note text,
  source_roller_id uuid,                        -- set when moved
  sent_lines jsonb,                             -- [{location_id, qty}] where the tools were taken from
  requested_at timestamptz not null default now(),
  requested_by uuid default auth.uid(),
  decided_at timestamptz, decided_by uuid,
  sent_at timestamptz, sent_by uuid,
  closed_at timestamptz, closed_by uuid);
create index if not exists inv_req_source on inventory_requests (source_factory, status);
create index if not exists inv_req_requester on inventory_requests (requester_factory, status);
alter table inventory_requests enable row level security;
drop policy if exists inv_req_read on inventory_requests;
create policy inv_req_read on inventory_requests for select using (can_see(source_factory) or can_see(requester_factory));
-- no insert / update / delete policies: every change goes through the functions below

-- 1. Ask for a tool ----------------------------------------------------------------------------------------
create or replace function inventory_request_create(
  p_source text, p_requester text, p_roller_size text, p_tool_type text, p_state text, p_qty integer, p_note text)
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
   where m.factory_id = p_source and r.roller_size = p_roller_size and m.tool_type = p_tool_type and m.state = p_state;
  if v_avail < p_qty then raise exception 'Only % available at %', v_avail, p_source; end if;
  insert into inventory_requests (source_factory, requester_factory, roller_size, tool_type, state, qty_requested, note)
  values (p_source, p_requester, p_roller_size, p_tool_type, p_state, p_qty, nullif(trim(p_note), ''))
  returning id into v_id;
  return v_id;
end $$;

-- 2. Giving factory approves or rejects --------------------------------------------------------------------
create or replace function inventory_request_decide(p_id uuid, p_approve boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare r inventory_requests;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into r from inventory_requests where id = p_id for update;
  if not found then raise exception 'Request not found'; end if;
  if not can_write(r.source_factory) then raise exception 'Only % can answer this request', r.source_factory; end if;
  if p_approve then
    if r.status <> 'REQUESTED' then raise exception 'This request is already %', r.status; end if;
    update inventory_requests set status = 'APPROVED', decision_note = nullif(trim(p_note), ''), decided_at = now(), decided_by = auth.uid() where id = p_id;
  else
    if r.status not in ('REQUESTED','APPROVED') then raise exception 'This request is already %', r.status; end if;
    update inventory_requests set status = 'REJECTED', decision_note = nullif(trim(p_note), ''), decided_at = now(), decided_by = auth.uid(), closed_at = now(), closed_by = auth.uid() where id = p_id;
  end if;
end $$;

-- 3. Giving factory moves the tool (stock leaves it) -------------------------------------------------------
-- p_lines = [{"location_id": "<uuid or null>", "qty": 2}, ...]  where the tools are taken from
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
      insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, note, move_group)
      values (r.source_factory, v_roller, r.tool_type, r.state, -v_q, nullif(e->>'location_id', '')::uuid, 'TRANSFER_OUT',
              'To ' || r.requester_factory, nullif(trim(p_note), ''), r.id);       -- blocked if there is not enough stock
    end if;
  end loop;
  update inventory_requests set status = 'IN_TRANSIT', qty_sent = v_total, sent_lines = p_lines, send_note = nullif(trim(p_note), ''),
         source_roller_id = v_roller, sent_at = now(), sent_by = auth.uid() where id = p_id;
end $$;

-- 4. Asking factory answers: received (stock lands here) or not received (stock goes back) ----------------
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
    insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, note, move_group)
    values (r.requester_factory, v_roller, r.tool_type, r.state, r.qty_sent, null, 'TRANSFER_IN',
            'From ' || r.source_factory, nullif(trim(p_note), ''), r.id);
    update inventory_requests set status = 'RECEIVED', receive_note = nullif(trim(p_note), ''), closed_at = now(), closed_by = auth.uid() where id = p_id;
  else
    for e in select x from jsonb_array_elements(coalesce(r.sent_lines, '[]'::jsonb)) as x loop
      v_q := coalesce((e->>'qty')::integer, 0);
      if v_q > 0 then
        insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, note, move_group)
        values (r.source_factory, r.source_roller_id, r.tool_type, r.state, v_q, nullif(e->>'location_id', '')::uuid, 'RETURN',
                'Not received by ' || r.requester_factory, nullif(trim(p_note), ''), r.id);
      end if;
    end loop;
    update inventory_requests set status = 'NOT_RECEIVED', receive_note = nullif(trim(p_note), ''), closed_at = now(), closed_by = auth.uid() where id = p_id;
  end if;
end $$;

-- 5. Asking factory cancels (before the tool is moved) ----------------------------------------------------
create or replace function inventory_request_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r inventory_requests;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into r from inventory_requests where id = p_id for update;
  if not found then raise exception 'Request not found'; end if;
  if not can_write(r.requester_factory) then raise exception 'Only % can cancel this request', r.requester_factory; end if;
  if r.status not in ('REQUESTED','APPROVED') then raise exception 'Cannot cancel: request is %', r.status; end if;
  update inventory_requests set status = 'CANCELLED', closed_at = now(), closed_by = auth.uid() where id = p_id;
end $$;

revoke all on function inventory_request_create(text, text, text, text, text, integer, text) from public, anon;
revoke all on function inventory_request_decide(uuid, boolean, text) from public, anon;
revoke all on function inventory_request_send(uuid, jsonb, text) from public, anon;
revoke all on function inventory_request_receive(uuid, boolean, text) from public, anon;
revoke all on function inventory_request_cancel(uuid) from public, anon;
grant execute on function inventory_request_create(text, text, text, text, text, integer, text) to authenticated;
grant execute on function inventory_request_decide(uuid, boolean, text) to authenticated;
grant execute on function inventory_request_send(uuid, jsonb, text) to authenticated;
grant execute on function inventory_request_receive(uuid, boolean, text) to authenticated;
grant execute on function inventory_request_cancel(uuid) to authenticated;
