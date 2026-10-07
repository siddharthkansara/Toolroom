export type ToolType = 'DIE_TOP'|'BOTTOM'|'FACING_PUNCH'|'SHORT_PIN'|'CUTTER'|'OTHER';
export type OrderStatus = 'QUEUED'|'ON_LATHE'|'IN_TRANSIT'|'RECEIVED'|'HEAT_TREAT'|'READY';
export type Priority = 'URGENT_MACHINE_DOWN'|'BUFFER_NEXT_SHIFT';
export type RunStatus = 'ACTIVE'|'COMPLETED';

export type RollerMaster = { id: string; roller_size: string; customer_drg: string|null; party_name: string|null; created_at: string }
export type ToolingMaster = { id: string; roller_id: string; tool_type: ToolType; batta_code: string|null;
  od_dim: number|null; length_dim: number|null; step_id_dim: number|null; step_depth_dim: number|null; od2_dim: number|null }
export type HeaderMachine = { id: string; current_roller_id: string|null; status: string|null }
export type ProductionRun = { id: string; machine_id: string; roller_id: string; started_at: string; ended_at: string|null; status: RunStatus }
export type ToolOrder = { id: string; slip_no: number; machine_id: string; tooling_id: string|null; run_id: string|null;
  custom_tool_name: string|null; custom_dimensions: string|null; quantity: number; priority: Priority; status: OrderStatus;
  order_group: string|null; roller_id: string|null; roller_qty: number|null; qty_made: number|null; target_strokes: string|null; notes: string|null; created_at: string;
  started_lathe_at: string|null; dispatched_at: string|null; received_at: string|null }

type T<R> = { Row: R; Insert: Partial<R>; Update: Partial<R>; Relationships: [] };
export type Database = { public: {
  Tables: { roller_master: T<RollerMaster>; tooling_master: T<ToolingMaster>; header_machines: T<HeaderMachine>;
    production_runs: T<ProductionRun>; tool_orders: T<ToolOrder>; profiles: T<{ id: string; role: string }> };
  Views: {}; Functions: {}; Enums: {}; CompositeTypes: {} } }

export type OrderFull = ToolOrder & {
  roller: Pick<RollerMaster,'roller_size'|'customer_drg'|'party_name'>|null;
  tooling: ToolingMaster | null };

export const TOOL_LABEL: Record<ToolType,string> = { DIE_TOP:'Die Top', BOTTOM:'Bottom', FACING_PUNCH:'Forging Punch', SHORT_PIN:'Forging Pin', CUTTER:'Cutter', OTHER:'Other tool' };
