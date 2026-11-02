-- Phase 1: multi-factory data model. Run ONCE, after 11_notes.sql and 12a_urgency.sql.
-- Back up first (export CSVs). Safe for the live app: factory columns default to 'NIC' until 13_drop_factory_defaults.sql.

create table if not exists factories (id text primary key, name text not null);
insert into factories (id, name) values ('NIC','NIC'), ('PEW','PEW'), ('BABA','BABA') on conflict do nothing;
alter table factories enable row level security;

-- Users: a toolroom user belongs to one factory; CNC and owner see all
alter table profiles add column if not exists factory_id text references factories(id);
update profiles set factory_id = 'NIC' where role = 'toolroom' and factory_id is null;
alter table profiles drop constraint if exists toolroom_needs_factory;
alter table profiles add constraint toolroom_needs_factory check (role <> 'toolroom' or factory_id is not null);

-- Roller sizes belong to a factory; the same size can exist in several
alter table roller_master add column if not exists factory_id text references factories(id);
update roller_master set factory_id = 'NIC' where factory_id is null;
alter table roller_master alter column factory_id set not null;
alter table roller_master alter column factory_id set default 'NIC';
alter table roller_master drop constraint if exists roller_master_roller_size_key;
alter table roller_master add constraint roller_master_factory_size_key unique (factory_id, roller_size);

-- Machines: id stays globally unique ('PEW:HD-1'); code is what people see ('HD-1'). Existing NIC ids stay as they are.
alter table header_machines add column if not exists factory_id text references factories(id);
alter table header_machines add column if not exists code text;
update header_machines set factory_id = 'NIC', code = id where factory_id is null;
alter table header_machines alter column factory_id set not null;
alter table header_machines alter column factory_id set default 'NIC';
alter table header_machines alter column code set not null;
create or replace function fill_machine_code() returns trigger language plpgsql as $$
begin if new.code is null then new.code := new.id; end if; return new; end $$;
drop trigger if exists header_machines_code on header_machines;
create trigger header_machines_code before insert on header_machines for each row execute function fill_machine_code();

-- Orders and deliveries carry their factory
alter table tool_orders add column if not exists factory_id text references factories(id);
update tool_orders set factory_id = 'NIC' where factory_id is null;
alter table tool_orders alter column factory_id set not null;
alter table tool_orders alter column factory_id set default 'NIC';
alter table deliveries add column if not exists factory_id text references factories(id);
update deliveries d set factory_id = o.factory_id from tool_orders o where o.id = d.order_id and d.factory_id is null;
alter table deliveries alter column factory_id set not null;
alter table deliveries alter column factory_id set default 'NIC';
create index if not exists tool_orders_factory on tool_orders (factory_id, status);

-- Header machines of the other two units
insert into header_machines (id, code, factory_id) values
 ('PEW:HD-1','HD-1','PEW'), ('PEW:HD-2','HD-2','PEW'), ('PEW:HD-3','HD-3','PEW'), ('PEW:HD-4','HD-4','PEW'), ('PEW:HD-5','HD-5','PEW'),
 ('BABA:HD-1','HD-1','BABA'), ('BABA:HD-2','HD-2','BABA'), ('BABA:HD-3','HD-3','BABA'), ('BABA:HD-4','HD-4','BABA'), ('BABA:HD-5','HD-5','BABA'),
 ('BABA:HD-7','HD-7','BABA'), ('BABA:HD-8','HD-8','BABA'), ('BABA:HD-9','HD-9','BABA'), ('BABA:HD-12','HD-12','BABA')
on conflict do nothing;

-- Who may see / change what
create or replace function public.my_factory() returns text language sql stable security definer set search_path = public as
$$ select factory_id from public.profiles where id = auth.uid() $$;
create or replace function public.can_see(f text) returns boolean language sql stable security definer set search_path = public as
$$ select public.my_role() in ('cnc','owner') or (public.my_role() = 'toolroom' and f = public.my_factory()) $$;
create or replace function public.can_write(f text) returns boolean language sql stable security definer set search_path = public as
$$ select public.my_role() = 'owner' or (public.my_role() = 'toolroom' and f = public.my_factory()) $$;

drop policy if exists "read" on factories;
create policy "read" on factories for select to authenticated using (my_role() is not null);

