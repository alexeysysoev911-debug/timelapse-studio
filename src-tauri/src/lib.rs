//! Оболочка приложения: команды для интерфейса, фоновые сборки, системная интеграция.
//! Никакого HTTP-сервера: интерфейс общается с ядром только через IPC Tauri.
mod commands;
mod extra;
mod state;
mod system;

use state::AppState;
use tauri::{Emitter, Manager, WindowEvent};

pub fn run() {
    tauri::Builder::default()
        // второй запуск — просто показываем уже открытое окно
        // второй запуск — показываем уже открытое окно; двойной щелчок по .tlsproj открывает проект в нём
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            if let Some(f) = extra::project_arg(args.iter().skip(1).cloned()) {
                let _ = app.emit("open-file", f);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state = match AppState::init(app.handle()) {
                Ok(s) => s,
                Err(e) => {
                    // без окна и журнала программа просто «исчезла» бы — показываем причину
                    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                    app.dialog()
                        .message(format!(
                            "Не удалось подготовить папки программы:\n{e}\n\nПроверьте доступ к папке AppData и перезапустите Timelapse Studio."
                        ))
                        .title("Timelapse Studio")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                    return Err(e);
                }
            };
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
            extra::projects_list,
            extra::project_open,
            extra::project_store,
            extra::project_delete,
            extra::project_duplicate,
            extra::autosave_load,
            extra::project_info,
            extra::open_link,
            extra::look_thumbs,
            extra::update_check,
            extra::update_install,
            extra::startup_file,
            commands::app_info,
            commands::probe_files,
            commands::list_folder,
            commands::thumbnail,
            commands::preview_frame,
            commands::start_build,
            commands::cancel_build,
            commands::load_project,
            commands::save_project,
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
