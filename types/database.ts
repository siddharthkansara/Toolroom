export type ToolType = 'DIE_TOP'|'BOTTOM'|'FACING_PUNCH'|'SHORT_PIN'|'CUTTER'|'OTHER';
export type OrderStatus = 'QUEUED'|'ON_LATHE'|'IN_TRANSIT'|'RECEIVED'|'HEAT_TREAT'|'READY'|'CLOSED';
export type Priority = 'URGENT_MACHINE_DOWN'|'URGENT'|'BUFFER_NEXT_SHIFT';
export type RunStatus = 'ACTIVE'|'COMPLETED';

export type RollerMaster = { id: string; roller_size: string; customer_drg: string|null; party_name: string|null; factory_id: string; created_at: string }
export type ToolingMaster = { id: string; roller_id: string; tool_type: ToolType; batta_code: string|null;
  od_dim: number|null; length_dim: number|null; step_id_dim: number|null; step_depth_dim: number|null; od2_dim: number|null }
export type HeaderMachine = { id: string; current_roller_id: string|null; status: string|null; factory_id: string; code: string }
export type ProductionRun = { id: string; machine_id: string; roller_id: string; started_at: string; ended_at: string|null; status: RunStatus }
export type MonthlyProduction = { id: string; factory_id: string; roller_id: string; month: string; rollers_forged: number; updated_at: string }
export type InventoryMove = { id: string; factory_id: string; roller_id: string; tool_type: string; state: 'SOFT'|'HARD'; qty: number; location_id: string|null; kind: string; reason: string|null; note: string|null; delivery_id: string|null; order_id: string|null; move_group: string|null; created_by: string|null; created_at: string }
export type InventoryTakedown = { id: string; factory_id: string; roller_id: string; machine_id: string|null; taken_down_on: string; wire_size: string|null; last_batta: string|null; extra_batta: string|null; tools: { tool_type: string; returned: number; scrapped: number }[]; note: string|null; created_by: string|null; created_at: string }
export type InventoryRequest = { id: string; source_factory: string; requester_factory: string; roller_size: string; tool_type: string; state: 'SOFT'|'HARD'; qty_requested: number; qty_sent: number|null; status: 'REQUESTED'|'APPROVED'|'REJECTED'|'CANCELLED'|'IN_TRANSIT'|'RECEIVED'|'NOT_RECEIVED'; note: string|null; decision_note: string|null; send_note: string|null; receive_note: string|null; source_roller_id: string|null; sent_lines: { location_id: string|null; qty: number }[]|null; requested_at: string; requested_by: string|null; decided_at: string|null; decided_by: string|null; sent_at: string|null; sent_by: string|null; closed_at: string|null; closed_by: string|null }
export type InventoryLocation = { id: string; factory_id: string; name: string; active: boolean; created_at: string }
export type InventoryCheck = { id: string; factory_id: string; check_date: string; status: 'UPDATED'|'NOTHING'; created_by: string|null; created_at: string; slot: 'MORNING'|'EVENING'; }
export type InventorySettings = { id: number; go_live: string }
export type InventoryStock = { factory_id: string; roller_id: string; tool_type: string; state: 'SOFT'|'HARD'; location_id: string|null; qty: number; last_move: string }
export type ToolOrder = { id: string; slip_no: number; machine_id: string; tooling_id: string|null; run_id: string|null;
  custom_tool_name: string|null; custom_dimensions: string|null; quantity: number; priority: Priority; status: OrderStatus;
   order_group: string|null; factory_id: string; roller_id: string|null; roller_qty: number|null; qty_made: number|null; qty_received: number|null; closed_at: string|null; target_strokes: string|null; notes: string|null; created_at: string;
  started_lathe_at: string|null; dispatched_at: string|null; received_at: string|null }

type T<R> = { Row: R; Insert: Partial<R>; Update: Partial<R>; Relationships: [] };
export type Database = { public: {
  Tables: { inventory_requests: T<InventoryRequest>;inventory_takedowns: T<InventoryTakedown>;inventory_moves: T<InventoryMove>; inventory_locations: T<InventoryLocation>; inventory_daily_checks: T<InventoryCheck>; inventory_settings: T<InventorySettings>;roller_master: T<RollerMaster>; tooling_master: T<ToolingMaster>; header_machines: T<HeaderMachine>;
  monthly_production: T<MonthlyProduction>; production_runs: T<ProductionRun>; tool_orders: T<ToolOrder>; deliveries: T<Delivery>; lathe_activity_logs: T<LatheLog>; factories: T<{ id: string; name: string }>; profiles: T<{ id: string; role: string; factory_id: string | null }> };
Views: { inventory_stock: { Row: InventoryStock; Relationships: [] } }; Functions: {}; Enums: {}; CompositeTypes: {} } }

export type OrderFull = ToolOrder & {
  roller: Pick<RollerMaster,'roller_size'|'customer_drg'|'party_name'>|null;
  tooling: ToolingMaster | null };

export const TOOL_LABEL: Record<ToolType,string> = { DIE_TOP:'Die Top', BOTTOM:'Bottom', FACING_PUNCH:'Forging Punch', SHORT_PIN:'Forging Pin', CUTTER:'Cutter', OTHER:'Other tool' };

export type Delivery = { id: string; order_id: string; qty_made: number; made_at: string; status: 'READY'|'RECEIVED'; qty_received: number|null; received_at: string|null; note: string|null; factory_id: string };
export type DeliveryFull = Delivery & { ord: OrderFull | null };
export type LatheLog = { id: string; order_id: string; factory_id: string; roller_size: string|null; tool_type: string|null; action: 'COMPLETED'|'STOPPED'; started_at: string; ended_at: string; duration_seconds: number; qty_made: number|null };
