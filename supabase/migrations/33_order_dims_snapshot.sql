-- Each order keeps the tool dimensions exactly as they were when it was ordered
alter table tool_orders add column if not exists dims jsonb;

create or replace function snapshot_order_dims(p_tooling uuid) returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'batta_code', batta_code, 'od_dim', od_dim, 'length_dim', length_dim,
    'od2_dim', od2_dim, 'step_id_dim', step_id_dim, 'step_depth_dim', step_depth_dim))
  from tooling_master where id = p_tooling $$;
revoke all on function snapshot_order_dims(uuid) from public, anon;
grant execute on function snapshot_order_dims(uuid) to authenticated;

create or replace function trg_order_dims() returns trigger language plpgsql as $$
begin
  if new.dims is null and new.tooling_id is not null then new.dims := snapshot_order_dims(new.tooling_id); end if;
  return new;
end $$;
drop trigger if exists order_dims on tool_orders;
create trigger order_dims before insert on tool_orders for each row execute function trg_order_dims();

-- Existing orders: best available value is today's (earlier values cannot be recovered)
update tool_orders set dims = snapshot_order_dims(tooling_id) where dims is null and tooling_id is not null;

notify pgrst, 'reload schema';