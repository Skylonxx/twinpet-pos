import type { Branch } from '../../lib/types';

type BranchSelectorProps = {
  branches: Branch[];
  branchId: string;
  loading: boolean;
  error?: Error | null;
  disabled: boolean;
  onChange: (id: string) => void;
  onRetry: () => void;
};

export function BranchSelector({
  branches,
  branchId,
  loading,
  error,
  disabled,
  onChange,
  onRetry,
}: BranchSelectorProps) {
  return (
    <div className="mb-6">
      <label
        htmlFor="branch-sel"
        className="block mb-2 text-sm font-medium text-gray-900 dark:text-white flex items-center gap-1.5"
      >
        <i className="ti ti-map-pin" aria-hidden="true" />
        สาขา
      </label>

      {error ? (
        <div className="flex flex-col items-center justify-center p-4 bg-red-50 border border-red-200 rounded-lg dark:bg-red-900/20 dark:border-red-800">
          <p className="text-sm text-red-600 dark:text-red-400 mb-3 text-center flex items-center gap-2">
            <i className="ti ti-alert-triangle" aria-hidden="true" />
            ไม่สามารถโหลดข้อมูลสาขาได้
          </p>
          <button
            type="button"
            onClick={onRetry}
            disabled={disabled || loading}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 focus:ring-4 focus:ring-red-300 dark:bg-red-600 dark:hover:bg-red-700 dark:focus:ring-red-800 transition-colors disabled:opacity-50"
          >
            <i className="ti ti-refresh mr-2" aria-hidden="true" />
            ลองใหม่อีกครั้ง
          </button>
        </div>
      ) : (
        <select
          id="branch-sel"
          value={branchId}
          disabled={disabled || loading || branches.length === 0}
          onChange={(e) => onChange(e.target.value)}
          className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-primary-500 focus:border-primary-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-primary-500 dark:focus:border-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <option value="">กำลังโหลดสาขา...</option>
          ) : branches.length === 0 ? (
            <option value="">ไม่พบสาขาที่ใช้งานได้</option>
          ) : (
            branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))
          )}
        </select>
      )}
    </div>
  );
}
