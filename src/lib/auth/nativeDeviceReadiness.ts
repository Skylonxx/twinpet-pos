/**
 * Native POS device-wide enrollment gate (TPOS-R7).
 *
 * Invariant: on a Tauri POS, no staff-authenticated UI/session may become
 * usable unless the machine has a fully valid local device enrollment. This
 * module is the single client-side source of that decision; AuthProvider uses
 * it for Quick PIN, Username/Password, restored sessions and route authority.
 *
 * Readiness comes only from the read-only native command
 * `native_get_device_security_readiness`, which reports READY only after the
 * full local prerequisite chain (security device id, committed key, verified
 * enrollment bindings, trusted active manifest) holds. The weaker
 * `deviceKeyPresent` status is never used as a security decision.
 *
 * Runtime detection fails closed: Tauri injects `window.isTauri = true` into
 * every webview (the same flag `@tauri-apps/api`'s `isTauri()` reads). If that
 * flag is set but the command bridge is missing or the command fails, the
 * result is UNAVAILABLE — never "web". Raw native error strings are never
 * surfaced; only the fixed messages below.
 */

import { getNativeDeviceEnrollmentInvoke } from './deviceRegistration';

type NativeInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export const NATIVE_DEVICE_SECURITY_READINESS_COMMAND = 'native_get_device_security_readiness';

/** `not_native` = genuine web runtime; every other value is a native Tauri POS. */
export type NativeDeviceReadiness =
  | 'not_native'
  | 'READY'
  | 'NOT_ENROLLED'
  | 'INVALID_OR_INCOMPLETE'
  | 'UNAVAILABLE';

export type DeviceNotReadyCode =
  | 'DEVICE_NOT_ENROLLED'
  | 'DEVICE_ENROLLMENT_INVALID'
  | 'DEVICE_STATUS_UNAVAILABLE'
  | 'DEVICE_SESSION_PREPARATION_FAILED'
  | 'DEVICE_SESSION_ISSUANCE_FAILED'
  | 'DEVICE_SESSION_PERSIST_FAILED';

const DEVICE_NOT_READY_MESSAGES: Record<DeviceNotReadyCode, string> = {
  DEVICE_NOT_ENROLLED:
    'เครื่อง POS นี้ยังไม่ได้ลงทะเบียนความปลอดภัย — กรุณาลงทะเบียนเครื่องก่อนเข้าสู่ระบบ',
  DEVICE_ENROLLMENT_INVALID:
    'ข้อมูลการลงทะเบียนความปลอดภัยของเครื่องนี้ไม่สมบูรณ์หรือไม่ถูกต้อง — ยังเข้าสู่ระบบไม่ได้ กรุณาติดต่อผู้ดูแลระบบ',
  DEVICE_STATUS_UNAVAILABLE:
    'ตรวจสอบสถานะการลงทะเบียนของเครื่องไม่สำเร็จ — ยังไม่ได้ส่งข้อมูลเข้าสู่ระบบไปยังเซิร์ฟเวอร์ กรุณาลองใหม่',
  DEVICE_SESSION_PREPARATION_FAILED:
    'เตรียมเซสชันความปลอดภัยของเครื่องไม่สำเร็จ — กรุณาตรวจสอบการลงทะเบียนเครื่อง หรือติดต่อผู้ดูแลระบบ',
  DEVICE_SESSION_ISSUANCE_FAILED:
    'ออกเซสชันความปลอดภัยของเครื่องไม่สำเร็จ — กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่ หรือติดต่อผู้ดูแลระบบ',
  DEVICE_SESSION_PERSIST_FAILED:
    'บันทึกเซสชันความปลอดภัยในเครื่องไม่สำเร็จ — กรุณาตรวจสอบการลงทะเบียนเครื่อง หรือติดต่อผู้ดูแลระบบ',
};

/** A device-side (not PIN / not branch-permission / not password) login failure. */
export class DeviceNotReadyError extends Error {
  readonly code: DeviceNotReadyCode;

  constructor(code: DeviceNotReadyCode) {
    super(DEVICE_NOT_READY_MESSAGES[code]);
    this.name = 'DeviceNotReadyError';
    this.code = code;
  }
}

export function isDeviceNotReadyError(err: unknown): err is DeviceNotReadyError {
  return err instanceof DeviceNotReadyError;
}

/** Canonical Tauri runtime signal; a present command bridge also implies native. */
export function isNativeTauriRuntime(): boolean {
  const g = globalThis as unknown as { isTauri?: unknown; window?: { isTauri?: unknown } };
  return g.isTauri === true || g.window?.isTauri === true || getNativeDeviceEnrollmentInvoke() != null;
}

export async function readNativeDeviceReadiness(): Promise<NativeDeviceReadiness> {
  if (!isNativeTauriRuntime()) return 'not_native';
  const invoke: NativeInvoke | null = getNativeDeviceEnrollmentInvoke();
  if (!invoke) return 'UNAVAILABLE';
  let raw: unknown;
  try {
    raw = await invoke(NATIVE_DEVICE_SECURITY_READINESS_COMMAND);
  } catch {
    return 'UNAVAILABLE';
  }
  const readiness = (raw as { readiness?: unknown } | null)?.readiness;
  return readiness === 'READY' || readiness === 'NOT_ENROLLED' || readiness === 'INVALID_OR_INCOMPLETE'
    ? readiness
    : 'UNAVAILABLE';
}

/** Web, or native with a fully valid local enrollment. */
export function isDeviceGateOpen(readiness: NativeDeviceReadiness | 'checking'): boolean {
  return readiness === 'not_native' || readiness === 'READY';
}

/** Throws the matching DeviceNotReadyError unless the gate is open. */
export function assertDeviceGateOpen(readiness: NativeDeviceReadiness): void {
  switch (readiness) {
    case 'not_native':
    case 'READY':
      return;
    case 'NOT_ENROLLED':
      throw new DeviceNotReadyError('DEVICE_NOT_ENROLLED');
    case 'INVALID_OR_INCOMPLETE':
      throw new DeviceNotReadyError('DEVICE_ENROLLMENT_INVALID');
    default:
      throw new DeviceNotReadyError('DEVICE_STATUS_UNAVAILABLE');
  }
}
