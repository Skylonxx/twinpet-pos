import { NavLink, Outlet } from 'react-router-dom';
import './SettingsLayout.css';

const SETTINGS_NAV = [
  {
    path: '/settings/document',
    label: 'ตั้งค่าทั่วไป & เอกสาร',
    icon: 'ti-file-settings',
  },
  {
    path: '/settings/branch',
    label: 'ตั้งค่าสาขา & POS',
    icon: 'ti-building-store',
  },
] as const;

export default function SettingsLayout() {
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
          <div className="pc-settings-sidebar-header">เมนูตั้งค่า</div>
          <nav className="pc-settings-nav">
            {SETTINGS_NAV.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  `pc-settings-nav-item${isActive ? ' active' : ''}`
                }
              >
                <i className={`ti ${item.icon}`} aria-hidden="true" />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <div className="pc-settings-main">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
