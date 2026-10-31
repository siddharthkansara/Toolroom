-- 16_inventory_foundation.sql
-- Inventory phase 1: stock ledger, locations, daily check-ins, automatic posting when a plant
-- confirms receipt, and a cross-factory search function. No screens use this yet.
-- Needs these functions to exist already: my_role(), can_see(text), can_write(text).
-- Safe to re-run. Undo with 16_inventory_foundation_rollback.sql.

-- ---------- settings (one row) ----------
create table if not exists inventory_settings (
  id int primary key default 1 check (id = 1),
  go_live timestamptz not null default now());      -- only batches received after this feed inventory
insert into inventory_settings (id) values (1) on conflict do nothing;
alter table inventory_settings enable row level security;
drop policy if exists inv_settings_read on inventory_settings;
drop policy if exists inv_settings_write on inventory_settings;
create policy inv_settings_read on inventory_settings for select using (auth.uid() is not null);
create policy inv_settings_write on inventory_settings for update using (my_role() = 'owner') with check (my_role() = 'owner');

-- ---------- locations (almirah / cupboard names, per factory) ----------
create table if not exists inventory_locations (
  id uuid primary key default gen_random_uuid(),
  factory_id text not null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now());
create unique index if not exists inv_loc_unique on inventory_locations (factory_id, lower(name));
alter table inventory_locations enable row level security;
drop policy if exists inv_loc_read on inventory_locations;
drop policy if exists inv_loc_write on inventory_locations;
create policy inv_loc_read on inventory_locations for select using (can_see(factory_id));
create policy inv_loc_write on inventory_locations for all using (can_write(factory_id)) with check (can_write(factory_id));

-- ---------- the stock ledger: every change is one row, qty is signed ----------
create table if not exists inventory_moves (
  id uuid primary key default gen_random_uuid(),
  factory_id text not null,
  roller_id uuid not null references roller_master(id),
  tool_type text not null,
  state text not null check (state in ('SOFT','HARD')),
  qty integer not null check (qty <> 0),
  location_id uuid references inventory_locations(id),
  kind text not null check (kind in ('RECEIPT','HARDEN','TAKE_OUT','MOVE','TRANSFER_OUT','TRANSFER_IN','OPENING','CORRECTION','RETURN')),
  reason text,
  note text,
  delivery_id uuid references deliveries(id),
  order_id uuid,
  move_group uuid,                                   -- ties the two legs of a harden / move / transfer together
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now());
create unique index if not exists inv_moves_one_receipt on inventory_moves (delivery_id) where kind = 'RECEIPT';
create index if not exists inv_moves_key on inventory_moves (factory_id, roller_id, tool_type, state);
create index if not exists inv_moves_time on inventory_moves (factory_id, created_at desc);
alter table inventory_moves enable row level security;
drop policy if exists inv_moves_read on inventory_moves;
drop policy if exists inv_moves_add on inventory_moves;
create policy inv_moves_read on inventory_moves for select using (can_see(factory_id));
create policy inv_moves_add on inventory_moves for insert with check (can_write(factory_id));
-- no update or delete policy on purpose: corrections are new rows, history stays intact

