/**
 * PK-4 Sync Center — pure classification and aggregation.
 * No I/O. nowMs is injected. Unknown status strings map to `unknown`.
 */

import type { OfflineReversalIntent } from './offlineReversalTypes';
import type { SaleIntentEntry, SaleIntentJournalStatus } from './saleIntentJournalTypes';
import type { ShiftCloseIntentEntry } from './shiftCloseIntentTypes';
import type { ShiftOpenIntentEntry } from './shiftOpenIntentTypes';
import type {
  ChannelRunResult,
  SyncChannelId,
  SyncOrchestratorState,
  SyncTrigger,
} from './syncOrchestrator';
import type { VoidIntentRecord, VoidTerminalReason } from './voidIntentStore';

export const SYNC_CENTER_CHANNEL_ORDER = [
  'offline_reversal',
  'void_intent',
  'shift_intent',
  'sale_intent',
  'trusted_resume',
] as const satisfies readonly SyncChannelId[];

export type SyncCenterChannelId = (typeof SYNC_CENTER_CHANNEL_ORDER)[number];

export type SyncCenterItemState =
  | 'pending'
  | 'in_flight'
  | 'waiting_retry'
  | 'attention'
  | 'confirmed'
  | 'unknown';

export type SyncCenterScopeKind = 'branch' | 'branch_device' | 'device' | 'unscoped';

export type SyncCenterActionId =
  | 'global_resweep'
  | 'item_retry_now'
  | 'open_manual_review'
  | 'open_shift_close_review'
  | 'open_admin_reconciliation';

const ACTIVE_SYNC_SCOPE = Symbol('twinpet.ActiveSyncScope');

export type ActiveSyncScope = {
  readonly branchId: string;
  readonly deviceId: string;
  readonly [ACTIVE_SYNC_SCOPE]: true;
};

export type SyncScopeUnavailableReason = 'no_branch' | 'branch_all' | 'no_device';

export type SyncCenterScopeResolution =
  | { ok: true; scope: ActiveSyncScope }
  | { ok: false; reason: SyncScopeUnavailableReason };

export type SyncCenterRow = {
  channel: SyncCenterChannelId;
  id: string;
  state: SyncCenterItemState;
  scopeKind: SyncCenterScopeKind;
  branchId: string | null;
  deviceId: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  attempts: number | null;
  nextEligibleAtMs: number | null;
  reasonCode: string | null;
  reasonTh: string;
  lastErrorAtMs: number | null;
  isStale: boolean;
  attemptCeilingReached: boolean;
  shiftKind: 'close' | 'open' | null;
  actionable: SyncCenterActionId[];
};

export type SyncCenterAvailability = 'ok' | 'unavailable' | 'not_observable';

export type SyncCenterChannelSummary = {
  channel: SyncCenterChannelId;
  pending: number;
  inFlight: number;
  waitingRetry: number;
  attention: number;
  confirmedRecent: number;
  availability: SyncCenterAvailability;
  unavailableReason: string | null;
};

export type SyncCenterAggregate = {
  generatedAtMs: number;
  isOnline: boolean;
  webLocksAvailable: boolean;
  scopeBranchId: string;
  scopeDeviceId: string;
  unifiedPending: number;
  unifiedAttention: number;
  unavailableChannelCount: number;
  outOfScopeDroppedCount: number;
  lastSyncCheckAtMs: number | null;
  lastCycleTrigger: SyncTrigger | null;
  lastCycleGateSkipReason: string | null;
  channels: SyncCenterChannelSummary[];
  rows: SyncCenterRow[];
};

export type SyncCenterView =
  | { status: 'scoped'; aggregate: SyncCenterAggregate }
  | { status: 'scope_unavailable'; reason: SyncScopeUnavailableReason };

export type SyncCenterChannelRead<T> =
  | { ok: true; rows: T[] }
  | { ok: false; reason: string };

