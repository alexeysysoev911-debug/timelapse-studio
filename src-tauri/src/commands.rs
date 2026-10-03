//! Команды, доступные интерфейсу. Тяжёлая работа — в фоновых потоках, интерфейс не замирает.
use crate::state::{AppState, Settings};
use crate::system::KeepAwake;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};
use tls_core::pipeline::{BuildOptions, Event};
use tls_core::probe::{kind_by_ext, MediaInfo, MediaKind};
use tls_core::project::{AfterAction, Project};
use tls_core::render::Cancel;

pub(crate) type CmdResult<T> = Result<T, tls_core::Error>;

pub(crate) fn err(e: impl std::fmt::Display) -> tls_core::Error {
    tls_core::Error::Invalid(e.to_string())
}

pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

#[derive(Serialize)]
pub struct AppInfo {
    version: String,
    ffmpeg: Option<String>,
    ffmpeg_error: Option<String>,
    default_out_dir: PathBuf,
    data_dir: PathBuf,
    log_dir: PathBuf,
    building: bool,
    builtin_music: Vec<crate::extra::BuiltinTrack>,
    looks: Vec<(String, String)>,
    fonts_dir: Option<PathBuf>,
    update_endpoint_default: String,
}

#[tauri::command]
pub async fn app_info(app: AppHandle) -> CmdResult<AppInfo> {
    blocking(move || {
        let st = app.state::<AppState>();
        let tools = st.tools();
        let info = AppInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            ffmpeg: tools.as_ref().ok().map(|t| t.ffmpeg.display().to_string()),
            ffmpeg_error: tools.err(),
            default_out_dir: st.out_dir(),
            data_dir: st.dirs.data.clone(),
            log_dir: st.dirs.logs.clone(),
            building: st.job.lock().map(|j| j.is_some()).unwrap_or(false),
            builtin_music: crate::extra::builtin_tracks(&st),
            looks: tls_core::looks::LOOKS
                .iter()
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect(),
            fonts_dir: st.res.fonts_dir.clone(),
            update_endpoint_default: crate::extra::DEFAULT_UPDATE_ENDPOINT.into(),
        };
        Ok(info)
    })
    .await
}

/// Разрешить интерфейсу показывать эти файлы (видео/картинки) через asset-протокол.
pub(crate) fn allow(app: &AppHandle, paths: &[PathBuf]) {
    let scope = app.asset_protocol_scope();
    for p in paths {
        let _ = scope.allow_file(p);
    }
}

#[tauri::command]
pub fn allow_files(app: AppHandle, paths: Vec<PathBuf>) {
    allow(&app, &paths);
}

#[derive(Serialize)]
pub struct ProbeItem {
    path: PathBuf,
    kind: MediaKind,
    info: Option<MediaInfo>,
    error: Option<String>,
}

