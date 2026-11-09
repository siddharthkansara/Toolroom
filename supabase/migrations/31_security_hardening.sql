-- Only logged-in users may call order_set_priority (not anonymous visitors)
revoke all on function public.order_set_priority(uuid[], priority_enum) from public, anon;
grant execute on function public.order_set_priority(uuid[], priority_enum) to authenticated;

-- Optional tidy: monthly_production owner-only policy applies to logged-in users, not "public"
alter policy "owner only" on monthly_production to authenticated;