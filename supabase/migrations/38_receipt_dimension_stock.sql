-- 38_receipt_dimension_stock.sql
-- Stock by dimension, step 3 (the switch): a received batch goes into the stock line of the dimensions the
-- PLANT measured. The CNC cannot confirm, and the plant cannot receive, without a complete number-checked checklist.
-- Needs 32, 36 and 37 first. Safe to run more than once.

-- The rules for a dimension checklist. Used by the CNC confirm step (p_plant = false) and the plant receive step (true).
create or replace function validate_check(p jsonb, p_plant boolean) returns void language plpgsql immutable as $$
declare it jsonb; v text;
begin
  if p is null then raise exception 'Write down the measured dimensions first'; end if;
  if coalesce(jsonb_typeof(p->'items'), '') <> 'array' then raise exception 'Write down the measured dimensions first'; end if;
  if jsonb_array_length(p->'items') = 0 then raise exception 'Write down the measured dimensions first'; end if;
  for it in select x from jsonb_array_elements(p->'items') x loop
    v := nullif(trim(it->>'v'), '');
    if v is null then raise exception 'Write the measured value for %', coalesce(it->>'k', 'each dimension'); end if;
    if it->>'k' in ('OD', 'Length', 'OD 2', 'Step depth') and v !~ '^[0-9]+([.][0-9]+)?$' then
      raise exception 'Enter a number for % (for example 25.4)', it->>'k';
    end if;
  end loop;
  if p_plant then
    if jsonb_typeof(p->'match') is distinct from 'boolean' then raise exception 'Choose Matches or Does not match'; end if;
    if (p->>'match')::boolean = false and nullif(trim(p->>'note'), '') is null then raise exception 'Write what is different'; end if;
  end if;
end $$;

-- The stock line a received batch goes into: the dimensions the PLANT measured, falling back to the ordered
-- value for any dimension the plant did not write down.
create or replace function receipt_dim_key(p_delivery uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare dl deliveries%rowtype; o tool_orders%rowtype; tm tooling_master%rowtype;
        it jsonb; v text; k text; ft text := ''; lab text;
        od numeric; len numeric; od2 numeric; stp numeric; bat text;
begin
  select * into dl from deliveries where id = p_delivery;
  select * into o from tool_orders where id = dl.order_id;
  select * into tm from tooling_master where id = o.tooling_id;
  bat := o.batta_code; od := o.od_dim; len := o.length_dim; od2 := o.od2_dim; stp := o.step_depth_dim;
  for it in select x from jsonb_array_elements(coalesce(dl.plant_check->'items', '[]'::jsonb)) x loop
    v := nullif(trim(it->>'v'), '');
    continue when v is null;
    k := it->>'k';
    if k = 'Batta' then bat := v;
    elsif k = 'Dimensions' then ft := v;
    elsif v ~ '^[0-9]+([.][0-9]+)?$' then
      if k = 'OD' then od := v::numeric;
      elsif k = 'Length' then len := v::numeric;
      elsif k = 'OD 2' then od2 := v::numeric;
      elsif k = 'Step depth' then stp := v::numeric;
      end if;
    end if;
  end loop;
  if tm.id is null then   -- a custom tool has no roller record: its written dimension is the key
    return coalesce(nullif(ft, ''), nullif(trim(o.custom_dimensions), ''), '');
  end if;
  lab := dim_label(tm.tool_type::text, bat, od, len, od2, stp);
  if lab = '' then lab := ft; end if;   -- a tool with no numeric dimensions keeps whatever was written
  return coalesce(lab, '');
end $$;
revoke all on function receipt_dim_key(uuid) from public, anon, authenticated;

-- CNC confirm: checklist required
create or replace function complete_batch(p_order uuid, p_qty int, p_note text default null, p_check jsonb default null) returns void language plpgsql as $$
declare o tool_orders%rowtype; made int;
begin
  perform validate_check(p_check, false);
  select * into o from tool_orders where id = p_order for update;
  if o.status <> 'ON_LATHE' then raise exception 'This order is not on the lathe'; end if;
  if p_qty < 1 then raise exception 'Quantity must be at least 1'; end if;
  insert into deliveries (order_id, qty_made, note, factory_id, cnc_check)
  values (p_order, p_qty, nullif(trim(p_note), ''), o.factory_id, p_check || jsonb_build_object('at', now()));
  select coalesce(sum(qty_made), 0) into made from deliveries where order_id = p_order;
  if made >= o.quantity then
    update tool_orders set status = 'CLOSED', closed_at = now(), qty_made = made where id = p_order;
  else
    update tool_orders set status = 'QUEUED', started_lathe_at = null, qty_made = made where id = p_order;
  end if;
end $$;

-- Plant receive: checklist required, and it decides the stock line
create or replace function receive_delivery(p_delivery uuid, p_qty int, p_check jsonb default null) returns void language plpgsql as $$
declare oid uuid;
begin
  if p_qty < 0 then raise exception 'Quantity cannot be negative'; end if;
  perform validate_check(p_check, true);
  update deliveries set status = 'RECEIVED', qty_received = p_qty, received_at = now(),
         plant_check = p_check || jsonb_build_object('at', now())
   where id = p_delivery and status = 'READY' returning order_id into oid;
  if oid is null then raise exception 'Already received, or not found'; end if;
  update tool_orders set qty_received = (select coalesce(sum(qty_received), 0) from deliveries where order_id = oid and status = 'RECEIVED') where id = oid;
end $$;

-- The automatic stock posting now files each receipt under its measured dimensions
create or replace function inv_post_receipt(p_delivery uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare d record; n integer := 0;
begin
  select dl.id, dl.order_id, dl.status, dl.qty_received, dl.received_at,
         coalesce(dl.factory_id, o.factory_id) as factory_id,
         coalesce(o.roller_id, tm.roller_id) as roller_id,
         coalesce(tm.tool_type::text, 'OTHER') as tool_type,
         case when tm.id is null then o.custom_tool_name end as note,
         o.target_strokes
    into d
    from deliveries dl
    join tool_orders o on o.id = dl.order_id
    left join tooling_master tm on tm.id = o.tooling_id
   where dl.id = p_delivery;
  if not found then return 0; end if;
  if d.status <> 'RECEIVED' or coalesce(d.qty_received, 0) <= 0 then return 0; end if;
  if d.target_strokes = 'DUMMY' or d.roller_id is null or d.factory_id is null then return 0; end if;
  if coalesce(d.received_at, now()) < (select go_live from inventory_settings where id = 1) then return 0; end if;
  insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, kind, delivery_id, order_id, note, created_by, dim_key)
  values (d.factory_id, d.roller_id, d.tool_type, 'SOFT', d.qty_received, 'RECEIPT', d.id, d.order_id, d.note, null, receipt_dim_key(d.id))
  on conflict (delivery_id) where kind = 'RECEIPT' do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function validate_check(jsonb, boolean) from public, anon;
grant execute on function validate_check(jsonb, boolean) to authenticated;

notify pgrst, 'reload schema';