export type SyncCenterReadResult = {
  scope: ActiveSyncScope;
  reversal: SyncCenterChannelRead<OfflineReversalIntent>;
  voidIntent: SyncCenterChannelRead<VoidIntentRecord>;
  shiftClose: SyncCenterChannelRead<ShiftCloseIntentEntry>;
  shiftOpen: SyncCenterChannelRead<ShiftOpenIntentEntry>;
  saleIntent: SyncCenterChannelRead<SaleIntentEntry>;
  orchestrator: Pick<SyncOrchestratorState, 'lastCycle' | 'webLocksAvailable' | 'ch4AttemptExhaustedIds'>;
  isOnline: boolean;
};

export const SALE_INTENT_PENDING_STATUSES: readonly SaleIntentJournalStatus[] = [
  'queued',
  'flushed_to_cache',
  'server_acknowledged',
];

export const SALE_INTENT_ATTENTION_STATUSES: readonly SaleIntentJournalStatus[] = [
  'rejected_by_rules',
  'orphaned',
  'manual_review',
];

export const SALE_INTENT_HISTORY_STATUSES: readonly SaleIntentJournalStatus[] = [
  'settled_observed',
  'exception_observed',
  'superseded',
];

export const SALE_INTENT_TRACKED_STATUSES: SaleIntentJournalStatus[] = [
  ...SALE_INTENT_PENDING_STATUSES,
  ...SALE_INTENT_ATTENTION_STATUSES,
  ...SALE_INTENT_HISTORY_STATUSES,
];

export const SHIFT_STALE_AGE_MS = 10 * 60 * 1000;
export const SALE_STALE_AGE_MS = 10 * 60 * 1000;
export const SYNC_CENTER_HISTORY_CAP = 20;
export const SYNC_CENTER_ATTENTION_CAP = 50;

export const VOID_TERMINAL_REASON_TH: Record<VoidTerminalReason, string> = {
  order_absent_server_side: 'บิลยังไม่ถึงเซิร์ฟเวอร์',
  day_boundary_expired: 'เลยกำหนดยกเลิกภายในวัน',
  authority_refused: 'เซิร์ฟเวอร์ปฏิเสธ',
  attempt_ceiling_reached: 'ครบจำนวนครั้งที่ลองส่ง',
  malformed_intent: 'คำขอไม่ถูกต้อง',
  order_already_terminal: 'บิลถูกยกเลิกแล้ว',
  staff_identity_mismatch: 'พนักงานผู้ขอไม่ตรงกับรอบปัจจุบัน',
};

export const CHANNEL_NAME_TH: Record<SyncCenterChannelId, string> = {
  offline_reversal: 'การคืน/ยกเลิกสต็อกออฟไลน์',
  void_intent: 'คำขอยกเลิกบิล',
  shift_intent: 'การเปิด/ปิดรอบขาย',
  sale_intent: 'บิลขายที่รอยืนยัน',
  trusted_resume: 'การกู้คืนการส่งบิล',
};

export const SCOPE_UNAVAILABLE_COPY: Record<SyncScopeUnavailableReason, string> = {
  no_branch: 'ยังไม่ได้เลือกสาขา — แสดงสถานะการซิงก์ไม่ได้',
  branch_all: 'โหมดทุกสาขา — แสดงสถานะการซิงก์ของสาขาใดสาขาหนึ่งไม่ได้',
  no_device: 'ยังระบุอุปกรณ์นี้ไม่ได้ — แสดงสถานะการซิงก์ไม่ได้',
};

type ClassifyResult = { inScope: true; row: SyncCenterRow } | { inScope: false };

export function resolveActiveSyncScope(
  branchId: string | null | undefined,
  deviceId: string | null | undefined,
): SyncCenterScopeResolution {
  if (branchId == null || branchId === '') return { ok: false, reason: 'no_branch' };
  if (branchId === 'ALL') return { ok: false, reason: 'branch_all' };
  if (deviceId == null || deviceId === '') return { ok: false, reason: 'no_device' };
  return {
    ok: true,
    scope: {
      branchId,
      deviceId,
      [ACTIVE_SYNC_SCOPE]: true,
    },
  };
}

