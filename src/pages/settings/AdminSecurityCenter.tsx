import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../../components/ui';
import ManagerPinModal from '../../components/pos/ManagerPinModal';
import { fetchActiveBranches } from '../../lib/branches';
import type { NativeInvoke } from '../../lib/auth/privilegedLockoutRecovery';
import {
  ADMIN_SECURITY_COPY as C,
  enterOwnPinInstruction,
  managerIdentityLine,
  wrongOwnPinCopy,
} from '../../lib/adminSecurity/adminSecurityCopy';
import {
  checkAdminPasswordSession,
  clearManagerApprovalLockout,
  createAdminUser,
  isProtectedAdminTarget,
  loadAdminSecurityOverview,
  reissueManagerOac,
  rotateAdminUserPin,
  setAdminUserActive,
  updateAdminUser,
  type AccountMutationResult,
  type AdminSecurityDeps,
  type AdminSecurityEvent,
  type AdminSecurityOverview,
  type AdminSecurityUser,
  type ReissueOacResult,
  type LockoutClearResult,
} from '../../lib/adminSecurity/adminSecurityService';
import {
  getManagerOacInvoke,
  projectApprovalCapability,
  readManagerOacStatus,
  type ApprovalCapabilityState,
  type NativeManagerOacStatus,
} from '../../lib/adminSecurity/managerOac';
import { cooldownText } from './PrivilegedLockoutRecoveryCard';
import { AdminChangePinDialog, AdminConfirmDialog, AdminUserFormDialog, type BranchOption } from './AdminSecurityDialogs';

/**
 * Settings → Admin & ความปลอดภัย — Admin & Security Center V1.
 *
 * Every mutation goes through `adminSecurityService` (primary password-admin
 * gate, one canonical call per explicit action, target-only local OAC
 * invalidation, no retries). This component never sees a PIN beyond the
 * transient dialog buffers, and never renders a uid, device id, lockout id,
 * OAC id, token or raw code.
 */

type Notice = { tone: 'success' | 'failure' | 'warning' | 'info'; text: string };

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; user: AdminSecurityUser }
  | { kind: 'pin'; user: AdminSecurityUser }
  | { kind: 'toggle'; user: AdminSecurityUser }
  | { kind: 'lockout'; user: AdminSecurityUser }
  | { kind: 'reissue_confirm'; user: AdminSecurityUser }
  | { kind: 'reissue_pin'; user: AdminSecurityUser };

export type AdminSecurityCenterDeps = {
  service?: AdminSecurityDeps;
  invoke?: NativeInvoke | null;
  fetchBranches?: () => Promise<BranchOption[]>;
};

/** Event-history role names (a role value, not an account classification). */
const ROLE_LABEL: Record<string, string> = { admin: 'Admin', manager: 'ผู้จัดการ', staff: 'พนักงาน' };

/** D-ASC9 row role label + secondary copy; admins are split by server classification. */
function roleDisplay(u: AdminSecurityUser): { label: string; hint: string | null } {
  if (u.role !== 'admin') return { label: ROLE_LABEL[u.role] ?? u.role, hint: null };
  if (u.securityAdminClassification === 'PASSWORD_ADMIN') return { label: C.roleSecurityAdmin, hint: C.roleSecurityAdminHint };
  if (u.securityAdminClassification === 'POS_ADMIN') return { label: C.rolePosAdmin, hint: C.rolePosAdminHint };
  return { label: C.roleAdminUnknown, hint: C.roleAdminUnknownHint };
}

const CAPABILITY_LABEL: Record<ApprovalCapabilityState, string> = {
  ready: C.oacReady,
  reissue_required: C.oacReissueRequired,
  expired: C.oacExpired,
  missing: C.oacMissing,
  locked: C.oacLocked,
  unknown: '—',
};

const CAPABILITY_COLOR: Record<ApprovalCapabilityState, string> = {
  ready: 'success',
  reissue_required: 'warning',
  expired: 'warning',
  missing: 'gray',
  locked: 'failure',
  unknown: 'gray',
};

