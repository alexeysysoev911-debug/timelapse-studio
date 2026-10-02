//! Оболочка приложения: команды для интерфейса, фоновые сборки, системная интеграция.
//! Никакого HTTP-сервера: интерфейс общается с ядром только через IPC Tauri.
mod commands;
mod state;
mod system;

use state::AppState;
use tauri::{Emitter, Manager, WindowEvent};

pub fn run() {
    tauri::Builder::default()
        // второй запуск — просто показываем уже открытое окно
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let state = AppState::init(app.handle())?;
            system::init_logging(&state.dirs.logs);
            tracing::info!(version = env!("CARGO_PKG_VERSION"), "запуск");
            app.manage(state);
            Ok(())
        })
        // закрытие окна во время сборки — сначала спросить пользователя (иначе ffmpeg остался бы работать)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let busy = window
                    .state::<AppState>()
                    .job
                    .lock()
                    .map(|j| j.is_some())
                    .unwrap_or(false);
                if busy {
                    api.prevent_close();
                    let _ = window.emit("close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::quit_after_cancel,
            commands::app_info,
            commands::probe_files,
            commands::list_folder,
            commands::thumbnail,
            commands::preview_frame,
            commands::start_build,
            commands::cancel_build,
            commands::load_project,
            commands::save_project,
            commands::autosave_load,
            commands::autosave_store,
            commands::settings_load,
            commands::settings_store,
            commands::reveal,
            commands::open_path,
            commands::read_log,
            commands::allow_files,
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска приложения");
}
