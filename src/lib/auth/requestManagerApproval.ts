/**
 * requestManagerApproval — client adapter. Never throws. PIN is sent only
 * in the callable payload and never copied into diagnostic result fields.
 */

import type {
  ManagerApprovalErrorCode,
  RequestManagerApprovalClientRequest,
} from './managerApprovalTypes';
import { isManagerApprovalErrorCode } from './managerApprovalTypes';

export type RequestManagerApprovalTransport = (
  req: RequestManagerApprovalClientRequest,
) => Promise<unknown>;

export type RequestManagerApprovalAdapterResult =
  | { kind: 'ok'; approvalId: string; expiresAtMillis: number }
  | { kind: 'error'; code: ManagerApprovalErrorCode };

let cachedTransport: RequestManagerApprovalTransport | null = null;

export async function getDefaultRequestManagerApprovalTransport(): Promise<RequestManagerApprovalTransport> {
  if (cachedTransport) return cachedTransport;
  const [{ getFunctions, httpsCallable, connectFunctionsEmulator }, { app, USE_EMULATOR }] = await Promise.all([
    import('firebase/functions'),
    import('../firebase'),
  ]);
  if (!app) throw new Error('Firebase not configured');
  const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
  if (USE_EMULATOR) {
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }
  const callable = httpsCallable<RequestManagerApprovalClientRequest, unknown>(functions, 'requestManagerApproval');
  cachedTransport = async (req) => (await callable(req)).data;
  return cachedTransport;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapTransportFailure(): RequestManagerApprovalAdapterResult {
  return { kind: 'error', code: 'verifier_unavailable' };
}

function parseResponse(raw: unknown): RequestManagerApprovalAdapterResult {
  if (!isPlainObject(raw)) return mapTransportFailure();
  if (raw.ok === true) {
    if (typeof raw.approvalId !== 'string' || !raw.approvalId) return mapTransportFailure();
    if (typeof raw.expiresAtMillis !== 'number' || !Number.isFinite(raw.expiresAtMillis)) {
      return mapTransportFailure();
    }
    return { kind: 'ok', approvalId: raw.approvalId, expiresAtMillis: raw.expiresAtMillis };
  }
  if (raw.ok === false && isManagerApprovalErrorCode(raw.code) && raw.code !== 'offline' && raw.code !== 'verifier_unavailable') {
    return { kind: 'error', code: raw.code };
  }
  return mapTransportFailure();
}

export async function callRequestManagerApproval(
  req: RequestManagerApprovalClientRequest,
  transport?: RequestManagerApprovalTransport,
): Promise<RequestManagerApprovalAdapterResult> {
  try {
    const call = transport ?? (await getDefaultRequestManagerApprovalTransport());
    const raw = await call(req);
    return parseResponse(raw);
  } catch {
    return mapTransportFailure();
  }
}
