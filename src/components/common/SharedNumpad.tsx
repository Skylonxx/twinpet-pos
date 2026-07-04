import './SharedNumpad.css';

// UI-10-A · SharedNumpad — a stateless, presentational key-grid primitive.
//
// This component owns NOTHING but rendering + semantic key emission. It holds no
// value state, does no numeric parsing, does no formatting, owns no confirm
// action, mounts no portal, and attaches no global/keyboard listeners. Every
// press is forwarded to the caller through `onKey` / accessory `onPress`, so all
// buffer, parsing, formatting, routing, validation and confirm logic stays with
// the consuming surface (PaymentModal, NumpadDialog, future cart/inventory
// panels). It is intentionally unused by production code in this packet.

export type NumpadKey =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '.'
  | 'C'
  | '⌫';

export type NumpadLayout = 'grid-3x4' | 'grid-4x5-payment';

/**
 * A caller-owned cell placed into the grid alongside the digit keys (e.g. the
 * PaymentModal banknote column or the fill-remaining row). SharedNumpad renders
 * it and calls `onPress` on activation; it applies no semantics of its own.
 */
export type NumpadAccessory = {
  id: string;
  label: string;
  gridRow: number;
  gridColumn: string;
  variant: 'banknote' | 'fill' | 'action';
  ariaLabel?: string;
  disabled?: boolean;
  onPress: () => void;
};

export type SharedNumpadProps = {
  layout: NumpadLayout;
  /** Fired with the semantic key on every enabled key activation. */
  onKey: (key: NumpadKey) => void;
  /** Whole-pad gate — disables every key AND every accessory. */
  disabled?: boolean;
  /** Per-key gate — disables only the listed keys. */
  disabledKeys?: Partial<Record<NumpadKey, boolean>>;
  /** Caller-owned extra cells (banknote / fill / action). */
  accessories?: NumpadAccessory[];
  /** Class namespace (default `snp`). Lets a consumer reuse its own CSS. */
  classPrefix?: string;
  ariaLabel?: string;
  'data-testid'?: string;
};

type KeyCell = { key: NumpadKey; row: number; col: number };

// Fixed key matrices per layout. Both matrices together expose every supported
// key (digits, decimal point, clear, backspace); a consumer picks the layout its
// surface needs. No layout carries any behavior — only placement.
const LAYOUT_KEYS: Record<NumpadLayout, KeyCell[]> = {
  'grid-3x4': [
    { key: '7', row: 1, col: 1 },
    { key: '8', row: 1, col: 2 },
    { key: '9', row: 1, col: 3 },
    { key: '4', row: 2, col: 1 },
    { key: '5', row: 2, col: 2 },
    { key: '6', row: 2, col: 3 },
    { key: '1', row: 3, col: 1 },
    { key: '2', row: 3, col: 2 },
    { key: '3', row: 3, col: 3 },
    { key: 'C', row: 4, col: 1 },
    { key: '0', row: 4, col: 2 },
    { key: '⌫', row: 4, col: 3 },
  ],
  // Mirrors the PaymentModal 4×5 footprint: digits 1–9 (rows 1–3, cols 1–3),
  // then `.` `0` `⌫` on row 4, and Clear on row 5 col 3. Columns 1–2 of row 5
  // and column 4 (all rows) are left open for caller accessories.
  'grid-4x5-payment': [
    { key: '1', row: 1, col: 1 },
    { key: '2', row: 1, col: 2 },
    { key: '3', row: 1, col: 3 },
    { key: '4', row: 2, col: 1 },
    { key: '5', row: 2, col: 2 },
    { key: '6', row: 2, col: 3 },
    { key: '7', row: 3, col: 1 },
    { key: '8', row: 3, col: 2 },
    { key: '9', row: 3, col: 3 },
    { key: '.', row: 4, col: 1 },
    { key: '0', row: 4, col: 2 },
    { key: '⌫', row: 4, col: 3 },
    { key: 'C', row: 5, col: 3 },
  ],
};

// The backspace glyph is not descriptive to a screen reader, so it carries a
// label; the rest read their own visible character.
const KEY_ARIA: Partial<Record<NumpadKey, string>> = {
  '⌫': 'ลบตัวเลขล่าสุด',
};

const isActionKey = (key: NumpadKey): boolean => key === 'C' || key === '⌫';

export default function SharedNumpad({
  layout,
  onKey,
  disabled = false,
  disabledKeys,
  accessories = [],
  classPrefix = 'snp',
  ariaLabel,
  'data-testid': dataTestId,
}: SharedNumpadProps) {
  const cells = LAYOUT_KEYS[layout];

  return (
    <div
      className={`${classPrefix}-grid ${classPrefix}-grid--${layout}`}
      role="group"
      aria-label={ariaLabel}
      data-testid={dataTestId}
    >
      {cells.map((cell) => (
        <button
          key={cell.key}
          type="button"
          className={`${classPrefix}-btn${isActionKey(cell.key) ? ` ${classPrefix}-btn--action` : ''}`}
          style={{ gridRow: cell.row, gridColumn: cell.col }}
          disabled={disabled || Boolean(disabledKeys?.[cell.key])}
          aria-label={KEY_ARIA[cell.key]}
          onClick={() => onKey(cell.key)}
        >
          {cell.key}
        </button>
      ))}

      {accessories.map((acc) => (
        <button
          key={acc.id}
          type="button"
          className={`${classPrefix}-btn ${classPrefix}-btn--${acc.variant}`}
          style={{ gridRow: acc.gridRow, gridColumn: acc.gridColumn }}
          disabled={disabled || Boolean(acc.disabled)}
          aria-label={acc.ariaLabel}
          onClick={acc.onPress}
        >
          {acc.label}
        </button>
      ))}
    </div>
  );
}
