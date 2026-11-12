-- The order's own dimension columns replace the saved copy from step 33
drop trigger if exists order_dims on tool_orders;
drop function if exists trg_order_dims();
drop function if exists snapshot_order_dims(uuid);
alter table tool_orders drop column if exists dims;

notify pgrst, 'reload schema';