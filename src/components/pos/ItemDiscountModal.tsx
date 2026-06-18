import { useEffect, useState } from 'react';
import type { CartLine, ItemDiscountType } from '../../lib/pos/types';
import { formatMoney, getLineTotal, IDP_LABELS } from '../../lib/pos/cartUtils';
import { useAuth } from '../../lib/hooks/useAuth';
import NumpadDialog from './NumpadDialog';

type ItemDiscountModalProps = {
  line: CartLine | null;
  onSave: (type: ItemDiscountType, val: number) => void;
  onClose: () => void;
};

type IdpMode = Exclude<ItemDiscountType, 'none'>;

// Compact tab captions (the full field label lives in IDP_LABELS, shown above the input).
// 7C-UI-06-ENHANCEMENT: `disc_per_unit` adds the "ลด/หน่วย" (discount per unit) tab.
const TAB_LABELS: Record<IdpMode, string> = {
  disc_thb: 'ลด ฿',
  disc_pct: 'ลด %',
  disc_per_unit: 'ลด/หน่วย',
  override: 'แก้ราคา',
};

// Safe default mode any user may always use (no RBAC restriction).
const DEFAULT_MODE: IdpMode = 'disc_thb';

// 7C-UI-06-HOTFIX-MODAL-STATE-REVISION: each tab keeps its OWN draft input value so switching tabs
// never destroys what was typed in another tab. A fresh object per call avoids shared mutable state.
const emptyDraftValues = (): Record<IdpMode, string> => ({
  disc_thb: '',
  disc_pct: '',
  disc_per_unit: '',
  override: '',
});

