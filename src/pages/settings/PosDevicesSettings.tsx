import { useEffect, useState } from 'react';
import { getDeviceId, getDeviceLabelRaw, setDeviceLabel } from '../../lib/pos/deviceId';
import {
  claimDevice,
  getThisDeviceRegistration,
  loadBranchDevices,
  registerThisDevice,
  type BranchDevice,
} from '../../lib/pos/posDeviceRegistry';

type ToastFn = (msg: string, type?: 'success' | 'info' | 'warn') => void;

/**
 * "This Device" self-registration card for the POS Devices settings section.
 * Shows the terminal's auto-generated id, lets a manager assign a friendly label
 * (used on offline receipt numbers), and on save persists it BOTH locally
 * (`setDeviceLabel`) AND to the `posDevices` registry so the label survives a
 * cache wipe and appears in the registered-devices list below.
 */
export default function PosDevicesSettings({
  branchId,
  userId,
  onToast,
}: {
  branchId: string | null;
  userId: string | null;
  onToast?: ToastFn;
}) {
  const deviceId = getDeviceId();
  const [label, setLabel] = useState(() => getDeviceLabelRaw() ?? '');
  const [saving, setSaving] = useState(false);
  const [registered, setRegistered] = useState(false);

  // Claim (total-wipe recovery) state.
  const [branchDevices, setBranchDevices] = useState<BranchDevice[]>([]);
  const [claimTargetId, setClaimTargetId] = useState('');
  const [claiming, setClaiming] = useState(false);

  // Reclaim: if this device has no local label yet but the registry has one
  // (e.g. after a partial cache wipe), restore it locally and prefill the input.
  useEffect(() => {
    let cancelled = false;
    void getThisDeviceRegistration().then((reg) => {
      if (cancelled || !reg) return;
      setRegistered(reg.registered);
      if (reg.registered && reg.name && reg.name !== deviceId && !getDeviceLabelRaw()) {
        setLabel(reg.name);
        setDeviceLabel(reg.name);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  // Load the branch's registered devices for the Claim picker.
  useEffect(() => {
    if (!branchId) {
      setBranchDevices([]);
      return;
    }
    let cancelled = false;
    void loadBranchDevices(branchId).then((list) => {
      if (!cancelled) setBranchDevices(list);
    });
    return () => {
      cancelled = true;
    };
  }, [branchId, registered]);

  // Orphans = other registered terminals this device could adopt (not itself).
  const orphanDevices = branchDevices.filter((d) => d.id !== deviceId);

  const save = async () => {
    const clean = label.trim();
    setSaving(true);
    try {
      setDeviceLabel(clean);
      if (branchId) await registerThisDevice(branchId, clean, userId);
      setRegistered(true);
      onToast?.('บันทึกชื่อเครื่องและลงทะเบียนแล้ว', 'success');
    } catch {
      onToast?.('บันทึกไม่สำเร็จ', 'warn');
    } finally {
      setSaving(false);
    }
  };

  const claim = async () => {
    if (!branchId || !claimTargetId) return;
    const target = orphanDevices.find((d) => d.id === claimTargetId);
    const ok = window.confirm(
      `ตั้งเครื่องนี้ให้เป็น "${target?.name ?? claimTargetId}" ?\n` +
        'เลขที่ใบเสร็จจะนับต่อจากของเดิมเพื่อไม่ให้ซ้ำ และหน้าจอจะรีเฟรชใหม่หลังกู้คืน',
    );
    if (!ok) return;
    setClaiming(true);
    try {
      await claimDevice(branchId, claimTargetId, target?.name ?? '', userId);
      onToast?.('กู้คืนอุปกรณ์เดิมสำเร็จ — กำลังรีเฟรช', 'success');
      window.setTimeout(() => window.location.reload(), 900);
    } catch {
      onToast?.('กู้คืนไม่สำเร็จ', 'warn');
      setClaiming(false);
    }
  };

  return (
    <div className="stg-card">
      <div className="stg-card-head">
        <i className="ti ti-device-tablet" aria-hidden="true" /> เครื่องนี้ (This Device)
        {registered ? <span className="stg-badge stg-badge-ok">ลงทะเบียนแล้ว</span> : null}
      </div>
      <div className="stg-card-body">
        <div className="stg-form-group">
          <label className="stg-form-label">รหัสเครื่อง (Device ID)</label>
          <input className="stg-form-input stg-readonly stg-code" value={deviceId} readOnly />
          <span className="stg-form-hint">
            สร้างอัตโนมัติ — ใช้รับประกันเลขที่ใบเสร็จไม่ซ้ำกันแม้ขณะออฟไลน์ (แก้ไขไม่ได้)
          </span>
        </div>

        <div className="stg-form-group">
          <label className="stg-form-label">ชื่อเครื่อง (Device Label)</label>
          <div className="stg-inline-row">
            <input
              className="stg-form-input"
              style={{ flex: 1 }}
              value={label}
              maxLength={24}
              placeholder="เช่น iPad-01, Counter-A, LDP-01"
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
              }}
            />
            <button
              type="button"
              className="stg-btn stg-btn-primary"
              onClick={() => void save()}
              disabled={saving || !branchId}
            >
              <i className="ti ti-check" aria-hidden="true" /> บันทึกชื่อ
            </button>
          </div>
          <span className="stg-form-hint">
            ชื่อนี้จะแสดงบนเลขที่ใบเสร็จ (เช่น RCP-260603-IPAD01-0007) และซิงก์ไปยังรายชื่อเครื่องด้านล่าง
          </span>
        </div>

        {orphanDevices.length > 0 ? (
          <div className="stg-form-group stg-claim-box">
            <label className="stg-form-label">
              <i className="ti ti-history" aria-hidden="true" /> กู้คืนอุปกรณ์เดิม (Claim Existing Device)
            </label>
            <div className="stg-inline-row">
              <select
                className="stg-form-select"
                style={{ flex: 1 }}
                value={claimTargetId}
                onChange={(e) => setClaimTargetId(e.target.value)}
              >
                <option value="">— เลือกเครื่องที่ต้องการกู้คืน —</option>
                {orphanDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.id})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="stg-btn stg-btn-ghost"
                onClick={() => void claim()}
                disabled={!claimTargetId || claiming}
              >
                <i className="ti ti-refresh-dot" aria-hidden="true" /> กู้คืนเครื่องนี้
              </button>
            </div>
            <span className="stg-form-hint">
              ใช้เมื่อแคชถูกล้างทั้งหมด: ตั้งเครื่องนี้ให้สวมรหัสเดิม เลขใบเสร็จจะนับต่อจากของเดิมเพื่อไม่ให้ซ้ำ
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
