/**
 * SEC-001 Packet E / E-1 — closed Thai copy / state mapping.
 *
 * Section 8 — total D-3-outcome -> UX-contract mapping. `projected` /
 * `already_projected` means ONLY "evidence captured, pending adjudication" —
 * this module never uses completed-void wording ("ยกเลิกบิลสำเร็จ",
 * "สำเร็จ" as a verdict on the void itself) for any pending/local/uncertain
 * state (false-success guard, Section 15).
 *
 * Section 14 — never renders a raw internal/server reason/error code. PIN
 * rejection copy is a single fixed fallback regardless of the D-1B/native
 * `errorCode` value.
 */

import type { PrivilegedVoidFlowState, PrivilegedVoidLocalFailureReason } from './privilegedVoidFlowMachine';
import type { ApproverRosterState } from '../../auth/useApproverRoster';

export type PrivilegedVoidCopyTone = 'pending' | 'info' | 'warning' | 'error';

export interface PrivilegedVoidCopyContent {
  title: string;
  body: string;
  tone: PrivilegedVoidCopyTone;
}

const LOCAL_FAILURE_COPY: Record<PrivilegedVoidLocalFailureReason, PrivilegedVoidCopyContent> = {
  unavailable: {
    title: 'ไม่พร้อมใช้งานในขณะนี้',
    body: 'ไม่สามารถเริ่มคำขอยกเลิกได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง',
    tone: 'error',
  },
  durable_unavailable: {
    title: 'ไม่สามารถบันทึกข้อมูลในเครื่องได้',
    body: 'ไม่สามารถบันทึกหลักฐานคำขอยกเลิกในเครื่องนี้ได้ กรุณาลองใหม่อีกครั้ง',
    tone: 'error',
  },
  integrity_conflict: {
    title: 'พบความไม่สอดคล้องของข้อมูล',
    body: 'ระบบตรวจพบความไม่สอดคล้องของข้อมูลในเครื่องนี้ ไม่สามารถดำเนินการต่อได้ กรุณาติดต่อผู้ดูแลระบบ',
    tone: 'error',
  },
  stale_context: {
    title: 'ข้อมูลไม่ตรงกับปัจจุบันแล้ว',
    body: 'ข้อมูลบิล สาขา หรือผู้ใช้งานเปลี่ยนไปตั้งแต่เริ่มคำขอนี้ กรุณาปิดหน้าต่างนี้แล้วเริ่มคำขอใหม่',
    tone: 'error',
  },
  // RC-E1-004 — structural D-1B denial copy. Never renders the raw errorCode;
  // each bucket below is a fixed, closed message keyed only by denial CLASS.
  denied_locked: {
    title: 'ถูกล็อกชั่วคราว',
    body: 'บัญชีผู้จัดการนี้ถูกล็อกชั่วคราวจากการอนุมัติที่ผิดพลาดหลายครั้ง ไม่สามารถลองใส่ PIN ซ้ำในคำขอนี้ได้ กรุณาติดต่อผู้ดูแลระบบ',
    tone: 'error',
  },
  denied_stale: {
    title: 'สิทธิ์อนุมัติออฟไลน์หมดอายุ',
    body: 'สิทธิ์อนุมัติออฟไลน์ของผู้จัดการหมดอายุแล้ว กรุณาเชื่อมต่อระบบแล้วเริ่มคำขอยกเลิกใหม่',
    tone: 'error',
  },
  denied_unverifiable: {
    title: 'ไม่สามารถตรวจสอบสิทธิ์อนุมัติได้',
    body: 'อุปกรณ์นี้ไม่สามารถตรวจสอบสิทธิ์อนุมัติแบบออฟไลน์ได้ในขณะนี้ กรุณาลองใหม่จากอุปกรณ์ที่รองรับ',
    tone: 'error',
  },
  denied_unknown: {
    title: 'ไม่สามารถอนุมัติคำขอนี้ได้',
    body: 'ไม่สามารถอนุมัติคำขอยกเลิกนี้ได้ในขณะนี้ กรุณาเริ่มคำขอยกเลิกใหม่',
    tone: 'error',
  },
};

/**
 * Result/status copy for the flow machine's non-interactive states. Returns
 * `null` for the interactive steps (IDLE/PRECHECK/VOID_REASON_ENTRY/
 * MANAGER_SELECT/MANAGER_PIN_ENTRY/PROJECTING) — those render their own step
 * UI, not a single result panel.
 */
