import { useCallback, useEffect, useRef, useState } from 'react';
import { BRANCH_OPTIONS, getBranchLabel } from '../lib/branches';
import { useAuth } from '../lib/hooks/useAuth';
import type { User, UserRole } from '../lib/types';
import './LoginPage.css';

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

  const [mode, setMode] = useState<LoginMode>('pin');
  const [branchId, setBranchId] = useState<string>(BRANCH_OPTIONS[0]!.id);
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

  const branchLabel = getBranchLabel(branchId);

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
      window.setTimeout(() => {
        void completeLogin(user, branchId).then(() => {
          setSuccessUser(null);
        });
      }, 2200);
    },
    [branchId, completeLogin],
  );

  const submitPin = useCallback(
    async (pin: string) => {
      if (pinSubmitting.current) return;
      pinSubmitting.current = true;
      setIsLoading(true);
      clearErrors();

      try {
        const user = await loginWithPin(pin, branchId);
        handleSuccess(user);
      } catch {
        setPinError(true);
        setPinShake(true);
        window.setTimeout(() => setPinShake(false), 300);
        setPinValue('');
        pinSubmitting.current = false;
      } finally {
        setIsLoading(false);
      }
    },
    [branchId, clearErrors, handleSuccess, loginWithPin],
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
    <div className="login-page">
      <div className="login-shell">
        <aside className="login-left-panel">
          <div className="login-brand">
            <div className="login-brand-icon" aria-hidden="true">
              🐾
            </div>
            <div>
              <div className="login-brand-name">TwinPet POS</div>
              <div className="login-brand-sub">Point of Sale System</div>
            </div>
          </div>

          <div className="login-hero-area">
            <h1 className="login-hero-headline">
              ระบบขายหน้าร้าน
              <br />
              สำหรับร้านสัตว์เลี้ยง
            </h1>
            <p className="login-hero-sub">
              จัดการสต็อก FIFO, รายงานกำไร, และระบบสมาชิกครบในที่เดียว
            </p>
            <ul className="login-feature-list">
              <li className="login-feature-item">
                <span className="login-feature-dot">
                  <i className="ti ti-stack" aria-hidden="true" />
                </span>
                ระบบสต็อก FIFO &amp; ต้นทุนแม่นยำ
              </li>
              <li className="login-feature-item">
                <span className="login-feature-dot">
                  <i className="ti ti-chart-bar" aria-hidden="true" />
                </span>
                รายงานยอดขายและกำไรแบบ Real-time
              </li>
              <li className="login-feature-item">
                <span className="login-feature-dot">
                  <i className="ti ti-users" aria-hidden="true" />
                </span>
                จัดการสมาชิกและสิทธิ์พนักงาน
              </li>
              <li className="login-feature-item">
                <span className="login-feature-dot">
                  <i className="ti ti-building-store" aria-hidden="true" />
                </span>
                รองรับหลายสาขา
              </li>
            </ul>
          </div>

          <div className="login-left-footer">
            TwinPet POS v2.4.1 · © 2026 TwinPet Co., Ltd.
          </div>
        </aside>

        <main className="login-right-panel">
          <div className="login-box">
            <header className="login-header">
              <h2 className="login-title">เข้าสู่ระบบ</h2>
              <p className="login-sub">เลือกสาขาและกรอกข้อมูลเพื่อเริ่มงาน</p>
            </header>

            <div className="login-branch-select-wrap">
              <label className="login-branch-select-label" htmlFor="branch-sel">
                <i className="ti ti-map-pin" style={{ fontSize: 12 }} aria-hidden="true" />{' '}
                สาขา
              </label>
              <select
                id="branch-sel"
                className="login-branch-select"
                value={branchId}
                onChange={(e) => {
                  setBranchId(e.target.value);
                  clearErrors();
                  setPinValue('');
                  pinSubmitting.current = false;
                }}
              >
                {BRANCH_OPTIONS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="login-mode-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'password'}
                className={`login-mode-tab${mode === 'password' ? ' active' : ''}`}
                onClick={() => switchMode('password')}
              >
                <i className="ti ti-lock" aria-hidden="true" />
                Username / Password
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'pin'}
                className={`login-mode-tab${mode === 'pin' ? ' active' : ''}`}
                onClick={() => switchMode('pin')}
              >
                <i className="ti ti-keyframe" aria-hidden="true" />
                Quick PIN
              </button>
            </div>

            {mode === 'password' && (
              <div id="password-panel">
                <div className="login-form-group">
                  <label className="login-form-label" htmlFor="inp-user">
                    Username
                  </label>
                  <div className="login-form-input-wrap">
                    <i className="ti ti-user pre" aria-hidden="true" />
                    <input
                      id="inp-user"
                      className={`login-form-input${pwError ? ' error' : ''}`}
                      type="text"
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

                <div className="login-form-group">
                  <label className="login-form-label" htmlFor="inp-pass">
                    Password
                  </label>
                  <div className="login-form-input-wrap">
                    <i className="ti ti-lock pre" aria-hidden="true" />
                    <input
                      id="inp-pass"
                      className={`login-form-input has-suf${pwError ? ' error' : ''}`}
                      type={showPassword ? 'text' : 'password'}
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
                    <i
                      className={`ti ${showPassword ? 'ti-eye-off' : 'ti-eye'} suf`}
                      role="button"
                      tabIndex={0}
                      aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                      onClick={() => setShowPassword((v) => !v)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          setShowPassword((v) => !v);
                        }
                      }}
                    />
                  </div>
                </div>

                <div className={`login-error-msg${pwError ? ' show' : ''}`}>
                  <i className="ti ti-alert-circle" aria-hidden="true" />
                  <span>{pwError ?? 'Username หรือ Password ไม่ถูกต้อง'}</span>
                </div>

                <button
                  type="button"
                  className={`login-btn-login${isLoading ? ' loading' : ''}`}
                  onClick={() => void handlePasswordLogin()}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <span className="spinner" />
                      กำลังตรวจสอบ...
                    </>
                  ) : (
                    <>
                      <i className="ti ti-login" aria-hidden="true" />
                      เข้าสู่ระบบ
                    </>
                  )}
                </button>

                <div className="login-login-help">
                  <button
                    type="button"
                    className="login-link-btn"
                    onClick={() =>
                      showToast('ติดต่อผู้ดูแลระบบเพื่อรีเซ็ต Password', 'info')
                    }
                  >
                    <i className="ti ti-help-circle" style={{ fontSize: 13 }} aria-hidden="true" />{' '}
                    ลืม Password?
                  </button>
                  <button
                    type="button"
                    className="login-link-btn"
                    onClick={() => switchMode('pin')}
                  >
                    ใช้ Quick PIN แทน
                  </button>
                </div>
              </div>
            )}

            {mode === 'pin' && (
              <div id="pin-panel" className="login-pin-panel active">
                <div
                  className={`login-pin-display${pinShake ? ' shake' : ''}`}
                  id="pin-dots"
                >
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className={`login-pin-dot${i < pinValue.length ? ' filled' : ''}`}
                    />
                  ))}
                </div>

                <div
                  className={`login-error-msg center${pinError ? ' show' : ''}`}
                  id="pin-error"
                >
                  <i className="ti ti-alert-circle" aria-hidden="true" />
                  <span>PIN ไม่ถูกต้อง กรุณาลองใหม่</span>
                </div>

                <div className="login-pin-grid">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                    <button
                      key={d}
                      type="button"
                      className="login-pin-btn"
                      onClick={() => handlePinPress(d)}
                      disabled={isLoading}
                    >
                      {d}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="login-pin-btn zero"
                    onClick={() => handlePinPress('0')}
                    disabled={isLoading}
                  >
                    0
                  </button>
                  <button
                    type="button"
                    className="login-pin-btn del"
                    onClick={handlePinDel}
                    disabled={isLoading}
                    aria-label="ลบ"
                  >
                    <i className="ti ti-backspace" aria-hidden="true" />
                  </button>
                </div>

                <div className="login-login-help single" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="login-link-btn"
                    onClick={() => switchMode('password')}
                  >
                    ใช้ Username/Password แทน
                  </button>
                </div>
              </div>
            )}

            <p className="login-version">
              v2.4.1 · สาขา {branchLabel}
              {import.meta.env.DEV && (
                <span style={{ display: 'block', marginTop: 4, fontSize: 10 }}>
                  Dev: somchai/1234 · suda/2345 · wichai/3456 · nongnuch/4567
                </span>
              )}
            </p>
          </div>
        </main>
      </div>

      <div
        className={`login-success-overlay${successUser ? ' show' : ''}`}
        role="status"
        aria-live="polite"
      >
        <div className="login-success-check">
          <i className="ti ti-check" aria-hidden="true" />
        </div>
        <div className="login-success-name">
          {successUser
            ? `ยินดีต้อนรับ, ${successUser.firstName} ${successUser.lastName}`
            : 'ยินดีต้อนรับ'}
        </div>
        <div className="login-success-sub">
          {successUser
            ? `${formatRole(successUser.role)} · สาขา${branchLabel}`
            : 'กำลังเข้าสู่ระบบ...'}
        </div>
      </div>

      <div className="login-toast-wrap" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`login-toast ${t.type}`}>
            <i
              className={`ti ti-${t.type === 'error' ? 'alert-circle' : 'info-circle'}`}
              aria-hidden="true"
            />
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
