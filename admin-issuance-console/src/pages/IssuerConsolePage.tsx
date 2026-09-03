import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import {
  beginDeviceEnrollmentAuthorizationIssuance,
  completeDeviceEnrollmentAuthorizationIssuance,
  exportEnrollmentFile,
  parseBootstrapImport,
  registerIssuer,
} from '../lib/issuerApi'

/**
 * SEC-001 Packet C-A — the console's single operator screen: (1) one-time
 * issuer bootstrap ceremony, (2) per-device enrollment-file issuance. Not a
 * design pass — Packet E owns final POS UI; this is the minimal Ops-facing
 * surface for the two callable flows `issuerApi.ts` wraps.
 */
export function IssuerConsolePage() {
  const { status, signIn, signOutUser, error: authError } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const [issuerId, setIssuerId] = useState('')
  const [bootstrapCredential, setBootstrapCredential] = useState('')
  const [registerMessage, setRegisterMessage] = useState<string | null>(null)

  const [branchId, setBranchId] = useState('')
  const [enrollmentAuthId, setEnrollmentAuthId] = useState<string | null>(null)
  const [enr1Base64, setEnr1Base64] = useState<string | null>(null)
  const [exportPath, setExportPath] = useState('')
  const [issuanceMessage, setIssuanceMessage] = useState<string | null>(null)

  if (status === 'loading') return <p>กำลังตรวจสอบสิทธิ์…</p>

  if (status !== 'signed-in-admin') {
    return (
      <div>
        <h1>Twinpet Issuer Console</h1>
        {status === 'signed-in-non-admin' && <p role="alert">บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void signIn(email, password)
          }}
        >
          <input aria-label="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
          <input
            aria-label="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
          />
          <button type="submit">เข้าสู่ระบบ</button>
        </form>
        {authError && <p role="alert">{authError}</p>}
      </div>
    )
  }

  const handleRegisterIssuer = async () => {
    setRegisterMessage(null)
    try {
      const parsed = await parseBootstrapImport(bootstrapCredential)
      const result = await registerIssuer({
        issuerId,
        bootstrapTokenId: parsed.tokenId,
        bootstrapToken: parsed.rawToken,
      })
      setRegisterMessage(result.ok ? `ลงทะเบียน issuer สำเร็จ: ${result.issuerId}` : `ล้มเหลว: ${result.code}`)
    } catch (err) {
      setRegisterMessage(err instanceof Error ? err.message : 'เกิดข้อผิดพลาด')
    }
  }

  const handleBeginIssuance = async () => {
    setIssuanceMessage(null)
    setEnr1Base64(null)
    const result = await beginDeviceEnrollmentAuthorizationIssuance({ issuerId, branchId })
    if (result.ok) {
      setEnrollmentAuthId(result.enrollmentAuthId)
      setIssuanceMessage(`เริ่มออกสิทธิ์ลงทะเบียนอุปกรณ์แล้ว: ${result.enrollmentAuthId}`)
    } else {
      setIssuanceMessage(`ล้มเหลว: ${result.code}`)
    }
  }

  const handleCompleteIssuance = async () => {
    if (!enrollmentAuthId) return
    setIssuanceMessage(null)
    const result = await completeDeviceEnrollmentAuthorizationIssuance({ issuerId, enrollmentAuthId })
    if (result.ok) {
      setEnr1Base64(result.enr1Base64)
      setIssuanceMessage('ออกไฟล์ลงทะเบียนสำเร็จ — พร้อมส่งออก')
    } else {
      setIssuanceMessage(`ล้มเหลว: ${result.code}`)
    }
  }

  const handleExportFile = async () => {
    if (!enr1Base64 || !exportPath) return
    await exportEnrollmentFile(exportPath, enr1Base64)
    setIssuanceMessage(`บันทึกไฟล์ลงทะเบียนที่ ${exportPath} แล้ว`)
  }

  return (
    <div>
      <h1>Twinpet Issuer Console</h1>
      <button onClick={() => void signOutUser()}>ออกจากระบบ</button>

      <section aria-label="issuer-bootstrap">
        <h2>ลงทะเบียน Issuer (ครั้งเดียวต่อเครื่อง)</h2>
        <input aria-label="issuerId" value={issuerId} onChange={(e) => setIssuerId(e.target.value)} placeholder="issuerId" />
        <textarea
          aria-label="bootstrapCredential"
          value={bootstrapCredential}
          onChange={(e) => setBootstrapCredential(e.target.value)}
          placeholder="tokenId:rawToken (จากสคริปต์ Ops)"
        />
        <button onClick={() => void handleRegisterIssuer()}>ลงทะเบียน Issuer</button>
        {registerMessage && <p role="status">{registerMessage}</p>}
      </section>

      <section aria-label="device-enrollment">
        <h2>ออกไฟล์ลงทะเบียนอุปกรณ์</h2>
        <input aria-label="branchId" value={branchId} onChange={(e) => setBranchId(e.target.value)} placeholder="branchId" />
        <button onClick={() => void handleBeginIssuance()}>เริ่มออกสิทธิ์</button>
        <button onClick={() => void handleCompleteIssuance()} disabled={!enrollmentAuthId}>
          ออกไฟล์ลงทะเบียน
        </button>
        {issuanceMessage && <p role="status">{issuanceMessage}</p>}
        {enr1Base64 && (
          <div>
            <input
              aria-label="exportPath"
              value={exportPath}
              onChange={(e) => setExportPath(e.target.value)}
              placeholder="C:/exports/enrollment.enr1"
            />
            <button onClick={() => void handleExportFile()}>บันทึกไฟล์</button>
          </div>
        )}
      </section>
    </div>
  )
}
