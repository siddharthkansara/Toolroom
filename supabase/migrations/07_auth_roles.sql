-- Roles: toolroom, cnc, owner. Run AFTER creating the three users in Authentication > Users.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('toolroom','cnc','owner')));
alter table profiles enable row level security;
create policy "read own profile" on profiles for select to authenticated using (id = auth.uid());

create or replace function public.my_role() returns text
  language sql stable security definer set search_path = public as
$$ select role from public.profiles where id = auth.uid() $$;

-- Remove the old wide-open policies
drop policy if exists "open" on roller_master;
drop policy if exists "open" on tooling_master;
drop policy if exists "open" on header_machines;
drop policy if exists "open" on production_runs;
drop policy if exists "open" on tool_orders;

-- Anyone logged in WITH a role can read everything (anonymous visitors get nothing)
create policy "read" on roller_master   for select to authenticated using (my_role() is not null);
create policy "read" on tooling_master  for select to authenticated using (my_role() is not null);
create policy "read" on header_machines for select to authenticated using (my_role() is not null);
create policy "read" on production_runs for select to authenticated using (my_role() is not null);
create policy "read" on tool_orders     for select to authenticated using (my_role() is not null);

-- Toolroom + owner manage rollers, tooling, machines, runs
create policy "write" on roller_master   for all to authenticated using (my_role() in ('toolroom','owner')) with check (my_role() in ('toolroom','owner'));
create policy "write" on tooling_master  for all to authenticated using (my_role() in ('toolroom','owner')) with check (my_role() in ('toolroom','owner'));
create policy "write" on header_machines for all to authenticated using (my_role() in ('toolroom','owner')) with check (my_role() in ('toolroom','owner'));
create policy "write" on production_runs for all to authenticated using (my_role() in ('toolroom','owner')) with check (my_role() in ('toolroom','owner'));

-- Orders: toolroom/owner create and delete; CNC can only update (start, stop, complete)
create policy "insert" on tool_orders for insert to authenticated with check (my_role() in ('toolroom','owner'));
create policy "delete" on tool_orders for delete to authenticated using (my_role() in ('toolroom','owner'));
create policy "update" on tool_orders for update to authenticated using (my_role() in ('toolroom','cnc','owner')) with check (my_role() in ('toolroom','cnc','owner'));

-- Then give each user a role (replace the emails):
-- insert into profiles (id, role) select id, 'owner'    from auth.users where email = 'you@example.com';
-- insert into profiles (id, role) select id, 'toolroom' from auth.users where email = 'toolroom@yourplant.com';
-- insert into profiles (id, role) select id, 'cnc'      from auth.users where email = 'cnc@yourplant.com';
