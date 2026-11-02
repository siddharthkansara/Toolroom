-- Step 1: run this alone. If it returns no rows, run step 2.
select roller_id, tool_type, count(*) from tooling_master group by 1, 2 having count(*) > 1;

-- Step 2: stop duplicate tool rows for the same roller size
create unique index if not exists tooling_one_per_type on tooling_master (roller_id, tool_type);
