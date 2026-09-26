import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Badge, Button } from '../../components/ui';
import {
  finalizeDeviceEnrollmentRetry,
  getNativeDeviceEnrollmentInvoke,
  loadEnrollmentRecoveryState,
  recoverDeviceRegistrationCompletion,
  registerDevice,
  type DeviceRegistrationResult,
  type EnrollmentRecoveryState,
  type FinalizeRetryContext,
} from '../../lib/auth/deviceRegistration';

/**
 * SEC-001 device security enrollment card (initial enrollment + recovery
 * only). Deliberately separate from the `posDevices` label/Claim registry in
 * PosDevicesSettings: this card never touches that registry and never
 * reads/writes Firestore directly.
 *
 * Flow: native ENR1 picker (`native_import_device_enrollment_file`) →
 * operator confirms the safe metadata → `registerDevice(enrollmentAuthId)`
 * (begin → native proof → durable completion intent → complete → native
 * finalize). Success is shown only when the native finalize commits.
 *
 * Durable recovery states block new enrollment, in this priority:
 *  - conflict (records for different generations): fail closed, no action;
 *  - pending finalization: local-only `finalizeDeviceEnrollmentRetry`;
 *  - pending completion (response lost): explicit
 *    `recoverDeviceRegistrationCompletion` — replays the exact saved request,
 *    never a new ENR1/begin/proof.
 */

type NativeInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

type ImportedEnrollment = {
  enrollmentAuthId: string;
  branchId: string;
  issuerId: string;
  issuedAtServerMs: number;
  expiresAtServerMs: number;
};

type StatusState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'loaded'; deviceKeyPresent: boolean };

type Notice = { tone: 'success' | 'failure' | 'warning' | 'info'; text: string } | null;

const LOCAL_FINALIZE_REQUIRED = 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED';
const PICKER_CANCELLED_MARKER = 'no enrollment file was selected';

function toImportedEnrollment(raw: unknown): ImportedEnrollment | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.enrollmentAuthId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(r.enrollmentAuthId) ||
    typeof r.branchId !== 'string' ||
    r.branchId.trim().length === 0 ||
    typeof r.issuerId !== 'string' ||
    typeof r.issuedAtServerMs !== 'number' ||
    !Number.isFinite(r.issuedAtServerMs) ||
    typeof r.expiresAtServerMs !== 'number' ||
    !Number.isFinite(r.expiresAtServerMs)
  ) {
    return null;
  }
  return {
    enrollmentAuthId: r.enrollmentAuthId,
    branchId: r.branchId,
    issuerId: r.issuerId,
    issuedAtServerMs: r.issuedAtServerMs,
    expiresAtServerMs: r.expiresAtServerMs,
  };
}

/** Renders only a short identifier-like code, never a raw error string. */
function safeCode(code: unknown): string {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : 'unknown';
}

/** `deviceKeyPresent === true` is the only enrolled signal; a security device id alone is not. */
async function readRegistrationStatus(invoke: NativeInvoke): Promise<StatusState> {
  try {
    const raw = (await invoke('native_get_device_registration_status')) as { deviceKeyPresent?: unknown } | null;
    return { kind: 'loaded', deviceKeyPresent: raw?.deviceKeyPresent === true };
  } catch {
    return { kind: 'error' };
  }
}

function formatServerTime(ms: number): string {
  return new Date(ms).toLocaleString('th-TH');
}

