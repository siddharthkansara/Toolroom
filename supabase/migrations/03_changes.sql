alter table tool_orders
  add column if not exists roller_id uuid references roller_master(id) on delete set null,
  add column if not exists roller_qty integer,
  add column if not exists qty_made integer;