function displayNameOf(u: Pick<AdminSecurityUser, 'firstName' | 'lastName' | 'username'>): string {
  const name = `${u.firstName} ${u.lastName}`.trim();
  return name || u.username || C.unknownUser;
}

function isApproverRole(role: string): boolean {
  return role === 'manager' || role === 'admin';
}

function mutationNotice(result: AccountMutationResult, successText: string): Notice {
  switch (result.kind) {
    case 'ok':
      return result.oacRevoke === 'failed'
        ? { tone: 'warning', text: `${successText} — ${C.oacRevokeFailed}` }
        : { tone: 'success', text: successText };
    case 'rejected':
      return { tone: 'failure', text: result.message };
    case 'uncertain':
      return { tone: 'warning', text: C.uncertain };
    case 'not_admin':
      return { tone: 'failure', text: C.passwordSessionRequired };
    case 'self_target':
      return { tone: 'warning', text: C.selfLocked };
    case 'protected_target':
      return { tone: 'warning', text: C.ownerRecoveryRequired };
    case 'invalid':
      return { tone: 'failure', text: result.reason === 'pin_format' ? C.pinFormat : 'กรุณากรอกข้อมูลให้ครบถ้วน' };
    case 'busy':
      return { tone: 'warning', text: 'กำลังบันทึกรายการก่อนหน้า กรุณารอสักครู่' };
  }
}

function reissueNotice(result: ReissueOacResult, displayName: string): Notice {
  switch (result.kind) {
    case 'provisioned':
      return { tone: 'success', text: C.oacReissueSuccess };
    case 'pin_rejected':
      return { tone: 'failure', text: wrongOwnPinCopy(displayName) };
    case 'offline':
      return { tone: 'failure', text: C.oacOffline };
    case 'not_eligible':
    case 'not_eligible_target':
      return { tone: 'failure', text: C.oacNotEligible };
    case 'device_not_ready':
      return { tone: 'failure', text: C.oacDeviceNotReady };
    case 'uncertain':
      return { tone: 'warning', text: C.oacUncertain };
    case 'not_admin':
      return { tone: 'failure', text: C.passwordSessionRequired };
    case 'self_target':
      return { tone: 'warning', text: C.selfLocked };
    case 'protected_target':
      return { tone: 'warning', text: C.ownerRecoveryRequired };
    case 'invalid':
      return { tone: 'failure', text: C.pinFormat };
    default:
      return { tone: 'failure', text: C.oacFailed };
  }
}

function lockoutNotice(result: LockoutClearResult): Notice {
  switch (result.kind) {
    case 'recovered':
      return { tone: 'success', text: C.lockoutSuccess };
    case 'not_locked':
      return { tone: 'info', text: C.lockoutNormal };
    case 'cooldown':
      return { tone: 'warning', text: cooldownText(result.cooldownRemainingMs) };
    case 'not_admin':
      return { tone: 'failure', text: C.passwordSessionRequired };
    case 'self_target':
      return { tone: 'warning', text: C.selfLocked };
    case 'protected_target':
      return { tone: 'warning', text: C.ownerRecoveryRequired };
    default:
      return { tone: 'failure', text: C.lockoutFailure };
  }
}

const EVENT_LABEL: Record<string, string> = {
  USER_CREATED: 'เพิ่มผู้ใช้งาน',
  USER_PROFILE_UPDATED: 'แก้ไขผู้ใช้',
  USER_ENABLED: 'เปิดใช้งานผู้ใช้',
  USER_DISABLED: 'ปิดใช้งานผู้ใช้',
  USER_SOFT_DELETED: 'ลบผู้ใช้ (เก็บประวัติ)',
  USER_RENAMED: 'เปลี่ยนชื่อผู้ใช้ (username)',
  QUICK_PIN_ROTATED: 'เปลี่ยน Quick PIN',
  APPROVAL_LOCKOUT_CLEAR_ISSUED: 'ปลดล็อกสิทธิ์อนุมัติ',
  OAC_ISSUED: 'ออกสิทธิ์ Offline',
};

