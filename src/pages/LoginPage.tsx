import { useCallback, useEffect, useRef, useState } from 'react';
import { getBranchLabel, useActiveBranches } from '../lib/branches';
import { useAuth } from '../lib/hooks/useAuth';
import type { User, UserRole } from '../lib/types';
import { PinPad } from '../components/auth/PinPad';
import { BranchSelector } from '../components/auth/BranchSelector';

// Note: Removing LoginPage.css as the layout has been fully transitioned to Flowbite/Tailwind primitives.

type LoginMode = 'pin' | 'password';

type Toast = {
  id: number;
  message: string;
  type: 'info' | 'error';
};

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  manager: 'Manager',
  staff: 'Staff',
};

function formatRole(role: UserRole): string {
  return ROLE_LABELS[role] ?? role;
}

export default function LoginPage() {
  const { loginWithPin, loginWithUsername, completeLogin } = useAuth();
  const { branches, loading: branchesLoading, error: branchesError, reload: reloadBranches } = useActiveBranches();

  const [mode, setMode] = useState<LoginMode>('pin');
  const [branchId, setBranchId] = useState<string>('');
  const [pinValue, setPinValue] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pinError, setPinError] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pinShake, setPinShake] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [successUser, setSuccessUser] = useState<User | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pinSubmitting = useRef(false);

  useEffect(() => {
    if (branchesLoading) return;
    // Removing full branch object logging in production
  }, [branchesLoading]);

  useEffect(() => {
    if (branches.length === 0) return;
    setBranchId((current) =>
      current && branches.some((b) => b.id === current) ? current : branches[0]!.id,
    );
  }, [branches]);

  const branchLabel = branchId
    ? (branches.find((b) => b.id === branchId)?.name ?? getBranchLabel(branchId))
    : '—';

  const showToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2600);
  }, []);

  const clearErrors = useCallback(() => {
    setPinError(false);
    setPwError(null);
    setPinShake(false);
  }, []);

  const switchMode = useCallback(
    (next: LoginMode) => {
      setMode(next);
      clearErrors();
      setPinValue('');
      pinSubmitting.current = false;
    },
    [clearErrors],
  );

  const handleSuccess = useCallback(
    (user: User) => {
      setSuccessUser(user);
      // Global Admins (branchIds: ['ALL']) are not tied to a physical branch.
      // Pass 'ALL' so the session is created correctly and PosShellRoute can
      // redirect them straight to /admin.
      const effectiveBranchId = user.branchIds.includes('ALL') ? 'ALL' : branchId;
      window.setTimeout(() => {
        void completeLogin(user, effectiveBranchId).then(() => {
          setSuccessUser(null);
        });
      }, 2200);
    },
    [branchId, completeLogin],
  );

  const submitPin = useCallback(
    async (pin: string) => {
      // SECURITY FIX: Removed raw PIN logging. Replaced with safe telemetry.
      console.log('[login] Submit clicked', { branchId, pinLength: pin.length, mode });

      if (pinSubmitting.current) {
        console.warn('[login] PIN submit ignored — already in progress');
        return;
      }

      if (branchesLoading) {
        showToast('กำลังโหลดรายการสาขา กรุณารอสักครู่', 'error');
        return;
      }

      if (!branchId || branches.length === 0) {
        showToast('กรุณาเลือกสาขาก่อนกรอก PIN', 'error');
        setPinValue('');
        return;
      }

      const normalizedPin = pin.trim();
      if (!/^\d{4}$/.test(normalizedPin)) {
        showToast('PIN ต้องเป็นตัวเลข 4 หลัก', 'error');
        setPinValue('');
        return;
      }

      pinSubmitting.current = true;
      setIsLoading(true);
      clearErrors();

      try {
        const user = await loginWithPin(normalizedPin, branchId);
        handleSuccess(user);
      } catch (err) {
        console.error('[login] PIN submit failed', err);
        const message =
          err instanceof Error ? err.message : 'PIN ไม่ถูกต้อง กรุณาลองใหม่';
        showToast(message, 'error');
        setPinError(true);
        setPinShake(true);
        window.setTimeout(() => setPinShake(false), 300);
        setPinValue('');
      } finally {
        setIsLoading(false);
        pinSubmitting.current = false;
      }
    },
    [
      branchId,
      branches.length,
      branchesLoading,
      clearErrors,
      handleSuccess,
      loginWithPin,
      mode,
      showToast,
    ],
  );

  const handlePinPress = useCallback(
    (digit: string) => {
      if (isLoading || pinValue.length >= 4) return;
      clearErrors();
      const next = pinValue + digit;
      setPinValue(next);
      if (next.length === 4) {
        window.setTimeout(() => void submitPin(next), 200);
      }
    },
    [clearErrors, isLoading, pinValue, submitPin],
  );

  const handlePinDel = useCallback(() => {
    if (isLoading) return;
    clearErrors();
    setPinValue((v) => v.slice(0, -1));
    pinSubmitting.current = false;
  }, [clearErrors, isLoading]);

  const handlePasswordLogin = useCallback(async () => {
    if (!branchId) {
      setPwError('กรุณาเลือกสาขา');
      return;
    }
    const normalizedUsername = username.trim().toLowerCase();
    if (!normalizedUsername || !password) {
      setPwError('กรุณากรอก Username และ Password');
      return;
    }

    setIsLoading(true);
    clearErrors();

    try {
      const user = await loginWithUsername(normalizedUsername, password, branchId);
      handleSuccess(user);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Username หรือ Password ไม่ถูกต้อง';
      setPwError(message);
    } finally {
      setIsLoading(false);
    }
  }, [
    branchId,
    clearErrors,
    handleSuccess,
    loginWithUsername,
    password,
    username,
  ]);

  useEffect(() => {
    if (successUser) {
      pinSubmitting.current = false;
      setPinValue('');
    }
  }, [successUser]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col md:flex-row font-sans">
      <aside className="md:w-[400px] shrink-0 bg-slate-900 flex flex-col p-8 md:p-10 relative overflow-hidden text-white border-r border-slate-800">
        <div className="flex items-center gap-3 mb-auto relative z-10">
          <div className="w-10 h-10 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-xl shadow-sm">
            🐾
          </div>
          <div>
            <div className="text-lg font-semibold tracking-wide">TwinPet POS</div>
            <div className="text-[11px] text-white/60 uppercase tracking-widest mt-0.5">Point of Sale System</div>
          </div>
        </div>

        <div className="flex-1 flex flex-col justify-center relative z-10 py-10 md:py-0">
          <h1 className="text-2xl font-semibold leading-tight mb-4 text-white">
            ระบบขายหน้าร้าน<br />สำหรับร้านสัตว์เลี้ยง
          </h1>
          <p className="text-sm text-slate-400 leading-relaxed max-w-[300px] mb-8">
            จัดการสต็อก FIFO, รายงานกำไร, และระบบสมาชิกครบในที่เดียว
          </p>
          <ul className="flex flex-col gap-4">
            <li className="flex items-center gap-3 text-sm text-slate-300">
              <span className="w-8 h-8 rounded bg-slate-800 flex items-center justify-center shrink-0">
                <i className="ti ti-stack text-base" aria-hidden="true" />
              </span>
              ระบบสต็อก FIFO & ต้นทุนแม่นยำ
            </li>
            <li className="flex items-center gap-3 text-sm text-slate-300">
              <span className="w-8 h-8 rounded bg-slate-800 flex items-center justify-center shrink-0">
                <i className="ti ti-chart-bar text-base" aria-hidden="true" />
              </span>
              รายงานยอดขายและกำไรแบบ Real-time
            </li>
            <li className="flex items-center gap-3 text-sm text-slate-300">
              <span className="w-8 h-8 rounded bg-slate-800 flex items-center justify-center shrink-0">
                <i className="ti ti-users text-base" aria-hidden="true" />
              </span>
              จัดการสมาชิกและสิทธิ์พนักงาน
            </li>
            <li className="flex items-center gap-3 text-sm text-slate-300">
              <span className="w-8 h-8 rounded bg-slate-800 flex items-center justify-center shrink-0">
                <i className="ti ti-building-store text-base" aria-hidden="true" />
              </span>
              รองรับหลายสาขา
            </li>
          </ul>
        </div>

        <div className="text-[11px] text-slate-500 mt-auto pt-6 relative z-10">
          TwinPet POS v2.4.1 · © 2026 TwinPet Co., Ltd.
        </div>
      </aside>

      <main className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900 p-6 md:p-12 overflow-y-auto">
        <div className="w-full max-w-md bg-white dark:bg-gray-800 rounded-lg shadow-md border border-gray-200 dark:border-gray-700 p-6 sm:p-8">
          <header className="mb-8 border-b border-gray-100 dark:border-gray-700 pb-4">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">เข้าสู่ระบบ</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">เลือกสาขาและกรอกข้อมูลเพื่อเริ่มงาน</p>
          </header>

          <BranchSelector
            branches={branches}
            branchId={branchId}
            loading={branchesLoading}
            error={branchesError}
            disabled={isLoading}
            onRetry={() => void reloadBranches()}
            onChange={(val) => {
              setBranchId(val);
              clearErrors();
              setPinValue('');
              pinSubmitting.current = false;
            }}
          />

          <div className="flex bg-gray-100 dark:bg-gray-700/50 rounded-lg p-1 mb-8" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'password'}
              className={`flex-1 py-2 px-3 text-sm font-medium rounded-md transition-all flex items-center justify-center gap-2 ${
                mode === 'password'
                  ? 'bg-white dark:bg-gray-600 text-primary-600 dark:text-primary-400 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
              onClick={() => switchMode('password')}
            >
              <i className="ti ti-lock" aria-hidden="true" />
              Username
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'pin'}
              className={`flex-1 py-2 px-3 text-sm font-medium rounded-md transition-all flex items-center justify-center gap-2 ${
                mode === 'pin'
                  ? 'bg-white dark:bg-gray-600 text-primary-600 dark:text-primary-400 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
              onClick={() => switchMode('pin')}
            >
              <i className="ti ti-keyframe" aria-hidden="true" />
              Quick PIN
            </button>
          </div>

          {mode === 'password' && (
            <div className="space-y-5 animate-fadeIn">
              <div>
                <label htmlFor="inp-user" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">
                  Username
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none">
                    <i className="ti ti-user text-gray-400 dark:text-gray-500" aria-hidden="true" />
                  </div>
                  <input
                    type="text"
                    id="inp-user"
                    className={`bg-gray-50 border text-gray-900 text-sm rounded-lg focus:ring-primary-500 focus:border-primary-500 block w-full pl-10 p-2.5 dark:bg-gray-700 dark:placeholder-gray-400 dark:text-white dark:focus:ring-primary-500 dark:focus:border-primary-500 ${
                      pwError ? 'border-red-500 dark:border-red-500' : 'border-gray-300 dark:border-gray-600'
                    }`}
                    placeholder="กรอก username"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      clearErrors();
                    }}
                    disabled={isLoading}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="inp-pass" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">
                  Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none">
                    <i className="ti ti-lock text-gray-400 dark:text-gray-500" aria-hidden="true" />
                  </div>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    id="inp-pass"
                    className={`bg-gray-50 border text-gray-900 text-sm rounded-lg focus:ring-primary-500 focus:border-primary-500 block w-full pl-10 p-2.5 pr-10 dark:bg-gray-700 dark:placeholder-gray-400 dark:text-white dark:focus:ring-primary-500 dark:focus:border-primary-500 ${
                      pwError ? 'border-red-500 dark:border-red-500' : 'border-gray-300 dark:border-gray-600'
                    }`}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      clearErrors();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handlePasswordLogin();
                    }}
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 flex items-center pr-3.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 focus:outline-none"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                  >
                    <i className={`ti ${showPassword ? 'ti-eye-off' : 'ti-eye'}`} />
                  </button>
                </div>
              </div>

              {pwError && (
                <p className="mt-2 text-sm text-red-600 dark:text-red-500 font-medium flex items-center gap-1">
                  <i className="ti ti-alert-circle" aria-hidden="true" />
                  {pwError ?? 'Username หรือ Password ไม่ถูกต้อง'}
                </p>
              )}

              <button
                type="button"
                className="w-full text-white bg-primary-600 hover:bg-primary-700 focus:ring-4 focus:outline-none focus:ring-primary-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center flex justify-center items-center gap-2 dark:bg-primary-600 dark:hover:bg-primary-700 dark:focus:ring-primary-800 disabled:opacity-50 disabled:cursor-not-allowed mt-2 transition-colors"
                onClick={() => void handlePasswordLogin()}
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <svg aria-hidden="true" role="status" className="inline w-4 h-4 text-white animate-spin" viewBox="0 0 100 101" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z" fill="#E5E7EB"/>
                      <path d="M93.9676 39.0409C96.393 38.4018 97.6632 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6799 93.9676 39.0409Z" fill="currentColor"/>
                    </svg>
                    กำลังตรวจสอบ...
                  </>
                ) : (
                  <>
                    <i className="ti ti-login" aria-hidden="true" />
                    เข้าสู่ระบบ
                  </>
                )}
              </button>

              <div className="flex items-center justify-between mt-4">
                <button
                  type="button"
                  className="text-sm font-medium text-primary-600 hover:underline dark:text-primary-500"
                  onClick={() => showToast('ติดต่อผู้ดูแลระบบเพื่อรีเซ็ต Password', 'info')}
                >
                  <i className="ti ti-help-circle" aria-hidden="true" /> ลืม Password?
                </button>
                <button
                  type="button"
                  className="text-sm font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                  onClick={() => switchMode('pin')}
                >
                  ใช้ Quick PIN แทน
                </button>
              </div>
            </div>
          )}

          {mode === 'pin' && (
            <div className="animate-fadeIn">
              <PinPad
                pinValue={pinValue}
                onPinPress={handlePinPress}
                onPinDel={handlePinDel}
                onSubmit={() => void submitPin(pinValue)}
                isLoading={isLoading}
                pinError={pinError}
                pinShake={pinShake}
              />
              <div className="text-center mt-6">
                <button
                  type="button"
                  className="text-sm font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors"
                  onClick={() => switchMode('password')}
                >
                  ใช้ Username/Password แทน
                </button>
              </div>
            </div>
          )}

          <div className="mt-8 pt-6 border-t border-gray-100 dark:border-gray-700/50">
            <p className="text-xs text-gray-400 dark:text-gray-500 text-center">
              v2.4.1 · สาขา {branchLabel}
              {import.meta.env.DEV && (
                <span className="block mt-1.5 text-[10px]">
                  Dev: somchai/1234 · suda/2345 · wichai/3456 · nongnuch/4567 · globaladmin/9999 (ALL)
                </span>
              )}
            </p>
          </div>
        </div>
      </main>

      {/* Success Overlay overlay matching Flowbite backdrop */}
      <div
        className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm transition-all duration-500 ${
          successUser ? 'opacity-100 visible' : 'opacity-0 invisible pointer-events-none'
        }`}
        role="status"
        aria-live="polite"
      >
        <div className="w-20 h-20 rounded-full bg-green-100 dark:bg-green-900/30 text-green-500 dark:text-green-400 flex items-center justify-center text-4xl mb-6 shadow-xl shadow-green-500/20 scale-in">
          <i className="ti ti-check" aria-hidden="true" />
        </div>
        <div className="text-2xl font-bold text-gray-900 dark:text-white mb-2 slide-up-fade">
          {successUser
            ? `ยินดีต้อนรับ, ${successUser.firstName} ${successUser.lastName}`
            : 'ยินดีต้อนรับ'}
        </div>
        <div className="text-gray-500 dark:text-gray-400 font-medium slide-up-fade-delay">
          {successUser
            ? successUser.branchIds.includes('ALL')
              ? 'Global Admin · ทุกสาขา'
              : `${formatRole(successUser.role)} · สาขา ${branchLabel}`
            : 'กำลังเข้าสู่ระบบ...'}
        </div>
      </div>

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-center w-full max-w-xs p-4 text-gray-500 bg-white rounded-lg shadow dark:text-gray-400 dark:bg-gray-800 animate-slideInRight border ${
              t.type === 'error' ? 'border-red-100 dark:border-red-900/50' : 'border-gray-100 dark:border-gray-700'
            }`}
          >
            <div
              className={`inline-flex items-center justify-center shrink-0 w-8 h-8 rounded-lg ${
                t.type === 'error'
                  ? 'text-red-500 bg-red-100 dark:bg-red-800 dark:text-red-200'
                  : 'text-blue-500 bg-blue-100 dark:bg-blue-800 dark:text-blue-200'
              }`}
            >
              <i
                className={`ti ti-${t.type === 'error' ? 'alert-circle' : 'info-circle'} text-lg`}
                aria-hidden="true"
              />
            </div>
            <div className="ml-3 text-sm font-normal">{t.message}</div>
          </div>
        ))}
      </div>
      
      {/* Required for simple custom animations not covered by tailwind defaults */}
      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideInRight { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        .animate-fadeIn { animation: fadeIn 0.3s ease-out; }
        .animate-slideInRight { animation: slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
        .scale-in { animation: scaleIn 0.5s cubic-bezier(0.16, 1, 0.3, 1); }
        .slide-up-fade { animation: slideUpFade 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards; opacity: 0; }
        .slide-up-fade-delay { animation: slideUpFade 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.1s forwards; opacity: 0; }
        @keyframes scaleIn { 0% { transform: scale(0.5); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
        @keyframes slideUpFade { 0% { transform: translateY(20px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
      `}</style>
    </div>
  );
}