export function isRowInScope(
  row: Pick<SyncCenterRow, 'channel' | 'branchId' | 'deviceId'>,
  scope: ActiveSyncScope,
): boolean {
  return channelPredicate(row.channel, row.branchId, row.deviceId, scope);
}

function channelPredicate(
  channel: SyncCenterChannelId,
  branchId: string | null | undefined,
  deviceId: string | null | undefined,
  scope: ActiveSyncScope,
): boolean {
  if (channel === 'trusted_resume') return false;
  if (branchId !== scope.branchId) return false;
  if (channel === 'offline_reversal') return true;
  if (channel === 'shift_intent') return deviceId === scope.deviceId || deviceId == null;
  return deviceId === scope.deviceId;
}

function emptyRow(partial: Omit<SyncCenterRow, 'actionable'> & { actionable?: SyncCenterActionId[] }): SyncCenterRow {
  return { actionable: [], ...partial };
}

function isoToMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function neverEmpty(text: string | null | undefined, fallback = 'ไม่ทราบสถานะ'): string {
  const trimmed = text?.trim();
  return trimmed ? trimmed : fallback;
}

export function thaiReasonForVoidTerminal(reason: VoidTerminalReason | null | undefined): string {
  if (!reason) return 'ไม่ระบุ';
  return VOID_TERMINAL_REASON_TH[reason] ?? 'ไม่ระบุ';
}

export function thaiStateLabel(state: SyncCenterItemState): string {
  switch (state) {
    case 'pending':
      return 'รอส่ง';
    case 'in_flight':
      return 'กำลังส่ง';
    case 'waiting_retry':
      return 'รอรอบถัดไป';
    case 'attention':
      return 'ต้องตรวจสอบ';
    case 'confirmed':
      return 'เสร็จสิ้น';
    default:
      return 'ไม่ทราบสถานะ';
  }
}

export function reversalLedgerKey(intentId: string): string {
  return `offline_reversal:${intentId}`;
}

function leaseIsLive(expiresAt: string | null | undefined, nowMs: number): boolean {
  const ms = isoToMs(expiresAt);
  return ms != null && ms > nowMs;
}

export function classifyReversalIntent(
  intent: OfflineReversalIntent,
  scope: ActiveSyncScope,
  exhaustedIds: ReadonlySet<string> | readonly string[],
  nowMs: number,
): ClassifyResult {
  if (!channelPredicate('offline_reversal', intent.branchId, null, scope)) {
    return { inScope: false };
  }
  const exhausted = (exhaustedIds instanceof Set ? exhaustedIds : new Set(exhaustedIds)).has(
    reversalLedgerKey(intent.id),
  );
  const createdAtMs = isoToMs(intent.createdAt);
  const updatedAtMs = isoToMs(intent.lastSyncedAt) ?? createdAtMs;
  const lastErrorAtMs = isoToMs(intent.lastSyncAttemptAt);
  const inFlight = intent.status === 'syncing' && leaseIsLive(intent.syncLeaseExpiresAt, nowMs);

  let state: SyncCenterItemState;
  let reasonCode: string | null = intent.status;
  let reasonTh: string;

  if (intent.status === 'manual_review_required' || exhausted) {
    state = 'attention';
    reasonCode = exhausted && intent.status !== 'manual_review_required' ? 'attempt_ceiling_reached' : intent.status;
    reasonTh = intent.status === 'manual_review_required'
      ? neverEmpty(intent.errorMessage ?? intent.rejectionCode, 'ต้องตรวจสอบด้วยตนเอง')
      : 'ครบจำนวนครั้งที่ลองส่ง';
  } else if (intent.status === 'queued' || intent.status === 'retryable_error') {
    state = 'pending';
    reasonTh =
      intent.status === 'retryable_error'
        ? neverEmpty(intent.errorMessage, 'บันทึกไว้ในเครื่องแล้ว ยังไม่ได้ส่ง')
        : 'บันทึกไว้ในเครื่องแล้ว ยังไม่ได้ส่ง';
  } else if (intent.status === 'syncing') {
    state = inFlight ? 'in_flight' : 'pending';
    reasonTh = inFlight ? 'กำลังส่ง…' : 'บันทึกไว้ในเครื่องแล้ว ยังไม่ได้ส่ง';
  } else if (
    intent.status === 'server_accepted' ||
    intent.status === 'server_rejected' ||
    intent.status === 'manual_review_resolved'
  ) {
    state = 'confirmed';
    reasonTh =
      intent.status === 'server_accepted'
        ? 'เซิร์ฟเวอร์ตอบรับแล้ว'
        : intent.status === 'server_rejected'
          ? 'เซิร์ฟเวอร์ปฏิเสธ — คืนค่าสต็อกในเครื่องแล้ว'
          : 'ปิดงานตรวจสอบแล้ว';
  } else {
    state = 'unknown';
    reasonTh = 'ไม่ทราบสถานะ';
  }

  return {
    inScope: true,
    row: emptyRow({
      channel: 'offline_reversal',
      id: intent.id,
      state,
      scopeKind: 'branch',
      branchId: intent.branchId,
      deviceId: null,
      createdAtMs,
      updatedAtMs,
      attempts: intent.syncAttempt ?? null,
      nextEligibleAtMs: null,
      reasonCode,
      reasonTh,
      lastErrorAtMs,
      isStale: false,
      attemptCeilingReached: exhausted,
      shiftKind: null,
    }),
  };
}

