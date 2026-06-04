import { type MouseEvent as ReactMouseEvent, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  SETTINGS_NAV_GROUPS,
  navItemBySlug,
  type SettingsOutletContext,
  type SettingsScope,
} from '../lib/settings/settingsNav';

export default function SettingsLayout() {
  const location = useLocation();
  // Unsaved-changes flag reported by the active page (branch or system scope).
  const [dirty, setDirty] = useState(false);

  const currentSlug = location.pathname.split('/').pop() ?? '';
  const currentScope = navItemBySlug(currentSlug)?.scope;

  // Only switching SCOPE remounts the page (and loses edits); navigating within
  // the same scope keeps the component mounted, so no warning is needed there.
  const guardNav = (e: ReactMouseEvent<HTMLAnchorElement>, targetScope: SettingsScope) => {
    if (dirty && targetScope !== currentScope) {
      const proceed = window.confirm(
        'คุณมีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก ต้องการละทิ้งหรือไม่?',
      );
      if (!proceed) {
        e.preventDefault();
        return;
      }
      setDirty(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--g50)] font-sans text-[var(--text-primary)]">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-[var(--g200)] bg-white px-5">
        <div className="flex h-[34px] w-[34px] items-center justify-center rounded-lg bg-[var(--p50)] text-[18px] text-[var(--p600)]">
          <i className="ti ti-settings" aria-hidden="true" />
        </div>
        <div>
          <div className="text-[15px] font-semibold">ศูนย์ตั้งค่าระบบ</div>
          <div className="text-xs text-[#5f5e5a]">จัดการการตั้งค่าทั่วไป เอกสาร และสาขา</div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className="flex w-60 shrink-0 flex-col overflow-y-auto border-r-[0.5px] border-[var(--g200)] bg-white"
          aria-label="เมนูตั้งค่า"
        >
          <nav className="flex flex-col gap-0.5 px-2 pb-4 pt-2">
            {SETTINGS_NAV_GROUPS.map((group) => (
              <div key={group.header} className="mt-2.5 flex flex-col gap-0.5 first:mt-0">
                <div className="px-3 pb-1.5 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#888780]">
                  {group.header}
                </div>
                {group.items.map((item) => (
                  <NavLink
                    key={item.slug}
                    to={`/settings/${item.slug}`}
                    onClick={(e) => guardNav(e, item.scope)}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] no-underline transition ${
                        isActive
                          ? 'bg-[var(--p50)] font-medium text-[var(--p600)]'
                          : 'text-[#5f5e5a] hover:bg-[var(--g50)] hover:text-[var(--text-primary)]'
                      }`
                    }
                  >
                    <i className={`ti ${item.icon} shrink-0 text-base`} aria-hidden="true" />
                    <span className="min-w-0 flex-1">{item.label}</span>
                    {item.badge ? (
                      <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[#e24b4a] px-[5px] text-[11px] font-semibold text-white">
                        {item.badge}
                      </span>
                    ) : null}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet context={{ setDirty } satisfies SettingsOutletContext} />
        </div>
      </div>
    </div>
  );
}
