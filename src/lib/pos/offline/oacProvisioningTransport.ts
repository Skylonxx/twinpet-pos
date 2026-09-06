/**
 * oacProvisioningTransport — SEC-001 Packet D-1A
 *
 * Preserves exact raw byte identity of the signed OAC envelope across the
 * client transport boundary.
 *
 * Mandatory rule (Prompt Section 12):
 * "Functions issuance must return exact opaque oacEnvelopeBytesBase64 representing
 *  UTF8(canonicalJSON(signedEnvelopeV1)). The exact raw bytes are the authority bytes.
 *  Do NOT recreate identity bytes with ordinary JSON.stringify.
 *  Client passes Base64 opaque."
 */

export interface OacProvisioningPayload {
  oacEnvelopeBytesBase64: string;
  srf1OacBase64: string;
  oacId: string;
  branchId: string;
  deviceId: string;
}

export type OacProvisioningValidationResult =
  | { ok: true; payload: OacProvisioningPayload }
  | { ok: false; code: 'missing_payload' | 'invalid_base64' | 'malformed_oac' };

export function parseOacEnvelopeBytes(oacEnvelopeBytesBase64: string): {
  oacId: string;
  branchId: string;
  deviceId: string;
} {
  const jsonStr = atob(oacEnvelopeBytesBase64);
  const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  if (
    typeof parsed.oacId !== 'string' ||
    typeof parsed.branchId !== 'string' ||
    typeof parsed.deviceId !== 'string'
  ) {
    throw new Error('malformed_oac');
  }
  return {
    oacId: parsed.oacId,
    branchId: parsed.branchId,
    deviceId: parsed.deviceId,
  };
}

export function validateOacProvisioningTransport(
  oacEnvelopeBytesBase64: unknown,
  srf1OacBase64: unknown,
): OacProvisioningValidationResult {
  if (
    typeof oacEnvelopeBytesBase64 !== 'string' ||
    typeof srf1OacBase64 !== 'string' ||
    !oacEnvelopeBytesBase64 ||
    !srf1OacBase64
  ) {
    return { ok: false, code: 'missing_payload' };
  }

  try {
    const { oacId, branchId, deviceId } = parseOacEnvelopeBytes(oacEnvelopeBytesBase64);
    return {
      ok: true,
      payload: {
        oacEnvelopeBytesBase64,
        srf1OacBase64,
        oacId,
        branchId,
        deviceId,
      },
    };
  } catch {
    return { ok: false, code: 'malformed_oac' };
  }
}
