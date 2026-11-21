-- 43_bottom_punch_od_only.sql
-- Bottom and Forging Punch are now described by OD only (no length, no second OD, no step).
-- The order form, both checklists and Add stock show just one OD box for them, so the stock label
-- for these two tools becomes "OD 25.4" instead of "OD 25.4 × L — · OD — · Step —".
-- Needs 36 first (it replaces 36's dim_label; same arguments, so no drop needed).
-- Other tools are unchanged: Die Top stays "Batta …", any other tool with OD/L stays "OD … × L …".

create or replace function dim_label(p_type text, p_batta text, p_od numeric, p_len numeric, p_od2 numeric, p_step numeric)
returns text language sql immutable as $$
  select case
    when p_type = 'DIE_TOP' then coalesce('Batta ' || nullif(trim(p_batta), ''), '')
    when p_type in ('BOTTOM', 'FACING_PUNCH') then 'OD ' || coalesce(trim_scale(p_od)::text, '—')
    when p_od is not null or p_len is not null
         then 'OD ' || coalesce(trim_scale(p_od)::text, '—') || ' × L ' || coalesce(trim_scale(p_len)::text, '—')
    else '' end
$$;
revoke all on function dim_label(text, text, numeric, numeric, numeric, numeric) from public, anon;
grant execute on function dim_label(text, text, numeric, numeric, numeric, numeric) to authenticated;

-- Clear the old extra values on the roller tool records, so new orders do not copy them
update tooling_master set length_dim = null, od2_dim = null, step_depth_dim = null
 where tool_type in ('BOTTOM', 'FACING_PUNCH')
   and (length_dim is not null or od2_dim is not null or step_depth_dim is not null);

notify pgrst, 'reload schema';

-- Check (should return 'OD 25.4' twice and 'OD 3 × L 40' once):
-- select dim_label('BOTTOM', null, 25.4, 60, 30, 2), dim_label('FACING_PUNCH', null, 25.4, 60, null, null), dim_label('SHORT_PIN', null, 3, 40, null, null);
