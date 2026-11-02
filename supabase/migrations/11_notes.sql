-- Notes: toolroom's note to the operator uses the existing tool_orders.notes column.
-- The CNC operator's note on a finished batch is stored on the delivery.
alter table deliveries add column if not exists note text;

drop function if exists complete_batch(uuid, int);
create or replace function complete_batch(p_order uuid, p_qty int, p_note text default null) returns void language plpgsql as $$
declare o tool_orders%rowtype; made int;
begin
  select * into o from tool_orders where id = p_order for update;
  if o.status <> 'ON_LATHE' then raise exception 'This order is not on the lathe'; end if;
  if p_qty < 1 then raise exception 'Quantity must be at least 1'; end if;
  insert into deliveries (order_id, qty_made, note) values (p_order, p_qty, nullif(trim(p_note), ''));
  select coalesce(sum(qty_made), 0) into made from deliveries where order_id = p_order;
  if made >= o.quantity then
    update tool_orders set status = 'CLOSED', closed_at = now(), qty_made = made where id = p_order;
  else
    update tool_orders set status = 'QUEUED', started_lathe_at = null, qty_made = made where id = p_order;
  end if;
end $$;
