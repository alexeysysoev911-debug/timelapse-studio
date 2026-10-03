//! Вспомогательные функции: атомарная запись, имена файлов, сортировка, разбор имён клипов.
use regex::Regex;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Запись через временный файл + переименование: файл никогда не остаётся «наполовину записанным».
pub fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    rename_retry(&tmp, path)
}

/// Переименование с повторами: на Windows антивирус/индексатор может ненадолго держать свежий файл.
pub fn rename_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last = None;
    for i in 0..8 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e)
                if e.kind() == std::io::ErrorKind::PermissionDenied
                    || e.raw_os_error() == Some(32) =>
            {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(150 * (i + 1)));
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

/// Естественная сортировка: clip2 < clip10.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(|c| c.is_ascii_digit()) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(|c| c.is_ascii_digit()) {
                    nb.push(c);
                    bi.next();
                }
                let ta = na.trim_start_matches('0');
                let tb = nb.trim_start_matches('0');
                let o = ta
                    .len()
                    .cmp(&tb.len())
                    .then_with(|| ta.cmp(tb))
                    .then_with(|| na.len().cmp(&nb.len()));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(x), Some(y)) => {
                let o = x.to_lowercase().cmp(y.to_lowercase());
                if o != Ordering::Equal {
                    return o;
                }
                ai.next();
                bi.next();
            }
        }
    }
}

pub fn sort_paths_natural(v: &mut [PathBuf]) {
    v.sort_by(|a, b| {
        natural_cmp(
            &a.file_name().unwrap_or_default().to_string_lossy(),
            &b.file_name().unwrap_or_default().to_string_lossy(),
        )
    });
}

/// Безопасное имя файла для Windows.
pub fn sanitize_filename(s: &str) -> String {
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3",
    ];
    let mut out: String = s
        .chars()
        .map(|c| {
            if c.is_control() || r#"\/:*?"<>|"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    out = out.trim_matches(|c| c == '.' || c == ' ').to_string();
    if out.chars().count() > 120 {
        out = out.chars().take(120).collect();
    }
    if out.is_empty() || RESERVED.contains(&out.to_uppercase().as_str()) {
        out = format!("video_{out}");
    }
    out
}

/// Путь, которого ещё нет: «имя.mp4», «имя (2).mp4», ...
pub fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let p = dir.join(format!("{stem}.{ext}"));
    if !p.exists() {
        return p;
    }
    for i in 2..10_000 {
        let p = dir.join(format!("{stem} ({i}).{ext}"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem} {}.{ext}", std::process::id()))
}

/// Имя выходного файла, «занятое» на время сборки: параллельные сборки форматов
/// не получат один и тот же путь, даже пока файла ещё нет на диске.
pub struct ReservedPath {
    pub path: PathBuf,
}

static RESERVED_PATHS: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

impl ReservedPath {
    pub fn new(dir: &Path, stem: &str, ext: &str) -> ReservedPath {
        let mut held = RESERVED_PATHS.lock().unwrap_or_else(|e| e.into_inner());
        let free = |p: &PathBuf| {
            !p.exists() && !p.with_extension(format!("{ext}.part")).exists() && !held.contains(p)
        };
        let mut path = dir.join(format!("{stem}.{ext}"));
        if !free(&path) {
            path = (2..10_000)
                .map(|i| dir.join(format!("{stem} ({i}).{ext}")))
                .find(|p| free(p))
                .unwrap_or_else(|| dir.join(format!("{stem} {}.{ext}", crate::util::rng_suffix())));
        }
        held.push(path.clone());
        ReservedPath { path }
    }
}

impl Drop for ReservedPath {
    fn drop(&mut self) {
        let mut held = RESERVED_PATHS.lock().unwrap_or_else(|e| e.into_inner());
        held.retain(|p| p != &self.path);
    }
}

fn rng_suffix() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", n & 0xffff_ffff)
}

/// Отношение сторон в виде «9x16», «4x5», «1x1», «16x9».
pub fn aspect_label(w: u32, h: u32) -> String {
    fn gcd(a: u32, b: u32) -> u32 {
        if b == 0 {
            a
        } else {
            gcd(b, a % b)
        }
    }
    let g = gcd(w, h).max(1);
    format!("{}x{}", w / g, h / g)
}

/// Убирает символы, которые шрифт видео не нарисует (эмодзи → квадратики).
/// Возвращает (очищенный текст, были ли удалены символы).
pub fn strip_unrenderable(s: &str) -> (String, bool) {
    let mut removed = false;
    let out: String = s
        .chars()
        .filter(|&c| {
            let cp = c as u32;
            let bad = (0x1F000..=0x1FAFF).contains(&cp)
                || (0x2600..=0x27BF).contains(&cp)
                || (0xFE00..=0xFE0F).contains(&cp)
                || cp == 0x200D
                || (0xE0000..=0xE007F).contains(&cp)
                || (c.is_control() && c != '\n');
            removed |= bad;
            !bad
        })
        .collect();
    (
        out.split_whitespace().collect::<Vec<_>>().join(" "),
        removed,
    )
}

/// Перенос по словам, не длиннее max_chars в строке.
pub fn wrap_words(s: &str, max_chars: usize) -> Vec<String> {
    let max_chars = max_chars.max(4);
    let mut lines: Vec<String> = vec![];
    let mut cur = String::new();
    for w in s.split_whitespace() {
        let wl = w.chars().count();
        let cl = cur.chars().count();
        if cl > 0 && cl + 1 + wl > max_chars {
            lines.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(w);
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}

pub const MATERIALS: &[&str] = &[
    "PLA", "PLA+", "PLA-CF", "SILK", "PETG", "PETG-CF", "PCTG", "ABS", "ASA", "TPU", "PC", "PA",
    "PA-CF", "PA6-CF", "PAHT", "PAHT-CF", "HIPS", "PVA", "PP", "PET", "NYLON", "RESIN",
];

static LAYER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^0[.,](0[5-9]|[1-4]\d?)$").unwrap());

/// Материал и высота слоя из имени файла: «Spool_PETG_0.2.mp4» → (PETG, 0.2).
pub fn parse_specs(path: &Path) -> (Option<String>, Option<String>) {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let (mut mat, mut layer) = (None, None);
    for t in stem.split(|c: char| c == '_' || c.is_whitespace()) {
        let u = t.to_uppercase();
        if mat.is_none() && MATERIALS.contains(&u.as_str()) {
            mat = Some(u);
        } else if layer.is_none() && LAYER_RE.is_match(t) {
            layer = Some(t.replace(',', "."));
        }
    }
    (mat, layer)
}

static TIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^a-z0-9])(?:(\d{1,3})h(?:(\d{1,2})m)?(?:(\d{1,2})s)?|(\d{1,4})m(?:(\d{1,2})s)?|(\d{1,5})s)(?:$|[^a-z0-9])").unwrap()
});

