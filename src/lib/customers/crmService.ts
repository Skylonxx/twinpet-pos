import { increment, serverTimestamp, type FieldValue } from 'firebase/firestore';
import { POS_FEATURES } from '../config/features';

/** 1 point per 100 THB spent (floor) */
export const LOYALTY_BAHT_PER_POINT = 100;

export function calcPointsEarned(grandTotal: number): number {
  if (!POS_FEATURES.enableLoyaltyPoints || grandTotal <= 0) return 0;
  return Math.floor(grandTotal / LOYALTY_BAHT_PER_POINT);
}

export type CrmSaleUpdateFields = {
  lifetimeValue: FieldValue;
  totalSpent: FieldValue;
  lastVisitAt: FieldValue;
  updatedAt: FieldValue;
  points?: FieldValue;
};

/** Firestore field updates after a completed sale — CRM always; points only when enabled. */
export function buildCrmSaleUpdateFields(grandTotal: number): CrmSaleUpdateFields {
  const fields: CrmSaleUpdateFields = {
    lifetimeValue: increment(grandTotal),
    totalSpent: increment(grandTotal),
    lastVisitAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const pointsEarned = calcPointsEarned(grandTotal);
  if (pointsEarned > 0) {
    fields.points = increment(pointsEarned);
  }

  return fields;
}

export type CrmSaleApplyResult = {
  pointsEarned: number;
  lifetimeValueDelta: number;
};

/** In-memory CRM deltas for dev mock / local state updates. */
export function applyCrmSaleLocally(
  current: { lifetimeValue: number; totalSpent: number; points: number },
  grandTotal: number,
): CrmSaleApplyResult & { lifetimeValue: number; totalSpent: number; points: number } {
  const pointsEarned = calcPointsEarned(grandTotal);
  return {
    lifetimeValue: current.lifetimeValue + grandTotal,
    totalSpent: current.totalSpent + grandTotal,
    points: current.points + pointsEarned,
    pointsEarned,
    lifetimeValueDelta: grandTotal,
  };
}