/** Account events that make an approver's previously issued OAC unusable (authVersion bump). */
const OAC_INVALIDATING_EVENTS = new Set([
  'USER_PROFILE_UPDATED',
  'USER_ENABLED',
  'USER_DISABLED',
  'USER_SOFT_DELETED',
  'USER_RENAMED',
  'QUICK_PIN_ROTATED',
]);

function describeEvent(
  e: AdminSecurityEvent,
  nameOf: (id: string) => string,
  branchLabel: (id: string) => string,
  isApproverNow: (id: string) => boolean,
): { title: string; detail: string } {
  const title = EVENT_LABEL[e.type] ?? 'กิจกรรมความปลอดภัย';
  const parts: string[] = [nameOf(e.targetStaffId)];
  if (e.type === 'USER_PROFILE_UPDATED' || e.type === 'USER_CREATED') {
    if (e.changedFields.includes('role') || (e.type === 'USER_CREATED' && e.roleAfter)) {
      parts.push(
        e.roleBefore && e.type !== 'USER_CREATED'
          ? `บทบาท ${ROLE_LABEL[e.roleBefore] ?? '—'} → ${ROLE_LABEL[e.roleAfter ?? ''] ?? '—'}`
          : `บทบาท ${ROLE_LABEL[e.roleAfter ?? ''] ?? '—'}`,
      );
    }
    if (e.changedFields.includes('branchIds') || (e.type === 'USER_CREATED' && e.branchIdsAfter)) {
      parts.push(`สาขา ${(e.branchIdsAfter ?? []).map(branchLabel).join(', ') || '—'}`);
    }
  }
  if (e.deviceBranchId) parts.push(`เครื่องสาขา ${branchLabel(e.deviceBranchId)}`);
  const wasApprover = e.roleBefore ? isApproverRole(e.roleBefore) : isApproverNow(e.targetStaffId);
  if (OAC_INVALIDATING_EVENTS.has(e.type) && wasApprover) {
    parts.push('สิทธิ์ Offline เดิมใช้ไม่ได้แล้ว');
  }
  parts.push(`โดย ${nameOf(e.actorStaffId)}`);
  return { title, detail: parts.join(' · ') };
}

