import { useState, type FormEvent } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from 'flowbite-react';
import { Alert, Button, Checkbox, Label, Select, TextInput } from '../../components/ui';
import { ADMIN_SECURITY_COPY as C } from '../../lib/adminSecurity/adminSecurityCopy';
import { ADMIN_PIN_RE, type AdminSecurityUser } from '../../lib/adminSecurity/adminSecurityService';
import type { UserRole } from '../../lib/types';

/**
 * Admin & Security Center V1 dialogs. PIN fields are masked, never
 * pre-filled, never echoed back, and their buffers are cleared the moment a
 * submit is accepted for sending (and on unmount). No existing PIN is ever
 * shown — a "reset" only sets a new PIN.
 */

export type BranchOption = { id: string; name: string };

const ROLE_OPTIONS: Array<{ value: UserRole; label: string }> = [
  { value: 'staff', label: 'พนักงาน' },
  { value: 'manager', label: 'ผู้จัดการ' },
  // D-ASC9: role=admin created here is a POS (Quick PIN) admin, never a
  // username/password Security Admin — no Firebase password account is made.
  { value: 'admin', label: C.rolePosAdmin },
];

function PinInput({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <TextInput
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        maxLength={4}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 4))}
      />
    </div>
  );
}

function pinError(pin: string, confirm: string): string | null {
  if (!ADMIN_PIN_RE.test(pin)) return C.pinFormat;
  if (pin !== confirm) return C.pinMismatch;
  return null;
}

export function AdminChangePinDialog({
  displayName,
  username,
  busy,
  onCancel,
  onSubmit,
}: {
  displayName: string;
  username: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (pin: string) => void;
}) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = pinError(pin, confirm);
    if (problem) {
      setError(problem);
      setPin('');
      setConfirm('');
      return;
    }
    const value = pin;
    setPin('');
    setConfirm('');
    setError(null);
    onSubmit(value);
  };

  return (
    <Modal show onClose={busy ? () => undefined : onCancel} size="md">
      <form onSubmit={submit} data-testid="admin-change-pin-dialog">
        <ModalHeader>{C.pinModalTitle}</ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-3">
            <div className="font-semibold">
              {displayName}
              {username ? ` (${username})` : ''}
            </div>
            <p className="text-sm">{C.pinModalCopy}</p>
            <PinInput id="admin-pin-new" label={C.pinNew} value={pin} onChange={setPin} disabled={busy} />
            <PinInput id="admin-pin-confirm" label={C.pinConfirm} value={confirm} onChange={setConfirm} disabled={busy} />
            {error ? (
              <Alert color="failure" role="alert">
                {error}
              </Alert>
            ) : null}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button type="submit" className="min-h-11" disabled={busy}>
            {busy ? 'กำลังบันทึก…' : C.changePin}
          </Button>
          <Button type="button" color="light" className="min-h-11" onClick={onCancel} disabled={busy}>
            ยกเลิก
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

export function AdminConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal show onClose={busy ? () => undefined : onCancel} size="md">
      <div data-testid="admin-confirm-dialog">
        <ModalHeader>{title}</ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-2">
            {body.split('\n').map((line, i) => (
              <p key={i} className={i === 0 ? 'font-semibold' : 'text-sm'}>
                {line}
              </p>
            ))}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button color="failure" className="min-h-11" onClick={onConfirm} disabled={busy}>
            {busy ? 'กำลังดำเนินการ…' : confirmLabel}
          </Button>
          <Button color="light" className="min-h-11" onClick={onCancel} disabled={busy}>
            ยกเลิก
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
}

export type AdminUserFormValues = {
  firstName: string;
  lastName: string;
  username: string;
  role: UserRole;
  branchIds: string[];
  pin: string;
};

