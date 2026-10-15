export const FACTORIES = ['NIC', 'PEW', 'BABA'] as const;
export const FCHIP: Record<string, string> = { NIC: 'bg-sky-600', PEW: 'bg-violet-600', BABA: 'bg-orange-600' };
// machine ids look like 'PEW:HD-1'; show only 'HD-1'
export const mname = (id: string) => (id.includes(':') ? id.split(':')[1] : id);
export const FactoryTag = ({ f }: { f: string }) => <span className={`${FCHIP[f] ?? 'bg-slate-600'} text-white rounded px-2 py-0.5 text-sm font-bold`}>{f}</span>;

// ---- Phase 1 additions ----
export type Factory = (typeof FACTORIES)[number];
// Header machines created for the two new units by migration 12 (NIC's machines already exist; the database is the source of truth)
export const SEEDED_MACHINES: Record<Exclude<Factory, 'NIC'>, string[]> = {
  PEW: ['HD-1', 'HD-2', 'HD-3', 'HD-4', 'HD-5'],
  BABA: ['HD-1', 'HD-2', 'HD-3', 'HD-4', 'HD-5', 'HD-7', 'HD-8', 'HD-9', 'HD-12'] };
export const machineId = (f: string, code: string) => `${f}:${code.trim().toUpperCase()}`;   // same format migration 12 uses
// Display rule: an order is always shown as "[Factory] - [Roller Size]"
export const rollerLabel = (f: string, size: string) => `${f} - ${size}`;
