-- Stock by dimension, step 1: the ledger can carry a dimension label. Nothing uses it yet.

-- One text label for a set of tool dimensions. The label is also the stock line's key,
-- so two tools are the same stock line only if every dimension matches.
create or replace function dim_label(p_type text, p_batta text, p_od numeric, p_len numeric, p_od2 numeric, p_step numeric)
returns text language sql immutable as $$
  select case
    when p_type = 'DIE_TOP' then coalesce('Batta ' || nullif(trim(p_batta), ''), '')
    when p_type = 'BOTTOM' then 'OD ' || coalesce(trim_scale(p_od)::text, '—') || ' × L ' || coalesce(trim_scale(p_len)::text, '—')
         || ' · OD ' || coalesce(trim_scale(p_od2)::text, '—') || ' · Step ' || coalesce(trim_scale(p_step)::text, '—')
    when p_type = 'FACING_PUNCH' or p_od is not null or p_len is not null
         then 'OD ' || coalesce(trim_scale(p_od)::text, '—') || ' × L ' || coalesce(trim_scale(p_len)::text, '—')
    else '' end
$$;
revoke all on function dim_label(text, text, numeric, numeric, numeric, numeric) from public, anon;
grant execute on function dim_label(text, text, numeric, numeric, numeric, numeric) to authenticated;

alter table inventory_moves add column if not exists dim_key text not null default '';
create index if not exists inv_moves_key2 on inventory_moves (factory_id, roller_id, tool_type, state, dim_key);

-- Current stock now also splits by dimension (new column goes last)
create or replace view inventory_stock with (security_invoker = true) as
select factory_id, roller_id, tool_type, state, location_id,
       sum(qty)::bigint as qty, max(created_at) as last_move, dim_key
from inventory_moves
group by factory_id, roller_id, tool_type, state, location_id, dim_key
having sum(qty) <> 0;

-- The "not enough stock" guard now counts each dimension separately
create or replace function trg_inv_no_negative() returns trigger
language plpgsql security definer set search_path = public as $$
declare bal bigint;
begin
  if new.qty < 0 then
    perform pg_advisory_xact_lock(hashtext(new.factory_id || '|' || new.roller_id::text || '|' || new.tool_type || '|' || new.state || '|' || new.dim_key));
    select coalesce(sum(m.qty), 0) into bal from inventory_moves m
     where m.factory_id = new.factory_id and m.roller_id = new.roller_id and m.tool_type = new.tool_type
       and m.state = new.state and m.dim_key = new.dim_key and m.location_id is not distinct from new.location_id;
    if bal + new.qty < 0 then
      raise exception 'Not enough stock: only % available', bal;
    end if;
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';