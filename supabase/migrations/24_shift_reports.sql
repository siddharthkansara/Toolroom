-- 24_shift_reports.sql
-- Report functions over the shift sheet. All adding-up happens in the database, so the dashboard stays fast.
-- They run with the caller's own access (owner sees every factory). p_to is EXCLUSIVE. p_factory null = all factories.
-- Safe to re-run.

-- 1. Totals per shift: factory x date x shift
create or replace function report_shift_totals(p_from date, p_to date, p_factory text default null)
returns table (factory_id text, work_date date, shift text, rollers bigint, lines bigint, headers bigint, not_running bigint, completed boolean)
language sql stable as $$
  select e.factory_id, e.work_date, e.shift,
         coalesce(sum(e.rollers_forged), 0)::bigint,
         count(*)::bigint,
         (count(distinct e.machine_id) filter (where e.status = 'RAN'))::bigint,
         (count(distinct e.machine_id) filter (where e.status = 'NOT_RUNNING'))::bigint,
         coalesce(bool_or(s.completed_at is not null), false)
    from shift_entries e
    left join shift_sheets s on s.factory_id = e.factory_id and s.work_date = e.work_date and s.shift = e.shift
   where e.deleted_at is null and e.work_date >= p_from and e.work_date < p_to and (p_factory is null or e.factory_id = p_factory)
   group by e.factory_id, e.work_date, e.shift
   order by e.work_date desc, e.factory_id, e.shift;
$$;

-- 2. Output per header machine
create or replace function report_headers(p_from date, p_to date, p_factory text default null)
returns table (factory_id text, machine_id text, rollers bigint, ran_shifts bigint, idle_shifts bigint)
language sql stable as $$
  select e.factory_id, e.machine_id,
         coalesce(sum(e.rollers_forged) filter (where e.status = 'RAN'), 0)::bigint,
         (count(distinct (e.work_date, e.shift)) filter (where e.status = 'RAN'))::bigint,
         (count(distinct (e.work_date, e.shift)) filter (where e.status = 'NOT_RUNNING'))::bigint
    from shift_entries e
   where e.deleted_at is null and e.work_date >= p_from and e.work_date < p_to and (p_factory is null or e.factory_id = p_factory)
   group by e.factory_id, e.machine_id
   order by e.factory_id, e.machine_id;
$$;

-- 3. Output per operator, split by roller size (op_shifts = shifts the operator worked, repeated on each row)
create or replace function report_operators(p_from date, p_to date, p_factory text default null)
returns table (factory_id text, operator_id uuid, operator_name text, roller_id uuid, roller_size text, rollers bigint, op_shifts bigint)
language sql stable as $$
  with e as (
    select x.factory_id, x.operator_id, x.roller_id, x.rollers_forged, x.work_date, x.shift
      from shift_entries x
     where x.deleted_at is null and x.status = 'RAN' and x.work_date >= p_from and x.work_date < p_to and (p_factory is null or x.factory_id = p_factory)),
  per as (select e.factory_id, e.operator_id, e.roller_id, sum(e.rollers_forged)::bigint as rollers from e group by e.factory_id, e.operator_id, e.roller_id),
  sh as (select e.factory_id, e.operator_id, count(distinct (e.work_date, e.shift))::bigint as shifts from e group by e.factory_id, e.operator_id)
  select per.factory_id, per.operator_id, coalesce(o.name, 'No operator'), per.roller_id, r.roller_size, per.rollers, sh.shifts
    from per
    join sh on sh.factory_id = per.factory_id and sh.operator_id is not distinct from per.operator_id
    left join header_operators o on o.id = per.operator_id
    left join roller_master r on r.id = per.roller_id
   order by per.factory_id, coalesce(o.name, 'No operator'), per.rollers desc;
$$;

-- 4. Rollers forged and tools used per roller size and tool type (tool_type is null when no tools were used)
create or replace function report_sizes(p_from date, p_to date, p_factory text default null)
returns table (factory_id text, roller_id uuid, roller_size text, rollers bigint, shifts bigint, tool_type text, tools bigint)
language sql stable as $$
  with e as (
    select x.id, x.factory_id, x.roller_id, x.rollers_forged, x.work_date, x.shift
      from shift_entries x
     where x.deleted_at is null and x.status = 'RAN' and x.work_date >= p_from and x.work_date < p_to and (p_factory is null or x.factory_id = p_factory)),
  r as (select e.factory_id, e.roller_id, sum(e.rollers_forged)::bigint as rollers, count(distinct (e.work_date, e.shift))::bigint as shifts from e group by e.factory_id, e.roller_id),
  t as (select e.factory_id, e.roller_id, st.tool_type, sum(st.qty)::bigint as tools from e join shift_tools st on st.entry_id = e.id group by e.factory_id, e.roller_id, st.tool_type)
  select r.factory_id, r.roller_id, ro.roller_size, r.rollers, r.shifts, t.tool_type, coalesce(t.tools, 0)::bigint
    from r
    join roller_master ro on ro.id = r.roller_id
    left join t on t.factory_id = r.factory_id and t.roller_id = r.roller_id
   order by ro.roller_size, t.tool_type;
$$;

revoke all on function report_shift_totals(date, date, text) from public, anon;
revoke all on function report_headers(date, date, text) from public, anon;
revoke all on function report_operators(date, date, text) from public, anon;
revoke all on function report_sizes(date, date, text) from public, anon;
grant execute on function report_shift_totals(date, date, text) to authenticated;
grant execute on function report_headers(date, date, text) to authenticated;
grant execute on function report_operators(date, date, text) to authenticated;
grant execute on function report_sizes(date, date, text) to authenticated;