-- ---------- daily check-ins (used by the reminder in phase 3) ----------
create table if not exists inventory_daily_checks (
  id uuid primary key default gen_random_uuid(),
  factory_id text not null,
  check_date date not null,
  status text not null check (status in ('UPDATED','NOTHING')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (factory_id, check_date));
alter table inventory_daily_checks enable row level security;
drop policy if exists inv_checks_read on inventory_daily_checks;
drop policy if exists inv_checks_write on inventory_daily_checks;
create policy inv_checks_read on inventory_daily_checks for select using (can_see(factory_id));
create policy inv_checks_write on inventory_daily_checks for all using (can_write(factory_id)) with check (can_write(factory_id));

-- ---------- current stock = sum of the ledger (respects the caller's access) ----------
create or replace view inventory_stock with (security_invoker = true) as
select factory_id, roller_id, tool_type, state, location_id,
       sum(qty)::bigint as qty, max(created_at) as last_move
from inventory_moves
group by factory_id, roller_id, tool_type, state, location_id
having sum(qty) <> 0;

-- ---------- block negative stock ----------
create or replace function trg_inv_no_negative() returns trigger
language plpgsql security definer set search_path = public as $$
declare bal bigint;
begin
  if new.qty < 0 then
    perform pg_advisory_xact_lock(hashtext(new.factory_id || '|' || new.roller_id::text || '|' || new.tool_type || '|' || new.state));
    select coalesce(sum(m.qty), 0) into bal from inventory_moves m
     where m.factory_id = new.factory_id and m.roller_id = new.roller_id and m.tool_type = new.tool_type
       and m.state = new.state and m.location_id is not distinct from new.location_id;
    if bal + new.qty < 0 then
      raise exception 'Not enough stock: only % available', bal;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists inv_no_negative on inventory_moves;
create trigger inv_no_negative before insert on inventory_moves for each row execute function trg_inv_no_negative();

-- ---------- automatic posting when a batch is received ----------
create or replace function inv_post_receipt(p_delivery uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare d record; n integer := 0;
begin
  select dl.id, dl.order_id, dl.status, dl.qty_received, dl.received_at,
         coalesce(dl.factory_id, o.factory_id) as factory_id,
         coalesce(o.roller_id, tm.roller_id) as roller_id,
         coalesce(tm.tool_type::text, 'OTHER') as tool_type,
         case when tm.id is null then o.custom_tool_name end as note,
         o.target_strokes
    into d
    from deliveries dl
    join tool_orders o on o.id = dl.order_id
    left join tooling_master tm on tm.id = o.tooling_id
   where dl.id = p_delivery;
  if not found then return 0; end if;
  if d.status <> 'RECEIVED' or coalesce(d.qty_received, 0) <= 0 then return 0; end if;
  if d.target_strokes = 'DUMMY' or d.roller_id is null or d.factory_id is null then return 0; end if;
  if coalesce(d.received_at, now()) < (select go_live from inventory_settings where id = 1) then return 0; end if;
  insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, kind, delivery_id, order_id, note, created_by)
  values (d.factory_id, d.roller_id, d.tool_type, 'SOFT', d.qty_received, 'RECEIPT', d.id, d.order_id, d.note, null)
  on conflict (delivery_id) where kind = 'RECEIPT' do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function inv_post_receipt(uuid) from public, anon, authenticated;

create or replace function trg_inv_receipt() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    if new.status = 'RECEIVED' then perform inv_post_receipt(new.id); end if;
  exception when others then
    raise warning 'inventory posting skipped for delivery %: %', new.id, sqlerrm;   -- never block receiving
  end;
  return new;
end $$;
drop trigger if exists inv_receipt_after on deliveries;
create trigger inv_receipt_after after insert or update of status, qty_received on deliveries
  for each row execute function trg_inv_receipt();

-- catch-up: posts any received batch that was missed (safe to run any time; owner or SQL editor only)
create or replace function inventory_catchup() returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  if auth.uid() is not null and my_role() is distinct from 'owner' then raise exception 'owner only'; end if;
  for r in select id from deliveries where status = 'RECEIVED' loop n := n + inv_post_receipt(r.id); end loop;
  return n;
end $$;
revoke all on function inventory_catchup() from public, anon;
grant execute on function inventory_catchup() to authenticated;

-- ---------- cross-factory search: any signed-in user, limited fields, location only for own factory / owner ----------
create or replace function inventory_search(p_size text)
returns table (factory_id text, roller_size text, tool_type text, state text, qty bigint, location text, last_move timestamptz)
language sql stable security definer set search_path = public as $$
  select s.factory_id, r.roller_size, s.tool_type, s.state, sum(s.qty)::bigint,
         case when can_see(s.factory_id) then l.name end, max(s.last_move)
    from (select m.factory_id, m.roller_id, m.tool_type, m.state, m.location_id, sum(m.qty) as qty, max(m.created_at) as last_move
            from inventory_moves m
           group by m.factory_id, m.roller_id, m.tool_type, m.state, m.location_id
          having sum(m.qty) <> 0) s
    join roller_master r on r.id = s.roller_id
    left join inventory_locations l on l.id = s.location_id
   where auth.uid() is not null and length(trim(p_size)) >= 1
     and r.roller_size ilike '%' || trim(p_size) || '%'
   group by s.factory_id, r.roller_size, s.tool_type, s.state, case when can_see(s.factory_id) then l.name end
   order by r.roller_size, s.factory_id, s.tool_type, s.state
   limit 300;
$$;
revoke all on function inventory_search(text) from public, anon;
grant execute on function inventory_search(text) to authenticated;