export function classifyVoidIntent(
  record: VoidIntentRecord,
  scope: ActiveSyncScope,
  nowMs: number,
): ClassifyResult {
  if (!channelPredicate('void_intent', record.branchId, record.deviceId, scope)) {
    return { inScope: false };
  }
  const claimLive =
    record.status === 'in_flight' &&
    record.claimExpiresAtMs != null &&
    record.claimExpiresAtMs > nowMs;

  let state: SyncCenterItemState;
  let reasonTh: string;
  if (record.status === 'terminal') {
    state = 'attention';
    reasonTh = thaiReasonForVoidTerminal(record.terminalReason);
  } else if (record.status === 'confirmed') {
    state = 'confirmed';
    reasonTh = record.confirmedAtMs != null ? 'เซิร์ฟเวอร์ยืนยันแล้ว' : 'เสร็จสิ้นแล้ว';
  } else if (claimLive) {
    state = 'in_flight';
    reasonTh = 'กำลังส่ง…';
  } else if (record.status === 'pending' && record.nextEligibleAtMs > nowMs) {
    state = 'waiting_retry';
    reasonTh = 'รอรอบถัดไป';
  } else if (record.status === 'pending' || record.status === 'in_flight') {
    state = 'pending';
    reasonTh = 'บันทึกไว้ในเครื่องแล้ว ยังไม่ได้ส่ง';
  } else {
    state = 'unknown';
    reasonTh = 'ไม่ทราบสถานะ';
  }

  return {
    inScope: true,
    row: emptyRow({
      channel: 'void_intent',
      id: record.orderId,
      state,
      scopeKind: 'branch_device',
      branchId: record.branchId,
      deviceId: record.deviceId,
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
      attempts: record.attempts,
      nextEligibleAtMs: record.nextEligibleAtMs,
      reasonCode: record.terminalReason ?? record.status,
      reasonTh,
      lastErrorAtMs: record.lastErrorAtMs,
      isStale: false,
      attemptCeilingReached: record.terminalReason === 'attempt_ceiling_reached',
      shiftKind: null,
    }),
  };
}

export function classifyShiftCloseIntent(
  entry: ShiftCloseIntentEntry,
  scope: ActiveSyncScope,
  nowMs: number,
): ClassifyResult {
  if (!channelPredicate('shift_intent', entry.branchId, entry.deviceId, scope)) {
    return { inScope: false };
  }
  return classifyShiftLike({
    id: `close:${entry.shiftId}`,
    status: entry.status,
    pendingStatus: 'local_closed_pending',
    branchId: entry.branchId,
    deviceId: entry.deviceId,
    createdAtMs: entry.createdAtLocal,
    updatedAtMs: entry.updatedAtLocal,
    lastErrorMessage: entry.lastErrorMessage,
    isStale: entry.status === 'local_closed_pending' && nowMs - entry.closedAtLocal >= SHIFT_STALE_AGE_MS,
    shiftKind: 'close',
  });
}

