//! Связь с сервером программы (панель управления в браузере):
//! реклама в двух блоках, сведения об обязательном обновлении, анонимный счётчик запусков.
//! Если сервер недоступен — показываем последнее полученное (картинки уже лежат на диске).
use crate::commands::{allow, err, CmdResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Сервер по умолчанию. Свой адрес можно указать в «О программе».
pub const DEFAULT_SERVER: &str = "https://tls.shadowpathlink.org";
/// Запасной источник обновлений, если сервер недоступен.
pub const GITHUB_LATEST: &str =
    "https://github.com/alexeysysoev911-debug/timelapse-studio/releases/latest/download/latest.json";

const MAX_IMAGE: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RemoteAd {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub url: String,
    /// Адрес картинки на сервере.
    #[serde(default)]
    pub img: String,
    #[serde(default)]
    pub alt: String,
    /// Картинка, скачанная в кэш (показывается интерфейсом).
    #[serde(default)]
    pub img_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RemoteUpdate {
    pub version: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RemoteConfig {
    #[serde(default)]
    pub ads: BTreeMap<String, RemoteAd>,
    #[serde(default)]
    pub update: Option<RemoteUpdate>,
    /// true — получено только что; false — из кэша (сервер недоступен).
    #[serde(default)]
    pub fresh: bool,
}

/// Адрес сервера: из настроек или по умолчанию.
pub fn server_base(st: &AppState) -> String {
    let s = st.settings().server_url;
    let s = s.trim().trim_end_matches('/');
    // http://127.0.0.1 — только в отладочной сборке, для проверки с локальным сервером
    if s.starts_with("https://") || (cfg!(debug_assertions) && s.starts_with("http://127.0.0.1:")) {
        s.to_string()
    } else {
        DEFAULT_SERVER.to_string()
    }
}

/// Ссылки, которые сейчас показаны в рекламе: только их интерфейс может открыть.
pub fn ad_url_allowed(st: &AppState, url: &str) -> bool {
    st.ad_urls
        .lock()
        .map(|v| v.iter().any(|u| u == url))
        .unwrap_or(false)
}

fn client() -> CmdResult<reqwest::Client> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent(concat!("TimelapseStudio/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(err)
}

fn device_id(st: &AppState) -> String {
    let id = st.settings().device_id;
    if id.len() >= 16 {
        return id;
    }
    // случайный номер установки (не связан с пользователем или компьютером)
    let seed = format!(
        "{:?}|{}|{:p}",
        std::time::SystemTime::now(),
        std::process::id(),
        &id
    );
    let new = sha1_smol::Sha1::from(seed).digest().to_string()[..20].to_string();
    let v = new.clone();
    let _ = st.update_settings(|s| s.device_id = v);
    new
}

async fn fetch_image(c: &reqwest::Client, url: &str, dir: &std::path::Path) -> Option<PathBuf> {
    if !url.starts_with("https://")
        && !(cfg!(debug_assertions) && url.starts_with("http://127.0.0.1:"))
    {
        return None;
    }
    let ext = match url.rsplit('.').next().map(|e| e.to_ascii_lowercase()) {
        Some(e) if ["png", "jpg", "jpeg", "webp"].contains(&e.as_str()) => e,
        _ => "img".into(),
    };
    let name = format!("{}.{ext}", sha1_smol::Sha1::from(url).digest());
    let dst = dir.join(name);
    if dst.is_file() {
        return Some(dst);
    }
    let r = c.get(url).send().await.ok()?.error_for_status().ok()?;
    let ctype = r
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !ctype.starts_with("image/") {
        return None;
    }
    if r.content_length().is_some_and(|n| n as usize > MAX_IMAGE) {
        return None;
    }
    // читаем по частям и обрываем на лимите: сервер не сможет «залить» память программы
    let mut r = r;
    let mut bytes = Vec::new();
    while let Some(chunk) = r.chunk().await.ok()? {
        if bytes.len() + chunk.len() > MAX_IMAGE {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    std::fs::create_dir_all(dir).ok()?;
    let tmp = dst.with_extension("part");
    std::fs::write(&tmp, &bytes).ok()?;
    std::fs::rename(&tmp, &dst).ok()?;
    Some(dst)
}

/// Настройки с сервера при запуске программы.
#[tauri::command]
pub async fn server_config(app: AppHandle) -> CmdResult<RemoteConfig> {
    let st = app.state::<AppState>();
    let cache_file = st.dirs.data.join("remote.json");
    let img_dir = st.dirs.cache.join("ads");
    let base = server_base(&st);
    let telemetry = st.settings().telemetry;
    let version = app.package_info().version.to_string();
    let mut url = format!("{base}/api/app/config?v={version}&os=windows");
    // запуск считается один раз за сеанс программы
    let first = !st
        .launch_counted
        .swap(true, std::sync::atomic::Ordering::SeqCst);
    if telemetry && first {
        url.push_str("&id=");
        url.push_str(&device_id(&st));
    }

    let fresh: Option<RemoteConfig> = async {
        let c = client().ok()?;
        let r = c.get(&url).send().await.ok()?.error_for_status().ok()?;
        let mut cfg: RemoteConfig = r.json().await.ok()?;
        for ad in cfg.ads.values_mut() {
            ad.img_path = if ad.img.is_empty() {
                None
            } else {
                fetch_image(&c, &ad.img, &img_dir).await
            };
        }
        // реклама без текста, у которой не скачалась картинка, — пустой блок: не показываем
        cfg.ads.retain(|_, a| {
            !a.title.trim().is_empty() || !a.text.trim().is_empty() || a.img_path.is_some()
        });
        cfg.fresh = true;
        Some(cfg)
    }
    .await;

    let cfg = match fresh {
        Some(cfg) => {
            let _ = tls_core::util::atomic_write(
                &cache_file,
                &serde_json::to_vec_pretty(&cfg).unwrap_or_default(),
            );
            cleanup_images(&img_dir, &cfg);
            cfg
        }
        None => {
            tracing::info!("сервер программы недоступен — беру сохранённые настройки");
            let mut cfg: RemoteConfig = std::fs::read(&cache_file)
                .ok()
                .and_then(|d| serde_json::from_slice(&d).ok())
                .unwrap_or_default();
            cfg.fresh = false;
            cfg.ads
                .values_mut()
                .for_each(|a| a.img_path = a.img_path.take().filter(|p| p.is_file()));
            cfg
        }
    };
    let imgs: Vec<PathBuf> = cfg
        .ads
        .values()
        .filter_map(|a| a.img_path.clone())
        .collect();
    allow(&app, &imgs);
    if let Ok(mut v) = st.ad_urls.lock() {
        *v = cfg
            .ads
            .values()
            .filter(|a| a.url.starts_with("https://"))
            .map(|a| a.url.clone())
            .collect();
    }
    Ok(cfg)
}

/// Старые картинки рекламы больше не нужны.
fn cleanup_images(dir: &std::path::Path, cfg: &RemoteConfig) {
    let keep: Vec<&PathBuf> = cfg
        .ads
        .values()
        .filter_map(|a| a.img_path.as_ref())
        .collect();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !keep.iter().any(|k| **k == p) {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

/// Страница скачивания на сайте программы (запасной путь, если обновление не установилось).
#[tauri::command(async)]
pub fn open_download_page(app: AppHandle) -> CmdResult<()> {
    let st = app.state::<AppState>();
    let url = format!("{}/#dl", server_base(&st));
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(err)
}

/// Открыть ссылку рекламного блока в браузере.
#[tauri::command(async)]
pub fn open_ad(app: AppHandle, url: String) -> CmdResult<()> {
    let st = app.state::<AppState>();
    if !ad_url_allowed(&st, &url) {
        return Err(err("ссылка не разрешена"));
    }
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_server_answer() {
        let j = r#"{"ads": {"1": {"title": "PETG −15%", "text": "Промокод", "url": "https://example.com", "img": "", "alt": "PETG"},
                    "2": {"title": "", "text": "", "url": "https://e.com/2", "img": "https://s/media/ad2-1.png", "alt": "Реклама"}},
                    "update": {"version": "3.0.1", "kind": "mandatory", "notes": "• важно"}, "server": "1.0"}"#;
        let c: RemoteConfig = serde_json::from_str(j).unwrap();
        assert_eq!(c.ads.len(), 2);
        assert_eq!(c.ads["1"].title, "PETG −15%");
        assert_eq!(c.update.unwrap().kind, "mandatory");
        let empty: RemoteConfig = serde_json::from_str(r#"{"ads": {}, "update": null}"#).unwrap();
        assert!(empty.update.is_none() && !empty.fresh);
    }
}
