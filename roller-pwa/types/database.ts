export type ToolType = 'DIE_TOP'|'BOTTOM'|'FACING_PUNCH'|'SHORT_PIN'|'CUTTER'|'OTHER';
export type OrderStatus = 'QUEUED'|'ON_LATHE'|'IN_TRANSIT'|'RECEIVED'|'HEAT_TREAT'|'READY'|'CLOSED';
export type Priority = 'URGENT_MACHINE_DOWN'|'URGENT'|'BUFFER_NEXT_SHIFT';
export type RunStatus = 'ACTIVE'|'COMPLETED';

export type RollerMaster = { id: string; roller_size: string; customer_drg: string|null; party_name: string|null; factory_id: string; created_at: string }
export type ToolingMaster = { id: string; roller_id: string; tool_type: ToolType; batta_code: string|null;
  od_dim: number|null; length_dim: number|null; step_id_dim: number|null; step_depth_dim: number|null; od2_dim: number|null }
export type HeaderMachine = { id: string; current_roller_id: string|null; status: string|null; factory_id: string; code: string }
export type ProductionRun = { id: string; machine_id: string; roller_id: string; started_at: string; ended_at: string|null; status: RunStatus }
export type ToolOrder = { id: string; slip_no: number; machine_id: string; tooling_id: string|null; run_id: string|null;
  custom_tool_name: string|null; custom_dimensions: string|null; quantity: number; priority: Priority; status: OrderStatus;
  order_group: string|null; factory_id: string; roller_id: string|null; roller_qty: number|null; qty_made: number|null; qty_received: number|null; closed_at: string|null; target_strokes: string|null; notes: string|null; created_at: string;
  started_lathe_at: string|null; dispatched_at: string|null; received_at: string|null }

type T<R> = { Row: R; Insert: Partial<R>; Update: Partial<R>; Relationships: [] };
export type Database = { public: {
  Tables: { roller_master: T<RollerMaster>; tooling_master: T<ToolingMaster>; header_machines: T<HeaderMachine>;
    production_runs: T<ProductionRun>; tool_orders: T<ToolOrder>; deliveries: T<Delivery>; lathe_activity_logs: T<LatheLog>; factories: T<{ id: string; name: string }>; profiles: T<{ id: string; role: string; factory_id: string | null }> };
  Views: {}; Functions: {}; Enums: {}; CompositeTypes: {} } }

export type OrderFull = ToolOrder & {
  roller: Pick<RollerMaster,'roller_size'|'customer_drg'|'party_name'>|null;
  tooling: ToolingMaster | null };

export const TOOL_LABEL: Record<ToolType,string> = { DIE_TOP:'Die Top', BOTTOM:'Bottom', FACING_PUNCH:'Forging Punch', SHORT_PIN:'Forging Pin', CUTTER:'Cutter', OTHER:'Other tool' };

export type Delivery = { id: string; order_id: string; qty_made: number; made_at: string; status: 'READY'|'RECEIVED'; qty_received: number|null; received_at: string|null; note: string|null; factory_id: string };
export type DeliveryFull = Delivery & { ord: OrderFull | null };
export type LatheLog = { id: string; order_id: string; factory_id: string; roller_size: string|null; tool_type: string|null; action: 'COMPLETED'|'STOPPED'; started_at: string; ended_at: string; duration_seconds: number; qty_made: number|null };
