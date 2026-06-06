import { describe, it, expect } from 'vitest';
import { canViewReconciliationExceptions } from './adminGate';

// Route / admin-gate: the page uses this to degrade safely for non-admins who
// reach the direct URL (independent of the AdminLayout route guard).
describe('canViewReconciliationExceptions (admin-gate)', () => {
  it('is true ONLY for admin', () => {
    expect(canViewReconciliationExceptions('admin')).toBe(true);
  });
  it('is false for manager, staff, and missing role', () => {
    expect(canViewReconciliationExceptions('manager')).toBe(false);
    expect(canViewReconciliationExceptions('staff')).toBe(false);
    expect(canViewReconciliationExceptions(null)).toBe(false);
    expect(canViewReconciliationExceptions(undefined)).toBe(false);
  });
});
