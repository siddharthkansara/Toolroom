-- Tool life, step 1: each physical tool on a header machine is one record, followed from mounting to wear-out.

create table if not exists machine_tools (
  id uuid primary key default gen_random_uuid(),
  factory_id text not null,
  machine_id text not null,                                    -- header machine id
  roller_id uuid not null references roller_master(id),        -- the roller size this tool is for
  tool_type text not null check (tool_type in ('DIE_TOP','BOTTOM','FACING_PUNCH','SHORT_PIN','CUTTER','OTHER')),
  dim_key text not null default '',                            -- its size label, same as the stock line it came from
  status text not null default 'ON' check (status in ('ON','WORN_OUT','REMOVED')),
  mounted_entry_id uuid not null references shift_entries(id), -- the sheet line where it was put on
  mounted_on date not null,
  ended_entry_id uuid references shift_entries(id),            -- the sheet line where it came off
  ended_on date,
  created_at timestamptz not null default now());
-- a machine holds one tool of each type at a time
create unique index if not exists machine_tools_one_on on machine_tools (machine_id, tool_type) where status = 'ON';
create index if not exists machine_tools_machine on machine_tools (factory_id, machine_id, status);

-- What each sheet line did with each tool: kg forged with it, and what happened to it at the end of the line
create table if not exists shift_tool_use (
  entry_id uuid not null references shift_entries(id) on delete cascade,
  tool_type text not null,
  seq integer not null,                                        -- order of use inside the line
  machine_tool_id uuid not null references machine_tools(id),
  kg numeric(10,2) not null check (kg >= 0),
  outcome text not null check (outcome in ('ON','WORN_OUT','REMOVED')),
  primary key (entry_id, tool_type, seq));
create index if not exists shift_tool_use_tool on shift_tool_use (machine_tool_id);

-- Read-only for people who can see the factory. Rows are written only by the sheet-saving function.
alter table machine_tools enable row level security;
drop policy if exists machine_tools_read on machine_tools;
create policy machine_tools_read on machine_tools for select using (can_see(factory_id));
alter table shift_tool_use enable row level security;
drop policy if exists shift_tool_use_read on shift_tool_use;
create policy shift_tool_use_read on shift_tool_use for select using (
  exists (select 1 from shift_entries e where e.id = entry_id and can_see(e.factory_id)));

-- One row per tool with its whole life so far: kg, rollers (kg x each line's rollers-per-kg) and lines
create or replace view tool_life with (security_invoker = true) as
select t.id, t.factory_id, t.machine_id, t.roller_id, t.tool_type, t.dim_key, t.status, t.mounted_on, t.ended_on,
       coalesce(sum(u.kg), 0)::numeric(12,2) as kg,
       coalesce(round(sum(u.kg * e.rollers_per_kg)), 0)::bigint as rollers,
       count(u.entry_id)::integer as lines
  from machine_tools t
  left join (shift_tool_use u join shift_entries e on e.id = u.entry_id and e.deleted_at is null) on u.machine_tool_id = t.id
 group by t.id;

notify pgrst, 'reload schema';