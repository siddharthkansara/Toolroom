-- Run this FIRST, on its own.
alter type order_status_enum add value if not exists 'CLOSED';
