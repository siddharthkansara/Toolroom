-- 30: the shift lines report (used by the production table and the sheet download) now also carries
-- party name, batch no, heat no, rollers per kg and the number of each tool type used on the line.
-- The old columns stay first and in the same order. Run after 28 and 29. Safe to run more than once.

drop function if exists report_lines(date, date, text);
create or replace function report_lines(p_from date, p_to date, p_factory text)
returns table (work_date date, shift text, factory_id text, machine_id text, status text, operator_name text, roller_size text, rollers integer, weight_kg numeric, note text,
               party_name text, batch_no text, heat_no text, rollers_per_kg numeric, die_top integer, bottom integer, facing_punch integer, short_pin integer)
language sql stable as $$
  select e.work_date, e.shift, e.factory_id, e.machine_id, e.status, o.name, r.roller_size, e.rollers_forged, e.weight_kg, e.note,
         r.party_name, e.batch_no, e.heat_no, e.rollers_per_kg,
         coalesce((select sum(t.qty) from shift_tools t where t.entry_id = e.id and t.tool_type = 'DIE_TOP'), 0)::integer,
         coalesce((select sum(t.qty) from shift_tools t where t.entry_id = e.id and t.tool_type = 'BOTTOM'), 0)::integer,
         coalesce((select sum(t.qty) from shift_tools t where t.entry_id = e.id and t.tool_type = 'FACING_PUNCH'), 0)::integer,
         coalesce((select sum(t.qty) from shift_tools t where t.entry_id = e.id and t.tool_type = 'SHORT_PIN'), 0)::integer
    from shift_entries e
    left join header_operators o on o.id = e.operator_id
    left join roller_master r on r.id = e.roller_id
   where e.deleted_at is null and e.work_date >= p_from and e.work_date < p_to and e.factory_id = p_factory
   order by e.work_date, e.shift, e.machine_id, e.created_at;
$$;
revoke all on function report_lines(date, date, text) from public, anon;
grant execute on function report_lines(date, date, text) to authenticated;
