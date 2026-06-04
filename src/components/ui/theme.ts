import { createTheme } from 'flowbite-react';

/**
 * Project-wide theme overrides for flowbite-react.
 *
 * Flowbite's default component colors already reference Tailwind's `primary-*`
 * scale, which we bridged to the TwinPet purple in src/index.css (@theme) — so
 * <Button>, <Spinner>, etc. inherit the brand automatically. This adds an
 * explicit `primary` color key (brand --p600) so `<Button color="primary">`
 * reads intentionally and maps to the exact existing primary-button shade.
 */
export const twinpetTheme = createTheme({
  button: {
    color: {
      primary:
        'bg-primary-600 text-white hover:bg-primary-800 focus:ring-4 focus:ring-primary-200',
    },
  },
  // Dark-purple rail matching the original AppShell sidebar. Width + smooth
  // animation live on the root (transition-[width] + width swap via collapsed
  // on/off) so toggling `collapsed` animates 60px ↔ 232px.
  sidebar: {
    root: {
      base: 'h-full transition-[width] duration-200 ease-out',
      collapsed: { on: 'w-[60px]', off: 'w-[232px]' },
      inner: 'flex h-full flex-col gap-1 overflow-hidden bg-[var(--p900)] px-2 py-2.5',
    },
    collapse: {
      button:
        'group flex w-full items-center rounded-lg p-3 text-[13px] font-semibold text-white/55 transition hover:bg-white/10 hover:text-white/90',
      icon: {
        base: 'h-5 w-5 shrink-0 text-center text-xl leading-none text-white/55 transition group-hover:text-white/90',
        open: { off: '', on: 'text-white' },
      },
      label: {
        base: 'ml-3 flex-1 whitespace-nowrap text-left',
        title: 'sr-only',
        icon: { base: 'h-4 w-4 transition', open: { on: 'rotate-180', off: '' } },
      },
      list: 'space-y-1 py-1',
    },
    item: {
      base: 'flex items-center justify-center rounded-lg p-2 text-[12.5px] font-medium text-white/50 transition hover:bg-white/10 hover:text-white/85',
      active: 'bg-[var(--p600)] text-white',
      collapsed: { insideCollapse: 'group w-full pl-7 transition', noIcon: 'font-bold' },
      content: { base: 'flex-1 whitespace-nowrap px-3' },
      icon: {
        base: 'h-4 w-4 shrink-0 text-base leading-none text-white/50 transition group-hover:text-white/85',
        active: 'text-white',
      },
      label: '',
      listItem: '',
    },
    items: { base: 'flex-1 overflow-y-auto overflow-x-hidden' },
    itemGroup: { base: 'mt-0 space-y-1 border-0 pt-0' },
    logo: {
      base: 'mb-2 flex items-center pl-2.5',
      collapsed: {
        on: 'hidden',
        off: 'self-center whitespace-nowrap text-xl font-semibold text-white',
      },
      img: 'mr-3 h-6 sm:h-7',
    },
  },
  // Compact, high-density POS tables (replaces the legacy .sr-table look):
  // tight padding, small uppercase grey headers, subtle row borders + hover.
  table: {
    root: {
      base: 'w-full text-left text-[13px] text-[var(--text-primary)]',
      // Flowbite renders an absolute bg-white "shadow" layer behind the table; its
      // deep-merge IGNORES an empty-string override (leaving the default opaque
      // white panel that covered our rows). `hidden` (display:none) reliably
      // removes it — these tables sit inside .sr-card which already has the card chrome.
      shadow: 'hidden',
    },
    head: {
      base: 'group/head text-[11px] uppercase tracking-[0.05em] text-[var(--text-muted)]',
      cell: {
        base: 'whitespace-nowrap border-b border-[var(--border)] bg-[var(--g50)] px-3 py-2 font-medium',
      },
    },
    body: {
      base: 'group/body',
      cell: { base: 'px-3 py-2 align-middle' },
    },
    row: {
      base: 'group/row border-b border-[var(--border)] last:border-0',
      hovered: 'hover:bg-[var(--g50)]',
    },
  },
});
