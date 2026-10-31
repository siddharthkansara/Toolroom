-- Undo 16_inventory_foundation.sql. WARNING: this deletes all inventory data (ledger, locations, check-ins).
-- Receiving of deliveries is not affected.
drop trigger if exists inv_receipt_after on deliveries;
drop function if exists trg_inv_receipt();
drop function if exists inv_post_receipt(uuid);
drop function if exists inventory_catchup();
drop function if exists inventory_search(text);
drop view if exists inventory_stock;
drop trigger if exists inv_no_negative on inventory_moves;
drop function if exists trg_inv_no_negative();
drop table if exists inventory_daily_checks;
drop table if exists inventory_moves;
drop table if exists inventory_locations;
drop table if exists inventory_settings;
