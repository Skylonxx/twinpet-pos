import { type MouseEvent as ReactMouseEvent, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  SETTINGS_NAV_GROUPS,
  navItemBySlug,
  type SettingsOutletContext,
  type SettingsScope,
} from '../lib/settings/settingsNav';
import './SettingsLayout.css';

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
    <div className="pc-settings-page">
      <div className="pc-settings-topbar">
        <div className="pc-settings-topbar-icon">
          <i className="ti ti-settings" aria-hidden="true" />
        </div>
        <div>
          <div className="pc-settings-topbar-title">ศูนย์ตั้งค่าระบบ</div>
          <div className="pc-settings-topbar-sub">จัดการการตั้งค่าทั่วไป เอกสาร และสาขา</div>
        </div>
      </div>

      <div className="pc-settings-body">
        <aside className="pc-settings-sidebar" aria-label="เมนูตั้งค่า">
          <nav className="pc-settings-nav">
            {SETTINGS_NAV_GROUPS.map((group) => (
              <div key={group.header} className="pc-settings-nav-group">
                <div className="pc-settings-nav-grouptitle">{group.header}</div>
                {group.items.map((item) => (
                  <NavLink
                    key={item.slug}
                    to={`/settings/${item.slug}`}
                    onClick={(e) => guardNav(e, item.scope)}
                    className={({ isActive }) =>
                      `pc-settings-nav-item${isActive ? ' active' : ''}`
                    }
                  >
                    <i className={`ti ${item.icon}`} aria-hidden="true" />
                    <span className="pc-settings-nav-label">{item.label}</span>
                    {item.badge ? (
                      <span className="pc-settings-nav-badge">{item.badge}</span>
                    ) : null}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        <div className="pc-settings-main">
          <Outlet context={{ setDirty } satisfies SettingsOutletContext} />
        </div>
      </div>
    </div>
  );
}
