create extension if not exists pgcrypto;
create type tool_type_enum as enum ('DIE_TOP','BOTTOM','FACING_PUNCH','SHORT_PIN','CUTTER','OTHER');
create type order_status_enum as enum ('QUEUED','ON_LATHE','IN_TRANSIT','RECEIVED','HEAT_TREAT','READY');
create type priority_enum as enum ('URGENT_MACHINE_DOWN','BUFFER_NEXT_SHIFT');
create type run_status_enum as enum ('ACTIVE','COMPLETED');

create table roller_master (
  id uuid primary key default gen_random_uuid(),
  roller_size varchar not null unique,
  customer_drg varchar,
  created_at timestamptz default now());

create table tooling_master (
  id uuid primary key default gen_random_uuid(),
  roller_id uuid not null references roller_master(id) on delete cascade,
  tool_type tool_type_enum not null,
  batta_code varchar,
  od_dim numeric(6,2), length_dim numeric(6,2), step_id_dim numeric(6,2), step_depth_dim numeric(6,2));

create table header_machines (
  id varchar(20) primary key,
  current_roller_id uuid references roller_master(id),
  status varchar default 'RUNNING');

create table production_runs (
  id uuid primary key default gen_random_uuid(),
  machine_id varchar(20) not null references header_machines(id),
  roller_id uuid not null references roller_master(id),
  started_at timestamptz default now(), ended_at timestamptz,
  status run_status_enum default 'ACTIVE');

create table tool_orders (
  id uuid primary key default gen_random_uuid(),
  slip_no serial,
  machine_id varchar(20) not null references header_machines(id),
  tooling_id uuid references tooling_master(id),
  run_id uuid references production_runs(id),
  custom_tool_name varchar, custom_dimensions varchar,
  quantity int default 20,
  priority priority_enum not null default 'BUFFER_NEXT_SHIFT',
  status order_status_enum not null default 'QUEUED',
  target_strokes varchar, notes text,
  created_at timestamptz default now(),
  started_lathe_at timestamptz, dispatched_at timestamptz, received_at timestamptz);

create index on tool_orders (status, priority, created_at);
create index on tool_orders (run_id);

alter publication supabase_realtime add table tool_orders, production_runs, header_machines;

-- Tablets use the anon key. Tighten with auth before exposing beyond the plant.
alter table roller_master enable row level security;
alter table tooling_master enable row level security;
alter table header_machines enable row level security;
alter table production_runs enable row level security;
alter table tool_orders enable row level security;
create policy "open" on roller_master for all using (true) with check (true);
create policy "open" on tooling_master for all using (true) with check (true);
create policy "open" on header_machines for all using (true) with check (true);
create policy "open" on production_runs for all using (true) with check (true);
create policy "open" on tool_orders for all using (true) with check (true);

-- Seed. DIMENSIONS ARE PLACEHOLDERS: replace with real drawing values.
insert into roller_master (roller_size, customer_drg) values
 ('31309','NEI CRSF1093'),('31310','ABC CR-1145'),('32018X',null),('33116',null),('602',null);

insert into tooling_master (roller_id, tool_type, batta_code, od_dim, length_dim, step_id_dim, step_depth_dim)
select r.id, t.tt::tool_type_enum, t.code, t.od, t.len, t.sid, t.sd
from roller_master r join (values
 ('31309','DIE_TOP','C61',36.50,40.00,18.20,6.00),
 ('31309','BOTTOM','B31',36.50,32.00,null::numeric,null::numeric),
 ('31309','FACING_PUNCH','P31',22.00,55.00,null::numeric,null::numeric),
 ('31310','DIE_TOP','A25',38.20,42.00,19.00,6.50),
 ('31310','BOTTOM','B32',38.20,33.00,null::numeric,null::numeric),
 ('32018X','DIE_TOP','D03',30.00,36.00,15.00,5.00),
 ('32018X','FACING_PUNCH','P18',20.00,52.00,null::numeric,null::numeric),
 ('33116','DIE_TOP','A09',34.00,38.00,17.00,5.50),
 ('33116','SHORT_PIN','S16',8.00,30.00,null::numeric,null::numeric),
 ('602','BOTTOM','B02',16.00,24.00,null::numeric,null::numeric)
) as t(size,tt,code,od,len,sid,sd) on t.size = r.roller_size;

insert into header_machines (id, current_roller_id)
select m.id, (select id from roller_master where roller_size = m.size) from (values
 ('HD-08','602'),('HD-12','31309'),('HD-13','31310'),('HD-14','31309'),
 ('HD-15','33116'),('HD-16','32018X'),('HD-20','31310'),('HD-21','602')) as m(id,size);

insert into production_runs (machine_id, roller_id)
select id, current_roller_id from header_machines;
