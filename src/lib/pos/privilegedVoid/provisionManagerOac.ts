/**
 * provisionManagerOac — just-in-time manager OAC provisioning for the
 * privileged void flow (Tech Lead decisions D-V6/D-V7,
 * TPOS-USABLE-POS-VOID-OAC-DECISION-IMPLEMENT-CLAUDE-002).
 *
 * Runs the EXISTING C-A ceremony, unchanged, for exactly one selected
 * manager/admin:
 *   1. `beginPrivilegedOacIssuanceSession`            (secondary manager principal)
 *   2. native `native_complete_oac_provisioning` produce_proof (primary native bridge)
 *   3. `completePrivilegedOacIssuanceSession`         (secondary manager principal)
 *   4. `getOacKeysetManifest`                         (secondary manager principal)
 *   5. native `native_complete_oac_provisioning` persist_result (primary native bridge)
 *
 * One-shot rules:
 *   - one begin per call, one complete per begin, never replayed;
 *   - a complete whose outcome is unknown (transport failure) is `uncertain`
 *     and is NEVER retried automatically — the server may already have
 *     consumed the session;
 *   - a definite rejection is returned as a closed outcome, never retried;
 *   - a module-level single-flight guard refuses a concurrent ceremony
 *     without any network call.
 *
 * Never logs or returns the PIN, tokens, OAC bytes, or server/native strings.
 * Offline => `offline` with zero network calls.
 */

import { withManagerApprovalPrincipal, type ManagerPrincipal, type SecondaryFirebaseFactory } from '../../auth/managerApprovalPrincipal';

export type NativeInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export type ProvisionManagerOacOutcome =
  | { kind: 'provisioned' }
  /** No connectivity: nothing was attempted. */
  | { kind: 'offline' }
  /** The selected manager's PIN was refused (verifyPinLogin or completion). */
  | { kind: 'pin_rejected' }
  /** The manager is not an eligible approver / credential not eligible / principal is not that manager. */
  | { kind: 'not_eligible' }
  /** Device registration / tuple / keyset problem — this terminal cannot hold an OAC right now. */
  | { kind: 'device_not_ready' }
  /** A definite, pre-commit failure (session expired, signing key unavailable, busy, ...). */
  | { kind: 'failed' }
  /** Completion outcome unknown, or issued but not persisted. Never auto-replayed. */
  | { kind: 'uncertain' };

export interface ProvisionManagerOacInput {
  managerStaffId: string;
  branchId: string;
  pin: string;
}

export interface ProvisionManagerOacDeps {
  invoke?: NativeInvoke | null;
  isOnline?: () => boolean;
  principalFactory?: SecondaryFirebaseFactory;
}

const SECURITY_DEVICE_ID_RE = /^[0-9a-f]{32}$/;

let ceremonyInFlight = false;

/** Test-only: reset the module single-flight guard. */
export function __resetProvisionManagerOacForTests(): void {
  ceremonyInFlight = false;
}

function defaultIsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function defaultInvoke(): NativeInvoke | null {
  const g = globalThis as unknown as Record<string, unknown>;
  const key = ['_', '_', 'T', 'A', 'U', 'R', 'I', '_', '_'].join('');
  const win = g.window as Record<string, unknown> | undefined;
  const bridge = (g[key] ?? win?.[key]) as { core?: { invoke?: unknown } } | undefined;
  const invoke = bridge?.core?.invoke;
  return typeof invoke === 'function' ? (invoke as NativeInvoke) : null;
}

function mapBeginFailure(code: unknown): ProvisionManagerOacOutcome {
  if (code === 'not_authorized') return { kind: 'not_eligible' };
  if (code === 'device_not_registered' || code === 'device_not_active' || code === 'device_branch_mismatch') {
    return { kind: 'device_not_ready' };
  }
  return { kind: 'failed' };
}

function mapCompleteFailure(code: unknown): ProvisionManagerOacOutcome {
  switch (code) {
    case 'invalid_pin':
      return { kind: 'pin_rejected' };
    case 'not_authorized':
    case 'oac_provision_forbidden_legacy_pin4':
    case 'session_wrong_owner':
      return { kind: 'not_eligible' };
    case 'device_not_registered':
    case 'device_not_active':
    case 'device_branch_mismatch':
    case 'tuple_device_key_mismatch':
    case 'tuple_device_mismatch':
    case 'ptp1_bad_self_signature':
    case 'pin1_bad_self_signature':
      return { kind: 'device_not_ready' };
    default:
      // session_not_found / session_already_consumed / session_expired /
      // tuple_* / decode / signing_key_unavailable / unknown: a definite
      // refusal; the session is not reused and nothing is retried.
      return { kind: 'failed' };
  }
}

