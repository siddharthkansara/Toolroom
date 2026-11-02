-- Run FIRST, on its own. Adds the middle urgency level.
-- Normal = BUFFER_NEXT_SHIFT, Urgent = URGENT (new), Breakdown / Line Down = URGENT_MACHINE_DOWN
alter type priority_enum add value if not exists 'URGENT' before 'BUFFER_NEXT_SHIFT';
