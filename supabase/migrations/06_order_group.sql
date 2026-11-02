alter table tool_orders add column if not exists order_group uuid;   -- ties together tools ordered in one go