/// Время процесса из имени: 3h1m33s / 45m10s / 2h / 90s → секунды. «0.4mm» не считается.
pub fn parse_duration_from_name(path: &Path) -> u64 {
    let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let Some(m) = TIME_RE.captures(name) else {
        return 0;
    };
    let g = |i: usize| {
        m.get(i)
            .and_then(|x| x.as_str().parse::<u64>().ok())
            .unwrap_or(0)
    };
    if m.get(1).is_some() {
        g(1) * 3600 + g(2) * 60 + g(3)
    } else if m.get(4).is_some() {
        g(4) * 60 + g(5)
    } else {
        g(6)
    }
}

pub fn fmt_duration_ru(sec: u64) -> String {
    let (h, m, s) = (sec / 3600, (sec % 3600) / 60, sec % 60);
    if h > 0 {
        format!("{h} ч {m} мин")
    } else if m > 0 {
        format!("{m} мин {s} с")
    } else {
        format!("{s} с")
    }
}

/// Байты свободного места на диске, где находится `dir`.
pub fn free_space(dir: &Path) -> Option<u64> {
    let mut p = dir;
    loop {
        if p.exists() {
            return fs2::available_space(p).ok();
        }
        p = p.parent()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural() {
        let mut v = vec!["clip10.mp4", "clip2.mp4", "Clip1.mp4", "clip02.mp4"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            v,
            vec!["Clip1.mp4", "clip2.mp4", "clip02.mp4", "clip10.mp4"]
        );
    }

    #[test]
    fn specs() {
        assert_eq!(
            parse_specs(Path::new("Spool_PETG_0.2.mp4")),
            (Some("PETG".into()), Some("0.2".into()))
        );
        assert_eq!(
            parse_specs(Path::new("box pla-cf 0,16.mp4")),
            (Some("PLA-CF".into()), Some("0.16".into()))
        );
        assert_eq!(parse_specs(Path::new("video_1.5_x.mp4")), (None, None));
    }

    #[test]
    fn durations() {
        assert_eq!(
            parse_duration_from_name(Path::new("part_3h1m33s.mp4")),
            3 * 3600 + 93
        );
        assert_eq!(
            parse_duration_from_name(Path::new("part 45m10s.mp4")),
            45 * 60 + 10
        );
        assert_eq!(parse_duration_from_name(Path::new("x_2h.mp4")), 7200);
        assert_eq!(parse_duration_from_name(Path::new("nozzle_0.4mm.mp4")), 0);
        assert_eq!(parse_duration_from_name(Path::new("Kobra_S1.mp4")), 0);
        assert_eq!(
            parse_duration_from_name(Path::new("VID_20261001_120000.mp4")),
            0
        );
    }

    #[test]
    fn names() {
        assert_eq!(sanitize_filename("a:b*c?  d"), "a_b_c_ d");
        assert_eq!(sanitize_filename("CON"), "video_CON");
        assert_eq!(sanitize_filename("  ..  "), "video_");
    }

    #[test]
    fn emoji() {
        let (s, r) = strip_unrenderable("Печать 🔥 12,5 ч ❤️");
        assert_eq!(s, "Печать 12,5 ч");
        assert!(r);
    }

    #[test]
    fn wrap() {
        assert_eq!(
            wrap_words("один два три четыре", 9),
            vec!["один два", "три", "четыре"]
        );
    }
}
