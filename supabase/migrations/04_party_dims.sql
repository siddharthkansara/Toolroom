alter table roller_master add column if not exists party_name varchar;
alter table tooling_master add column if not exists od2_dim numeric(6,2);
-- Bottom: od_dim + length_dim (line 1), od2_dim (line 2), step_depth_dim (line 3). Die Top: batta_code. Punch: od_dim + length_dim.
