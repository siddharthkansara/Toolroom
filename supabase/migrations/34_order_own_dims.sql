-- Orders own their dimensions: real columns, filled from the roller's defaults at the moment of ordering
alter table tool_orders
  add column if not exists batta_code     varchar,
  add column if not exists od_dim         numeric(6,2),
  add column if not exists length_dim     numeric(6,2),
  add column if not exists od2_dim        numeric(6,2),
  add column if not exists step_id_dim    numeric(6,2),
  add column if not exists step_depth_dim numeric(6,2);

-- Existing orders: copy the ordered values saved in step 33
update tool_orders set
  batta_code     = dims->>'batta_code',
  od_dim         = (dims->>'od_dim')::numeric,
  length_dim     = (dims->>'length_dim')::numeric,
  od2_dim        = (dims->>'od2_dim')::numeric,
  step_id_dim    = (dims->>'step_id_dim')::numeric,
  step_depth_dim = (dims->>'step_depth_dim')::numeric
where dims is not null;

-- New orders: copy the roller's current values at the moment of ordering, then they never change
create or replace function trg_order_own_dims() returns trigger language plpgsql as $$
declare tm tooling_master%rowtype;
begin
  if new.tooling_id is not null then
    select * into tm from tooling_master where id = new.tooling_id;
    new.batta_code     := coalesce(new.batta_code, tm.batta_code);
    new.od_dim         := coalesce(new.od_dim, tm.od_dim);
    new.length_dim     := coalesce(new.length_dim, tm.length_dim);
    new.od2_dim        := coalesce(new.od2_dim, tm.od2_dim);
    new.step_id_dim    := coalesce(new.step_id_dim, tm.step_id_dim);
    new.step_depth_dim := coalesce(new.step_depth_dim, tm.step_depth_dim);
  end if;
  return new;
end $$;
drop trigger if exists order_own_dims on tool_orders;
create trigger order_own_dims before insert on tool_orders for each row execute function trg_order_own_dims();

notify pgrst, 'reload schema';