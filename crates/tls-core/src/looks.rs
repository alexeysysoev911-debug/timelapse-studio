//! Встроенные ресурсы: цветовые «образы» (3D LUT), шрифты, музыка.
use crate::error::{Error, Result};
use std::path::{Path, PathBuf};

/// (id, название). Файлы: `<luts_dir>/<id>.cube`.
pub const LOOKS: &[(&str, &str)] = &[
    ("none", "Без образа"),
    ("vivid", "Сочный"),
    ("clean_bright", "Чистый светлый"),
    ("warm_film", "Тёплая плёнка"),
    ("golden_hour", "Золотой час"),
    ("cool_tech", "Холодный техно"),
    ("teal_orange", "Кино: бирюза и оранж"),
    ("pastel", "Пастель"),
    ("matte", "Матовый"),
    ("bw_contrast", "Ч/Б контраст"),
];

/// (id, название, файл в `<fonts_dir>`).
pub const FONTS: &[(&str, &str, &str)] = &[
    ("montserrat", "Montserrat", "Montserrat-Bold.ttf"),
    ("unbounded", "Unbounded", "Unbounded-Bold.ttf"),
    ("rubik", "Rubik", "Rubik-Bold.ttf"),
    ("oswald", "Oswald", "Oswald-Bold.ttf"),
    ("inter", "Inter", "Inter-Bold.ttf"),
    ("ptsans", "PT Sans", "PTSans-Bold.ttf"),
];

pub const BUILTIN_PREFIX: &str = "builtin:";

/// Путь к ресурсам программы (музыка, LUT, шрифты).
#[derive(Debug, Clone, Default)]
pub struct Resources {
    pub music_dir: Option<PathBuf>,
    pub luts_dir: Option<PathBuf>,
    pub fonts_dir: Option<PathBuf>,
}

impl Resources {
    /// Ресурсы в стандартной раскладке: `<root>/music`, `<root>/luts`, `<root>/fonts`.
    pub fn from_root(root: &Path) -> Self {
        let d = |n: &str| Some(root.join(n)).filter(|p| p.is_dir());
        Resources {
            music_dir: d("music"),
            luts_dir: d("luts"),
            fonts_dir: d("fonts"),
        }
    }

    /// «builtin:rise_up» → путь к встроенному треку; обычные пути — без изменений.
    pub fn resolve(&self, p: &Path) -> PathBuf {
        let s = p.to_string_lossy();
        match (s.strip_prefix(BUILTIN_PREFIX), &self.music_dir) {
            (Some(id), Some(dir)) => {
                dir.join(format!("{}.mp3", crate::util::sanitize_filename(id)))
            }
            _ => p.to_path_buf(),
        }
    }

    pub fn font_file(&self, id: &str) -> Option<PathBuf> {
        let file = FONTS.iter().find(|(k, _, _)| *k == id).map(|f| f.2)?;
        self.fonts_dir
            .as_ref()
            .map(|d| d.join(file))
            .filter(|p| p.is_file())
    }

    pub fn lut_file(&self, look: &str) -> Option<PathBuf> {
        if look == "none" || !LOOKS.iter().any(|(k, _)| *k == look) {
            return None;
        }
        self.luts_dir
            .as_ref()
            .map(|d| d.join(format!("{look}.cube")))
            .filter(|p| p.is_file())
    }
}

/// Читает .cube и смешивает с нейтральной таблицей по силе `k` (0..1). Результат — текст .cube.
/// Так сила образа «запекается» в таблицу: граф ffmpeg остаётся простым и быстрым.
pub fn blend_cube(src: &str, k: f64) -> Result<String> {
    let mut size = 0usize;
    let mut header = String::new();
    let mut vals: Vec<[f64; 3]> = vec![];
    for line in src.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some(n) = t.strip_prefix("LUT_3D_SIZE") {
            size = n
                .trim()
                .parse()
                .map_err(|_| Error::Invalid("LUT: размер".into()))?;
            header.push_str(t);
            header.push('\n');
            continue;
        }
        if t.starts_with("TITLE") || t.starts_with("DOMAIN_") {
            header.push_str(t);
            header.push('\n');
            continue;
        }
        let v: Vec<f64> = t
            .split_whitespace()
            .filter_map(|x| x.parse().ok())
            .collect();
        if v.len() == 3 {
            vals.push([v[0], v[1], v[2]]);
        }
    }
    if size < 2 || vals.len() != size * size * size {
        return Err(Error::Invalid("LUT повреждён".into()));
    }
    let k = k.clamp(0.0, 1.0);
    let m = (size - 1) as f64;
    let mut out = header;
    for (i, v) in vals.iter().enumerate() {
        // порядок .cube: R меняется быстрее всего
        let r = (i % size) as f64 / m;
        let g = ((i / size) % size) as f64 / m;
        let b = (i / (size * size)) as f64 / m;
        let id = [r, g, b];
        let mix = |c: usize| id[c] + (v[c] - id[c]) * k;
        out.push_str(&format!("{:.5} {:.5} {:.5}\n", mix(0), mix(1), mix(2)));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_cube() -> String {
        // 2×2×2: инверсия цвета
        let mut s = String::from("LUT_3D_SIZE 2\n");
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    s.push_str(&format!("{} {} {}\n", 1 - r, 1 - g, 1 - b));
                }
            }
        }
        s
    }

    #[test]
    fn blend_zero_is_identity_and_one_is_original() {
        let c = tiny_cube();
        let zero = blend_cube(&c, 0.0).unwrap();
        assert!(zero.contains("0.00000 0.00000 0.00000\n1.00000 0.00000 0.00000"));
        let one = blend_cube(&c, 1.0).unwrap();
        assert!(one.contains("1.00000 1.00000 1.00000\n0.00000 1.00000 1.00000"));
        let half = blend_cube(&c, 0.5).unwrap();
        assert!(half.lines().skip(1).all(|l| l == "0.50000 0.50000 0.50000"));
    }

    #[test]
    fn broken_cube_is_error() {
        assert!(blend_cube("LUT_3D_SIZE 3\n0 0 0\n", 1.0).is_err());
    }

    #[test]
    fn builtin_resolution() {
        let r = Resources {
            music_dir: Some("/res/music".into()),
            ..Default::default()
        };
        assert_eq!(
            r.resolve(Path::new("builtin:rise_up")),
            PathBuf::from("/res/music/rise_up.mp3")
        );
        assert_eq!(
            r.resolve(Path::new("C:/a/b.mp3")),
            PathBuf::from("C:/a/b.mp3")
        );
        // попытка выйти из папки — обезврежена
        assert_eq!(
            r.resolve(Path::new("builtin:../x")),
            PathBuf::from("/res/music/_x.mp3")
        );
    }
}
