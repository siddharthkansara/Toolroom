-- 1) Only one job may be ON_LATHE at any time (enforced by the database, even with two CNC screens open)
update tool_orders set status = 'QUEUED', started_lathe_at = null
 where status = 'ON_LATHE'
   and id not in (select id from tool_orders where status = 'ON_LATHE' order by started_lathe_at limit 1);
create unique index if not exists one_job_on_lathe on tool_orders (status) where status = 'ON_LATHE';

-- 2) Rename HD-21 to HD-09 (moves any existing runs/orders across)
insert into header_machines (id) values ('HD-09') on conflict do nothing;
update production_runs set machine_id = 'HD-09' where machine_id = 'HD-21';
update tool_orders     set machine_id = 'HD-09' where machine_id = 'HD-21';
delete from header_machines where id = 'HD-21';
