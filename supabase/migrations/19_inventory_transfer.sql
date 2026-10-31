-- 19_inventory_transfer.sql
-- Inventory phase 5: give stock from one factory to another in one safe step.
-- Runs as the database owner so it can write the receiving factory's rows, but it first checks that the
-- caller may write the GIVING factory (own toolroom or owner). Safe to re-run.
create or replace function inventory_transfer(
  p_from text, p_to text, p_roller uuid, p_tool_type text, p_state text, p_qty integer, p_from_location uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare v_size text; v_to_roller uuid; v_group uuid := gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not can_write(p_from) then raise exception 'You cannot give stock from %', p_from; end if;
  if p_from = p_to then raise exception 'Choose a different factory'; end if;
  if not exists (select 1 from header_machines where factory_id = p_to) then raise exception 'Unknown factory %', p_to; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Enter a quantity of 1 or more'; end if;
  if p_state not in ('SOFT','HARD') then raise exception 'Bad condition'; end if;
  select roller_size into v_size from roller_master where id = p_roller and factory_id = p_from;
  if v_size is null then raise exception 'Roller not found in %', p_from; end if;
  select id into v_to_roller from roller_master where factory_id = p_to and roller_size = v_size;
  if v_to_roller is null then   -- the receiving factory has never used this size: add it to their list (size only)
    insert into roller_master (roller_size, factory_id) values (v_size, p_to) returning id into v_to_roller;
  end if;
  insert into inventory_moves (factory_id, roller_id, tool_type, state, qty, location_id, kind, reason, note, move_group)
  values (p_from, p_roller, p_tool_type, p_state, -p_qty, p_from_location, 'TRANSFER_OUT', 'To ' || p_to, nullif(trim(p_note), ''), v_group),
         (p_to, v_to_roller, p_tool_type, p_state, p_qty, null, 'TRANSFER_IN', 'From ' || p_from, nullif(trim(p_note), ''), v_group);
end $$;
revoke all on function inventory_transfer(text, text, uuid, text, text, integer, uuid, text) from public, anon;
grant execute on function inventory_transfer(text, text, uuid, text, text, integer, uuid, text) to authenticated;