drop policy if exists "read" on roller_master; drop policy if exists "write" on roller_master;
create policy "read"  on roller_master for select to authenticated using (can_see(factory_id));
create policy "write" on roller_master for all to authenticated using (can_write(factory_id)) with check (can_write(factory_id));

drop policy if exists "read" on tooling_master; drop policy if exists "write" on tooling_master;
create policy "read"  on tooling_master for select to authenticated using (exists (select 1 from roller_master r where r.id = roller_id and can_see(r.factory_id)));
create policy "write" on tooling_master for all to authenticated
  using (exists (select 1 from roller_master r where r.id = roller_id and can_write(r.factory_id)))
  with check (exists (select 1 from roller_master r where r.id = roller_id and can_write(r.factory_id)));

drop policy if exists "read" on header_machines; drop policy if exists "write" on header_machines;
create policy "read"  on header_machines for select to authenticated using (can_see(factory_id));
create policy "write" on header_machines for all to authenticated using (can_write(factory_id)) with check (can_write(factory_id));

drop policy if exists "read" on production_runs; drop policy if exists "write" on production_runs;
create policy "read"  on production_runs for select to authenticated using (exists (select 1 from header_machines m where m.id = machine_id and can_see(m.factory_id)));
create policy "write" on production_runs for all to authenticated
  using (exists (select 1 from header_machines m where m.id = machine_id and can_write(m.factory_id)))
  with check (exists (select 1 from header_machines m where m.id = machine_id and can_write(m.factory_id)));

drop policy if exists "read" on tool_orders; drop policy if exists "insert" on tool_orders; drop policy if exists "delete" on tool_orders; drop policy if exists "update" on tool_orders;
create policy "read"   on tool_orders for select to authenticated using (can_see(factory_id));
create policy "insert" on tool_orders for insert to authenticated with check (can_write(factory_id));
create policy "delete" on tool_orders for delete to authenticated using (can_write(factory_id));
create policy "update" on tool_orders for update to authenticated using (my_role() = 'cnc' or can_write(factory_id)) with check (my_role() = 'cnc' or can_write(factory_id));

drop policy if exists "read" on deliveries; drop policy if exists "insert" on deliveries; drop policy if exists "update" on deliveries;
create policy "read"   on deliveries for select to authenticated using (can_see(factory_id));
create policy "insert" on deliveries for insert to authenticated with check (my_role() in ('cnc','owner'));
create policy "update" on deliveries for update to authenticated using (can_write(factory_id)) with check (can_write(factory_id));

-- Batch and close functions carry the factory
create or replace function complete_batch(p_order uuid, p_qty int, p_note text default null) returns void language plpgsql as $$
declare o tool_orders%rowtype; made int;
begin
  select * into o from tool_orders where id = p_order for update;
  if o.status <> 'ON_LATHE' then raise exception 'This order is not on the lathe'; end if;
  if p_qty < 1 then raise exception 'Quantity must be at least 1'; end if;
  insert into deliveries (order_id, qty_made, note, factory_id) values (p_order, p_qty, nullif(trim(p_note), ''), o.factory_id);
  select coalesce(sum(qty_made), 0) into made from deliveries where order_id = p_order;
  if made >= o.quantity then
    update tool_orders set status = 'CLOSED', closed_at = now(), qty_made = made where id = p_order;
  else
    update tool_orders set status = 'QUEUED', started_lathe_at = null, qty_made = made where id = p_order;
  end if;
end $$;

create or replace function close_order(p_order uuid) returns void language plpgsql as $$
begin
  if my_role() not in ('toolroom','owner') then raise exception 'Only the toolroom can close an order'; end if;
  update tool_orders set status = 'CLOSED', closed_at = now() where id = p_order and status = 'QUEUED' and can_write(factory_id);
  if not found then raise exception 'Order is not waiting in the queue, or it belongs to another factory'; end if;
end $$;

-- Then create the PEW and BABA toolroom logins in Authentication > Users and give them roles:
-- insert into profiles (id, role, factory_id) select id, 'toolroom', 'PEW'  from auth.users where email = 'toolroom.pew@yourplant.com';
-- insert into profiles (id, role, factory_id) select id, 'toolroom', 'BABA' from auth.users where email = 'toolroom.baba@yourplant.com';
