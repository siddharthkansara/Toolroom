-- Run this SECOND (after 10a), once. Partial deliveries: one order, many batches.
alter table tool_orders add column if not exists closed_at timestamptz;

create table if not exists deliveries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references tool_orders(id),
  qty_made int not null check (qty_made > 0),
  made_at timestamptz not null default now(),
  status text not null default 'READY' check (status in ('READY','RECEIVED')),
  qty_received int,
  received_at timestamptz);
create index if not exists deliveries_order on deliveries (order_id);
alter publication supabase_realtime add table deliveries;
alter table deliveries enable row level security;
create policy "read"   on deliveries for select to authenticated using (my_role() is not null);
create policy "insert" on deliveries for insert to authenticated with check (my_role() in ('cnc','owner'));
create policy "update" on deliveries for update to authenticated using (my_role() in ('toolroom','owner')) with check (my_role() in ('toolroom','owner'));

-- Convert existing finished orders into one delivery each
insert into deliveries (order_id, qty_made, made_at, status, qty_received, received_at)
select id, qty_made, coalesce(dispatched_at, now()), case when status = 'RECEIVED' then 'RECEIVED' else 'READY' end, qty_received, received_at
from tool_orders where status in ('IN_TRANSIT','RECEIVED') and qty_made > 0;
update tool_orders set status = 'CLOSED', closed_at = coalesce(received_at, dispatched_at, now()) where status in ('IN_TRANSIT','RECEIVED');

-- CNC finishes a batch: record it; order closes only if fully made, otherwise returns to the queue
create or replace function complete_batch(p_order uuid, p_qty int) returns void language plpgsql as $$
declare o tool_orders%rowtype; made int;
begin
  select * into o from tool_orders where id = p_order for update;
  if o.status <> 'ON_LATHE' then raise exception 'This order is not on the lathe'; end if;
  if p_qty < 1 then raise exception 'Quantity must be at least 1'; end if;
  insert into deliveries (order_id, qty_made) values (p_order, p_qty);
  select coalesce(sum(qty_made), 0) into made from deliveries where order_id = p_order;
  if made >= o.quantity then
    update tool_orders set status = 'CLOSED', closed_at = now(), qty_made = made where id = p_order;
  else
    update tool_orders set status = 'QUEUED', started_lathe_at = null, qty_made = made where id = p_order;
  end if;
end $$;

-- Plant confirms what it received for one batch
create or replace function receive_delivery(p_delivery uuid, p_qty int) returns void language plpgsql as $$
declare oid uuid;
begin
  if p_qty < 0 then raise exception 'Quantity cannot be negative'; end if;
  update deliveries set status = 'RECEIVED', qty_received = p_qty, received_at = now()
   where id = p_delivery and status = 'READY' returning order_id into oid;
  if oid is null then raise exception 'Already received, or not found'; end if;
  update tool_orders set qty_received = (select coalesce(sum(qty_received), 0) from deliveries where order_id = oid and status = 'RECEIVED') where id = oid;
end $$;

-- Only the toolroom (or owner) can close the remaining balance
create or replace function close_order(p_order uuid) returns void language plpgsql as $$
begin
  if my_role() not in ('toolroom','owner') then raise exception 'Only the toolroom can close an order'; end if;
  update tool_orders set status = 'CLOSED', closed_at = now() where id = p_order and status = 'QUEUED';
  if not found then raise exception 'Order is not waiting in the queue (is it on the lathe?)'; end if;
end $$;

-- Safety net: CNC cannot close an order short, even by calling the database directly
create or replace function guard_close() returns trigger language plpgsql as $$
begin
  if new.status = 'CLOSED' and old.status <> 'CLOSED' and my_role() = 'cnc' and coalesce(new.qty_made, 0) < new.quantity then
    raise exception 'Only the toolroom can close an order early';
  end if;
  return new;
end $$;
drop trigger if exists guard_close_trg on tool_orders;
create trigger guard_close_trg before update on tool_orders for each row execute function guard_close();
