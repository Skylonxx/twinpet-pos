//! SEC-001 Packet C-A binary frame contracts (pure, no signing/verification).
//!
//! Exact frozen wire contract for `DeviceRegistrationPossessionFrameV1` (DRP1)
//! per `docs/agent-workflow/CURRENT_PACKET.md` — 185 bytes, little-endian, no
//! padding, no trailing bytes. TS counterpart: `functions/src/oacFrame.ts`
//! (byte-for-byte parity, proven by identical literal test vectors in both
//! suites — see the `drp1_canonical_vector_matches_ts_parity_anchor` test).

pub const DRP1_MAGIC: &[u8; 4] = b"DRP1";
pub const DRP1_VERSION: u8 = 1;
pub const DRP1_ENROLLMENT_AUTH_ID_LEN: usize = 32;
pub const DRP1_NONCE_LEN: usize = 32;
pub const DRP1_SECURITY_DEVICE_ID_LEN: usize = 16;
pub const DRP1_DEV_PROOF_PUBLIC_KEY_LEN: usize = 32;
pub const DRP1_SIGNATURE_LEN: usize = 64;
pub const DRP1_SIGNED_LEN: usize = 121;
pub const DRP1_TOTAL_BYTES: usize = 185;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRegistrationPossessionFrameV1 {
    pub enrollment_auth_id: String,
    pub device_registration_nonce: [u8; DRP1_NONCE_LEN],
    pub security_device_id: [u8; DRP1_SECURITY_DEVICE_ID_LEN],
    pub dev_proof_public_key: [u8; DRP1_DEV_PROOF_PUBLIC_KEY_LEN],
    pub signature: [u8; DRP1_SIGNATURE_LEN],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameDecodeError {
    WrongTotalLength,
    BadMagic,
    BadVersion,
    BadFieldLength,
    BadFieldFormat,
}

fn is_lowercase_hex32(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `[0,121)` — the exact bytes DRP1's signature is computed over.
pub fn drp1_signed_prefix(frame: &DeviceRegistrationPossessionFrameV1) -> [u8; DRP1_SIGNED_LEN] {
    let mut buf = [0u8; DRP1_SIGNED_LEN];
    let mut o = 0usize;
    buf[o..o + 4].copy_from_slice(DRP1_MAGIC);
    o += 4;
    buf[o] = DRP1_VERSION;
    o += 1;
    buf[o] = DRP1_ENROLLMENT_AUTH_ID_LEN as u8;
    o += 1;
    buf[o..o + DRP1_ENROLLMENT_AUTH_ID_LEN].copy_from_slice(frame.enrollment_auth_id.as_bytes());
    o += DRP1_ENROLLMENT_AUTH_ID_LEN;
    buf[o] = DRP1_NONCE_LEN as u8;
    o += 1;
    buf[o..o + DRP1_NONCE_LEN].copy_from_slice(&frame.device_registration_nonce);
    o += DRP1_NONCE_LEN;
    buf[o] = DRP1_SECURITY_DEVICE_ID_LEN as u8;
    o += 1;
    buf[o..o + DRP1_SECURITY_DEVICE_ID_LEN].copy_from_slice(&frame.security_device_id);
    o += DRP1_SECURITY_DEVICE_ID_LEN;
    buf[o] = DRP1_DEV_PROOF_PUBLIC_KEY_LEN as u8;
    o += 1;
    buf[o..o + DRP1_DEV_PROOF_PUBLIC_KEY_LEN].copy_from_slice(&frame.dev_proof_public_key);
    o += DRP1_DEV_PROOF_PUBLIC_KEY_LEN;
    debug_assert_eq!(o, DRP1_SIGNED_LEN);
    buf
}

pub fn encode_drp1(frame: &DeviceRegistrationPossessionFrameV1) -> [u8; DRP1_TOTAL_BYTES] {
    let prefix = drp1_signed_prefix(frame);
    let mut out = [0u8; DRP1_TOTAL_BYTES];
    out[..DRP1_SIGNED_LEN].copy_from_slice(&prefix);
    out[DRP1_SIGNED_LEN..].copy_from_slice(&frame.signature);
    out
}

pub fn decode_drp1(bytes: &[u8]) -> Result<DeviceRegistrationPossessionFrameV1, FrameDecodeError> {
    if bytes.len() != DRP1_TOTAL_BYTES {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    if &bytes[0..4] != DRP1_MAGIC {
        return Err(FrameDecodeError::BadMagic);
    }
    if bytes[4] != DRP1_VERSION {
        return Err(FrameDecodeError::BadVersion);
    }
    if bytes[5] != DRP1_ENROLLMENT_AUTH_ID_LEN as u8 {
        return Err(FrameDecodeError::BadFieldLength);
    }
    let enrollment_auth_id = std::str::from_utf8(&bytes[6..38])
        .map_err(|_| FrameDecodeError::BadFieldFormat)?
        .to_string();
    if !is_lowercase_hex32(&enrollment_auth_id) {
        return Err(FrameDecodeError::BadFieldFormat);
    }
    if bytes[38] != DRP1_NONCE_LEN as u8 {
        return Err(FrameDecodeError::BadFieldLength);
    }
    let mut device_registration_nonce = [0u8; DRP1_NONCE_LEN];
    device_registration_nonce.copy_from_slice(&bytes[39..71]);
    if bytes[71] != DRP1_SECURITY_DEVICE_ID_LEN as u8 {
        return Err(FrameDecodeError::BadFieldLength);
    }
    let mut security_device_id = [0u8; DRP1_SECURITY_DEVICE_ID_LEN];
    security_device_id.copy_from_slice(&bytes[72..88]);
    if bytes[88] != DRP1_DEV_PROOF_PUBLIC_KEY_LEN as u8 {
        return Err(FrameDecodeError::BadFieldLength);
    }
    let mut dev_proof_public_key = [0u8; DRP1_DEV_PROOF_PUBLIC_KEY_LEN];
    dev_proof_public_key.copy_from_slice(&bytes[89..121]);
    let mut signature = [0u8; DRP1_SIGNATURE_LEN];
    signature.copy_from_slice(&bytes[121..185]);
    Ok(DeviceRegistrationPossessionFrameV1 {
        enrollment_auth_id,
        device_registration_nonce,
        security_device_id,
        dev_proof_public_key,
        signature,
    })
}

// --- ProvisioningTupleProofFrameV1 ("PTP1") --------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvisioningTupleProofFrameV1 {
    pub security_device_id: [u8; DRP1_SECURITY_DEVICE_ID_LEN],
    pub oac_issuance_session_id: String,
    pub manager_staff_id: String,
    pub nonce: [u8; 32],
    pub dev_proof_public_key: [u8; DRP1_DEV_PROOF_PUBLIC_KEY_LEN],
    pub signature: [u8; DRP1_SIGNATURE_LEN],
}

const PTP1_MAGIC: &[u8; 4] = b"PTP1";
const PTP1_VERSION: u8 = 1;
const PTP1_NONCE_LEN: usize = 32;

fn write_len_prefixed_str(out: &mut Vec<u8>, value: &str) -> Result<(), FrameDecodeError> {
    let bytes = value.as_bytes();
    if bytes.len() > 255 {
        return Err(FrameDecodeError::BadFieldLength);
    }
    out.push(bytes.len() as u8);
    out.extend_from_slice(bytes);
    Ok(())
}

fn read_len_prefixed_str(bytes: &[u8], offset: usize) -> Result<(String, usize), FrameDecodeError> {
    if offset >= bytes.len() {
        return Err(FrameDecodeError::BadFieldLength);
    }
    let len = bytes[offset] as usize;
    let start = offset + 1;
    let end = start + len;
    if end > bytes.len() {
        return Err(FrameDecodeError::BadFieldLength);
    }
    let value = std::str::from_utf8(&bytes[start..end])
        .map_err(|_| FrameDecodeError::BadFieldFormat)?
        .to_string();
    Ok((value, end))
}

fn write_len_prefixed_bytes(out: &mut Vec<u8>, value: &[u8]) -> Result<(), FrameDecodeError> {
    if value.len() > 255 {
        return Err(FrameDecodeError::BadFieldLength);
    }
    out.push(value.len() as u8);
    out.extend_from_slice(value);
    Ok(())
}

fn read_len_prefixed_bytes(bytes: &[u8], offset: usize) -> Result<(Vec<u8>, usize), FrameDecodeError> {
    if offset >= bytes.len() {
        return Err(FrameDecodeError::BadFieldLength);
    }
    let len = bytes[offset] as usize;
    let start = offset + 1;
    let end = start + len;
    if end > bytes.len() {
        return Err(FrameDecodeError::BadFieldLength);
    }
    Ok((bytes[start..end].to_vec(), end))
}

pub fn ptp1_signed_prefix(frame: &ProvisioningTupleProofFrameV1) -> Result<Vec<u8>, FrameDecodeError> {
    let mut out = Vec::with_capacity(4 + 1 + 16 + 1 + 1 + 32 + 32);
    out.extend_from_slice(PTP1_MAGIC);
    out.push(PTP1_VERSION);
    out.extend_from_slice(&frame.security_device_id);
    write_len_prefixed_str(&mut out, &frame.oac_issuance_session_id)?;
    write_len_prefixed_str(&mut out, &frame.manager_staff_id)?;
    out.extend_from_slice(&frame.nonce);
    out.extend_from_slice(&frame.dev_proof_public_key);
    Ok(out)
}

pub fn encode_ptp1(frame: &ProvisioningTupleProofFrameV1) -> Result<Vec<u8>, FrameDecodeError> {
    let mut out = ptp1_signed_prefix(frame)?;
    out.extend_from_slice(&frame.signature);
    Ok(out)
}

pub fn decode_ptp1(bytes: &[u8]) -> Result<ProvisioningTupleProofFrameV1, FrameDecodeError> {
    if bytes.len() < 4 + 1 + 16 + 1 + 1 + 32 + 32 + 64 {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    if &bytes[0..4] != PTP1_MAGIC {
        return Err(FrameDecodeError::BadMagic);
    }
    if bytes[4] != PTP1_VERSION {
        return Err(FrameDecodeError::BadVersion);
    }
    let mut o = 5usize;
    let mut security_device_id = [0u8; DRP1_SECURITY_DEVICE_ID_LEN];
    security_device_id.copy_from_slice(&bytes[o..o + DRP1_SECURITY_DEVICE_ID_LEN]);
    o += DRP1_SECURITY_DEVICE_ID_LEN;
    let (oac_issuance_session_id, next) = read_len_prefixed_str(bytes, o)?;
    o = next;
    let (manager_staff_id, next) = read_len_prefixed_str(bytes, o)?;
    o = next;
    if o + PTP1_NONCE_LEN + DRP1_DEV_PROOF_PUBLIC_KEY_LEN + DRP1_SIGNATURE_LEN != bytes.len() {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    let mut nonce = [0u8; PTP1_NONCE_LEN];
    nonce.copy_from_slice(&bytes[o..o + PTP1_NONCE_LEN]);
    o += PTP1_NONCE_LEN;
    let mut dev_proof_public_key = [0u8; DRP1_DEV_PROOF_PUBLIC_KEY_LEN];
    dev_proof_public_key.copy_from_slice(&bytes[o..o + DRP1_DEV_PROOF_PUBLIC_KEY_LEN]);
    o += DRP1_DEV_PROOF_PUBLIC_KEY_LEN;
    let mut signature = [0u8; DRP1_SIGNATURE_LEN];
    signature.copy_from_slice(&bytes[o..o + DRP1_SIGNATURE_LEN]);
    if oac_issuance_session_id.is_empty() || manager_staff_id.is_empty() {
        return Err(FrameDecodeError::BadFieldFormat);
    }
    Ok(ProvisioningTupleProofFrameV1 {
        security_device_id,
        oac_issuance_session_id,
        manager_staff_id,
        nonce,
        dev_proof_public_key,
        signature,
    })
}

// --- PinBindingFrameV1 ("PIN1") --------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinBindingFrameV1 {
    pub security_device_id: [u8; DRP1_SECURITY_DEVICE_ID_LEN],
    pub oac_issuance_session_id: String,
    pub manager_staff_id: String,
    pub verifier_algo: String,
    pub m: u32,
    pub t: u32,
    pub p: u32,
    pub verifier_salt: Vec<u8>,
    pub verifier: Vec<u8>,
    pub pepper_commitment: Vec<u8>,
    pub dev_proof_public_key: [u8; DRP1_DEV_PROOF_PUBLIC_KEY_LEN],
    pub signature: [u8; DRP1_SIGNATURE_LEN],
}

const PIN1_MAGIC: &[u8; 4] = b"PIN1";
const PIN1_VERSION: u8 = 1;

pub fn pin1_signed_prefix(frame: &PinBindingFrameV1) -> Result<Vec<u8>, FrameDecodeError> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(PIN1_MAGIC);
    out.push(PIN1_VERSION);
    out.extend_from_slice(&frame.security_device_id);
    write_len_prefixed_str(&mut out, &frame.oac_issuance_session_id)?;
    write_len_prefixed_str(&mut out, &frame.manager_staff_id)?;
    write_len_prefixed_str(&mut out, &frame.verifier_algo)?;
    out.extend_from_slice(&frame.m.to_le_bytes());
    out.extend_from_slice(&frame.t.to_le_bytes());
    out.extend_from_slice(&frame.p.to_le_bytes());
    write_len_prefixed_bytes(&mut out, &frame.verifier_salt)?;
    write_len_prefixed_bytes(&mut out, &frame.verifier)?;
    write_len_prefixed_bytes(&mut out, &frame.pepper_commitment)?;
    out.extend_from_slice(&frame.dev_proof_public_key);
    Ok(out)
}

pub fn encode_pin1(frame: &PinBindingFrameV1) -> Result<Vec<u8>, FrameDecodeError> {
    let mut out = pin1_signed_prefix(frame)?;
    out.extend_from_slice(&frame.signature);
    Ok(out)
}

pub fn decode_pin1(bytes: &[u8]) -> Result<PinBindingFrameV1, FrameDecodeError> {
    if bytes.len() < 4 + 1 + DRP1_SECURITY_DEVICE_ID_LEN {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    if &bytes[0..4] != PIN1_MAGIC {
        return Err(FrameDecodeError::BadMagic);
    }
    if bytes[4] != PIN1_VERSION {
        return Err(FrameDecodeError::BadVersion);
    }
    let mut o = 5usize;
    let mut security_device_id = [0u8; DRP1_SECURITY_DEVICE_ID_LEN];
    security_device_id.copy_from_slice(&bytes[o..o + DRP1_SECURITY_DEVICE_ID_LEN]);
    o += DRP1_SECURITY_DEVICE_ID_LEN;
    let (oac_issuance_session_id, next) = read_len_prefixed_str(bytes, o)?;
    o = next;
    let (manager_staff_id, next) = read_len_prefixed_str(bytes, o)?;
    o = next;
    let (verifier_algo, next) = read_len_prefixed_str(bytes, o)?;
    o = next;
    if o + 12 > bytes.len() {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    let m = u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    o += 4;
    let t = u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    o += 4;
    let p = u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    o += 4;
    let (verifier_salt, next) = read_len_prefixed_bytes(bytes, o)?;
    o = next;
    let (verifier, next) = read_len_prefixed_bytes(bytes, o)?;
    o = next;
    let (pepper_commitment, next) = read_len_prefixed_bytes(bytes, o)?;
    o = next;
    if o + DRP1_DEV_PROOF_PUBLIC_KEY_LEN + DRP1_SIGNATURE_LEN != bytes.len() {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    let mut dev_proof_public_key = [0u8; DRP1_DEV_PROOF_PUBLIC_KEY_LEN];
    dev_proof_public_key.copy_from_slice(&bytes[o..o + DRP1_DEV_PROOF_PUBLIC_KEY_LEN]);
    o += DRP1_DEV_PROOF_PUBLIC_KEY_LEN;
    let mut signature = [0u8; DRP1_SIGNATURE_LEN];
    signature.copy_from_slice(&bytes[o..o + DRP1_SIGNATURE_LEN]);
    if oac_issuance_session_id.is_empty() || manager_staff_id.is_empty() || verifier_algo.is_empty() {
        return Err(FrameDecodeError::BadFieldFormat);
    }
    Ok(PinBindingFrameV1 {
        security_device_id,
        oac_issuance_session_id,
        manager_staff_id,
        verifier_algo,
        m,
        t,
        p,
        verifier_salt,
        verifier,
        pepper_commitment,
        dev_proof_public_key,
        signature,
    })
}

// --- EnrollmentProofFrameV1 ("ENR1") ---------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnrollmentProofFrameV1 {
    pub enrollment_auth_id: String,
    pub branch_id: String,
    pub issued_at_server_ms: u64,
    pub expires_at_server_ms: u64,
    pub issuer_id: String,
    pub signature: [u8; DRP1_SIGNATURE_LEN],
}

const ENR1_MAGIC: &[u8; 4] = b"ENR1";
const ENR1_VERSION: u8 = 1;

pub fn enr1_signed_prefix(frame: &EnrollmentProofFrameV1) -> Result<Vec<u8>, FrameDecodeError> {
    if !is_lowercase_hex32(&frame.enrollment_auth_id) {
        return Err(FrameDecodeError::BadFieldFormat);
    }
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(ENR1_MAGIC);
    out.push(ENR1_VERSION);
    out.extend_from_slice(frame.enrollment_auth_id.as_bytes());
    write_len_prefixed_str(&mut out, &frame.branch_id)?;
    out.extend_from_slice(&frame.issued_at_server_ms.to_le_bytes());
    out.extend_from_slice(&frame.expires_at_server_ms.to_le_bytes());
    write_len_prefixed_str(&mut out, &frame.issuer_id)?;
    Ok(out)
}

pub fn encode_enr1(frame: &EnrollmentProofFrameV1) -> Result<Vec<u8>, FrameDecodeError> {
    let mut out = enr1_signed_prefix(frame)?;
    out.extend_from_slice(&frame.signature);
    Ok(out)
}

pub fn decode_enr1(bytes: &[u8]) -> Result<EnrollmentProofFrameV1, FrameDecodeError> {
    if bytes.len() < 4 + 1 + DRP1_ENROLLMENT_AUTH_ID_LEN {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    if &bytes[0..4] != ENR1_MAGIC {
        return Err(FrameDecodeError::BadMagic);
    }
    if bytes[4] != ENR1_VERSION {
        return Err(FrameDecodeError::BadVersion);
    }
    let enrollment_auth_id = std::str::from_utf8(&bytes[5..37])
        .map_err(|_| FrameDecodeError::BadFieldFormat)?
        .to_string();
    if !is_lowercase_hex32(&enrollment_auth_id) {
        return Err(FrameDecodeError::BadFieldFormat);
    }
    let mut o = 37usize;
    let (branch_id, next) = read_len_prefixed_str(bytes, o)?;
    o = next;
    if o + 16 > bytes.len() {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    let issued_at_server_ms = u64::from_le_bytes(bytes[o..o + 8].try_into().unwrap());
    o += 8;
    let expires_at_server_ms = u64::from_le_bytes(bytes[o..o + 8].try_into().unwrap());
    o += 8;
    let (issuer_id, next) = read_len_prefixed_str(bytes, o)?;
    o = next;
    if o + DRP1_SIGNATURE_LEN != bytes.len() {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    let mut signature = [0u8; DRP1_SIGNATURE_LEN];
    signature.copy_from_slice(&bytes[o..o + DRP1_SIGNATURE_LEN]);
    if branch_id.is_empty() || issuer_id.is_empty() {
        return Err(FrameDecodeError::BadFieldFormat);
    }
    Ok(EnrollmentProofFrameV1 {
        enrollment_auth_id,
        branch_id,
        issued_at_server_ms,
        expires_at_server_ms,
        issuer_id,
        signature,
    })
}

// --- OKS1 (OacKeysetManifestFrameV1) ---------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OacKeysetManifestKeyV1 {
    pub signing_key_id: String,
    pub public_key: [u8; DRP1_DEV_PROOF_PUBLIC_KEY_LEN],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OacKeysetManifestFrameV1 {
    pub revocation_epoch: u32,
    pub generated_at_server_ms: u64,
    pub keys: Vec<OacKeysetManifestKeyV1>,
    pub signature: [u8; DRP1_SIGNATURE_LEN],
}

const OKS1_MAGIC: &[u8; 4] = b"OKS1";
const OKS1_VERSION: u8 = 1;

pub fn oks1_signed_prefix(frame: &OacKeysetManifestFrameV1) -> Result<Vec<u8>, FrameDecodeError> {
    if frame.keys.is_empty() || frame.keys.len() > 255 {
        return Err(FrameDecodeError::BadFieldLength);
    }
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(OKS1_MAGIC);
    out.push(OKS1_VERSION);
    out.extend_from_slice(&frame.revocation_epoch.to_le_bytes());
    out.extend_from_slice(&frame.generated_at_server_ms.to_le_bytes());
    out.push(frame.keys.len() as u8);
    for key in &frame.keys {
        write_len_prefixed_str(&mut out, &key.signing_key_id)?;
        out.extend_from_slice(&key.public_key);
    }
    Ok(out)
}

pub fn encode_oks1(frame: &OacKeysetManifestFrameV1) -> Result<Vec<u8>, FrameDecodeError> {
    let mut out = oks1_signed_prefix(frame)?;
    out.extend_from_slice(&frame.signature);
    Ok(out)
}

pub fn decode_oks1(bytes: &[u8]) -> Result<OacKeysetManifestFrameV1, FrameDecodeError> {
    if bytes.len() < 4 + 1 + 4 + 8 + 1 {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    if &bytes[0..4] != OKS1_MAGIC {
        return Err(FrameDecodeError::BadMagic);
    }
    if bytes[4] != OKS1_VERSION {
        return Err(FrameDecodeError::BadVersion);
    }
    let mut o = 5usize;
    let revocation_epoch = u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    o += 4;
    let generated_at_server_ms = u64::from_le_bytes(bytes[o..o + 8].try_into().unwrap());
    o += 8;
    let key_count = bytes[o] as usize;
    o += 1;
    if key_count == 0 {
        return Err(FrameDecodeError::BadFieldLength);
    }
    let mut keys = Vec::with_capacity(key_count);
    for _ in 0..key_count {
        let (signing_key_id, next) = read_len_prefixed_str(bytes, o)?;
        if signing_key_id.is_empty() {
            return Err(FrameDecodeError::BadFieldLength);
        }
        o = next;
        if o + DRP1_DEV_PROOF_PUBLIC_KEY_LEN > bytes.len() {
            return Err(FrameDecodeError::WrongTotalLength);
        }
        let mut public_key = [0u8; DRP1_DEV_PROOF_PUBLIC_KEY_LEN];
        public_key.copy_from_slice(&bytes[o..o + DRP1_DEV_PROOF_PUBLIC_KEY_LEN]);
        o += DRP1_DEV_PROOF_PUBLIC_KEY_LEN;
        keys.push(OacKeysetManifestKeyV1 { signing_key_id, public_key });
    }
    if o + DRP1_SIGNATURE_LEN != bytes.len() {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    let mut signature = [0u8; DRP1_SIGNATURE_LEN];
    signature.copy_from_slice(&bytes[o..o + DRP1_SIGNATURE_LEN]);
    Ok(OacKeysetManifestFrameV1 { revocation_epoch, generated_at_server_ms, keys, signature })
}

// --- LockoutClearTokenFrameV1 ("LCT1") --------------------------------------

pub const LCT1_MAGIC: &[u8; 4] = b"LCT1";
pub const LCT1_VERSION: u8 = 1;
pub const LCT1_SECURITY_DEVICE_ID_LEN: usize = 16;
pub const LCT1_LOCKOUT_ID_LEN: usize = 32;
pub const LCT1_NONCE_LEN: usize = 32;
pub const LCT1_SIGNATURE_LEN: usize = 64;
pub const LOCKOUT_CLEAR_TOKEN_TTL_MS: u64 = 15 * 60 * 1000; // 900_000 ms

pub fn is_canonical_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockoutClearTokenFrameV1 {
    pub security_device_id: [u8; LCT1_SECURITY_DEVICE_ID_LEN],
    pub manager_staff_id: String,
    pub lockout_id: [u8; LCT1_LOCKOUT_ID_LEN],
    pub issued_at_server_ms: u64,
    pub expires_at_server_ms: u64,
    pub token_nonce: [u8; LCT1_NONCE_LEN],
    pub signing_key_id: String,
    pub signature: [u8; LCT1_SIGNATURE_LEN],
}

pub fn lct1_signed_prefix(frame: &LockoutClearTokenFrameV1) -> Result<Vec<u8>, FrameDecodeError> {
    if !is_canonical_identifier(&frame.manager_staff_id) || !is_canonical_identifier(&frame.signing_key_id) {
        return Err(FrameDecodeError::BadFieldFormat);
    }
    if frame.expires_at_server_ms <= frame.issued_at_server_ms {
        return Err(FrameDecodeError::BadFieldFormat);
    }
    if frame.expires_at_server_ms - frame.issued_at_server_ms > LOCKOUT_CLEAR_TOKEN_TTL_MS {
        return Err(FrameDecodeError::BadFieldFormat);
    }
    let mut out = Vec::with_capacity(4 + 1 + 16 + 1 + frame.manager_staff_id.len() + 32 + 8 + 8 + 32 + 1 + frame.signing_key_id.len());
    out.extend_from_slice(LCT1_MAGIC);
    out.push(LCT1_VERSION);
    out.extend_from_slice(&frame.security_device_id);
    write_len_prefixed_str(&mut out, &frame.manager_staff_id)?;
    out.extend_from_slice(&frame.lockout_id);
    out.extend_from_slice(&frame.issued_at_server_ms.to_le_bytes());
    out.extend_from_slice(&frame.expires_at_server_ms.to_le_bytes());
    out.extend_from_slice(&frame.token_nonce);
    write_len_prefixed_str(&mut out, &frame.signing_key_id)?;
    Ok(out)
}

pub fn encode_lct1(frame: &LockoutClearTokenFrameV1) -> Result<Vec<u8>, FrameDecodeError> {
    let mut out = lct1_signed_prefix(frame)?;
    out.extend_from_slice(&frame.signature);
    Ok(out)
}

pub fn decode_lct1(bytes: &[u8]) -> Result<LockoutClearTokenFrameV1, FrameDecodeError> {
    if bytes.len() < 4 + 1 + 16 + 1 + 32 + 8 + 8 + 32 + 1 + 64 {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    if &bytes[0..4] != LCT1_MAGIC {
        return Err(FrameDecodeError::BadMagic);
    }
    if bytes[4] != LCT1_VERSION {
        return Err(FrameDecodeError::BadVersion);
    }
    let mut o = 5usize;
    let mut security_device_id = [0u8; LCT1_SECURITY_DEVICE_ID_LEN];
    security_device_id.copy_from_slice(&bytes[o..o + LCT1_SECURITY_DEVICE_ID_LEN]);
    o += LCT1_SECURITY_DEVICE_ID_LEN;
    let (manager_staff_id, next) = read_len_prefixed_str(bytes, o)?;
    o = next;
    if o + LCT1_LOCKOUT_ID_LEN + 8 + 8 + LCT1_NONCE_LEN > bytes.len() {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    let mut lockout_id = [0u8; LCT1_LOCKOUT_ID_LEN];
    lockout_id.copy_from_slice(&bytes[o..o + LCT1_LOCKOUT_ID_LEN]);
    o += LCT1_LOCKOUT_ID_LEN;
    let issued_at_server_ms = u64::from_le_bytes(bytes[o..o + 8].try_into().unwrap());
    o += 8;
    let expires_at_server_ms = u64::from_le_bytes(bytes[o..o + 8].try_into().unwrap());
    o += 8;
    let mut token_nonce = [0u8; LCT1_NONCE_LEN];
    token_nonce.copy_from_slice(&bytes[o..o + LCT1_NONCE_LEN]);
    o += LCT1_NONCE_LEN;
    let (signing_key_id, next) = read_len_prefixed_str(bytes, o)?;
    o = next;
    if o + LCT1_SIGNATURE_LEN != bytes.len() {
        return Err(FrameDecodeError::WrongTotalLength);
    }
    let mut signature = [0u8; LCT1_SIGNATURE_LEN];
    signature.copy_from_slice(&bytes[o..o + LCT1_SIGNATURE_LEN]);

    if !is_canonical_identifier(&manager_staff_id) || !is_canonical_identifier(&signing_key_id) {
        return Err(FrameDecodeError::BadFieldFormat);
    }
    if expires_at_server_ms <= issued_at_server_ms {
        return Err(FrameDecodeError::BadFieldFormat);
    }
    if expires_at_server_ms - issued_at_server_ms > LOCKOUT_CLEAR_TOKEN_TTL_MS {
        return Err(FrameDecodeError::BadFieldFormat);
    }

    Ok(LockoutClearTokenFrameV1 {
        security_device_id,
        manager_staff_id,
        lockout_id,
        issued_at_server_ms,
        expires_at_server_ms,
        token_nonce,
        signing_key_id,
        signature,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Canonical DRP1 test vector — MUST stay byte-identical to the TS vector
    // in functions/src/__tests__/oacFrame.test.ts.
    fn vector_frame() -> DeviceRegistrationPossessionFrameV1 {
        let mut nonce = [0u8; 32];
        for (i, b) in nonce.iter_mut().enumerate() {
            *b = i as u8;
        }
        let mut security_device_id = [0u8; 16];
        for (i, b) in security_device_id.iter_mut().enumerate() {
            *b = 0xA0 + i as u8;
        }
        let mut dev_proof_public_key = [0u8; 32];
        for (i, b) in dev_proof_public_key.iter_mut().enumerate() {
            *b = 0xC0 + i as u8;
        }
        let mut signature = [0u8; 64];
        for (i, b) in signature.iter_mut().enumerate() {
            *b = i as u8;
        }
        DeviceRegistrationPossessionFrameV1 {
            enrollment_auth_id: "00112233445566778899aabbccddeeff".to_string(),
            device_registration_nonce: nonce,
            security_device_id,
            dev_proof_public_key,
            signature,
        }
    }

    const VECTOR_FULL_HEX: &str = "445250310120303031313232333334343535363637373838393961616262636364646565666620000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f10a0a1a2a3a4a5a6a7a8a9aaabacadaeaf20c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";

    fn hex_decode(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn hex_encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn drp1_canonical_vector_matches_ts_parity_anchor() {
        let encoded = encode_drp1(&vector_frame());
        assert_eq!(encoded.len(), DRP1_TOTAL_BYTES);
        assert_eq!(hex_encode(&encoded), VECTOR_FULL_HEX);
    }

    #[test]
    fn drp1_decodes_canonical_vector() {
        let bytes = hex_decode(VECTOR_FULL_HEX);
        let decoded = decode_drp1(&bytes).unwrap();
        assert_eq!(decoded, vector_frame());
    }

    #[test]
    fn drp1_round_trips_arbitrary_frame() {
        let frame = DeviceRegistrationPossessionFrameV1 {
            enrollment_auth_id: "ffeeddccbbaa99887766554433221100".to_string(),
            device_registration_nonce: [0x7a; 32],
            security_device_id: [0x11; 16],
            dev_proof_public_key: [0x22; 32],
            signature: [0x33; 64],
        };
        let decoded = decode_drp1(&encode_drp1(&frame)).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn drp1_rejects_wrong_length() {
        assert_eq!(decode_drp1(&[0u8; 184]), Err(FrameDecodeError::WrongTotalLength));
        assert_eq!(decode_drp1(&[0u8; 186]), Err(FrameDecodeError::WrongTotalLength));
        assert_eq!(decode_drp1(&[]), Err(FrameDecodeError::WrongTotalLength));
    }

    #[test]
    fn drp1_rejects_bad_magic() {
        let mut bytes = hex_decode(VECTOR_FULL_HEX);
        bytes[0] = b'X';
        assert_eq!(decode_drp1(&bytes), Err(FrameDecodeError::BadMagic));
    }

    #[test]
    fn drp1_rejects_bad_version() {
        let mut bytes = hex_decode(VECTOR_FULL_HEX);
        bytes[4] = 2;
        assert_eq!(decode_drp1(&bytes), Err(FrameDecodeError::BadVersion));
    }

    #[test]
    fn drp1_rejects_tampered_field_length() {
        let mut bytes = hex_decode(VECTOR_FULL_HEX);
        bytes[5] = 31;
        assert_eq!(decode_drp1(&bytes), Err(FrameDecodeError::BadFieldLength));
    }

    #[test]
    fn drp1_rejects_non_hex_enrollment_auth_id() {
        let mut bytes = hex_decode(VECTOR_FULL_HEX);
        bytes[6] = b'Z';
        assert_eq!(decode_drp1(&bytes), Err(FrameDecodeError::BadFieldFormat));
    }

    #[test]
    fn ptp1_round_trips() {
        let frame = ProvisioningTupleProofFrameV1 {
            security_device_id: [0x09; 16],
            oac_issuance_session_id: "sess-abc123".to_string(),
            manager_staff_id: "staff-xyz789".to_string(),
            nonce: [0x44; 32],
            dev_proof_public_key: [0x55; 32],
            signature: [0x66; 64],
        };
        let decoded = decode_ptp1(&encode_ptp1(&frame).unwrap()).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn pin1_round_trips() {
        let frame = PinBindingFrameV1 {
            security_device_id: [0x01; 16],
            oac_issuance_session_id: "sess-1".to_string(),
            manager_staff_id: "staff-1".to_string(),
            verifier_algo: "argon2id".to_string(),
            m: 65536,
            t: 3,
            p: 1,
            verifier_salt: vec![0x02; 16],
            verifier: vec![0x03; 32],
            pepper_commitment: vec![0x04; 32],
            dev_proof_public_key: [0x05; 32],
            signature: [0x06; 64],
        };
        let decoded = decode_pin1(&encode_pin1(&frame).unwrap()).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn enr1_round_trips() {
        let frame = EnrollmentProofFrameV1 {
            enrollment_auth_id: "00112233445566778899aabbccddeeff".to_string(),
            branch_id: "branch-001".to_string(),
            issued_at_server_ms: 1_772_000_000_000,
            expires_at_server_ms: 1_772_000_600_000,
            issuer_id: "issuer-001".to_string(),
            signature: [0x07; 64],
        };
        let decoded = decode_enr1(&encode_enr1(&frame).unwrap()).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn enr1_rejects_non_hex_enrollment_auth_id() {
        let frame = EnrollmentProofFrameV1 {
            enrollment_auth_id: "not-hex".to_string(),
            branch_id: "b".to_string(),
            issued_at_server_ms: 1,
            expires_at_server_ms: 2,
            issuer_id: "i".to_string(),
            signature: [0u8; 64],
        };
        assert_eq!(encode_enr1(&frame), Err(FrameDecodeError::BadFieldFormat));
    }

    #[test]
    fn oks1_round_trips_multi_key_manifest() {
        let frame = OacKeysetManifestFrameV1 {
            revocation_epoch: 7,
            generated_at_server_ms: 1_772_000_000_000,
            keys: vec![
                OacKeysetManifestKeyV1 { signing_key_id: "key-1".to_string(), public_key: [0x08; 32] },
                OacKeysetManifestKeyV1 { signing_key_id: "key-2".to_string(), public_key: [0x09; 32] },
            ],
            signature: [0x0a; 64],
        };
        let decoded = decode_oks1(&encode_oks1(&frame).unwrap()).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn oks1_rejects_zero_keys() {
        let frame = OacKeysetManifestFrameV1 {
            revocation_epoch: 0,
            generated_at_server_ms: 0,
            keys: vec![],
            signature: [0u8; 64],
        };
        assert_eq!(encode_oks1(&frame), Err(FrameDecodeError::BadFieldLength));
    }

    fn canonical_lct1_vector() -> LockoutClearTokenFrameV1 {
        let mut security_device_id = [0u8; 16];
        for (i, b) in security_device_id.iter_mut().enumerate() {
            *b = 0x10 + i as u8;
        }
        let mut lockout_id = [0u8; 32];
        for (i, b) in lockout_id.iter_mut().enumerate() {
            *b = 0x20 + i as u8;
        }
        let mut token_nonce = [0u8; 32];
        for (i, b) in token_nonce.iter_mut().enumerate() {
            *b = 0x30 + i as u8;
        }
        let mut signature = [0u8; 64];
        for (i, b) in signature.iter_mut().enumerate() {
            *b = 0x40 + (i as u8 % 64);
        }
        LockoutClearTokenFrameV1 {
            security_device_id,
            manager_staff_id: "mgr_001".to_string(),
            lockout_id,
            issued_at_server_ms: 1_700_000_000_000,
            expires_at_server_ms: 1_700_000_900_000,
            token_nonce,
            signing_key_id: "key_001".to_string(),
            signature,
        }
    }

    pub const LCT1_CANONICAL_PARITY_HEX: &str =
        "4c43543101101112131415161718191a1b1c1d1e1f076d67725f303031202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f0068e5cf8b010000a023f3cf8b010000303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f076b65795f303031404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f";

    #[test]
    fn lct1_matches_shared_literal_fixture_and_ts_parity() {
        let frame = canonical_lct1_vector();
        let encoded = encode_lct1(&frame).unwrap();
        assert_eq!(encoded.len(), 181);

        let hex_str: String = encoded.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex_str, LCT1_CANONICAL_PARITY_HEX);

        // Prefix length check
        let prefix = lct1_signed_prefix(&frame).unwrap();
        assert_eq!(prefix.len(), 117);

        // Decode from literal hex
        let mut hex_bytes = Vec::with_capacity(181);
        for i in (0..LCT1_CANONICAL_PARITY_HEX.len()).step_by(2) {
            hex_bytes.push(u8::from_str_radix(&LCT1_CANONICAL_PARITY_HEX[i..i + 2], 16).unwrap());
        }
        let decoded = decode_lct1(&hex_bytes).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn lct1_round_trips_canonical_vector() {
        let frame = canonical_lct1_vector();
        let encoded = encode_lct1(&frame).unwrap();
        assert_eq!(encoded.len(), 181);
        let decoded = decode_lct1(&encoded).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn lct1_rejects_truncated_input() {
        let frame = canonical_lct1_vector();
        let encoded = encode_lct1(&frame).unwrap();
        assert_eq!(decode_lct1(&encoded[..encoded.len() - 1]), Err(FrameDecodeError::WrongTotalLength));
    }

    #[test]
    fn lct1_rejects_trailing_bytes() {
        let frame = canonical_lct1_vector();
        let mut encoded = encode_lct1(&frame).unwrap();
        encoded.push(0x00);
        assert_eq!(decode_lct1(&encoded), Err(FrameDecodeError::WrongTotalLength));
    }

    #[test]
    fn lct1_rejects_bad_magic() {
        let frame = canonical_lct1_vector();
        let mut encoded = encode_lct1(&frame).unwrap();
        encoded[0] = b'X';
        assert_eq!(decode_lct1(&encoded), Err(FrameDecodeError::BadMagic));
    }

    #[test]
    fn lct1_rejects_bad_version() {
        let frame = canonical_lct1_vector();
        let mut encoded = encode_lct1(&frame).unwrap();
        encoded[4] = 2;
        assert_eq!(decode_lct1(&encoded), Err(FrameDecodeError::BadVersion));
    }

    #[test]
    fn lct1_rejects_timestamp_inversion() {
        let mut frame = canonical_lct1_vector();
        frame.expires_at_server_ms = frame.issued_at_server_ms - 1000;
        assert_eq!(encode_lct1(&frame), Err(FrameDecodeError::BadFieldFormat));

        // Equal timestamps also invalid (TTL must be positive)
        frame.expires_at_server_ms = frame.issued_at_server_ms;
        assert_eq!(encode_lct1(&frame), Err(FrameDecodeError::BadFieldFormat));
    }

    #[test]
    fn lct1_rejects_oversized_ttl() {
        let mut frame = canonical_lct1_vector();
        // TTL > 900_000 ms
        frame.expires_at_server_ms = frame.issued_at_server_ms + LOCKOUT_CLEAR_TOKEN_TTL_MS + 1;
        assert_eq!(encode_lct1(&frame), Err(FrameDecodeError::BadFieldFormat));
    }

    #[test]
    fn lct1_rejects_invalid_identifiers() {
        let mut frame = canonical_lct1_vector();
        frame.manager_staff_id = "".to_string();
        assert_eq!(encode_lct1(&frame), Err(FrameDecodeError::BadFieldFormat));

        let mut frame2 = canonical_lct1_vector();
        frame2.manager_staff_id = "mgr with spaces".to_string();
        assert_eq!(encode_lct1(&frame2), Err(FrameDecodeError::BadFieldFormat));

        let mut frame3 = canonical_lct1_vector();
        frame3.signing_key_id = "k".repeat(65);
        assert_eq!(encode_lct1(&frame3), Err(FrameDecodeError::BadFieldFormat));
    }
}