export function classifyShiftOpenIntent(
  entry: ShiftOpenIntentEntry,
  scope: ActiveSyncScope,
  nowMs: number,
): ClassifyResult {
  if (!channelPredicate('shift_intent', entry.branchId, entry.deviceId, scope)) {
    return { inScope: false };
  }
  return classifyShiftLike({
    id: `open:${entry.shiftId}`,
    status: entry.status,
    pendingStatus: 'local_open_pending',
    branchId: entry.branchId,
    deviceId: entry.deviceId,
    createdAtMs: entry.createdAtLocal,
    updatedAtMs: entry.updatedAtLocal,
    lastErrorMessage: entry.lastErrorMessage,
    isStale: entry.status === 'local_open_pending' && nowMs - entry.openedAtLocal >= SHIFT_STALE_AGE_MS,
    shiftKind: 'open',
  });
}

function classifyShiftLike(args: {
  id: string;
  status: string;
  pendingStatus: string;
  branchId: string;
  deviceId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  lastErrorMessage: string | null;
  isStale: boolean;
  shiftKind: 'close' | 'open';
}): ClassifyResult {
  let state: SyncCenterItemState;
  let reasonTh: string;
  if (args.status === args.pendingStatus) {
    state = 'pending';
    reasonTh = args.isStale ? 'ค้างนานเกิน 10 นาที' : 'บันทึกไว้ในเครื่องแล้ว ยังไม่ได้ส่ง';
  } else if (args.status === 'rejected_manual_attention') {
    state = 'attention';
    reasonTh = neverEmpty(args.lastErrorMessage, 'ต้องตรวจสอบด้วยตนเอง');
  } else if (args.status === 'synced') {
    state = 'confirmed';
    reasonTh = 'บันทึกบนเซิร์ฟเวอร์แล้ว';
  } else {
    state = 'unknown';
    reasonTh = 'ไม่ทราบสถานะ';
  }
  return {
    inScope: true,
    row: emptyRow({
      channel: 'shift_intent',
      id: args.id,
      state,
      scopeKind: args.deviceId == null ? 'branch' : 'branch_device',
      branchId: args.branchId,
      deviceId: args.deviceId,
      createdAtMs: args.createdAtMs,
      updatedAtMs: args.updatedAtMs,
      attempts: null,
      nextEligibleAtMs: null,
      reasonCode: args.status,
      reasonTh,
      lastErrorAtMs: null,
      isStale: args.isStale,
      attemptCeilingReached: false,
      shiftKind: args.shiftKind,
    }),
  };
}

