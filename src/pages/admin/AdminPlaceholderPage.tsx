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
    <div className="flex flex-1 items-center justify-center px-6 py-8">
      <div className="rounded-xl border-[0.5px] border-[var(--g200)] bg-white px-14 py-12 text-center shadow-[0_1px_3px_rgba(26,26,46,0.04)]">
        <i className={`ti ${copy.icon} mb-4 block text-[40px] text-[var(--p600)]`} aria-hidden="true" />
        <h1 className="mb-2 text-xl font-semibold text-[var(--text-primary)]">{copy.title}</h1>
        <p className="text-sm text-[#5f5e5a]">{copy.hint}</p>
      </div>
    </div>
  );
}