export default function ItemDiscountModal({
  line,
  onSave,
  onClose,
}: ItemDiscountModalProps) {
  // 7C-UI-06-HOTFIX-MODAL-UX-RBAC Fix 3: Price Override is a manager/admin-only action. The role
  // is read from the existing auth context (useAuth -> user.role: UserRole). No parallel auth
  // source, no session change. Default-deny: a null user (should not occur inside POS) is treated
  // as not allowed.
  const { user } = useAuth();
  const canOverridePrice = user?.role === 'manager' || user?.role === 'admin';

  // The override tab is hidden for staff; the modal only offers the discount modes everyone may use.
  const availableModes: IdpMode[] = canOverridePrice
    ? ['disc_thb', 'disc_pct', 'disc_per_unit', 'override']
    : ['disc_thb', 'disc_pct', 'disc_per_unit'];

  const [mode, setMode] = useState<IdpMode>(DEFAULT_MODE);
  // Per-tab draft: one input string per mode. `mode` is the active tab; `draftValues[mode]` is the
  // field shown/edited. Only Save commits; switching tabs and Clear never mutate the cart line.
  const [draftValues, setDraftValues] = useState<Record<IdpMode, string>>(emptyDraftValues);
  // UI-06 hotfix Fix 2: the value field opens the custom on-screen numpad on touch (like the
  // bill-discount field) instead of falling back to the native mobile keyboard.
  const [numpadOpen, setNumpadOpen] = useState(false);

  useEffect(() => {
    if (!line) return;
    // Any newly (re)opened modal starts with the numpad closed and ALL tab drafts empty, then seeds
    // only the saved mode's own tab with the saved value -- so re-opening shows exactly what was
    // committed, and the other tabs start blank.
    setNumpadOpen(false);
    const drafts = emptyDraftValues();
    if (line.discount.type !== 'none') {
      const persisted = line.discount.type as IdpMode;
      // RBAC state guard: never open in (or seed) price-override mode for a non-manager, even if the
      // line already carries an override (set earlier by a manager). Fall back to a safe discount
      // mode so override can be neither shown nor applied through internal state.
      if (persisted === 'override' && !canOverridePrice) {
        setMode(DEFAULT_MODE);
      } else {
        drafts[persisted] = String(line.discount.val || '');
        setMode(persisted);
      }
    } else {
      setMode(DEFAULT_MODE);
    }
    setDraftValues(drafts);
  }, [line, canOverridePrice]);

  if (!line) return null;

  // ── Draft vs saved state (per-tab memory; 7C-UI-06-HOTFIX-MODAL-STATE-REVISION) ────────────
  // `mode` + `draftValues` are the LOCAL DRAFT only. The committed cart line (line.discount) is never
  // mutated here -- the parent's onSave is the ONLY write path, called solely by Save (handleSave).
  // Switching tabs and Clear edit the draft only; Cancel (onClose) discards the draft and leaves the
  // saved line untouched.
  const num = parseFloat(draftValues[mode]) || 0;

  // Empty/zero override safety: an empty or non-positive draft is treated as NO discount for BOTH the
  // preview and Save. So an empty override previews the original base price (never THB 0.00) and never
  // commits override-0. For every mode, `num <= 0` => effective type 'none' (getLineTotal returns base).
  const effectiveType: ItemDiscountType = num > 0 ? mode : 'none';

  // 7C-UI-06-ENHANCEMENT (Codex fix): the preview total is computed through the SHARED getLineTotal
  // path -- the same pure function that produces the real cart line total -- not a local re-impl of
  // the discount arithmetic. previewLine uses `effectiveType`, so empty/zero never yields a 0 price.
  const previewLine: CartLine = { ...line, discount: { type: effectiveType, val: num } };
  const preview = getLineTotal(previewLine);

  // Save COMMITS only the active mode + its draft value. Empty/zero => onSave('none', 0) (the project
  // convention for "no discount"), so override-0 can never be committed. The RBAC guard additionally
  // ensures a non-manager can never submit an override even via stale internal state.
  const handleSave = () => {
    const safeMode: IdpMode = mode === 'override' && !canOverridePrice ? DEFAULT_MODE : mode;
    onSave(num > 0 ? safeMode : 'none', num);
    onClose();
  };

  // Clear edits the DRAFT ONLY: reset the active mode to the safe default and blank every tab's draft,
  // so the preview returns to the base price. It does NOT call onSave -- the saved cart line stays
  // intact until Save (Clear then Cancel keeps the original discount; Clear then Save removes it).
  const handleClear = () => {
    setMode(DEFAULT_MODE);
    setDraftValues(emptyDraftValues());
    setNumpadOpen(false);
  };

  return (
    <div className="pos-modal-bg" role="dialog" aria-modal="true">
      <div className="pos-item-disc-popup">
        <div>
          <div className="pos-idp-title">แก้ไขราคา / ส่วนลดรายชิ้น</div>
          <div className="pos-idp-prod">{line.productName}</div>
        </div>
        <div className="pos-idp-tabs">
          {availableModes.map((m) => (
            <button
              key={m}
              type="button"
              className={`pos-idp-tab${mode === m ? ' on' : ''}`}
              onClick={() => {
                // Per-tab memory: switch the ACTIVE tab only. Each tab keeps its own draft value, so
                // switching away and back preserves what was typed. Close the numpad so it reseeds
                // from the newly active tab's value on next open. No onSave, no auto-apply.
                setMode(m);
                setNumpadOpen(false);
              }}
            >
              {TAB_LABELS[m]}
            </button>
          ))}
        </div>
        <div className="pos-idp-input-wrap">
          <div className="pos-idp-input-lbl">{IDP_LABELS[mode]}</div>
          <input
            className="pos-idp-input"
            type="number"
            min={0}
            value={draftValues[mode]}
            onChange={(e) => setDraftValues((d) => ({ ...d, [mode]: e.target.value }))}
            onPointerDown={(e) => {
              // Touch/click opens the custom POS numpad instead of the native mobile keyboard,
              // mirroring the bill-discount field. preventDefault suppresses (does not force)
              // native focus so the dialog isn't fighting an on-screen keyboard; physical keyboard
              // (Tab) editing of the field still works for desktop. Discount math is unchanged --
              // the numpad only writes back into `value`, which onSave already parses.
              e.preventDefault();
              setNumpadOpen(true);
            }}
          />
        </div>
        <div className="pos-idp-result">
          <span className="pos-idp-result-lbl">ราคาหลังปรับ</span>
          <span className="pos-idp-result-val">฿{formatMoney(preview)}</span>
        </div>
        {/* Standard dialog footer (7C-UI-06-HOTFIX-MODAL-REDESIGN): subtle ghost Clear on the left,
            Cancel (outline) + Save (primary) grouped on the right with clean spacing. */}
        <div className="pos-idp-footer">
          <button type="button" className="pos-idp-clear" onClick={handleClear}>
            ล้างส่วนลด
          </button>
          <div className="pos-idp-footer-actions">
            <button type="button" className="pos-idp-btn pos-idp-btn-cancel" onClick={onClose}>
              ยกเลิก
            </button>
            <button type="button" className="pos-idp-btn pos-idp-btn-save" onClick={handleSave}>
              บันทึก
            </button>
          </div>
        </div>
      </div>

      {/* UI-06 hotfix Fix 2: custom on-screen numpad for the value field. Reuses the touch-only
          NumpadDialog in decimal/zero mode so it accepts the same values the field parses
          (`parseFloat(...) || 0`). It portals above this modal and writes back into `value` only --
          no discount math, no auto-submit (the existing Save button still applies the discount). */}
      <NumpadDialog
        open={numpadOpen}
        title={IDP_LABELS[mode]}
        initialValue={num}
        allowDecimal
        allowZero
        maxLength={7}
        onClose={() => setNumpadOpen(false)}
        onConfirm={(v) => {
          // The numpad edits only the ACTIVE tab's draft value.
          setDraftValues((d) => ({ ...d, [mode]: String(v) }));
          setNumpadOpen(false);
        }}
      />
    </div>
  );
}
