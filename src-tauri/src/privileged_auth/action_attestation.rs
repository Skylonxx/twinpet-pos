//! SEC-001 Packet D / D-1B — action-bound offline privileged-action attestation.
//!
//! One indivisible native operation: run the landed C-B offline PIN
//! verification pipeline and, only on `APPROVED_LOCAL`, seal a `PAA1`
//! (`PrivilegedActionAttestationFrameV1`) over fields this module derived
//! itself from D-1A trust material the WebView cannot read, forge, or reach.
//!
//! Security posture:
//! - There is **no generic signer**. This module signs exactly one frame shape,
//!   under one fixed domain separator, over fields it derived. No caller-supplied
//!   byte string ever reaches the signing key.
//! - The renderer supplies exactly four values — `action_id`, `target_order_id`,
//!   `target_order_utc7_date`, `local_intent_id` — and every one of them is
//!   independently revalidated or recomputed by the server.
//! - The PIN is in-process only: never persisted, never logged, never returned,
//!   and zeroized on the way out.
//! - A denial is never attested. `PAA1` exists only for `APPROVED_LOCAL`, so a
//!   signed denial that could be replayed or misread as authority cannot exist.

use std::path::Path;

use ed25519_dalek::Signer;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use super::device_proof;
use super::enrollment_meta;
use super::frames;
use super::offline_verifier::{
    self, base64_encode_std, PrivilegedEvidenceSeedDto, PrivilegedVerifyEvidence,
};
use super::staff_session;

/// Frozen D4 pending-execution window: trusted approval time + 72 hours.
pub const PENDING_EXECUTION_72H_MS: u64 = 259_200_000;

const MS_PER_DAY: u64 = 86_400_000;
const THAILAND_UTC_OFFSET_MS: u64 = 25_200_000;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegedActionAttestationDto {
    pub ok: bool,
    pub verified_branch_id: Option<String>,
    pub evidence_seed: Option<PrivilegedEvidenceSeedDto>,
    pub attestation_id_hex: Option<String>,
    pub paa1_base64: Option<String>,
    /// Exact SSA1 bytes — the server does not persist assertions and must
    /// re-verify them by signature, bound by `ssa1Digest`.
    pub ssa1_base64: Option<String>,
    /// Exact stored OAC envelope bytes — the preimage of `oacDigest`.
    pub oac_envelope_bytes_base64: Option<String>,
    pub trusted_approval_lower_ms: Option<u64>,
    pub trusted_approval_upper_ms: Option<u64>,
    pub pending_execution_expires_at_ms: Option<u64>,
    pub error_code: Option<String>,
}

fn denied(code: &str, verified_branch_id: Option<String>) -> PrivilegedActionAttestationDto {
    PrivilegedActionAttestationDto {
        ok: false,
        verified_branch_id,
        evidence_seed: None,
        attestation_id_hex: None,
        paa1_base64: None,
        ssa1_base64: None,
        oac_envelope_bytes_base64: None,
        trusted_approval_lower_ms: None,
        trusted_approval_upper_ms: None,
        pending_execution_expires_at_ms: None,
        error_code: Some(code.to_string()),
    }
}

// --- UTC+7 calendar arithmetic (frozen pending-execution lifetime, §6) ------

