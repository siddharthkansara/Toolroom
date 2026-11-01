-- 23_take_down_notebook_only.sql
-- Off machine is now only the run notebook (wire size, batta, extra batta).
-- Tools used are recorded on the Shift Sheet and deducted from stock there, so this function must NOT add tools
-- back to stock any more (that would count them twice). Same name and inputs as before. Safe to re-run.
create or replace function inventory_take_down(
  p_factory text, p_roller uuid, p_machine text, p_date date, p_wire text, p_batta text, p_extra text,
  p_note text, p_location uuid, p_tools jsonb)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into inventory_takedowns (factory_id, roller_id, machine_id, taken_down_on, wire_size, last_batta, extra_batta, note, tools)
  values (p_factory, p_roller, nullif(trim(p_machine), ''), p_date, nullif(trim(p_wire), ''), nullif(trim(p_batta), ''),
          nullif(trim(p_extra), ''), nullif(trim(p_note), ''), '[]'::jsonb)
  returning id into v_id;
  return v_id;
end $$;
