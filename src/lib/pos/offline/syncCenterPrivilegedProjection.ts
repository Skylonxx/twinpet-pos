/**
 * SEC-001 Packet E / E-2 — safe Sync Center projection of D-2 privileged
 * evidence.
 *
 * `projectPrivilegedEvidenceForSyncCenter` is the sole boundary between the
 * durable 54-key `PrivilegedEvidenceJournalRecordV1` journal row (Class I
 * authority bytes, Class II signed provenance, Class III server-owned
 * fields) and anything Sync Center ever renders. It reads named fields only
 * — it never spreads the durable record — and it never returns PIN,
 * attestation bytes, signatures, device signing material, OAC key material,
 * raw cryptographic digests, raw adjudication payloads, raw server reason
 * codes, or actor/device identifiers beyond the approving manager's role in
 * the outcome. `statusClass` is a closed, total mapping over every landed
 * `(syncStatus, lastDispositionKind)` combination the parser can produce;
 * anything the switch does not explicitly recognize fails closed to
 * `unknown_fail_closed` rather than defaulting to a success/complete state.
 */

import type { PrivilegedEvidenceJournalRecordV1 } from './privilegedEvidenceTypes';

export const SYNC_CENTER_PRIVILEGED_STATUS_CLASSES = [
  'queued',
  'waiting_retry',
  'syncing',
  'accepted',
  'rejected',
  'uncertain',
  'manual_attention',
  'unknown_fail_closed',
] as const;

export type SyncCenterPrivilegedStatusClass = (typeof SYNC_CENTER_PRIVILEGED_STATUS_CLASSES)[number];

export type SyncCenterPrivilegedAttentionClass = 'none' | 'requires_attention';

/** Closed output shape. Every field is either a display-safe identifier or already-localized copy — never a passthrough of durable evidence. */
export interface SyncCenterPrivilegedRow {
  readonly id: string;
  readonly branchId: string;
  readonly targetOrderId: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly statusClass: SyncCenterPrivilegedStatusClass;
  readonly statusTh: string;
  readonly detailTh: string;
  readonly attentionClass: SyncCenterPrivilegedAttentionClass;
  readonly contributesToAttentionCount: boolean;
  readonly integrityConflict: boolean;
}

const STATUS_TH: Record<SyncCenterPrivilegedStatusClass, string> = {
  queued: 'รอส่งไปยังเซิร์ฟเวอร์',
  waiting_retry: 'รอส่งรอบถัดไป',
  syncing: 'กำลังส่ง…',
  accepted: 'เซิร์ฟเวอร์ยืนยันการยกเลิกแล้ว',
  rejected: 'เซิร์ฟเวอร์ปฏิเสธคำขอนี้',
  uncertain: 'ผลลัพธ์ยังไม่ชัดเจน — ต้องตรวจสอบ',
  manual_attention: 'ต้องตรวจสอบด้วยตนเอง',
  unknown_fail_closed: 'ไม่ทราบสถานะ — ต้องตรวจสอบ',
};

const DETAIL_TH: Record<SyncCenterPrivilegedStatusClass, string> = {
  queued: 'บันทึกไว้ในเครื่องแล้ว ยังไม่ได้ส่ง',
  waiting_retry: 'เคยส่งแล้วแต่ยังไม่สำเร็จ ระบบจะลองส่งอีกครั้ง',
  syncing: 'กำลังส่งคำขอไปยังเซิร์ฟเวอร์',
  accepted: 'มีหลักฐานจากเซิร์ฟเวอร์ว่ายกเลิกสำเร็จ',
  rejected: 'เซิร์ฟเวอร์ไม่รับคำขอยกเลิกนี้ — บิลยังไม่ถูกยกเลิก',
  uncertain: 'เซิร์ฟเวอร์รับคำขอไว้แต่ยังสรุปผลไม่ได้ — ต้องให้เจ้าหน้าที่ตรวจสอบ',
  manual_attention: 'ต้องให้เจ้าหน้าที่ตรวจสอบก่อนดำเนินการต่อ',
  unknown_fail_closed: 'ระบบไม่รู้จักสถานะนี้ — ต้องให้เจ้าหน้าที่ตรวจสอบ',
};

/** True only for statuses that describe an open question a human still needs to look at. */
const ATTENTION_REQUIRED_STATUS_CLASSES: ReadonlySet<SyncCenterPrivilegedStatusClass> = new Set([
  'uncertain',
  'manual_attention',
  'unknown_fail_closed',
]);

/**
 * Total, closed mapping. Every one of D-2's 5 `syncStatus` values is an
 * explicit case; every reachable `lastDispositionKind` under
 * `MANUAL_ATTENTION` is enumerated. Any combination the parser's own matrix
 * could never actually produce still falls through to the `default` /
 * innermost fallback, which returns `unknown_fail_closed` — never
 * `accepted` or `confirmed`.
 */
function computeStatusClass(record: PrivilegedEvidenceJournalRecordV1): SyncCenterPrivilegedStatusClass {
  switch (record.syncStatus) {
    case 'PRIVILEGED_INTENT_QUEUED':
      return record.lastDispositionKind === null ? 'queued' : 'waiting_retry';
    case 'SYNCING':
      return 'syncing';
    case 'SERVER_ACCEPTED':
      return record.lastDispositionKind === 'ACCEPTED' ? 'accepted' : 'unknown_fail_closed';
    case 'SERVER_REJECTED':
      return record.lastDispositionKind === 'REJECTED' ? 'rejected' : 'unknown_fail_closed';
    case 'MANUAL_ATTENTION':
      switch (record.lastDispositionKind) {
        case 'ADJUDICATION_ANOMALY':
          return 'uncertain';
        case 'MANUAL_ATTENTION_REQUIRED':
        case 'PROTOCOL_REJECTED_PERMANENT':
        case 'LOCAL_TERMINAL':
          return 'manual_attention';
        default:
          return 'unknown_fail_closed';
      }
    default:
      return 'unknown_fail_closed';
  }
}

/**
 * Converts one durable D-2 journal row into the narrow, display-safe shape
 * Sync Center renders. Field-by-field only — the durable record is never
 * spread, so a future 55th key on the journal schema cannot silently leak
 * into the UI.
 */
export function projectPrivilegedEvidenceForSyncCenter(
  record: PrivilegedEvidenceJournalRecordV1,
): SyncCenterPrivilegedRow {
  const statusClass = computeStatusClass(record);
  const attentionClass: SyncCenterPrivilegedAttentionClass = ATTENTION_REQUIRED_STATUS_CLASSES.has(statusClass)
    ? 'requires_attention'
    : 'none';

  return {
    id: record.adjudicationId,
    branchId: record.branchId,
    targetOrderId: record.targetOrderId,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    statusClass,
    statusTh: STATUS_TH[statusClass],
    detailTh: DETAIL_TH[statusClass],
    attentionClass,
    contributesToAttentionCount: attentionClass === 'requires_attention',
    integrityConflict: record.integrityConflict,
  };
}
