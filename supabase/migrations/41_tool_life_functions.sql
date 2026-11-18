-- 41_tool_life_functions.sql
-- Tool life, step 2: the sheet-saving function tracks each die top and bottom from mounting to wear-out.
-- Needs 39 and 40 first. A sheet saved WITHOUT tool rows (p_toolrows) still works the old way.
-- Rows look like: [{"tool_type":"BOTTOM","tool_id":null,"dim_key":"OD 25.4 ...","kg":100,"outcome":"WORN_OUT"}, ...]
-- listed in the order the tools were used; the first row is the tool already on the machine (its tool_id) if there is one.

-- Rolls back the tool records of one sheet line, so it can be changed or deleted.
-- Only the latest line of a machine may change, because later lines build on the tools it left on the machine.
create or replace function shift_tools_undo(p_entry uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e shift_entries%rowtype;
begin
  select * into e from shift_entries where id = p_entry;
  if e.id is null then return; end if;
  if not exists (select 1 from shift_tool_use where entry_id = p_entry)
     and not exists (select 1 from machine_tools where mounted_entry_id = p_entry or ended_entry_id = p_entry) then
    return;   -- no tools were tracked on this line
  end if;
  if exists (select 1 from shift_entries x
              where x.factory_id = e.factory_id and x.machine_id = e.machine_id and x.deleted_at is null and x.id <> e.id
                and (x.work_date, x.shift, x.created_at) > (e.work_date, e.shift, e.created_at)
                and exists (select 1 from shift_tool_use u where u.entry_id = x.id)) then
    raise exception 'A later entry for this machine already uses these tools. Change or delete the later entry first.';
  end if;
  delete from shift_tool_use where entry_id = p_entry;
  delete from machine_tools where mounted_entry_id = p_entry;                      -- tools first put on in this line
  update machine_tools set status = 'ON', ended_entry_id = null, ended_on = null    -- tools that came off in this line go back on
   where ended_entry_id = p_entry;
end $$;
revoke all on function shift_tools_undo(uuid) from public, anon, authenticated;

drop function if exists shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text, numeric, text, text, jsonb);
create or replace function shift_entry_save(
  p_id uuid, p_factory text, p_date date, p_shift text, p_machine text, p_status text,
  p_roller uuid, p_operator uuid, p_rollers integer, p_tools jsonb, p_note text,
  p_weight numeric default null, p_batch text default null, p_heat text default null, p_picks jsonb default null, p_toolrows jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid()); prev shift_entries;
  k text; q integer; v_short jsonb := '{}'::jsonb;
  picks jsonb; pk jsonb; want integer; picked integer; shortfall integer; dk text; n_dims integer;
  tt text; c machine_tools%rowtype; r record; seqn integer; n_rows integer; sum_kg numeric; kgv numeric; oc text; tid uuid;
  mt_id uuid; mt_roller uuid; mt_dim text; dkey text; short_n integer;
  v_rate numeric; v_rollers integer := 0;
  v_batch text := upper(nullif(trim(p_batch), '')); v_heat text := upper(nullif(trim(p_heat), ''));
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not can_write(p_factory) then raise exception 'You cannot enter data for %', p_factory; end if;
  perform pg_advisory_xact_lock(hashtext('machine_tools|' || p_machine));   -- one save at a time per machine
  if p_shift not in ('DAY','NIGHT') then raise exception 'Bad shift'; end if;
  if p_status not in ('RAN','NOT_RUNNING') then raise exception 'Bad status'; end if;
  if not exists (select 1 from header_machines where id = p_machine and factory_id = p_factory) then
    raise exception 'Header machine not found in %', p_factory; end if;
  perform shift_check_open(p_date, p_shift);
  if p_status = 'RAN' then
    if p_roller is null then raise exception 'Choose the roller size'; end if;
    if not exists (select 1 from roller_master where id = p_roller and factory_id = p_factory) then raise exception 'Roller size not found in %', p_factory; end if;
    if p_weight is null or p_weight <= 0 then raise exception 'Enter the weight of the rollers forged (kg)'; end if;
    if v_batch is null then raise exception 'Enter the batch number'; end if;
    if v_heat is null then raise exception 'Enter the heat number'; end if;
    if length(v_batch) > 40 or length(v_heat) > 40 then raise exception 'Batch and heat numbers can be at most 40 characters'; end if;
    if p_operator is not null and not exists (select 1 from header_operators where id = p_operator and factory_id = p_factory) then raise exception 'Operator not found'; end if;
    -- rollers per kg: an edited line keeps the rate it was first entered with (if the roller size is unchanged); otherwise the owner's current rate
    if p_id is not null then select e.rollers_per_kg into v_rate from shift_entries e where e.id = p_id and e.roller_id = p_roller; end if;
    if v_rate is null then
      select h.rollers_per_kg into v_rate from roller_rate_history h where h.roller_id = p_roller order by h.set_at desc, h.id desc limit 1;
    end if;
    if v_rate is null then raise exception 'Rollers per kg is not set for this roller size. Ask the owner to set it.'; end if;
    if p_weight * v_rate > 100000000 then raise exception 'That weight looks too large. Please check it.'; end if;
    v_rollers := round(p_weight * v_rate)::integer;
  end if;

  if p_id is null then
    insert into shift_entries (id, factory_id, work_date, shift, machine_id, status, roller_id, operator_id, rollers_forged, note, weight_kg, rollers_per_kg, batch_no, heat_no)
    values (v_id, p_factory, p_date, p_shift, p_machine, p_status,
            case when p_status = 'RAN' then p_roller end, case when p_status = 'RAN' then p_operator end,
            case when p_status = 'RAN' then v_rollers else 0 end, nullif(trim(p_note), ''),
            case when p_status = 'RAN' then p_weight end, case when p_status = 'RAN' then v_rate end,
            case when p_status = 'RAN' then v_batch end, case when p_status = 'RAN' then v_heat end);
  else
    select * into prev from shift_entries where id = p_id for update;
    if not found or prev.deleted_at is not null then raise exception 'Entry not found'; end if;
    if prev.factory_id <> p_factory then raise exception 'Wrong factory'; end if;
    perform shift_check_open(prev.work_date, prev.shift);     -- the line's original shift must still be open too
    perform shift_tools_undo(p_id);                          -- tool records of this line are rolled back (only the latest line of a machine may change)
    perform shift_return_stock(p_id, 'Entry changed');
    delete from shift_tools where entry_id = p_id;
    update shift_entries set work_date = p_date, shift = p_shift, machine_id = p_machine, status = p_status,
           roller_id = case when p_status = 'RAN' then p_roller end, operator_id = case when p_status = 'RAN' then p_operator end,
           rollers_forged = case when p_status = 'RAN' then v_rollers else 0 end, note = nullif(trim(p_note), ''),
           weight_kg = case when p_status = 'RAN' then p_weight end, rollers_per_kg = case when p_status = 'RAN' then v_rate end,
           batch_no = case when p_status = 'RAN' then v_batch end, heat_no = case when p_status = 'RAN' then v_heat end,
           updated_by = auth.uid(), updated_at = now()
     where id = p_id;
  end if;

  if p_status = 'RAN' then
    if p_toolrows is not null then
      -- Tool tracking for die top and bottom: one row per tool used, in the order they were used
      if jsonb_typeof(p_toolrows) <> 'array' then raise exception 'Bad tool rows'; end if;
      foreach tt in array array['DIE_TOP', 'BOTTOM'] loop
        select count(*), coalesce(sum((x->>'kg')::numeric), 0) into n_rows, sum_kg
          from jsonb_array_elements(p_toolrows) x where x->>'tool_type' = tt;
        if n_rows = 0 then raise exception 'Add the % that was used', initcap(replace(tt, '_', ' ')); end if;
        if abs(sum_kg - p_weight) > 0.005 then
          raise exception 'The kg for % add up to %, but the line weight is % kg', initcap(replace(tt, '_', ' ')), sum_kg, p_weight; end if;
        select * into c from machine_tools
         where factory_id = p_factory and machine_id = p_machine and tool_type = tt and status = 'ON';   -- already on the machine
        seqn := 0;
        for r in select x.j, x.ord from jsonb_array_elements(p_toolrows) with ordinality as x(j, ord)
                  where x.j->>'tool_type' = tt order by x.ord loop
          seqn := seqn + 1;
          kgv := (r.j->>'kg')::numeric; oc := r.j->>'outcome'; tid := nullif(r.j->>'tool_id', '')::uuid;
          if kgv is null or kgv < 0 then raise exception 'Enter the kg for each % (0 or more)', initcap(replace(tt, '_', ' ')); end if;
          if oc not in ('ON', 'WORN_OUT', 'REMOVED') then raise exception 'Choose what happened to the %', initcap(replace(tt, '_', ' ')); end if;
          if seqn < n_rows and oc = 'ON' then
            raise exception 'Only the last % can stay on the machine', initcap(replace(tt, '_', ' ')); end if;
          if seqn = 1 and c.id is not null then
            if tid is distinct from c.id then
              raise exception 'The % already on this machine must be the first one listed', initcap(replace(tt, '_', ' ')); end if;
            if c.roller_id <> p_roller and (kgv > 0 or oc = 'ON') then
              raise exception 'The % on this machine is for another roller size. Take it off, with 0 kg.', initcap(replace(tt, '_', ' ')); end if;
            if oc <> 'ON' then
              update machine_tools set status = oc, ended_entry_id = v_id, ended_on = p_date where id = c.id; end if;
            mt_id := c.id; mt_roller := c.roller_id; mt_dim := c.dim_key;
          else
            if tid is not null then raise exception 'Bad tool record'; end if;
            if jsonb_exists(r.j, 'dim_key') then dkey := coalesce(r.j->>'dim_key', '');
            else
              select count(distinct s.dim_key), min(s.dim_key) into n_dims, dkey from inventory_stock s
               where s.factory_id = p_factory and s.roller_id = p_roller and s.tool_type = tt;
              if n_dims > 1 then raise exception 'Choose which size of % was put on', initcap(replace(tt, '_', ' ')); end if;
              dkey := coalesce(dkey, '');
            end if;
            insert into machine_tools (factory_id, machine_id, roller_id, tool_type, dim_key, status, mounted_entry_id, mounted_on, ended_entry_id, ended_on)
            values (p_factory, p_machine, p_roller, tt, dkey, oc, v_id, p_date,
                    case when oc <> 'ON' then v_id end, case when oc <> 'ON' then p_date end)
            returning id into mt_id;
            mt_roller := p_roller; mt_dim := dkey;
          end if;
          insert into shift_tool_use (entry_id, tool_type, seq, machine_tool_id, kg, outcome) values (v_id, tt, seqn, mt_id, kgv, oc);
          if oc = 'WORN_OUT' then   -- the worn-out tool leaves stock, from its own size
            short_n := shift_use_stock(p_factory, mt_roller, tt, mt_dim, 1, v_id, p_machine);
            if short_n > 0 then v_short := v_short || jsonb_build_object(tt, coalesce((v_short->>tt)::integer, 0) + short_n); end if;
          end if;
        end loop;
      end loop;
      -- the line's tools-used summary for these types = the tools worn out in it, per size
      insert into shift_tools (entry_id, tool_type, dim_key, qty)
      select u.entry_id, u.tool_type, t.dim_key, count(*)::integer
        from shift_tool_use u join machine_tools t on t.id = u.machine_tool_id
       where u.entry_id = v_id and u.outcome = 'WORN_OUT'
       group by u.entry_id, u.tool_type, t.dim_key;
    end if;
    for k, q in select key, (value #>> '{}')::integer from jsonb_each(coalesce(p_tools, '{}'::jsonb)) loop
      if k not in ('DIE_TOP','BOTTOM','FACING_PUNCH','SHORT_PIN','CUTTER','OTHER') then raise exception 'Unknown tool %', k; end if;
      if q < 0 then raise exception 'Tool counts cannot be negative'; end if;
      if p_toolrows is not null and k in ('DIE_TOP', 'BOTTOM') then continue; end if;   -- these types are handled by the tool rows
      if q > 0 then
        picks := coalesce(p_picks -> k, '[]'::jsonb);
        if jsonb_typeof(picks) <> 'array' then raise exception 'Bad size choice for %', k; end if;
        picked := 0; shortfall := 0;
        if jsonb_array_length(picks) > 0 then
          -- the person chose which size(s) were used: [{"dim_key": "...", "qty": 2}, ...]
          for pk in select x from jsonb_array_elements(picks) x loop
            want := coalesce((pk->>'qty')::integer, 0);
            continue when want <= 0;
            picked := picked + want;
            if picked > q then raise exception 'The sizes chosen for % add up to more than %', k, q; end if;
            dk := coalesce(pk->>'dim_key', '');
            insert into shift_tools (entry_id, tool_type, dim_key, qty) values (v_id, k, dk, want)
              on conflict (entry_id, tool_type, dim_key) do update set qty = shift_tools.qty + excluded.qty;
            shortfall := shortfall + shift_use_stock(p_factory, p_roller, k, dk, want, v_id, p_machine);
          end loop;
          if q > picked then   -- not covered by a chosen size: counted as used, and as short
            insert into shift_tools (entry_id, tool_type, dim_key, qty) values (v_id, k, '', q - picked)
              on conflict (entry_id, tool_type, dim_key) do update set qty = shift_tools.qty + excluded.qty;
            shortfall := shortfall + (q - picked);
          end if;
        else
          -- no choice given: only allowed when there is at most one size in stock for this roller and tool
          select count(distinct s.dim_key), min(s.dim_key) into n_dims, dk from inventory_stock s
           where s.factory_id = p_factory and s.roller_id = p_roller and s.tool_type = k;
          if n_dims > 1 then raise exception 'Choose which size of % was used', k; end if;
          insert into shift_tools (entry_id, tool_type, dim_key, qty) values (v_id, k, coalesce(dk, ''), q)
            on conflict (entry_id, tool_type, dim_key) do update set qty = shift_tools.qty + excluded.qty;
          shortfall := shift_use_stock(p_factory, p_roller, k, null, q, v_id, p_machine);
        end if;
        if shortfall > 0 then v_short := v_short || jsonb_build_object(k, shortfall); end if;   -- recorded, not blocked
      end if;
    end loop;
  end if;
  update shift_entries set short = v_short where id = v_id;
  return jsonb_build_object('id', v_id, 'short', v_short);
end $$;

create or replace function shift_entry_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e shift_entries;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into e from shift_entries where id = p_id for update;
  if not found then raise exception 'Entry not found'; end if;
  if e.deleted_at is not null then return; end if;
  if not can_write(e.factory_id) then raise exception 'You cannot change data for %', e.factory_id; end if;
  perform shift_check_open(e.work_date, e.shift);
  perform shift_tools_undo(p_id);   -- tool records of this line are rolled back (only the latest line of a machine may be deleted)
  perform shift_return_stock(p_id, 'Entry deleted');
  update shift_entries set deleted_at = now(), deleted_by = auth.uid() where id = p_id;
end $$;

revoke all on function shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text, numeric, text, text, jsonb, jsonb) from public, anon;
grant execute on function shift_entry_save(uuid, text, date, text, text, text, uuid, uuid, integer, jsonb, text, numeric, text, text, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
