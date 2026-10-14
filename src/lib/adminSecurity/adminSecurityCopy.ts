/**
 * Admin & Security Center V1 — fixed Thai copy. Never interpolates raw ids,
 * codes, PINs or tokens; only display names / usernames.
 */

export const ADMIN_SECURITY_COPY = {
  title: 'Admin & ความปลอดภัย',
  subtitle: 'จัดการผู้ใช้งาน PIN สิทธิ์อนุมัติ และความปลอดภัยของเครื่อง',
  badgeEligible: 'Admin password session',
  badgeIneligible: 'ต้องเข้าสู่ระบบแบบผู้ดูแลระบบ',
  passwordSessionRequired: 'ต้องเข้าสู่ระบบด้วยชื่อผู้ใช้และรหัสผ่านของผู้ดูแลระบบเพื่อจัดการความปลอดภัย',
  checkingSession: 'กำลังตรวจสอบเซสชันผู้ดูแลระบบ…',
  loading: 'กำลังโหลดรายชื่อผู้ใช้งาน…',
  loadFailed: 'โหลดข้อมูลผู้ใช้งานไม่สำเร็จ กรุณาลองใหม่',
  reload: 'โหลดใหม่',
  usersHeading: 'ผู้ใช้งาน',
  addUser: 'เพิ่มผู้ใช้งาน',
  editUser: 'แก้ไขผู้ใช้',
  changePin: 'เปลี่ยน Quick PIN',
  clearLockout: 'ปลดล็อกสิทธิ์อนุมัติ',
  reissueOac: 'ออกสิทธิ์ Offline ใหม่',
  disable: 'ปิดใช้งาน',
  enable: 'เปิดใช้งาน',
  selfAccount: 'บัญชีของคุณ',
  selfLocked: 'ไม่สามารถแก้ไขความปลอดภัยของบัญชีตนเองจากหน้านี้',
  // D-ASC9 — Security Admin (username/password) vs POS Admin (Quick PIN).
  roleSecurityAdmin: 'Security Admin',
  roleSecurityAdminHint: 'เข้า Admin & ความปลอดภัยด้วย username/password',
  rolePosAdmin: 'POS Admin (Quick PIN)',
  rolePosAdminHint: 'จัดการงาน POS ได้ตามสิทธิ์ แต่ใช้ Admin & ความปลอดภัยไม่ได้',
  roleAdminUnknown: 'ผู้ดูแลระบบ (ยืนยันประเภทไม่ได้)',
  roleAdminUnknownHint: 'ยืนยันประเภทบัญชีไม่ได้ จึงแสดงแบบอ่านอย่างเดียว',
  ownerRecoveryManaged: 'จัดการผ่าน Owner Recovery',
  ownerRecoveryRequired: 'บัญชีผู้ดูแลระบบหลักต้องจัดการผ่าน Owner Recovery',
  adminUnknownReadOnly: 'อ่านอย่างเดียว — ลองโหลดใหม่ภายหลัง',
  // D-ASC12/D-ASC13 — password-backed / unclassified staff & manager rows.
  passwordPrincipalBadge: 'username/password',
  passwordPrincipalOwnerRecoveryRequired: 'บัญชีนี้มีการเข้าสู่ระบบด้วย username/password จึงต้องจัดการผ่าน Owner Recovery',
  accountUnknownReadOnly: 'ยืนยันประเภทบัญชีไม่ได้ — ลองโหลดใหม่ภายหลัง',
  accountClassificationUnavailable:
    'ไม่สามารถยืนยันประเภทการเข้าสู่ระบบของบัญชีนี้ได้ จึงยังไม่บันทึกการเปลี่ยนแปลง กรุณาลองใหม่ภายหลัง',
  posAdminCreateWarning: 'บัญชีนี้ใช้ Quick PIN สำหรับงาน POS และไม่ใช่ Security Admin แบบ username/password',
  // D-ASC11 — editing an existing staff/manager into role=admin.
  posAdminPromoteWarning:
    'เปลี่ยนเป็น POS Admin ได้เฉพาะบัญชีที่ใช้ Quick PIN เท่านั้น บัญชีที่มีการเข้าสู่ระบบด้วยรหัสผ่านจะถูกปฏิเสธและต้องใช้ Owner Recovery',
  pinSet: 'ตั้งค่าแล้ว',
  pinRequired: 'ต้องตั้งค่า',
  active: 'ใช้งาน',
  inactive: 'ปิดใช้งาน',
  allBranches: 'ทุกสาขา',
  // Approval capability (OAC) state on this terminal.
  oacReady: 'พร้อมใช้',
  oacReissueRequired: 'ต้องออกใหม่',
  oacExpired: 'หมดอายุ',
  oacMissing: 'ไม่มี',
  oacLocked: 'ถูกล็อก',
  oacNativeOnly: 'ใช้ได้เฉพาะในแอป Twinpet POS',
  // D-ASC10 — ALL workspace: no concrete terminal branch.
  oacBranchRequired: 'เลือกสาขาจริงก่อนจัดการสิทธิ์อนุมัติบนเครื่องนี้',
  // Lockout.
  lockoutNormal: 'ปกติ',
  lockoutLocked: 'ถูกล็อกบนเครื่องนี้',
  lockoutConfirm: 'ปลดล็อกสิทธิ์อนุมัติของผู้จัดการรายนี้บนเครื่องนี้หรือไม่',
  lockoutSuccess: 'ปลดล็อกสิทธิ์อนุมัติแล้ว',
  lockoutFailure: 'ปลดล็อกสิทธิ์อนุมัติไม่สำเร็จ กรุณาติดต่อผู้ดูแลระบบ',
  // PIN rotation.
  pinModalTitle: 'เปลี่ยน Quick PIN',
  pinModalCopy: 'ระบบจะไม่แสดง PIN เดิม กรุณาตั้ง PIN ใหม่',
  pinNew: 'PIN ใหม่',
  pinConfirm: 'ยืนยัน PIN ใหม่',
  pinFormat: 'PIN ต้องเป็นตัวเลข 4 หลัก',
  pinMismatch: 'PIN ใหม่และการยืนยันไม่ตรงกัน',
  pinRotated: 'Quick PIN เปลี่ยนแล้ว — ต้องออกสิทธิ์ Offline ใหม่',
  pinRotatedStaff: 'Quick PIN เปลี่ยนแล้ว',
  // OAC reissue.
  oacReissueSuccess: 'ออกสิทธิ์ Offline ใหม่แล้ว',
  oacReissueConfirmValid: 'สิทธิ์ Offline ของผู้จัดการรายนี้ยังใช้ได้อยู่ ต้องการออกใหม่หรือไม่',
  oacOffline: 'ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อออกสิทธิ์ Offline ใหม่',
  oacNotEligible: 'ผู้ใช้นี้ไม่สามารถรับสิทธิ์อนุมัติบนเครื่องนี้ได้',
  oacDeviceNotReady: 'เครื่องนี้ยังไม่พร้อมออกสิทธิ์อนุมัติ กรุณาติดต่อผู้ดูแลระบบ',
  oacFailed: 'ออกสิทธิ์ Offline ใหม่ไม่สำเร็จ',
  oacUncertain: 'ไม่สามารถยืนยันผลการออกสิทธิ์ Offline ได้ กรุณาตรวจสอบสถานะก่อนลองใหม่',
  // Generic mutation outcomes.
  saved: 'บันทึกแล้ว',
  userCreated: 'เพิ่มผู้ใช้งานแล้ว',
  userDisabled: 'ปิดใช้งานผู้ใช้แล้ว',
  userEnabled: 'เปิดใช้งานผู้ใช้แล้ว — ต้องออกสิทธิ์ Offline ใหม่ก่อนอนุมัติ',
  uncertain: 'ไม่สามารถยืนยันผลการบันทึกได้ กรุณาโหลดข้อมูลใหม่เพื่อตรวจสอบก่อนลองอีกครั้ง',
  oacRevokeFailed: 'ไม่สามารถยกเลิกสิทธิ์ Offline เดิมบนเครื่องนี้ได้ กรุณาติดต่อผู้ดูแลระบบ',
  disableConfirm: 'ปิดใช้งานผู้ใช้นี้หรือไม่ ประวัติทั้งหมดจะถูกเก็บไว้ และสิทธิ์ Offline บนเครื่องนี้จะถูกยกเลิก',
  // Activity.
  activityHeading: 'กิจกรรมล่าสุด',
  activityEmpty: 'ยังไม่มีกิจกรรม',
  unknownUser: 'ผู้ใช้ที่ไม่พบในระบบ',
  operatorCli: 'ผู้ดูแลระบบ (เครื่องมือปฏิบัติการ)',
} as const;

export function managerIdentityLine(displayName: string, username: string): string {
  return username ? `ผู้จัดการ: ${displayName} (${username})` : `ผู้จัดการ: ${displayName}`;
}

export function approverIdentityLine(displayName: string, username: string): string {
  return username ? `ผู้อนุมัติ: ${displayName} (${username})` : `ผู้อนุมัติ: ${displayName}`;
}

export function enterOwnPinInstruction(displayName: string): string {
  return `กรุณาใส่ Quick PIN ของ ${displayName}`;
}

export function wrongOwnPinCopy(displayName: string): string {
  return `Quick PIN ของ ${displayName} ไม่ถูกต้อง`;
}

export function failedAttemptsCopy(n: number): string {
  return `กรอกไม่ถูกต้อง ${n} ครั้ง`;
}

export function remainingAttemptsCopy(n: number): string {
  return `เหลืออีก ${n} ครั้งก่อนถูกล็อก`;
}