/// Howard Hinnant's `days_from_civil`, valid for the proleptic Gregorian calendar.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // March = 0
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// Inverse of `days_from_civil`.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `YYYY-MM-DD` of the UTC+7 calendar day containing `ms`.
pub fn utc7_date_string(ms: u64) -> String {
    let days = ((ms + THAILAND_UTC_OFFSET_MS) / MS_PER_DAY) as i64;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Exclusive end of the given UTC+7 calendar day, expressed in epoch ms:
/// `((daysSinceEpochUtc7(dateStr) + 1) * 86_400_000) - 25_200_000`.
pub fn utc7_day_end_ms(date: &str) -> Option<u64> {
    if !frames::is_paa1_utc7_date(date) {
        return None;
    }
    let y: i64 = date[0..4].parse().ok()?;
    let m: i64 = date[5..7].parse().ok()?;
    let d: i64 = date[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let days = days_from_civil(y, m, d);
    // Reject a non-existent calendar date (e.g. 2025-02-31) by round-tripping.
    if civil_from_days(days) != (y, m, d) {
        return None;
    }
    let end = (days + 1).checked_mul(MS_PER_DAY as i64)? - THAILAND_UTC_OFFSET_MS as i64;
    if end < 0 {
        return None;
    }
    Some(end as u64)
}

/// Frozen rule: pending privileged execution expires at the **earlier** of
/// (1) trusted approval time + 72h, and (2) the end of the target order's UTC+7 day.
pub fn pending_execution_expires_at_ms(
    trusted_approval_lower_ms: u64,
    target_order_utc7_date: &str,
) -> Option<u64> {
    let day_end = utc7_day_end_ms(target_order_utc7_date)?;
    let seventy_two_hours = trusted_approval_lower_ms.checked_add(PENDING_EXECUTION_72H_MS)?;
    Some(seventy_two_hours.min(day_end))
}

// --- The one new native operation ------------------------------------------

fn action_kind_for(action_id: &str) -> Option<u8> {
    match action_id {
        "VOID_PENDING_SALE" => Some(frames::PAA1_ACTION_KIND_VOID_PENDING_SALE),
        "VOID_SETTLED_SALE" => Some(frames::PAA1_ACTION_KIND_VOID_SETTLED_SALE),
        _ => None,
    }
}

fn manager_role_kind_for(role: &str) -> Option<u8> {
    match role {
        "manager" => Some(frames::PAA1_MANAGER_ROLE_MANAGER),
        "admin" => Some(frames::PAA1_MANAGER_ROLE_ADMIN),
        _ => None,
    }
}

fn committed_device_key_version(root: &Path) -> Option<u32> {
    let fence_bytes = std::fs::read(enrollment_meta::enrollment_fence_path(root)).ok()?;
    let fence: enrollment_meta::EnrollmentFenceState = serde_json::from_slice(&fence_bytes).ok()?;
    if fence.state != "COMMITTED" {
        return None;
    }
    Some(fence.device_key_version)
}

/// `native_attest_privileged_action` implementation.
///
/// Holds the cross-process lifecycle lock and `VERIFIER_MUTEX` for the whole
/// sequence, so offline PIN verification and PAA1 sealing are one indivisible
/// operation and the renderer can never obtain an unbound, reusable approval.
pub fn attest_privileged_action(
    root: &Path,
    manager_staff_id: &str,
    action_id: &str,
    target_order_id: &str,
    target_order_utc7_date: &str,
    local_intent_id: &str,
    pin: &str,
) -> Result<PrivilegedActionAttestationDto, String> {
    let _guards = match offline_verifier::acquire_privileged_verifier_guards(root) {
        Ok(g) => g,
        Err(_) => return Ok(denied("DENIED_UNVERIFIABLE", None)),
    };

    // 1. Canonical staff session (SSCA1): boot-session continuity, digests,
    //    SSA1/SRF1 signatures against OKS1, DEC-D-06 lifetime, DEC-D-07 bounds.
    let envelope = match staff_session::load_and_validate_canonical_staff_session(root) {
        Ok(env) => env,
        Err(_) => return Ok(denied("DENIED_STALE", None)),
    };
    let ssa1 = match frames::decode_ssa1(&envelope.ssa1_bytes) {
        Ok(f) => f,
        Err(_) => return Ok(denied("DENIED_STALE", None)),
    };

    // 2. Trusted approval-time bounds L and U (§5), from the validated envelope
    //    and the live QPC clock. Both travel in PAA1 so the server can audit the
    //    client's arithmetic rather than trust its conclusion.
    let bounds = match staff_session::compute_trusted_approval_bounds_now(&envelope) {
        Ok(b) => b,
        Err(_) => return Ok(denied("DENIED_STALE", None)),
    };

    // 3. Structural validation of the four renderer-declared values.
    if action_kind_for(action_id).is_none()
        || !frames::is_canonical_identifier(target_order_id)
        || !frames::is_canonical_identifier(local_intent_id)
        || !frames::is_paa1_utc7_date(target_order_utc7_date)
        || utc7_day_end_ms(target_order_utc7_date).is_none()
        || !frames::is_canonical_identifier(manager_staff_id)
    {
        return Ok(denied("DENIED_UNVERIFIABLE", None));
    }

    // 4. D1 self-approval bar — refused natively, before any PIN comparison.
    if manager_staff_id == ssa1.staff_id {
        return Ok(denied("DENIED_UNVERIFIABLE", None));
    }

    // 5. The landed C-B verification pipeline, unchanged, inside the same held
    //    locks. Lockout, attempt accounting, and clock semantics are its own.
    let mut evidence = PrivilegedVerifyEvidence::default();
    let outcome =
        offline_verifier::verify_offline_pin_locked(root, manager_staff_id, action_id, pin, &mut evidence)?;

    // 6. Anything other than APPROVED_LOCAL returns the C-B outcome verbatim,
    //    with no PAA1 and no attestation material.
    if !outcome.ok {
        return Ok(PrivilegedActionAttestationDto {
            ok: false,
            verified_branch_id: outcome.verified_branch_id,
            evidence_seed: outcome.evidence_seed,
            attestation_id_hex: None,
            paa1_base64: None,
            ssa1_base64: None,
            oac_envelope_bytes_base64: None,
            trusted_approval_lower_ms: None,
            trusted_approval_upper_ms: None,
            pending_execution_expires_at_ms: None,
            error_code: outcome.error_code,
        });
    }

    let (oac, oac_envelope_bytes, security_device_id, nonce_raw, approval_proof_digest_raw) = match (
        evidence.oac,
        evidence.oac_envelope_bytes,
        evidence.security_device_id,
        evidence.nonce_raw,
        evidence.approval_proof_digest_raw,
    ) {
        (Some(a), Some(b), Some(c), Some(d), Some(e)) => (a, b, c, d, e),
        _ => return Ok(denied("DENIED_UNVERIFIABLE", outcome.verified_branch_id)),
    };
    let verified_branch_id = oac.branch_id.clone();

    // 7. D7 exact-branch authority: the manager's OAC branch and the staff
    //    session branch must be the same branch.
    if oac.branch_id != ssa1.branch_id || oac.branch_id != envelope.branch_id {
        return Ok(denied("DENIED_UNVERIFIABLE", Some(verified_branch_id)));
    }
    // The session and the approval must be bound to this same physical device.
    if ssa1.security_device_id != security_device_id || envelope.security_device_id != security_device_id {
        return Ok(denied("DENIED_UNVERIFIABLE", Some(verified_branch_id)));
    }

    // 8. The signing key version must be the committed enrolled generation, and
    //    the session must have been issued against that same generation.
    let device_key_version = match committed_device_key_version(root) {
        Some(v) if v > 0 => v,
        _ => return Ok(denied("DENIED_UNVERIFIABLE", Some(verified_branch_id))),
    };
    if envelope.device_key_version != device_key_version {
        return Ok(denied("DENIED_STALE", Some(verified_branch_id)));
    }

    // 9. D8 cross-midnight bar: an offline approval may only be given on the
    //    target order's own UTC+7 day. `U` is the latest possible server now.
    if utc7_date_string(bounds.upper_ms) != target_order_utc7_date {
        return Ok(denied("DENIED_STALE", Some(verified_branch_id)));
    }

    // 10. Frozen pending-execution lifetime (§6).
    let pending_expiry = match pending_execution_expires_at_ms(bounds.lower_ms, target_order_utc7_date) {
        Some(v) if v > bounds.lower_ms => v,
        _ => return Ok(denied("DENIED_STALE", Some(verified_branch_id))),
    };

    // 11. Seal PAA1.
    let manager_role_kind = match manager_role_kind_for(&oac.manager_role) {
        Some(k) => k,
        None => return Ok(denied("MANAGER_NOT_AUTHORIZED", Some(verified_branch_id))),
    };
    let action_kind = match action_kind_for(action_id) {
        Some(k) => k,
        None => return Ok(denied("DENIED_UNVERIFIABLE", Some(verified_branch_id))),
    };

    let oac_digest: [u8; 32] = Sha256::digest(&oac_envelope_bytes).into();
    let ssa1_digest = envelope.ssa1_digest;

    let mut attestation_id = [0u8; frames::PAA1_ATTESTATION_ID_LEN];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut attestation_id);
    if attestation_id.iter().all(|b| *b == 0) {
        return Ok(denied("DENIED_UNVERIFIABLE", Some(verified_branch_id)));
    }

    let signing_key = match device_proof::load_enrolled_device_keypair(root) {
        Ok(k) => k,
        Err(_) => return Ok(denied("DENIED_UNVERIFIABLE", Some(verified_branch_id))),
    };

    let unsigned = frames::PrivilegedActionAttestationFrameV1 {
        attestation_id,
        action_kind,
        approval_result_kind: frames::PAA1_APPROVAL_RESULT_APPROVED_LOCAL,
        manager_role_kind,
        security_device_id,
        device_key_version,
        oac_schema_version: oac.schema_version,
        revocation_epoch_at_issue: oac.revocation_epoch,
        manager_auth_version_at_issue: oac.auth_version_at_issue,
        manager_credential_version_at_issue: oac.credential_version_at_issue,
        ssa1_auth_version_at_issue: ssa1.auth_version_at_issue,
        attempt_count: outcome.evidence_seed.as_ref().map(|s| s.attempt_count).unwrap_or(0),
        ssa1_expires_at_server_ms: ssa1.expires_at_server_ms,
        trusted_approval_lower_ms: bounds.lower_ms,
        trusted_approval_upper_ms: bounds.upper_ms,
        pending_execution_expires_at_ms: pending_expiry,
        nonce: nonce_raw,
        approval_proof_digest: approval_proof_digest_raw,
        oac_digest,
        ssa1_digest,
        branch_id: oac.branch_id.clone(),
        initiating_staff_id: ssa1.staff_id.clone(),
        approving_manager_staff_id: manager_staff_id.to_string(),
        oac_id: oac.oac_id.clone(),
        ssa1_id: ssa1.ssa1_id.clone(),
        target_order_id: target_order_id.to_string(),
        target_order_utc7_date: target_order_utc7_date.to_string(),
        local_intent_id: local_intent_id.to_string(),
        signature: [0u8; frames::PAA1_SIGNATURE_LEN],
    };

    let preimage = match frames::paa1_signature_preimage(&unsigned) {
        Ok(p) => p,
        Err(_) => return Ok(denied("DENIED_UNVERIFIABLE", Some(verified_branch_id))),
    };
    let signature = signing_key.sign(&preimage).to_bytes();
    let signed = frames::PrivilegedActionAttestationFrameV1 { signature, ..unsigned };
    let paa1_bytes = match frames::encode_paa1(&signed) {
        Ok(b) => b,
        Err(_) => return Ok(denied("DENIED_UNVERIFIABLE", Some(verified_branch_id))),
    };

    Ok(PrivilegedActionAttestationDto {
        ok: true,
        verified_branch_id: Some(verified_branch_id),
        evidence_seed: outcome.evidence_seed,
        attestation_id_hex: Some(attestation_id.iter().map(|b| format!("{b:02x}")).collect()),
        paa1_base64: Some(base64_encode_std(&paa1_bytes)),
        ssa1_base64: Some(base64_encode_std(&envelope.ssa1_bytes)),
        oac_envelope_bytes_base64: Some(base64_encode_std(&oac_envelope_bytes)),
        trusted_approval_lower_ms: Some(bounds.lower_ms),
        trusted_approval_upper_ms: Some(bounds.upper_ms),
        pending_execution_expires_at_ms: Some(pending_expiry),
        error_code: None,
    })
}

/// Tauri command entry point. Takes the PIN by value so it can be zeroized the
/// moment the attestation attempt finishes, on every path.
pub fn attest_privileged_action_owned(
    root: &Path,
    manager_staff_id: String,
    action_id: String,
    target_order_id: String,
    target_order_utc7_date: String,
    local_intent_id: String,
    mut pin: String,
) -> Result<PrivilegedActionAttestationDto, String> {
    let result = attest_privileged_action(
        root,
        &manager_staff_id,
        &action_id,
        &target_order_id,
        &target_order_utc7_date,
        &local_intent_id,
        &pin,
    );
    pin.zeroize();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc7_day_end_matches_the_frozen_formula() {
        // 2025-11-14 UTC+7 ends at 2025-11-14T17:00:00Z.
        let end = utc7_day_end_ms("2025-11-14").unwrap();
        let days = days_from_civil(2025, 11, 14) as u64;
        assert_eq!(end, (days + 1) * MS_PER_DAY - THAILAND_UTC_OFFSET_MS);
        // Round-trips: one ms before the end is still that UTC+7 day; the end is not.
        assert_eq!(utc7_date_string(end - 1), "2025-11-14");
        assert_eq!(utc7_date_string(end), "2025-11-15");
    }

    #[test]
    fn utc7_helpers_reject_malformed_and_impossible_dates() {
        assert!(utc7_day_end_ms("2025-11-4").is_none());
        assert!(utc7_day_end_ms("20251114").is_none());
        assert!(utc7_day_end_ms("2025-13-01").is_none());
        assert!(utc7_day_end_ms("2025-02-31").is_none());
        assert!(utc7_day_end_ms("").is_none());
        assert!(utc7_day_end_ms("2024-02-29").is_some());
        assert!(utc7_day_end_ms("2025-02-29").is_none());
    }

    #[test]
    fn civil_day_conversions_round_trip() {
        for (y, m, d) in [(1970, 1, 1), (2000, 2, 29), (2025, 12, 31), (2038, 1, 19)] {
            assert_eq!(civil_from_days(days_from_civil(y, m, d)), (y, m, d));
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0);
    }

    #[test]
    fn pending_lifetime_takes_the_earlier_of_72h_and_the_utc7_day_end() {
        let day_end = utc7_day_end_ms("2025-11-14").unwrap();
        // Approved early in the day: the day boundary binds.
        let early = day_end - 20 * 60 * 60 * 1000;
        assert_eq!(pending_execution_expires_at_ms(early, "2025-11-14"), Some(day_end));
        // Counterfactual with the day boundary far away: the 72h term binds.
        let l = day_end - PENDING_EXECUTION_72H_MS - 1;
        assert_eq!(
            pending_execution_expires_at_ms(l, "2025-11-14"),
            Some(l + PENDING_EXECUTION_72H_MS)
        );
        assert!(pending_execution_expires_at_ms(1, "not-a-date").is_none());
    }

    #[test]
    fn action_and_role_kind_maps_are_closed() {
        assert_eq!(action_kind_for("VOID_PENDING_SALE"), Some(frames::PAA1_ACTION_KIND_VOID_PENDING_SALE));
        assert_eq!(action_kind_for("VOID_SETTLED_SALE"), Some(frames::PAA1_ACTION_KIND_VOID_SETTLED_SALE));
        assert_eq!(action_kind_for("EXCHANGE"), None);
        assert_eq!(action_kind_for(""), None);
        assert_eq!(manager_role_kind_for("manager"), Some(frames::PAA1_MANAGER_ROLE_MANAGER));
        assert_eq!(manager_role_kind_for("admin"), Some(frames::PAA1_MANAGER_ROLE_ADMIN));
        assert_eq!(manager_role_kind_for("staff"), None);
    }

    #[test]
    fn a_device_with_no_enrolled_session_never_produces_an_attestation() {
        let dir = std::env::temp_dir().join(format!(
            "twinpet-attest-empty-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let dto = attest_privileged_action(
            &dir,
            "manager-1",
            "VOID_SETTLED_SALE",
            "order-1",
            "2025-11-14",
            "intent-1",
            "123456",
        )
        .unwrap();
        assert!(!dto.ok);
        assert!(dto.paa1_base64.is_none());
        assert!(dto.attestation_id_hex.is_none());
        assert_eq!(dto.error_code.as_deref(), Some("DENIED_STALE"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_denied_outcome_is_never_attested() {
        // Structural refusal paths return no PAA1 material at all.
        let dto = denied("DENIED_INVALID_PIN", Some("LDP-001".to_string()));
        assert!(!dto.ok);
        assert!(dto.paa1_base64.is_none());
        assert!(dto.ssa1_base64.is_none());
        assert!(dto.oac_envelope_bytes_base64.is_none());
        assert!(dto.pending_execution_expires_at_ms.is_none());
    }
}
