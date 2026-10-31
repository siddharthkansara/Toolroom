-- 18_inventory_takedowns.sql
-- Inventory phase 4: the "roller taken off the header machine" record (the notebook entry),
-- and one function that saves the record AND returns reusable tools to hard stock in one step.
-- Safe to re-run.

create table if not exists inventory_takedowns (
  id uuid primary key default gen_random_uuid(),
  factory_id text not null,
  roller_id uuid not null references roller_master(id),
  machine_id text,                                  -- header machine id, e.g. HD-08 or PEW:HD-1
  taken_down_on date not null,
  wire_size text,
  last_batta text,
  extra_batta text,
  tools jsonb not null default '[]'::jsonb,         -- [{tool_type, returned, scrapped}]
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now());
create index if not exists inv_td_roller on inventory_takedowns (factory_id, roller_id, taken_down_on desc);
alter table inventory_takedowns enable row level security;
drop policy if exists inv_td_read on inventory_takedowns;
drop policy if exists inv_td_add on inventory_takedowns;
create policy inv_td_read on inventory_takedowns for select using (can_see(factory_id));
create policy inv_td_add on inventory_takedowns for insert with check (can_write(factory_id));
-- no update/delete policy on purpose: a wrong entry is fixed by adding a newer one (the latest is shown)

-- Runs with the caller's own access (not security definer), so the same factory rules apply.
create or replace function inventory_take_down(
  p_factory text, p_roller uuid, p_machine text, p_date date, p_wire text, p_batta text, p_extra text,
  p_note text, p_location uuid, p_tools jsonb)
returns uuid language plpgsql as $$
declare v_id uuid; e jsonb; r integer;
begin
  insert into inventory_takedowns (factory_id, roller_id, machine_id, taken_down_on, wire_size, last_batta, extra_batta, note, tools)
  values (p_factory, p_roller, nullif(trim(p_machine), ''), p_date, nullif(trim(p_wire), ''), nullif(trim(p_batta), ''),
          nullif(trim(p_extra), ''), nullif(trim(p_note), ''), coalesce(p_tools, '[]'::jsonb))
  returning id into v_id;
  for e in select x from jsonb_array_elements(coalesce(p_tools, '[]'::jsonb)) as x loop
    r := coalesce((e->>'returned')::integer, 0);
    if r > 0 then
      insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, move_group)
      values (p_factory, p_roller, e->>'tool_type', 'HARD', r, p_location, 'RETURN', 'Taken down from machine', v_id);
    end if;
  end loop;
  return v_id;
end $$;
revoke all on function inventory_take_down(text, uuid, text, date, text, text, text, text, uuid, jsonb) from public, anon;
grant execute on function inventory_take_down(text, uuid, text, date, text, text, text, text, uuid, jsonb) to authenticated;
