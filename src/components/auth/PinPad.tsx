import React, { useEffect } from 'react';

type PinPadProps = {
  pinValue: string;
  onPinPress: (digit: string) => void;
  onPinDel: () => void;
  onSubmit: () => void;
  isLoading: boolean;
  pinError: boolean;
  pinShake: boolean;
};

export function PinPad({
  pinValue,
  onPinPress,
  onPinDel,
  onSubmit,
  isLoading,
  pinError,
  pinShake,
}: PinPadProps) {
  // Listen for physical keyboard input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isLoading) return;
      if (e.key >= '0' && e.key <= '9') {
        onPinPress(e.key);
      } else if (e.key === 'Backspace') {
        onPinDel();
      } else if (e.key === 'Enter' && pinValue.length === 4) {
        onSubmit();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isLoading, onPinPress, onPinDel, onSubmit, pinValue.length]);

  return (
    <div className="flex flex-col items-center w-full max-w-xs mx-auto">
      <div
        className={`flex justify-center gap-4 mb-6 transition-transform ${
          pinShake ? 'animate-pulse' : ''
        }`}
      >
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`w-4 h-4 rounded-full border-2 transition-colors duration-200 ${
              i < pinValue.length
                ? pinError
                  ? 'bg-red-500 border-red-500'
                  : 'bg-primary-600 border-primary-600'
                : 'bg-gray-200 border-gray-300 dark:bg-gray-700 dark:border-gray-600'
            }`}
          />
        ))}
      </div>

      {pinError && (
        <p className="text-sm text-red-600 dark:text-red-500 mb-4 font-medium flex items-center gap-1">
          <i className="ti ti-alert-circle" aria-hidden="true" />
          PIN ไม่ถูกต้อง กรุณาลองใหม่
        </p>
      )}

      <div className="grid grid-cols-3 gap-3 w-full mb-6">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button
            key={digit}
            type="button"
            disabled={isLoading}
            onClick={() => onPinPress(digit)}
            className="flex items-center justify-center h-14 text-xl font-medium text-gray-900 bg-white border border-gray-200 rounded-lg hover:bg-gray-100 hover:text-primary-700 focus:z-10 focus:ring-2 focus:ring-primary-700 focus:text-primary-700 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-600 dark:hover:text-white dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {digit}
          </button>
        ))}
        <div className="col-start-2">
          <button
            type="button"
            disabled={isLoading}
            onClick={() => onPinPress('0')}
            className="flex items-center justify-center w-full h-14 text-xl font-medium text-gray-900 bg-white border border-gray-200 rounded-lg hover:bg-gray-100 hover:text-primary-700 focus:z-10 focus:ring-2 focus:ring-primary-700 focus:text-primary-700 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-600 dark:hover:text-white dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            0
          </button>
        </div>
        <div className="col-start-3">
          <button
            type="button"
            disabled={isLoading}
            onClick={onPinDel}
            aria-label="ลบ"
            className="flex items-center justify-center w-full h-14 text-xl font-medium text-gray-900 bg-gray-50 border border-gray-200 rounded-lg hover:bg-red-50 hover:text-red-600 hover:border-red-200 focus:z-10 focus:ring-2 focus:ring-red-500 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-red-900/30 dark:hover:text-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <i className="ti ti-backspace" aria-hidden="true" />
          </button>
        </div>
      </div>

      <button
        type="button"
        disabled={isLoading || pinValue.length !== 4}
        onClick={onSubmit}
        className="w-full text-white bg-primary-600 hover:bg-primary-700 focus:ring-4 focus:outline-none focus:ring-primary-300 font-medium rounded-lg text-sm px-5 py-3 text-center flex justify-center items-center gap-2 dark:bg-primary-600 dark:hover:bg-primary-700 dark:focus:ring-primary-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isLoading ? (
          <>
            <svg aria-hidden="true" role="status" className="inline w-4 h-4 text-white animate-spin" viewBox="0 0 100 101" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z" fill="#E5E7EB"/>
              <path d="M93.9676 39.0409C96.393 38.4018 97.6632 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6799 93.9676 39.0409Z" fill="currentColor"/>
            </svg>
            กำลังตรวจสอบ PIN...
          </>
        ) : (
          <>
            <i className="ti ti-login" aria-hidden="true" />
            ยืนยัน PIN
          </>
        )}
      </button>
    </div>
  );
}