#[tauri::command]
pub async fn probe_files(app: AppHandle, paths: Vec<PathBuf>) -> CmdResult<Vec<ProbeItem>> {
    blocking(move || {
        let st = app.state::<AppState>();
        let tools = st.tools().map_err(tls_core::Error::ToolMissing)?;
        let res = st.res.clone();
        allow(&app, &paths);
        // параллельно, но не больше 4 ffprobe одновременно
        let chunks: Vec<Vec<PathBuf>> = paths
            .chunks(paths.len().div_ceil(4).max(1))
            .map(|c| c.to_vec())
            .collect();
        let mut out: Vec<ProbeItem> = std::thread::scope(|s| {
            let hs: Vec<_> = chunks
                .into_iter()
                .map(|chunk| {
                    let tools = tools.clone();
                    let res = res.clone();
                    s.spawn(move || {
                        chunk
                            .into_iter()
                            .map(|p| {
                                // «builtin:...» — встроенный трек; в ответе оставляем исходное имя
                                let real = res.resolve(&p);
                                let kind = kind_by_ext(&real);
                                match tls_core::probe::probe(&tools, &real) {
                                    Ok(i) => ProbeItem {
                                        path: p,
                                        kind: i.kind,
                                        info: Some(i),
                                        error: None,
                                    },
                                    Err(e) => ProbeItem {
                                        path: p,
                                        kind,
                                        info: None,
                                        error: Some(e.to_string()),
                                    },
                                }
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            hs.into_iter()
                .flat_map(|h| h.join().unwrap_or_default())
                .collect()
        });
        out.sort_by(|a, b| {
            tls_core::util::natural_cmp(
                &a.path.file_name().unwrap_or_default().to_string_lossy(),
                &b.path.file_name().unwrap_or_default().to_string_lossy(),
            )
        });
        Ok(out)
    })
    .await
}

/// Медиафайлы папки (для перетаскивания целой папки).
#[tauri::command]
pub fn list_folder(path: PathBuf) -> CmdResult<Vec<PathBuf>> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(&path)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && kind_by_ext(p) != MediaKind::Unknown)
        .collect();
    tls_core::util::sort_paths_natural(&mut v);
    Ok(v)
}

#[tauri::command]
pub async fn thumbnail(app: AppHandle, path: PathBuf, at: f64, width: u32) -> CmdResult<PathBuf> {
    blocking(move || {
        let st = app.state::<AppState>();
        let tools = st.tools().map_err(tls_core::Error::ToolMissing)?;
        let meta = std::fs::metadata(&path)?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let key = sha1_smol::Sha1::from(format!(
            "{}|{}|{}|{:.2}|{}",
            path.display(),
            mtime,
            meta.len(),
            at,
            width
        ))
        .digest()
        .to_string();
        let dir = st.dirs.cache.join("thumbs");
        std::fs::create_dir_all(&dir)?;
        let out = dir.join(format!("{key}.jpg"));
        if !out.is_file() {
            if kind_by_ext(&path) == MediaKind::Image {
                tls_core::probe::thumbnail(&tools, &path, 0.0, width, &out)?;
            } else {
                tls_core::probe::thumbnail(&tools, &path, at, width, &out)?;
            }
        }
        allow(&app, std::slice::from_ref(&out));
        Ok(out)
    })
    .await
}

/// Слой текста от интерфейса: PNG в base64 (data URL или чистый base64).
#[derive(serde::Deserialize, Default, Clone)]
#[serde(default)]
pub struct OverlayPayload {
    static_png: Option<String>,
    hook_png: Option<String>,
}

fn decode_png(s: &Option<String>) -> Option<Vec<u8>> {
    use base64::Engine;
    let s = s.as_ref()?;
    let b64 = s.split_once(',').map(|x| x.1).unwrap_or(s);
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()
}

pub(crate) fn build_opts(
    st: &AppState,
    draft: Option<f64>,
    overlays: Option<std::collections::HashMap<String, OverlayPayload>>,
) -> BuildOptions {
    BuildOptions {
        cache_dir: st.dirs.cache.clone(),
        default_out_dir: st.out_dir(),
        font: None,
        draft_seconds: draft,
        seed: None,
        resources: st.res.clone(),
        overlays: overlays
            .unwrap_or_default()
            .into_iter()
            .map(|(k, v)| {
                (
                    k,
                    tls_core::graph::OverlayImages {
                        static_png: decode_png(&v.static_png),
                        hook_png: decode_png(&v.hook_png),
                    },
                )
            })
            .collect(),
    }
}

#[derive(Serialize)]
pub struct Frame {
    path: PathBuf,
    warnings: Vec<String>,
}

#[tauri::command]
pub async fn preview_frame(
    app: AppHandle,
    project: Project,
    target_id: String,
    options: tls_core::pipeline::PreviewOptions,
    overlays: Option<std::collections::HashMap<String, OverlayPayload>>,
) -> CmdResult<Frame> {
    blocking(move || {
        let st = app.state::<AppState>();
        let tools = st.tools().map_err(tls_core::Error::ToolMissing)?;
        let (path, warnings) = tls_core::pipeline::preview_frame(
            &tools,
            &project,
            &build_opts(&st, None, overlays),
            &target_id,
            &options,
        )?;
        allow(&app, std::slice::from_ref(&path));
        Ok(Frame { path, warnings })
    })
    .await
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Done {
    Ok {
        report: serde_json::Value,
        draft: bool,
    },
    Error {
        error: tls_core::Error,
        draft: bool,
    },
}

/// Запуск сборки в фоне. События: `build-event` (Event), итог: `build-done`.
#[tauri::command]
pub fn start_build(
    app: AppHandle,
    project: Project,
    draft_seconds: Option<f64>,
    overlays: Option<std::collections::HashMap<String, OverlayPayload>>,
) -> CmdResult<()> {
    let st = app.state::<AppState>();
    let tools = st.tools().map_err(tls_core::Error::ToolMissing)?;
    let cancel = Cancel::new();
    {
        // проверка и установка флага — атомарно под одной блокировкой (нет двойного запуска)
        let mut job = st.job.lock().unwrap();
        if job.is_some() {
            return Err(err(
                "Сборка уже идёт — дождитесь окончания или остановите её.",
            ));
        }
        *job = Some(cancel.clone());
    }
    let settings = st.settings();
    let mut project = project;
    if let AfterAction::Archive { dir } = &mut project.after {
        if dir.as_os_str().is_empty() {
            *dir = if settings.archive_dir.as_os_str().is_empty() {
                st.out_dir().join("Архив исходников")
            } else {
                settings.archive_dir.clone()
            };
        }
    }
    let opts = build_opts(&st, draft_seconds, overlays);
    let app2 = app.clone();
    std::thread::Builder::new()
        .name("build".into())
        .spawn(move || {
            let _awake = (settings.prevent_sleep && draft_seconds.is_none()).then(KeepAwake::new);
            let win = app2.get_webview_window("main");
            let last = std::sync::Mutex::new((0i64, std::time::Instant::now()));
            let on = |e: Event| {
                if let (Event::Progress { value }, Some(w)) = (&e, &win) {
                    // прогресс на значке в панели задач (не чаще 4 раз в секунду)
                    let pct = (value * 100.0) as i64;
                    let mut l = last.lock().unwrap();
                    if pct != l.0 && l.1.elapsed().as_millis() > 250 {
                        *l = (pct, std::time::Instant::now());
                        let _ = w.set_progress_bar(tauri::window::ProgressBarState {
                            status: Some(tauri::window::ProgressBarStatus::Normal),
                            progress: Some(pct.clamp(0, 100) as u64),
                        });
                    }
                }
                if let Event::Log { line } = &e {
                    tracing::debug!("{line}");
                }
                let _ = app2.emit("build-event", &e);
            };
            tracing::info!(clips = project.clips.len(), draft = ?draft_seconds, "сборка: старт");
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                tls_core::pipeline::build(&tools, &project, &opts, &cancel, &on)
            }))
            .unwrap_or_else(|_| Err(err("Внутренняя ошибка программы — подробности в журнале.")));
            let draft = draft_seconds.is_some();
            let done = match res {
                Ok(r) => {
                    tracing::info!(ok = r.all_ok, "сборка: итог");
                    let mut paths = vec![];
                    for o in &r.outputs {
                        paths.extend(o.path.clone());
                        paths.extend(o.cover.clone());
                    }
                    allow(&app2, &paths);
                    if !draft
                        && settings.notify
                        && !win
                            .as_ref()
                            .and_then(|w| w.is_focused().ok())
                            .unwrap_or(false)
                    {
                        use tauri_plugin_notification::NotificationExt;
                        let _ = app2
                            .notification()
                            .builder()
                            .title("Timelapse Studio")
                            .body(if r.all_ok {
                                "Ролики готовы"
                            } else {
                                "Сборка завершилась с ошибками"
                            })
                            .show();
                    }
                    Done::Ok {
                        report: serde_json::to_value(&r).unwrap_or_default(),
                        draft,
                    }
                }
                Err(e) => {
                    tracing::warn!(%e, "сборка: ошибка");
                    Done::Error { error: e, draft }
                }
            };
            if let Some(w) = &win {
                let _ = w.set_progress_bar(tauri::window::ProgressBarState {
                    status: Some(tauri::window::ProgressBarStatus::None),
                    progress: None,
                });
            }
            *app2.state::<AppState>().job.lock().unwrap() = None;
            let _ = app2.emit("build-done", &done);
        })
        .map_err(|e| {
            *st.job.lock().unwrap() = None;
            err(e)
        })?;
    Ok(())
}

#[tauri::command]
pub fn cancel_build(st: State<AppState>) {
    if let Some(c) = st.job.lock().unwrap().as_ref() {
        c.cancel();
    }
}

#[tauri::command]
pub fn load_project(app: AppHandle, path: PathBuf) -> CmdResult<Project> {
    let p = Project::load(&path)?;
    let mut files: Vec<PathBuf> = p.clips.iter().map(|c| c.path.clone()).collect();
    files.extend(p.end_photos.iter().cloned());
    files.extend(p.style.watermark.iter().cloned());
    allow(&app, &files);
    remember_recent(&app.state::<AppState>(), &path);
    Ok(p)
}

#[tauri::command]
pub fn save_project(app: AppHandle, path: PathBuf, project: Project) -> CmdResult<()> {
    project.save(&path)?;
    remember_recent(&app.state::<AppState>(), &path);
    Ok(())
}

fn remember_recent(st: &AppState, path: &Path) {
    let mut s = st.settings();
    s.recent.retain(|p| p != path);
    s.recent.insert(0, path.to_path_buf());
    s.recent.truncate(10);
    let _ = tls_core::util::atomic_write(
        &st.settings_path(),
        &serde_json::to_vec_pretty(&s).unwrap_or_default(),
    );
}

#[tauri::command]
pub fn settings_load(st: State<AppState>) -> Settings {
    st.settings()
}

#[tauri::command]
pub fn settings_store(st: State<AppState>, settings: Settings) -> CmdResult<()> {
    Ok(tls_core::util::atomic_write(
        &st.settings_path(),
        &serde_json::to_vec_pretty(&settings)?,
    )?)
}

#[tauri::command]
pub fn reveal(path: PathBuf) -> CmdResult<()> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(err)
}

#[tauri::command]
pub fn open_path(path: PathBuf) -> CmdResult<()> {
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(err)
}

/// Хвост сегодняшнего журнала — для «Отправить отчёт разработчику».
#[tauri::command]
pub fn read_log(st: State<AppState>) -> String {
    let mut files: Vec<PathBuf> = std::fs::read_dir(&st.dirs.logs)
        .map(|rd| rd.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    files.sort();
    files
        .last()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| {
            s.chars()
                .rev()
                .take(100_000)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        })
        .unwrap_or_default()
}

/// Остановить сборку (ffmpeg завершается, недособранные файлы удаляются) и выйти.
#[tauri::command]
pub async fn quit_after_cancel(app: AppHandle) {
    let _ = blocking(move || {
        let st = app.state::<AppState>();
        if let Some(c) = st.job.lock().unwrap().as_ref() {
            c.cancel();
        }
        for _ in 0..100 {
            if st.job.lock().map(|j| j.is_none()).unwrap_or(true) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        app.exit(0);
        Ok(())
    })
    .await;
}
