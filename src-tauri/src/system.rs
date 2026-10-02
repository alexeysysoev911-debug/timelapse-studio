//! Системная интеграция: журнал, запрет сна во время сборки.
use std::path::Path;

pub fn init_logging(dir: &Path) {
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("timelapse-studio")
        .filename_suffix("log")
        .max_log_files(7)
        .build(dir);
    let Ok(appender) = appender else { return };
    let _ = tracing_subscriber::fmt()
        .with_writer(appender)
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("TLS_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .try_init();
    std::panic::set_hook(Box::new(|info| {
        tracing::error!(
            "ПАНИКА: {info}\n{}",
            std::backtrace::Backtrace::force_capture()
        );
    }));
}

/// Пока объект жив — Windows не уходит в сон (сборка не прервётся ночью).
pub struct KeepAwake;

impl KeepAwake {
    pub fn new() -> Self {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::Power::{
                SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
            };
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        }
        KeepAwake
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}
