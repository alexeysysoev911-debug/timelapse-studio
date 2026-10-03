//! Библиотека проектов, встроенная музыка, ссылки, миниатюры образов, обновления.
use crate::commands::{allow, blocking, build_opts, err, CmdResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tls_core::project::Project;

// ---------------- встроенная музыка ----------------

#[derive(Serialize, Deserialize, Clone)]
pub struct BuiltinTrack {
    pub id: String,
    pub title: String,
    pub mood: String,
    pub genre: String,
    pub bpm: u32,
    pub file: String,
    #[serde(default)]
    pub path: PathBuf,
    /// Значение для проекта: «builtin:<id>».
    #[serde(default)]
    pub token: String,
}

pub fn builtin_tracks(st: &AppState) -> Vec<BuiltinTrack> {
    let Some(dir) = &st.res.music_dir else {
        return vec![];
    };
    let Ok(data) = std::fs::read(dir.join("music.json")) else {
        return vec![];
    };
    let mut v: Vec<BuiltinTrack> = serde_json::from_slice(&data).unwrap_or_default();
    for t in &mut v {
        t.path = dir.join(&t.file);
        t.token = format!("{}{}", tls_core::looks::BUILTIN_PREFIX, t.id);
    }
    v.retain(|t| t.path.is_file());
    v
}

// ---------------- библиотека проектов ----------------

#[derive(Serialize)]
pub struct ProjectMeta {
    id: String,
    name: String,
    /// Время изменения, мс с 1970 г.
    updated: u64,
    clips: usize,
    first_clip: Option<PathBuf>,
}

fn new_id() -> String {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("p{:x}{:04x}", t, std::process::id() & 0xffff)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn project_path(st: &AppState, id: &str) -> CmdResult<PathBuf> {
    if !valid_id(id) {
        return Err(err("некорректный идентификатор проекта"));
    }
    Ok(st.projects_dir().join(format!("{id}.tlsproj")))
}

pub(crate) fn allow_project_files(app: &AppHandle, p: &Project) {
    let mut files: Vec<PathBuf> = p.clips.iter().map(|c| c.path.clone()).collect();
    files.extend(p.end_photos.iter().cloned());
    files.extend(p.style.watermark.iter().cloned());
    files.extend(p.style.font.iter().cloned());
    files.extend(p.music.tracks.iter().cloned());
    allow(app, &files);
}

#[tauri::command(async)]
pub fn projects_list(app: AppHandle) -> Vec<ProjectMeta> {
    let st = app.state::<AppState>();
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(st.projects_dir()) {
        for e in rd.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("tlsproj") {
                continue;
            }
            let Ok(p) = Project::load(&path) else {
                continue;
            };
            let updated = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let first_clip = p
                .clips
                .iter()
                .find(|c| c.enabled && c.path.is_file())
                .map(|c| c.path.clone());
            if let Some(f) = &first_clip {
                allow(&app, std::slice::from_ref(f));
            }
            out.push(ProjectMeta {
                id: path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                name: p.name,
                updated,
                clips: p.clips.len(),
                first_clip,
            });
        }
    }
    out.sort_by_key(|p| std::cmp::Reverse(p.updated));
    out
}

#[tauri::command(async)]
pub fn project_open(app: AppHandle, id: String) -> CmdResult<Project> {
    let st = app.state::<AppState>();
    let mut p = Project::load(&project_path(&st, &id)?)?;
    p.id = id.clone();
    allow_project_files(&app, &p);
    let _ = st.update_settings(|s| s.last_project = id);
    Ok(p)
}

/// Сохраняет проект в библиотеку (новому проекту присваивается id). Возвращает id.
#[tauri::command(async)]
pub fn project_store(app: AppHandle, project: Project) -> CmdResult<String> {
    let st = app.state::<AppState>();
    let mut p = project;
    if !valid_id(&p.id) {
        p.id = new_id();
    }
    p.save(&project_path(&st, &p.id)?)?;
    if st.settings().last_project != p.id {
        let id = p.id.clone();
        let _ = st.update_settings(|s| s.last_project = id);
    }
    Ok(p.id)
}

#[tauri::command(async)]
pub fn project_delete(app: AppHandle, id: String) -> CmdResult<()> {
    let st = app.state::<AppState>();
    let path = project_path(&st, &id)?;
    if path.is_file() {
        trash::delete(&path)
            .or_else(|_| std::fs::remove_file(&path))
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn project_duplicate(app: AppHandle, id: String) -> CmdResult<Project> {
    let st = app.state::<AppState>();
    let mut p = Project::load(&project_path(&st, &id)?)?;
    p.id = new_id();
    p.name = format!("{} (копия)", p.name);
    p.save(&project_path(&st, &p.id)?)?;
    Ok(p)
}

/// Проект при запуске: последний из библиотеки → старое автосохранение (3.0) → ничего.
#[tauri::command(async)]
pub fn autosave_load(app: AppHandle) -> Option<Project> {
    let st = app.state::<AppState>();
    let last = st.settings().last_project;
    if valid_id(&last) {
        if let Ok(path) = project_path(&st, &last) {
            if let Ok(mut p) = Project::load(&path) {
                p.id = last;
                allow_project_files(&app, &p);
                return Some(p);
            }
        }
    }
    let old = st.dirs.data.join("autosave.tlsproj");
    let mut p = Project::load(&old).ok()?;
    p.id = new_id();
    if p.save(&project_path(&st, &p.id).ok()?).is_ok() {
        let _ = std::fs::remove_file(&old);
        let id = p.id.clone();
        let _ = st.update_settings(|s| s.last_project = id);
    }
    allow_project_files(&app, &p);
    Some(p)
}

/// Что программа нашла в именах файлов (материал, слой, время) — для подсказок в полях.
#[tauri::command(async)]
pub fn project_info(project: Project) -> tls_core::pipeline::ClipInfoText {
    let paths: Vec<&std::path::Path> = project
        .clips
        .iter()
        .filter(|c| c.enabled)
        .map(|c| c.path.as_path())
        .collect();
    tls_core::pipeline::info_text(&project, &paths)
}

/// Открыть ссылку в браузере (только разрешённые адреса).
#[tauri::command(async)]
pub fn open_link(url: String) -> CmdResult<()> {
    const ALLOWED: &[&str] = &["https://t.me/", "https://github.com/"];
    if !ALLOWED.iter().any(|p| url.starts_with(p)) || url.contains(char::is_whitespace) {
        return Err(err("ссылка не разрешена"));
    }
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(err)
}

// ---------------- миниатюры образов ----------------

#[derive(Serialize)]
pub struct LookThumb {
    id: String,
    label: String,
    path: PathBuf,
}

#[tauri::command]
pub async fn look_thumbs(
    app: AppHandle,
    project: Project,
    target_id: String,
    at: Option<f64>,
) -> CmdResult<Vec<LookThumb>> {
    blocking(move || {
        let st = app.state::<AppState>();
        let tools = st.tools().map_err(tls_core::Error::ToolMissing)?;
        let po = tls_core::pipeline::PreviewOptions {
            at,
            bare: true,
            look_override: Some("none".into()),
            scale: Some(0.3),
        };
        let mut p = project;
        p.style.auto_color = false;
        p.style.sharpen = false;
        let (base, _) = tls_core::pipeline::preview_frame(
            &tools,
            &p,
            &build_opts(&st, None, None),
            &target_id,
            &po,
        )?;
        let dir = st.dirs.cache.join("looks");
        let v = tls_core::pipeline::look_thumbnails(&tools, &base, &st.res, &dir, 240)?;
        let _ = std::fs::remove_file(&base);
        let out: Vec<LookThumb> = v
            .into_iter()
            .map(|(id, path)| LookThumb {
                label: tls_core::looks::LOOKS
                    .iter()
                    .find(|l| l.0 == id)
                    .map(|l| l.1)
                    .unwrap_or("")
                    .to_string(),
                id,
                path,
            })
            .collect();
        let paths: Vec<PathBuf> = out.iter().map(|t| t.path.clone()).collect();
        allow(&app, &paths);
        Ok(out)
    })
    .await
}

// ---------------- обновления ----------------

#[derive(Serialize)]
pub struct UpdateInfo {
    current: String,
    available: bool,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
}

fn updater(app: &AppHandle) -> CmdResult<tauri_plugin_updater::Updater> {
    use tauri_plugin_updater::UpdaterExt;
    let st = app.state::<AppState>();
    let custom = st.settings().server_url;
    let custom = custom.trim();
    if !custom.is_empty() && !custom.starts_with("https://") {
        return Err(err(
            "Адрес сервера программы должен начинаться с https:// (или оставьте поле пустым).",
        ));
    }
    // сначала свой сервер, при его недоступности — GitHub Releases
    let primary = format!("{}/updates/latest.json", crate::remote::server_base(&st));
    let mut urls = vec![];
    for u in [primary.as_str(), crate::remote::GITHUB_LATEST] {
        urls.push(
            u.parse()
                .map_err(|_| err("Адрес сервера программы записан с ошибкой."))?,
        );
    }
    app.updater_builder()
        .timeout(std::time::Duration::from_secs(30))
        .endpoints(urls)
        .map_err(err)?
        .build()
        .map_err(err)
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> CmdResult<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let up = updater(&app)?
        .check()
        .await
        .map_err(|e| err(format!("Не удалось проверить обновления: {e}")))?;
    Ok(match up {
        Some(u) => UpdateInfo {
            current,
            available: true,
            version: Some(u.version.clone()),
            notes: u.body.clone(),
            date: u.date.map(|d| d.to_string()),
        },
        None => UpdateInfo {
            current,
            available: false,
            version: None,
            notes: None,
            date: None,
        },
    })
}

#[derive(Serialize, Clone)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Скачать и установить обновление (подпись проверяется), затем перезапуск.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> CmdResult<()> {
    if app
        .state::<AppState>()
        .job
        .lock()
        .map(|j| j.is_some())
        .unwrap_or(false)
    {
        return Err(err("Дождитесь окончания сборки — потом обновим программу."));
    }
    let Some(u) = updater(&app)?.check().await.map_err(err)? else {
        return Err(err("Обновлений нет — у вас последняя версия."));
    };
    let st = app.state::<AppState>();
    st.updating.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut downloaded = 0u64;
    let app2 = app.clone();
    let bytes = u
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = app2.emit("update-progress", UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| {
            st.updating
                .store(false, std::sync::atomic::Ordering::SeqCst);
            err(format!("Не удалось скачать обновление: {e}"))
        })?;
    // установщик закрывает программу: убеждаемся, что за время загрузки не началась сборка
    if st.job.lock().map(|j| j.is_some()).unwrap_or(false) {
        st.updating
            .store(false, std::sync::atomic::Ordering::SeqCst);
        return Err(err("Идёт сборка — обновление установим после неё."));
    }
    u.install(bytes).map_err(|e| {
        st.updating
            .store(false, std::sync::atomic::Ordering::SeqCst);
        err(format!("Не удалось установить обновление: {e}"))
    })?;
    tracing::info!(version = %u.version, "обновление установлено, перезапуск");
    app.restart();
}

/// Файл проекта из командной строки (двойной щелчок по .tlsproj в Проводнике).
pub(crate) fn project_arg(args: impl Iterator<Item = String>) -> Option<PathBuf> {
    args.map(PathBuf::from).find(|p| {
        p.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("tlsproj"))
            && p.is_file()
    })
}

/// Проект, с которым программу запустили (если запустили двойным щелчком по файлу).
#[tauri::command]
pub fn startup_file() -> Option<PathBuf> {
    project_arg(std::env::args().skip(1))
}
