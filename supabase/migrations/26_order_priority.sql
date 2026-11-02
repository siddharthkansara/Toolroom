-- 26: raise the priority of tools still waiting in the queue (never lowers, never touches tools already on the lathe)
create or replace function public.order_set_priority(p_ids uuid[], p_priority priority_enum)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_priority::text not in ('URGENT', 'URGENT_MACHINE_DOWN') then
    raise exception 'Priority can only be raised to Urgent or Breakdown';
  end if;
  update tool_orders o set priority = p_priority
   where o.id = any(p_ids) and o.status = 'QUEUED' and can_write(o.factory_id)
     and (case o.priority::text when 'BUFFER_NEXT_SHIFT' then 2 when 'URGENT' then 1 else 0 end)
       > (case p_priority::text when 'URGENT' then 1 else 0 end);
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'Nothing changed: the tool may already be on the lathe, or already at this priority or higher.';
  end if;
  return n;
end $$;
grant execute on function public.order_set_priority(uuid[], priority_enum) to authenticated;