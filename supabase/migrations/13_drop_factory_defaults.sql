-- Run LATER, only after Phases 2-4 are deployed (every screen then sends factory_id explicitly).
-- It makes a forgotten factory an error instead of silently becoming 'NIC'.
alter table roller_master  alter column factory_id drop default;
alter table header_machines alter column factory_id drop default;
alter table tool_orders    alter column factory_id drop default;
alter table deliveries     alter column factory_id drop default;