/** UTF-8 decode of the server's exact canonical OAC bytes. Never re-serialized. */
function decodeOacEnvelopeJson(oacEnvelopeBytesBase64: string): string | null {
  try {
    const binary = atob(oacEnvelopeBytesBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function envelopeBoundTo(
  json: string,
  expected: { managerStaffId: string; branchId: string; securityDeviceIdHex: string },
): boolean {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return (
      parsed.managerStaffId === expected.managerStaffId &&
      parsed.branchId === expected.branchId &&
      typeof parsed.deviceId === 'string' &&
      parsed.deviceId.toLowerCase() === expected.securityDeviceIdHex
    );
  } catch {
    return false;
  }
}

async function runCeremony(
  principal: ManagerPrincipal,
  invoke: NativeInvoke,
  input: ProvisionManagerOacInput,
  securityDeviceIdHex: string,
): Promise<ProvisionManagerOacOutcome> {
  // 1. begin — exactly once. A transport failure here is definite for us: no
  //    capability can have been issued; an orphaned PENDING session simply expires.
  let begin: { ok?: unknown; code?: unknown; sessionId?: unknown; nonceBase64?: unknown };
  try {
    begin = await principal.call('beginPrivilegedOacIssuanceSession', { securityDeviceIdHex });
  } catch {
    return { kind: 'failed' };
  }
  if (begin?.ok !== true || typeof begin.sessionId !== 'string' || typeof begin.nonceBase64 !== 'string') {
    return begin?.ok === false ? mapBeginFailure(begin.code) : { kind: 'failed' };
  }

  // 2. native proof — PIN used in-process once by native, never persisted.
  let proof: { ptp1Base64?: unknown; pin1Base64?: unknown };
  try {
    proof = (await invoke('native_complete_oac_provisioning', {
      phase: 'produce_proof',
      pin: input.pin,
      sessionId: begin.sessionId,
      securityDeviceIdHex,
      managerStaffId: input.managerStaffId,
      nonceBase64: begin.nonceBase64,
    })) as { ptp1Base64?: unknown; pin1Base64?: unknown };
  } catch {
    return { kind: 'device_not_ready' };
  }
  if (typeof proof?.ptp1Base64 !== 'string' || typeof proof?.pin1Base64 !== 'string') {
    return { kind: 'device_not_ready' };
  }

  // 3. complete — exactly once per begin. Unknown outcome => uncertain, no replay.
  let complete: { ok?: unknown; code?: unknown; oacEnvelopeBytesBase64?: unknown };
  try {
    complete = await principal.call('completePrivilegedOacIssuanceSession', {
      sessionId: begin.sessionId,
      pin: input.pin,
      ptp1Base64: proof.ptp1Base64,
      pin1Base64: proof.pin1Base64,
    });
  } catch {
    return { kind: 'uncertain' };
  }
  if (complete?.ok !== true) {
    return complete?.ok === false ? mapCompleteFailure(complete.code) : { kind: 'uncertain' };
  }
  if (typeof complete.oacEnvelopeBytesBase64 !== 'string') return { kind: 'uncertain' };
  const envelopeJson = decodeOacEnvelopeJson(complete.oacEnvelopeBytesBase64);
  if (
    envelopeJson == null ||
    !envelopeBoundTo(envelopeJson, {
      managerStaffId: input.managerStaffId,
      branchId: input.branchId,
      securityDeviceIdHex,
    })
  ) {
    // Issued (session consumed) but not for this manager/branch/device: never persisted.
    return { kind: 'uncertain' };
  }

  // 4. keyset manifest for native verification of the OAC signature.
  let manifest: { ok?: unknown; oks1Base64?: unknown };
  try {
    manifest = await principal.call('getOacKeysetManifest', {});
  } catch {
    return { kind: 'uncertain' };
  }
  if (manifest?.ok !== true || typeof manifest.oks1Base64 !== 'string') return { kind: 'uncertain' };

  // 5. native persist — writes ONLY the selected manager's slot (native re-checks the binding).
  try {
    await invoke('native_complete_oac_provisioning', {
      phase: 'persist_result',
      oacEnvelopeJson: envelopeJson,
      oks1Base64: manifest.oks1Base64,
      managerStaffId: input.managerStaffId,
    });
  } catch (err) {
    const message = typeof err === 'string' ? err : err instanceof Error ? err.message : '';
    if (message.includes('PROVISIONING_MANIFEST_MISMATCH')) return { kind: 'device_not_ready' };
    return { kind: 'uncertain' };
  }
  return { kind: 'provisioned' };
}

export async function provisionManagerOac(
  input: ProvisionManagerOacInput,
  deps: ProvisionManagerOacDeps = {},
): Promise<ProvisionManagerOacOutcome> {
  const isOnline = deps.isOnline ?? defaultIsOnline;
  if (!isOnline()) return { kind: 'offline' };
  if (!input.managerStaffId || !input.branchId || input.branchId === 'ALL' || !input.pin) {
    return { kind: 'failed' };
  }
  const invoke = deps.invoke === undefined ? defaultInvoke() : deps.invoke;
  if (!invoke) return { kind: 'device_not_ready' };

  if (ceremonyInFlight) return { kind: 'failed' };
  ceremonyInFlight = true;
  try {
    let securityDeviceIdHex: string;
    try {
      const status = (await invoke('native_get_device_registration_status')) as {
        securityDeviceIdHex?: unknown;
      } | null;
      const hex = typeof status?.securityDeviceIdHex === 'string' ? status.securityDeviceIdHex.toLowerCase() : '';
      if (!SECURITY_DEVICE_ID_RE.test(hex)) return { kind: 'device_not_ready' };
      securityDeviceIdHex = hex;
    } catch {
      return { kind: 'device_not_ready' };
    }

    let result: Awaited<ReturnType<typeof withManagerApprovalPrincipal<ProvisionManagerOacOutcome>>>;
    try {
      result = await withManagerApprovalPrincipal(
        { managerStaffId: input.managerStaffId, pin: input.pin, branchId: input.branchId },
        (principal) => runCeremony(principal, invoke, input, securityDeviceIdHex),
        deps.principalFactory,
      );
    } catch {
      // `runCeremony` never throws by construction; anything here is unknown.
      return { kind: 'uncertain' };
    }
    if (result.ok) return result.value;
    switch (result.code) {
      case 'pin_rejected':
        return { kind: 'pin_rejected' };
      case 'identity_mismatch':
        return { kind: 'not_eligible' };
      default:
        return { kind: 'failed' };
    }
  } finally {
    ceremonyInFlight = false;
  }
}
