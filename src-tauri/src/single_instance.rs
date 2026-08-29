use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr;
use std::sync::atomic::{AtomicPtr, Ordering};

const MUTEX_NAME: &str = "Local\\com.twinpet.pos.single-instance";
const WINDOW_TITLE: &str = "Twinpet POS";
const ERROR_ALREADY_EXISTS: u32 = 183;

static MUTEX_HANDLE: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(ptr::null_mut());

#[cfg(windows)]
mod ffi {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateMutexW(
            lp_mutex_attributes: *mut c_void,
            b_initial_owner: i32,
            lp_name: *const u16,
        ) -> *mut c_void;
        pub fn GetLastError() -> u32;
        pub fn FindWindowW(lp_class_name: *const u16, lp_window_name: *const u16) -> *mut c_void;
        pub fn SetForegroundWindow(h_wnd: *mut c_void) -> i32;
        pub fn CloseHandle(h_object: *mut c_void) -> i32;
    }
}

fn to_wide(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

pub struct NamedMutex {
    handle: *mut std::ffi::c_void,
}

unsafe impl Send for NamedMutex {}
unsafe impl Sync for NamedMutex {}

impl Drop for NamedMutex {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                ffi::CloseHandle(self.handle);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SingleInstanceResult {
    Acquired,
    AlreadyHeld,
}

/// Acquire the process-lifetime named mutex. Does not start a WebView.
pub fn try_acquire(mutex_name: &str) -> SingleInstanceResult {
    let wide = to_wide(mutex_name);
    let handle = unsafe { ffi::CreateMutexW(ptr::null_mut(), 1, wide.as_ptr()) };
    if handle.is_null() {
        return SingleInstanceResult::AlreadyHeld;
    }
    let err = unsafe { ffi::GetLastError() };
    if err == ERROR_ALREADY_EXISTS {
        unsafe {
            ffi::CloseHandle(handle);
        }
        return SingleInstanceResult::AlreadyHeld;
    }
    MUTEX_HANDLE.store(handle, Ordering::SeqCst);
    // Leak the handle for process lifetime so Drop does not release the mutex.
    std::mem::forget(NamedMutex { handle });
    SingleInstanceResult::Acquired
}

fn try_focus_existing_window() {
    let title = to_wide(WINDOW_TITLE);
    let hwnd = unsafe { ffi::FindWindowW(ptr::null(), title.as_ptr()) };
    if !hwnd.is_null() {
        unsafe {
            ffi::SetForegroundWindow(hwnd);
        }
    }
}

/// First instance holds the mutex. Second instance best-effort focuses then exits
/// before `tauri::Builder` / WebView.
pub fn acquire_or_exit() {
    match try_acquire(MUTEX_NAME) {
        SingleInstanceResult::Acquired => {}
        SingleInstanceResult::AlreadyHeld => {
            try_focus_existing_window();
            std::process::exit(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_with_same_name_is_already_held() {
        let name = format!(
            "Local\\com.twinpet.pos.single-instance-test-{}",
            std::process::id()
        );
        let first = try_acquire(&name);
        assert_eq!(first, SingleInstanceResult::Acquired);
        let second = try_acquire(&name);
        assert_eq!(second, SingleInstanceResult::AlreadyHeld);
    }
}
