import React from 'react';
import type { Branch } from '../../lib/types';

type BranchSelectorProps = {
  branches: Branch[];
  branchId: string;
  loading: boolean;
  disabled: boolean;
  onChange: (id: string) => void;
};

export function BranchSelector({
  branches,
  branchId,
  loading,
  disabled,
  onChange,
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
    </div>
  );
}