export function classifySaleIntentEntry(
  entry: SaleIntentEntry,
  scope: ActiveSyncScope,
  nowMs: number,
): ClassifyResult {
  if (!channelPredicate('sale_intent', entry.branchId, entry.deviceId, scope)) {
    return { inScope: false };
  }
  let state: SyncCenterItemState;
  let reasonTh: string;
  if ((SALE_INTENT_PENDING_STATUSES as readonly string[]).includes(entry.status)) {
    state = 'pending';
    const ageMs = Math.max(0, nowMs - entry.createdAtLocal);
    reasonTh = ageMs >= SALE_STALE_AGE_MS ? 'ค้างนานเกิน 10 นาที' : 'บันทึกไว้ในเครื่องแล้ว ยังไม่ได้ส่ง';
  } else if ((SALE_INTENT_ATTENTION_STATUSES as readonly string[]).includes(entry.status)) {
    state = 'attention';
    if (entry.status === 'manual_review' && entry.manualReviewReason) reasonTh = entry.manualReviewReason;
    else if (entry.lastErrorMessage) reasonTh = entry.lastErrorMessage;
    else if (entry.status === 'orphaned') reasonTh = 'ไม่พบการยืนยันจากเซิร์ฟเวอร์ภายในเวลาที่กำหนด';
    else if (entry.status === 'rejected_by_rules') reasonTh = 'เซิร์ฟเวอร์ปฏิเสธรายการนี้';
    else reasonTh = 'ต้องตรวจสอบด้วยตนเอง';
  } else if ((SALE_INTENT_HISTORY_STATUSES as readonly string[]).includes(entry.status)) {
    state = 'confirmed';
    reasonTh = entry.status === 'settled_observed' ? 'ยืนยันแล้ว' : 'เสร็จสิ้นแล้ว';
  } else {
    state = 'unknown';
    reasonTh = 'ไม่ทราบสถานะ';
  }
  const isStale =
    state === 'pending' && nowMs - entry.createdAtLocal >= SALE_STALE_AGE_MS;
  return {
    inScope: true,
    row: emptyRow({
      channel: 'sale_intent',
      id: entry.billId || entry.asyncOrderId,
      state,
      scopeKind: 'branch_device',
      branchId: entry.branchId,
      deviceId: entry.deviceId,
      createdAtMs: entry.createdAtLocal,
      updatedAtMs: isoToMs(entry.updatedAtLocal) ?? entry.createdAtLocal,
      attempts: entry.retryCount,
      nextEligibleAtMs: null,
      reasonCode: entry.status,
      reasonTh,
      lastErrorAtMs: isoToMs(entry.lastAttemptAt),
      isStale,
      attemptCeilingReached: false,
      shiftKind: null,
    }),
  };
}

export function classifyTrustedResume(
  lastCycleChannel: ChannelRunResult | null,
): SyncCenterChannelSummary {
  const status = lastCycleChannel?.status;
  let unavailableReason: string;
  if (!lastCycleChannel) unavailableReason = 'ไม่ทราบสถานะ';
  else if (status === 'ok') unavailableReason = 'ตรวจสอบล่าสุด (ไม่ผูกกับสาขา)';
  else if (status === 'failed') unavailableReason = lastCycleChannel.errorClass
    ? `รอบล่าสุดล้มเหลว (${lastCycleChannel.errorClass})`
    : 'รอบล่าสุดล้มเหลว';
  else unavailableReason = lastCycleChannel.skipReason
    ? lastCycleChannel.skipReason === 'boot_excluded'
      ? 'ข้ามในรอบเปิดแอป (มีตัวช่วยอื่นดูแลอยู่)'
      : `ข้ามรอบล่าสุด (${lastCycleChannel.skipReason})`
    : 'ตรวจสอบล่าสุด (ไม่ผูกกับสาขา)';

  return {
    channel: 'trusted_resume',
    pending: 0,
    inFlight: 0,
    waitingRetry: 0,
    attention: 0,
    confirmedRecent: 0,
    availability: 'not_observable',
    unavailableReason,
  };
}

function countStates(rows: SyncCenterRow[], channel: SyncCenterChannelId): Pick<
  SyncCenterChannelSummary,
  'pending' | 'inFlight' | 'waitingRetry' | 'attention' | 'confirmedRecent'
> {
  const of = rows.filter((r) => r.channel === channel);
  return {
    pending: of.filter((r) => r.state === 'pending').length,
    inFlight: of.filter((r) => r.state === 'in_flight').length,
    waitingRetry: of.filter((r) => r.state === 'waiting_retry').length,
    attention: of.filter((r) => r.state === 'attention').length,
    confirmedRecent: of.filter((r) => r.state === 'confirmed').length,
  };
}

function lastSyncCheckAtMs(lastCycle: SyncOrchestratorState['lastCycle']): number | null {
  if (!lastCycle) return null;
  if (lastCycle.gateOutcome !== 'ran') return null;
  if (lastCycle.completed !== true) return null;
  if (lastCycle.channels.some((c) => c.status === 'failed')) return null;
  return lastCycle.startedAtMs + lastCycle.durationMs;
}

function pushClassified(
  target: Map<string, SyncCenterRow>,
  result: ClassifyResult,
  dropped: { count: number },
): void {
  if (!result.inScope) {
    dropped.count += 1;
    return;
  }
  target.set(`${result.row.channel}:${result.row.id}`, result.row);
}

