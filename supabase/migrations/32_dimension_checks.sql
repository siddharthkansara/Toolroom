-- Dimension checklist: CNC writes it at dispatch, the plant cross-checks it at receipt
alter table deliveries
  add column if not exists cnc_check   jsonb,
  add column if not exists plant_check jsonb;

-- Drop the old signatures first, otherwise the API sees two versions and refuses to choose
drop function if exists complete_batch(uuid, int);
drop function if exists complete_batch(uuid, int, text);
drop function if exists receive_delivery(uuid, int);

create or replace function complete_batch(p_order uuid, p_qty int, p_note text default null, p_check jsonb default null) returns void language plpgsql as $$
declare o tool_orders%rowtype; made int;
begin
  if p_check is not null and jsonb_typeof(p_check) <> 'object' then raise exception 'Bad check data'; end if;
  select * into o from tool_orders where id = p_order for update;
  if o.status <> 'ON_LATHE' then raise exception 'This order is not on the lathe'; end if;
  if p_qty < 1 then raise exception 'Quantity must be at least 1'; end if;
  insert into deliveries (order_id, qty_made, note, factory_id, cnc_check)
  values (p_order, p_qty, nullif(trim(p_note), ''), o.factory_id,
          case when p_check is null then null else p_check || jsonb_build_object('at', now()) end);
  select coalesce(sum(qty_made), 0) into made from deliveries where order_id = p_order;
  if made >= o.quantity then
    update tool_orders set status = 'CLOSED', closed_at = now(), qty_made = made where id = p_order;
  else
    update tool_orders set status = 'QUEUED', started_lathe_at = null, qty_made = made where id = p_order;
  end if;
end $$;

create or replace function receive_delivery(p_delivery uuid, p_qty int, p_check jsonb default null) returns void language plpgsql as $$
declare oid uuid;
begin
  if p_qty < 0 then raise exception 'Quantity cannot be negative'; end if;
  if p_check is not null and jsonb_typeof(p_check) <> 'object' then raise exception 'Bad check data'; end if;
  update deliveries set status = 'RECEIVED', qty_received = p_qty, received_at = now(),
         plant_check = case when p_check is null then null else p_check || jsonb_build_object('at', now()) end
   where id = p_delivery and status = 'READY' returning order_id into oid;
  if oid is null then raise exception 'Already received, or not found'; end if;
  update tool_orders set qty_received = (select coalesce(sum(qty_received), 0) from deliveries where order_id = oid and status = 'RECEIVED') where id = oid;
end $$;

revoke all on function complete_batch(uuid, int, text, jsonb) from public, anon;
grant execute on function complete_batch(uuid, int, text, jsonb) to authenticated;
revoke all on function receive_delivery(uuid, int, jsonb) from public, anon;
grant execute on function receive_delivery(uuid, int, jsonb) to authenticated;

notify pgrst, 'reload schema';