export function AdminUserFormDialog({
  mode,
  user,
  branches,
  existingUsernames,
  busy,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  user: AdminSecurityUser | null;
  branches: BranchOption[];
  existingUsernames: string[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: AdminUserFormValues) => void;
}) {
  const [firstName, setFirstName] = useState(user?.firstName ?? '');
  const [lastName, setLastName] = useState(user?.lastName ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [role, setRole] = useState<UserRole>(user?.role ?? 'staff');
  const [branchIds, setBranchIds] = useState<string[]>(user?.branchIds ?? []);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Existing assignments stay selectable even if the branch list is stale.
  const options: BranchOption[] = [...branches];
  for (const id of user?.branchIds ?? []) {
    if (id !== 'ALL' && !options.some((b) => b.id === id)) options.push({ id, name: id });
  }

  const toggleBranch = (id: string) =>
    setBranchIds((cur) => (cur.includes(id) ? cur.filter((b) => b !== id) : [...cur.filter((b) => b !== 'ALL'), id]));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const normalized = username.trim().toLowerCase();
    let problem: string | null = null;
    if (!firstName.trim() || (mode === 'create' && !normalized)) problem = 'กรุณากรอกชื่อและชื่อผู้ใช้';
    else if (branchIds.length === 0) problem = 'กรุณาเลือกสาขาอย่างน้อย 1 สาขา';
    else if (branchIds.includes('ALL') && role !== 'admin') problem = `สิทธิ์ทุกสาขาใช้ได้เฉพาะ ${C.rolePosAdmin}`;
    else if (mode === 'create' && existingUsernames.includes(normalized)) problem = 'username นี้ถูกใช้แล้ว';
    else if (mode === 'create') problem = pinError(pin, confirm);
    if (problem) {
      setError(problem);
      setPin('');
      setConfirm('');
      return;
    }
    const value = pin;
    setPin('');
    setConfirm('');
    setError(null);
    onSubmit({ firstName, lastName, username: normalized, role, branchIds, pin: value });
  };

  return (
    <Modal show onClose={busy ? () => undefined : onCancel} size="lg">
      <form onSubmit={submit} data-testid="admin-user-form-dialog">
        <ModalHeader>{mode === 'create' ? C.addUser : C.editUser}</ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="admin-user-first">ชื่อ</Label>
                <TextInput id="admin-user-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} disabled={busy} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="admin-user-last">นามสกุล</Label>
                <TextInput id="admin-user-last" value={lastName} onChange={(e) => setLastName(e.target.value)} disabled={busy} />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="admin-user-username">ชื่อผู้ใช้ (username)</Label>
              <TextInput
                id="admin-user-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={busy || mode === 'edit'}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="admin-user-role">บทบาท</Label>
              <Select
                id="admin-user-role"
                value={role}
                onChange={(e) => {
                  const next = e.target.value as UserRole;
                  setRole(next);
                  if (next !== 'admin') setBranchIds((cur) => cur.filter((b) => b !== 'ALL'));
                }}
                disabled={busy}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
              {role === 'admin' ? (
                <Alert color="warning" data-testid="admin-pos-admin-warning">
                  {C.posAdminCreateWarning}
                </Alert>
              ) : null}
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">สาขาที่เข้าถึงได้</legend>
              {role === 'admin' ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="admin-user-branch-ALL"
                    checked={branchIds.includes('ALL')}
                    onChange={() => setBranchIds((cur) => (cur.includes('ALL') ? [] : ['ALL']))}
                    disabled={busy}
                  />
                  <Label htmlFor="admin-user-branch-ALL">{C.allBranches}</Label>
                </div>
              ) : null}
              {options.map((b) => (
                <div key={b.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`admin-user-branch-${b.id}`}
                    checked={branchIds.includes(b.id)}
                    onChange={() => toggleBranch(b.id)}
                    disabled={busy || branchIds.includes('ALL')}
                  />
                  <Label htmlFor={`admin-user-branch-${b.id}`}>{b.name}</Label>
                </div>
              ))}
            </fieldset>
            {mode === 'create' ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <PinInput id="admin-user-pin" label="Quick PIN เริ่มต้น" value={pin} onChange={setPin} disabled={busy} />
                <PinInput id="admin-user-pin-confirm" label="ยืนยัน Quick PIN" value={confirm} onChange={setConfirm} disabled={busy} />
              </div>
            ) : null}
            {error ? (
              <Alert color="failure" role="alert">
                {error}
              </Alert>
            ) : null}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button type="submit" className="min-h-11" disabled={busy}>
            {busy ? 'กำลังบันทึก…' : mode === 'create' ? C.addUser : 'บันทึก'}
          </Button>
          <Button type="button" color="light" className="min-h-11" onClick={onCancel} disabled={busy}>
            ยกเลิก
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
