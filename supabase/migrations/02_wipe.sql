-- Blank slate: removes all orders, runs, tooling and roller sizes. Keeps the machine list.
delete from deliveries where true;
delete from tool_orders where true;
delete from production_runs where true;
delete from tooling_master where true;
update header_machines set current_roller_id = null where true;
delete from roller_master where true;
alter sequence tool_orders_slip_no_seq restart with 1;