export function buildSyncCenterAggregate(input: SyncCenterReadResult, nowMs: number): SyncCenterAggregate {
  const exhausted = new Set(input.orchestrator.ch4AttemptExhaustedIds);
  const dropped = { count: 0 };
  const keyed = new Map<string, SyncCenterRow>();

  const reversalUnavailable = !input.reversal.ok;
  if (input.reversal.ok) {
    for (const intent of input.reversal.rows) {
      pushClassified(keyed, classifyReversalIntent(intent, input.scope, exhausted, nowMs), dropped);
    }
  }

  const voidUnavailable = !input.voidIntent.ok;
  if (input.voidIntent.ok) {
    for (const rec of input.voidIntent.rows) {
      pushClassified(keyed, classifyVoidIntent(rec, input.scope, nowMs), dropped);
    }
  }

  const shiftUnavailable = !input.shiftClose.ok || !input.shiftOpen.ok;
  if (input.shiftClose.ok) {
    for (const entry of input.shiftClose.rows) {
      pushClassified(keyed, classifyShiftCloseIntent(entry, input.scope, nowMs), dropped);
    }
  }
  if (input.shiftOpen.ok) {
    for (const entry of input.shiftOpen.rows) {
      pushClassified(keyed, classifyShiftOpenIntent(entry, input.scope, nowMs), dropped);
    }
  }

  const saleUnavailable = !input.saleIntent.ok;
  if (input.saleIntent.ok) {
    for (const entry of input.saleIntent.rows) {
      pushClassified(keyed, classifySaleIntentEntry(entry, input.scope, nowMs), dropped);
    }
  }

  const rows = [...keyed.values()];
  const trusted = classifyTrustedResume(
    input.orchestrator.lastCycle?.channels.find((c) => c.channel === 'trusted_resume') ?? null,
  );

  const channels: SyncCenterChannelSummary[] = SYNC_CENTER_CHANNEL_ORDER.map((channel) => {
    if (channel === 'trusted_resume') return trusted;
    const availability: SyncCenterAvailability =
      channel === 'offline_reversal' && reversalUnavailable
        ? 'unavailable'
        : channel === 'void_intent' && voidUnavailable
          ? 'unavailable'
          : channel === 'shift_intent' && shiftUnavailable
            ? 'unavailable'
            : channel === 'sale_intent' && saleUnavailable
              ? 'unavailable'
              : 'ok';
    const reason =
      availability === 'unavailable' ? 'อ่านข้อมูลช่องทางนี้ไม่ได้' : null;
    return {
      channel,
      ...countStates(rows, channel),
      availability,
      unavailableReason: reason,
    };
  });

  const pendingRows = rows.filter(
    (r) => r.state === 'pending' || r.state === 'in_flight' || r.state === 'waiting_retry',
  );
  const attentionRows = rows.filter((r) => r.state === 'attention');

  return {
    generatedAtMs: nowMs,
    isOnline: input.isOnline,
    webLocksAvailable: input.orchestrator.webLocksAvailable,
    scopeBranchId: input.scope.branchId,
    scopeDeviceId: input.scope.deviceId,
    unifiedPending: pendingRows.length,
    unifiedAttention: attentionRows.length,
    unavailableChannelCount: channels.filter((c) => c.availability === 'unavailable').length,
    outOfScopeDroppedCount: dropped.count,
    lastSyncCheckAtMs: lastSyncCheckAtMs(input.orchestrator.lastCycle),
    lastCycleTrigger: input.orchestrator.lastCycle?.trigger ?? null,
    lastCycleGateSkipReason: input.orchestrator.lastCycle?.gateSkipReason ?? null,
    channels,
    rows,
  };
}

export function aggregateForbidsClean(aggregate: SyncCenterAggregate): boolean {
  return (
    aggregate.unifiedPending > 0 ||
    aggregate.unifiedAttention > 0 ||
    aggregate.unavailableChannelCount > 0 ||
    aggregate.lastSyncCheckAtMs == null
  );
}
