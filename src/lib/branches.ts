/** Branch options for login selector (maps to Firestore branchId) */
export const BRANCH_OPTIONS = [
  { id: 'LDP-001', label: 'สาขา ลาดพร้าว' },
  { id: 'BKK-002', label: 'สาขา เอกมัย' },
] as const;

export type BranchOptionId = (typeof BRANCH_OPTIONS)[number]['id'];

export function getBranchLabel(branchId: string): string {
  return (
    BRANCH_OPTIONS.find((b) => b.id === branchId)?.label.replace('สาขา ', '') ??
    branchId
  );
}
