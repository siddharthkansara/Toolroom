-- 17_inventory_daily_slots.sql
-- Inventory phase 3: allow two daily check-ins per factory (MORNING = night shift, EVENING = day shift).
-- Safe to re-run.
alter table inventory_daily_checks add column if not exists slot text not null default 'EVENING';
alter table inventory_daily_checks drop constraint if exists inventory_daily_checks_slot_check;
alter table inventory_daily_checks add constraint inventory_daily_checks_slot_check check (slot in ('MORNING','EVENING'));
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'inventory_daily_checks'::regclass and contype = 'u' loop
    execute format('alter table inventory_daily_checks drop constraint %I', c);
  end loop;
end $$;
create unique index if not exists inv_checks_unique on inventory_daily_checks (factory_id, check_date, slot);
