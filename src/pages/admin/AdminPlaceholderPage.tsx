import { useLocation } from 'react-router-dom';

const PLACEHOLDER_COPY: Record<string, { title: string; icon: string; hint: string }> = {
  '/admin': {
    title: 'Admin Dashboard Placeholder',
    icon: 'ti-layout-dashboard',
    hint: 'ภาพรวมระบบจะแสดงที่นี่',
  },
  '/admin/branches': {
    title: 'Branches Placeholder',
    icon: 'ti-building-store',
    hint: 'จัดการสาขาจะแสดงที่นี่',
  },
  '/admin/staff': {
    title: 'Staff Placeholder',
    icon: 'ti-users',
    hint: 'จัดการพนักงานจะแสดงที่นี่',
  },
  '/admin/products': {
    title: 'Products Placeholder',
    icon: 'ti-package',
    hint: 'จัดการสินค้าจะแสดงที่นี่',
  },
};

export default function AdminPlaceholderPage() {
  const { pathname } = useLocation();
  const copy = PLACEHOLDER_COPY[pathname] ?? PLACEHOLDER_COPY['/admin']!;

  return (
    <div className="admin-layout-placeholder">
      <div className="admin-layout-placeholder-card">
        <i className={`ti ${copy.icon}`} aria-hidden="true" />
        <h1>{copy.title}</h1>
        <p>{copy.hint}</p>
      </div>
    </div>
  );
}