export default function AdminSecurityCenter({
  operator,
  branchId,
  deps,
}: {
  operator: { id: string; role: string } | null | undefined;
  branchId: string | null;
  /** Test seam only. */
  deps?: AdminSecurityCenterDeps;
}) {
  const service = deps?.service;
  const [invoke] = useState<NativeInvoke | null>(() => (deps?.invoke !== undefined ? deps.invoke : getManagerOacInvoke()));
  const [session, setSession] = useState<'checking' | 'eligible' | 'ineligible'>('checking');
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [overview, setOverview] = useState<AdminSecurityOverview | null>(null);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [oac, setOac] = useState<Record<string, NativeManagerOacStatus>>({});
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  // Synchronous one-action guard: a second click before re-render is a no-op.
  const actionRef = useRef(false);
  const loadSeqRef = useRef(0);

  const terminalBranchId = branchId && branchId !== 'ALL' ? branchId : null;

  const refreshOac = useCallback(
    async (users: AdminSecurityUser[]) => {
      if (!invoke) return;
      const next: Record<string, NativeManagerOacStatus> = {};
      for (const u of users) {
        if (isApproverRole(u.role)) next[u.userId] = await readManagerOacStatus(u.userId, invoke);
      }
      setOac(next);
    },
    [invoke],
  );

  const reload = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoad('loading');
    const res = await loadAdminSecurityOverview(operator, service);
    if (seq !== loadSeqRef.current) return;
    if (res.kind === 'not_admin') {
      setSession('ineligible');
      return;
    }
    if (res.kind === 'failed') {
      setLoad('failed');
      return;
    }
    setOverview(res.overview);
    setLoad('ready');
    await refreshOac(res.overview.users);
  }, [operator, service, refreshOac]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ok = await checkAdminPasswordSession(operator, service);
      if (cancelled) return;
      setSession(ok ? 'eligible' : 'ineligible');
      if (!ok) return;
      const fetchBranches = deps?.fetchBranches ?? fetchActiveBranches;
      void fetchBranches()
        .then((list) => {
          if (!cancelled) setBranches(list.map((b) => ({ id: b.id, name: b.name })));
        })
        .catch(() => undefined);
      await reload();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operator?.id, operator?.role]);

  const runAction = async (fn: () => Promise<Notice>) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setBusy(true);
    try {
      setNotice(await fn());
    } finally {
      setDialog(null);
      setBusy(false);
      actionRef.current = false;
      void reload();
    }
  };

  const users = overview?.users ?? [];
  const byId = new Map(users.map((u) => [u.userId, u]));
  const nameOf = (id: string) => {
    if (id === 'OPERATOR_CLI') return C.operatorCli;
    const u = byId.get(id);
    return u ? (u.username ? `${displayNameOf(u)} (${u.username})` : displayNameOf(u)) : C.unknownUser;
  };
  const branchLabel = (id: string) =>
    id === 'ALL' ? C.allBranches : (branches.find((b) => b.id === id)?.name ?? id);

  const capabilityOf = (u: AdminSecurityUser): ApprovalCapabilityState =>
    projectApprovalCapability({
      status: oac[u.userId] ?? { kind: 'unavailable' },
      role: u.role,
      isActive: u.isActive,
      branchIds: u.branchIds,
      liveAuthVersion: u.authVersion,
      terminalBranchId,
    });

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="stg-section-title">{C.title}</div>
      <Badge color={session === 'eligible' ? 'success' : 'warning'} data-testid="admin-session-badge">
        {session === 'eligible' ? C.badgeEligible : C.badgeIneligible}
      </Badge>
    </div>
  );

  let body: ReactNode;
  if (session === 'checking') {
    body = <div className="stg-form-hint">{C.checkingSession}</div>;
  } else if (session === 'ineligible') {
    body = (
      <Alert color="warning" role="alert" data-testid="admin-password-required">
        {C.passwordSessionRequired}
      </Alert>
    );
  } else if (load === 'failed') {
    body = (
      <div className="flex flex-col gap-3">
        <Alert color="failure" role="alert">
          {C.loadFailed}
        </Alert>
        <div>
          <Button color="light" className="min-h-11" onClick={() => void reload()}>
            {C.reload}
          </Button>
        </div>
      </div>
    );
  } else if (load === 'loading' && !overview) {
    body = <div className="stg-form-hint">{C.loading}</div>;
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {notice ? (
          <Alert
            color={notice.tone}
            role={notice.tone === 'success' || notice.tone === 'info' ? 'status' : 'alert'}
            onDismiss={() => setNotice(null)}
            data-testid="admin-security-notice"
          >
            {notice.text}
          </Alert>
        ) : null}
        <div className="stg-card">
          <div className="stg-card-head">
            <i className="ti ti-users" aria-hidden="true" /> {C.usersHeading}
            <div className="stg-card-head-right">
              <Button size="sm" className="min-h-11" onClick={() => setDialog({ kind: 'create' })} disabled={busy}>
                <i className="ti ti-user-plus mr-1" aria-hidden="true" /> {C.addUser}
              </Button>
            </div>
          </div>
          <div className="stg-card-body stg-card-body-flush">
            <div className="overflow-x-auto">
              <Table className="min-w-[860px]">
                <TableHead>
                  <TableRow>
                    <TableHeadCell>ผู้ใช้งาน</TableHeadCell>
                    <TableHeadCell>บทบาท</TableHeadCell>
                    <TableHeadCell>สาขา</TableHeadCell>
                    <TableHeadCell>สถานะ</TableHeadCell>
                    <TableHeadCell>Quick PIN</TableHeadCell>
                    <TableHeadCell>สิทธิ์อนุมัติ (เครื่องนี้)</TableHeadCell>
                    <TableHeadCell>จัดการ</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {users.map((u) => {
                    const self = u.userId === operator?.id;
                    // Security Admin / unclassified admin rows are read-only (D-ASC9).
                    const readOnly = isProtectedAdminTarget(u);
                    const roleView = roleDisplay(u);
                    const approver = isApproverRole(u.role);
                    const cap = approver ? capabilityOf(u) : null;
                    return (
                      <TableRow key={u.userId} data-testid="admin-user-row">
                        <TableCell>
                          <div className="font-medium">{displayNameOf(u)}</div>
                          <div className="text-xs text-gray-500">{u.username}</div>
                          {self ? (
                            <Badge color="info" className="mt-1 w-fit">
                              {C.selfAccount}
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium" data-testid="admin-role-label">
                            {roleView.label}
                          </div>
                          {roleView.hint ? (
                            <div className="text-xs text-gray-500" data-testid="admin-role-hint">
                              {roleView.hint}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell>{u.branchIds.map(branchLabel).join(', ') || '—'}</TableCell>
                        <TableCell>
                          <Badge color={u.isActive ? 'success' : 'gray'} className="w-fit">
                            {u.isActive ? C.active : C.inactive}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge color={u.quickPinState === 'set' ? 'success' : 'warning'} className="w-fit">
                            {u.quickPinState === 'set' ? C.pinSet : C.pinRequired}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {!approver ? (
                            '—'
                          ) : !invoke ? (
                            <span className="text-xs text-gray-500">{C.oacNativeOnly}</span>
                          ) : (
                            <div className="flex flex-col gap-1">
                              <Badge color={CAPABILITY_COLOR[cap!]} className="w-fit" data-testid="admin-oac-state">
                                {CAPABILITY_LABEL[cap!]}
                              </Badge>
                              <span className="text-xs text-gray-500" data-testid="admin-lockout-state">
                                {cap === 'locked' ? C.lockoutLocked : C.lockoutNormal}
                              </span>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {readOnly ? (
                            <span className="text-xs text-gray-500" data-testid="admin-row-readonly">
                              {u.securityAdminClassification === 'PASSWORD_ADMIN' ? C.ownerRecoveryManaged : C.adminUnknownReadOnly}
                            </span>
                          ) : self ? (
                            <span className="text-xs text-gray-500">{C.selfLocked}</span>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              <Button size="xs" color="light" className="min-h-11" disabled={busy} onClick={() => setDialog({ kind: 'edit', user: u })}>
                                {C.editUser}
                              </Button>
                              <Button size="xs" color="light" className="min-h-11" disabled={busy} onClick={() => setDialog({ kind: 'pin', user: u })}>
                                {C.changePin}
                              </Button>
                              {approver && invoke && cap === 'locked' ? (
                                <Button size="xs" color="warning" className="min-h-11" disabled={busy} onClick={() => setDialog({ kind: 'lockout', user: u })}>
                                  {C.clearLockout}
                                </Button>
                              ) : null}
                              {approver && invoke && cap !== 'locked' && u.isActive && terminalBranchId ? (
                                <Button
                                  size="xs"
                                  color="light"
                                  className="min-h-11"
                                  disabled={busy}
                                  onClick={() => setDialog(cap === 'ready' ? { kind: 'reissue_confirm', user: u } : { kind: 'reissue_pin', user: u })}
                                >
                                  {C.reissueOac}
                                </Button>
                              ) : null}
                              <Button
                                size="xs"
                                color={u.isActive ? 'failure' : 'light'}
                                className="min-h-11"
                                disabled={busy}
                                onClick={() =>
                                  u.isActive
                                    ? setDialog({ kind: 'toggle', user: u })
                                    : void runAction(async () =>
                                        mutationNotice(await setAdminUserActive(operator, u, true, service), C.userEnabled),
                                      )
                                }
                              >
                                {u.isActive ? C.disable : C.enable}
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>

        <div className="stg-card" data-testid="admin-activity">
          <div className="stg-card-head">
            <i className="ti ti-history" aria-hidden="true" /> {C.activityHeading}
          </div>
          <div className="stg-card-body">
            {(overview?.events ?? []).length === 0 ? (
              <div className="stg-form-hint">{C.activityEmpty}</div>
            ) : (
              <ul className="flex flex-col gap-2">
                {(overview?.events ?? []).map((e, i) => {
                  const d = describeEvent(e, nameOf, branchLabel, (id) => isApproverRole(byId.get(id)?.role ?? ''));
                  return (
                    <li key={`${e.createdAtMs ?? 0}-${i}`} className="flex flex-col">
                      <span className="font-medium">{d.title}</span>
                      <span className="text-xs text-gray-500">
                        {d.detail}
                        {e.createdAtMs ? ` · ${new Date(e.createdAtMs).toLocaleString('th-TH')}` : ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    );
  }

  const active = dialog;
  const activeName = active && 'user' in active ? displayNameOf(active.user) : '';

  return (
    <div data-testid="admin-security-center">
      {header}
      <div className="stg-section-sub">{C.subtitle}</div>
      {body}

      {active?.kind === 'create' || active?.kind === 'edit' ? (
        <AdminUserFormDialog
          mode={active.kind}
          user={active.kind === 'edit' ? active.user : null}
          branches={branches}
          existingUsernames={users.map((u) => u.username.toLowerCase())}
          busy={busy}
          onCancel={() => setDialog(null)}
          onSubmit={(values) =>
            void runAction(async () => {
              if (active.kind === 'create') {
                return mutationNotice(await createAdminUser(operator, values, service), C.userCreated);
              }
              const res = await updateAdminUser(operator, active.user, values, service);
              return mutationNotice(res, isApproverRole(active.user.role) ? `${C.saved} — ต้องออกสิทธิ์ Offline ใหม่` : C.saved);
            })
          }
        />
      ) : null}

      {active?.kind === 'pin' ? (
        <AdminChangePinDialog
          displayName={activeName}
          username={active.user.username}
          busy={busy}
          onCancel={() => setDialog(null)}
          onSubmit={(pin) =>
            void runAction(async () =>
              mutationNotice(
                await rotateAdminUserPin(operator, active.user, pin, service),
                isApproverRole(active.user.role) ? C.pinRotated : C.pinRotatedStaff,
              ),
            )
          }
        />
      ) : null}

      {active?.kind === 'toggle' ? (
        <AdminConfirmDialog
          title={C.disable}
          body={`ผู้ใช้: ${activeName}${active.user.username ? ` (${active.user.username})` : ''}\n${C.disableConfirm}`}
          confirmLabel={C.disable}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            void runAction(async () =>
              mutationNotice(await setAdminUserActive(operator, active.user, false, service), C.userDisabled),
            )
          }
        />
      ) : null}

      {active?.kind === 'lockout' ? (
        <AdminConfirmDialog
          title={C.clearLockout}
          body={`${managerIdentityLine(activeName, active.user.username)}\n${C.lockoutConfirm}`}
          confirmLabel={C.clearLockout}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            void runAction(async () =>
              lockoutNotice(
                await clearManagerApprovalLockout(operator, active.user, {
                  ...service,
                  lockoutDeps: { invoke, ...service?.lockoutDeps },
                }),
              ),
            )
          }
        />
      ) : null}

      {active?.kind === 'reissue_confirm' ? (
        <AdminConfirmDialog
          title={C.reissueOac}
          body={`${managerIdentityLine(activeName, active.user.username)}\n${C.oacReissueConfirmValid}`}
          confirmLabel={C.reissueOac}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => setDialog({ kind: 'reissue_pin', user: active.user })}
        />
      ) : null}

      {active?.kind === 'reissue_pin' ? (
        <ManagerPinModal
          open
          title={C.reissueOac}
          description={
            <>
              <span className="block text-base font-semibold" data-testid="reissue-manager-identity">
                {managerIdentityLine(activeName, active.user.username)}
              </span>
              <span className="block" data-testid="reissue-pin-instruction">
                {enterOwnPinInstruction(activeName)}
              </span>
            </>
          }
          pinLength={4}
          isSubmitting={busy}
          onCancel={() => setDialog(null)}
          onSubmitPin={(pin) =>
            void runAction(async () =>
              reissueNotice(
                await reissueManagerOac(operator, active.user, terminalBranchId, pin, {
                  ...service,
                  provisionDeps: { invoke, ...service?.provisionDeps },
                }),
                activeName,
              ),
            )
          }
          data-testid="reissue-oac-pin-modal"
        />
      ) : null}
    </div>
  );
}