export default function DeviceSecurityEnrollmentCard({ branchId }: { branchId: string | null }) {
  const [invoke] = useState<NativeInvoke | null>(() => getNativeDeviceEnrollmentInvoke());
  const [status, setStatus] = useState<StatusState>({ kind: 'loading' });
  const [recovery, setRecovery] = useState<EnrollmentRecoveryState>(() => loadEnrollmentRecoveryState());
  const pending = recovery.kind === 'finalization_pending' ? recovery.context : null;
  const [imported, setImported] = useState<ImportedEnrollment | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // Synchronous mutex: blocks a second click before React re-renders `busy`.
  const busyRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    if (!invoke) return;
    setStatus({ kind: 'loading' });
    setStatus(await readRegistrationStatus(invoke));
  }, [invoke]);

  useEffect(() => {
    if (!invoke) return;
    let cancelled = false;
    void readRegistrationStatus(invoke).then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, [invoke]);

  /**
   * Re-reads the durable recovery state. If nothing durable exists but the
   * helper handed back an in-memory finalize context (its save failed), keep
   * that context so the local-only finalize can still be attempted.
   */
  const adoptRecoveryState = (retryContext?: FinalizeRetryContext): EnrollmentRecoveryState => {
    const durable = loadEnrollmentRecoveryState();
    const next: EnrollmentRecoveryState =
      durable.kind === 'none' && retryContext ? { kind: 'finalization_pending', context: retryContext } : durable;
    setRecovery(next);
    return next;
  };

  const localFinalizeRequiredNotice = (next: EnrollmentRecoveryState): Notice => ({
    tone: 'warning',
    text:
      next.kind === 'completion_pending'
        ? 'เซิร์ฟเวอร์รับการลงทะเบียนแล้ว แต่เครื่องนี้ยังบันทึกผลไม่สำเร็จ — กรุณากด "กู้คืนการลงทะเบียน"'
        : 'เซิร์ฟเวอร์รับการลงทะเบียนแล้ว แต่เครื่องนี้ยังยืนยันไม่เสร็จ — กรุณากด "ยืนยันในเครื่องให้เสร็จ"',
  });

  const runExclusive = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const pickEnrollmentFile = () =>
    runExclusive(async () => {
      if (!invoke) return;
      setNotice(null);
      setImported(null);
      let raw: unknown;
      try {
        raw = await invoke('native_import_device_enrollment_file');
      } catch (err) {
        const cancelled = String(err).includes(PICKER_CANCELLED_MARKER);
        setNotice(
          cancelled
            ? { tone: 'info', text: 'ยกเลิกการเลือกไฟล์ลงทะเบียน' }
            : { tone: 'failure', text: 'ไฟล์ลงทะเบียนไม่ถูกต้องหรือหมดอายุ กรุณาขอไฟล์ใหม่จากผู้ดูแลระบบ' },
        );
        return;
      }
      const parsed = toImportedEnrollment(raw);
      if (!parsed) {
        setNotice({ tone: 'failure', text: 'ไฟล์ลงทะเบียนไม่ถูกต้อง กรุณาขอไฟล์ใหม่จากผู้ดูแลระบบ' });
        return;
      }
      setImported(parsed);
    });

  const confirmEnrollment = () =>
    runExclusive(async () => {
      if (!imported || recovery.kind !== 'none') return;
      const enrollmentAuthId = imported.enrollmentAuthId;
      setNotice(null);
      // The authorization is single-use; the operator must re-pick after any attempt.
      setImported(null);
      try {
        const result = await registerDevice(enrollmentAuthId);
        if (result.ok) {
          adoptRecoveryState();
          setNotice({ tone: 'success', text: 'ลงทะเบียนความปลอดภัยของเครื่องนี้สำเร็จ' });
          await refreshStatus();
          return;
        }
        if (result.code === LOCAL_FINALIZE_REQUIRED) {
          setNotice(localFinalizeRequiredNotice(adoptRecoveryState(result.retryContext)));
          return;
        }
        adoptRecoveryState();
        setNotice({ tone: 'failure', text: `ลงทะเบียนไม่สำเร็จ (รหัส: ${safeCode(result.code)})` });
      } catch {
        // A transport error after the durable completion intent was saved:
        // the server may have committed, so the card moves to explicit recovery.
        adoptRecoveryState();
        setNotice({ tone: 'failure', text: 'ติดต่อเซิร์ฟเวอร์ไม่สำเร็จ ลงทะเบียนยังไม่เสร็จ กรุณาตรวจสอบการเชื่อมต่อ' });
      }
    });

  const completeLocalFinalize = () =>
    runExclusive(async () => {
      if (!pending) return;
      setNotice(null);
      const result = await finalizeDeviceEnrollmentRetry(pending);
      if (result.ok) {
        adoptRecoveryState();
        setNotice({ tone: 'success', text: 'ยืนยันการลงทะเบียนในเครื่องนี้สำเร็จ' });
        await refreshStatus();
        return;
      }
      adoptRecoveryState(pending);
      setNotice({
        tone: 'failure',
        text: `ยืนยันในเครื่องยังไม่สำเร็จ (รหัส: ${safeCode(result.code)}) — ยังไม่ได้ส่งคำขอใหม่ไปยังเซิร์ฟเวอร์`,
      });
    });

  const recoverCompletion = () =>
    runExclusive(async () => {
      if (recovery.kind !== 'completion_pending') return;
      setNotice(null);
      let result: DeviceRegistrationResult;
      try {
        result = await recoverDeviceRegistrationCompletion();
      } catch {
        adoptRecoveryState();
        setNotice({ tone: 'failure', text: 'กู้คืนการลงทะเบียนไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่' });
        return;
      }
      if (result.ok) {
        adoptRecoveryState();
        setNotice({ tone: 'success', text: 'กู้คืนและลงทะเบียนความปลอดภัยของเครื่องนี้สำเร็จ' });
        await refreshStatus();
        return;
      }
      if (result.code === LOCAL_FINALIZE_REQUIRED) {
        setNotice(localFinalizeRequiredNotice(adoptRecoveryState(result.retryContext)));
        return;
      }
      adoptRecoveryState();
      setNotice({
        tone: 'failure',
        text: `กู้คืนการลงทะเบียนไม่สำเร็จ (รหัส: ${safeCode(result.code)}) — ยังไม่ได้เริ่มการลงทะเบียนใหม่`,
      });
    });

  const branchMismatch = imported != null && imported.branchId !== branchId;

  let body: ReactNode;
  if (!invoke) {
    body = (
      <Alert color="gray">
        การลงทะเบียนความปลอดภัยใช้ได้เฉพาะในแอป Twinpet POS บนเครื่อง Windows เท่านั้น
      </Alert>
    );
  } else if (recovery.kind === 'conflict') {
    body = (
      <Alert color="failure">
        พบข้อมูลการลงทะเบียนค้างที่ไม่ตรงกันในเครื่องนี้ — ระบบหยุดการลงทะเบียนไว้เพื่อความปลอดภัย กรุณาติดต่อผู้ดูแลระบบ
      </Alert>
    );
  } else if (pending) {
    body = (
      <div className="flex flex-col gap-3">
        <Alert color="warning">
          มีการลงทะเบียนที่ค้างการยืนยันในเครื่องนี้ (สาขา {pending.branchId}) — ต้องยืนยันให้เสร็จก่อนจึงจะลงทะเบียนใหม่ได้
        </Alert>
        <div>
          <Button className="min-h-11" onClick={() => void completeLocalFinalize()} disabled={busy}>
            ยืนยันในเครื่องให้เสร็จ
          </Button>
        </div>
      </div>
    );
  } else if (recovery.kind === 'completion_pending') {
    body = (
      <div className="flex flex-col gap-3">
        <Alert color="warning">
          การลงทะเบียนครั้งก่อนยังไม่ได้รับผลยืนยันจากเซิร์ฟเวอร์ — ต้องกู้คืนให้เสร็จก่อนจึงจะลงทะเบียนใหม่ได้
          (ไม่ต้องใช้ไฟล์ลงทะเบียนใหม่)
        </Alert>
        <div>
          <Button className="min-h-11" onClick={() => void recoverCompletion()} disabled={busy}>
            กู้คืนการลงทะเบียน
          </Button>
        </div>
      </div>
    );
  } else if (status.kind === 'loading') {
    body = <div className="stg-form-hint">กำลังตรวจสอบสถานะเครื่อง…</div>;
  } else if (status.kind === 'error') {
    body = (
      <div className="flex flex-col gap-3">
        <Alert color="failure">ตรวจสอบสถานะความปลอดภัยของเครื่องไม่สำเร็จ</Alert>
        <div>
          <Button color="light" className="min-h-11" onClick={() => void refreshStatus()} disabled={busy}>
            ตรวจสอบอีกครั้ง
          </Button>
        </div>
      </div>
    );
  } else if (status.deviceKeyPresent) {
    body = <div className="stg-form-hint">เครื่องนี้ลงทะเบียนความปลอดภัยแล้ว</div>;
  } else if (imported) {
    body = (
      <div className="flex flex-col gap-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt>สาขาในไฟล์</dt>
          <dd className="stg-code">{imported.branchId}</dd>
          <dt>ผู้ออกไฟล์</dt>
          <dd className="stg-code">{imported.issuerId}</dd>
          <dt>ออกเมื่อ</dt>
          <dd>{formatServerTime(imported.issuedAtServerMs)}</dd>
          <dt>หมดอายุ</dt>
          <dd>{formatServerTime(imported.expiresAtServerMs)}</dd>
        </dl>
        {branchMismatch ? (
          <Alert color="failure">
            สาขาในไฟล์ ({imported.branchId}) ไม่ตรงกับสาขาปัจจุบัน ({branchId ?? 'ไม่ทราบ'}) — เครื่องจะถูกลงทะเบียนกับสาขาในไฟล์
            กรุณาตรวจสอบก่อนยืนยัน
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" onClick={() => void confirmEnrollment()} disabled={busy}>
            ยืนยันลงทะเบียนเครื่องนี้
          </Button>
          <Button color="light" className="min-h-11" onClick={() => setImported(null)} disabled={busy}>
            ยกเลิก
          </Button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <span className="stg-form-hint">
          เลือกไฟล์ลงทะเบียน (.enr1) ที่ได้รับจากผู้ดูแลระบบ เพื่อผูกเครื่องนี้กับระบบความปลอดภัย
        </span>
        <div>
          <Button className="min-h-11" onClick={() => void pickEnrollmentFile()} disabled={busy}>
            เลือกไฟล์ลงทะเบียน
          </Button>
        </div>
      </div>
    );
  }

  const enrolled = invoke != null && recovery.kind === 'none' && status.kind === 'loaded' && status.deviceKeyPresent;

  return (
    <div className="stg-card">
      <div className="stg-card-head">
        <i className="ti ti-shield-lock" aria-hidden="true" /> ความปลอดภัยของเครื่อง (Device Security)
        {enrolled ? (
          <div className="stg-card-head-right">
            <Badge color="success">ลงทะเบียนแล้ว</Badge>
          </div>
        ) : null}
      </div>
      <div className="stg-card-body">
        <div className="flex flex-col gap-3">
          {notice ? (
            <Alert color={notice.tone === 'info' ? 'gray' : notice.tone} role={notice.tone === 'failure' ? 'alert' : 'status'}>
              {notice.text}
            </Alert>
          ) : null}
          {body}
        </div>
      </div>
    </div>
  );
}