export function copyForFlowState(state: PrivilegedVoidFlowState): PrivilegedVoidCopyContent | null {
  switch (state.status) {
    case 'CAPTURED_PENDING_ADJUDICATION':
      return {
        title: 'บันทึกคำขอยกเลิกแล้ว รอการตรวจสอบ',
        body:
          'หลักฐานการอนุมัติถูกบันทึกในเครื่องนี้แล้ว และจะถูกส่งตรวจสอบเมื่อพร้อม บิลนี้ยังไม่ถูกยกเลิกจนกว่าจะได้รับการยืนยัน',
        tone: 'pending',
      };
    case 'TERMINAL_SERVER_ACCEPTED':
      return {
        title: 'คำขอยกเลิกได้รับการยืนยันจากเซิร์ฟเวอร์แล้ว',
        body: 'เซิร์ฟเวอร์ยืนยันหลักฐานการอนุมัติของคำขอนี้แล้ว',
        tone: 'info',
      };
    case 'TERMINAL_SERVER_REJECTED':
      return {
        title: 'คำขอยกเลิกไม่ได้รับการอนุมัติ',
        body: 'เซิร์ฟเวอร์ปฏิเสธคำขอนี้ ท่านสามารถเริ่มคำขอยกเลิกใหม่ได้',
        tone: 'error',
      };
    case 'MANUAL_ATTENTION':
      return {
        title: 'ต้องให้เจ้าหน้าที่ตรวจสอบ',
        body: 'รายการนี้ต้องรอการตรวจสอบจากเจ้าหน้าที่ก่อน ยังไม่สามารถดำเนินการต่อได้ที่นี่',
        tone: 'warning',
      };
    case 'LOCAL_FAILURE':
      return LOCAL_FAILURE_COPY[state.reasonCode];
    case 'LOCAL_UNCERTAIN':
      return {
        title: 'ไม่สามารถยืนยันผลของคำขอนี้ได้',
        body:
          'ระบบไม่สามารถยืนยันผลของคำขอนี้ได้ในขณะนี้ กรุณาตรวจสอบสถานะใหม่ก่อน ห้ามเริ่มคำขอใหม่จนกว่าจะตรวจสอบเสร็จ',
        tone: 'warning',
      };
    case 'RECOVERED_ACTIVE':
      return {
        title: 'มีคำขอยกเลิกที่ยังดำเนินการอยู่',
        body: 'บิลนี้มีคำขอยกเลิกที่ยังไม่เสร็จสิ้น กรุณารอผลก่อนเริ่มคำขอใหม่',
        tone: 'info',
      };
    default:
      return null;
  }
}

/**
 * PIN-rejection copy. Deliberately IGNORES the D-1B/native `errorCode` value
 * — Section 14 forbids rendering a raw internal/server reason string, and no
 * safe/localized sub-mapping of that vocabulary is in scope for E-1.
 */
export function pinErrorCopy(_errorCode: string | null): string {
  return 'PIN ไม่ถูกต้อง หรือไม่สามารถอนุมัติได้ กรุณาลองใหม่อีกครั้ง';
}

export const PRIVILEGED_VOID_ROSTER_EMPTY_COPY =
  'ไม่พบรายชื่อผู้จัดการที่สามารถอนุมัติได้ในสาขานี้';
export const PRIVILEGED_VOID_ROSTER_UNCONFIRMED_EMPTY_COPY =
  'ไม่สามารถยืนยันรายชื่อผู้จัดการได้ในขณะนี้ (ไม่มีการเชื่อมต่อ) กรุณาลองใหม่เมื่อออนไลน์';
export const PRIVILEGED_VOID_ROSTER_UNAVAILABLE_COPY =
  'ไม่สามารถโหลดรายชื่อผู้จัดการได้ในขณะนี้';

/**
 * GD-E-006 fail-closed roster gate copy. `null` means the roster may be
 * used (either genuinely ready-with-candidates, or still loading). A
 * cache-only empty roster is distinguished from a confirmed-empty one —
 * both fail closed, with different copy — and `disabled`/`error` fail
 * closed unconditionally.
 */
export function rosterFailClosedReason(roster: Pick<ApproverRosterState, 'status' | 'fromCache' | 'candidates'>): string | null {
  if (roster.status === 'disabled' || roster.status === 'error') {
    return PRIVILEGED_VOID_ROSTER_UNAVAILABLE_COPY;
  }
  if (roster.status === 'pending') return null;
  if (roster.candidates.length === 0) {
    return roster.fromCache ? PRIVILEGED_VOID_ROSTER_UNCONFIRMED_EMPTY_COPY : PRIVILEGED_VOID_ROSTER_EMPTY_COPY;
  }
  return null;
}
