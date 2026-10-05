#![allow(clippy::redundant_closure)]
//! Интеграционные тесты на настоящем ffmpeg: набор «неудобных» файлов из реальной жизни.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use tls_core::pipeline::{build, BuildOptions, Event};
use tls_core::project::*;
use tls_core::render::Cancel;
use tls_core::tools::Tools;

fn ff(args: &[&str]) {
    let st = Command::new("ffmpeg")
        .args(["-v", "error", "-y"])
        .args(args)
        .status()
        .expect("ffmpeg");
    assert!(st.success(), "ffmpeg {:?}", args);
}

struct Fx {
    dir: PathBuf,
}

fn fixtures() -> &'static Fx {
    static F: OnceLock<Fx> = OnceLock::new();
    F.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("tls-fixtures-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().into_owned();
        // горизонтальное 1080p 30 fps
        ff(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=1920x1080:r=30:d=4",
            "-pix_fmt",
            "yuv420p",
            &p("a_1080.mp4"),
        ]);
        // вертикальное с телефона 25 fps, со своим звуком
        ff(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc=s=1080x1920:r=25:d=3",
            "-f",
            "lavfi",
            "-i",
            "sine=d=3",
            "-shortest",
            "-pix_fmt",
            "yuv420p",
            &p("b_vert.mp4"),
        ]);
        // переменная частота кадров
        ff(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=1280x720:r=60:d=4",
            "-vf",
            "select='not(mod(n\\,3))+lt(t\\,1)',setpts=N/FRAME_RATE/TB*1.3",
            "-fps_mode",
            "vfr",
            "-pix_fmt",
            "yuv420p",
            &p("c_vfr.mp4"),
        ]);
        // HDR HLG 10 бит (как iPhone)
        ff(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=1280x720:r=30:d=3",
            "-c:v",
            "libx265",
            "-x265-params",
            "log-level=error",
            "-pix_fmt",
            "yuv420p10le",
            "-color_primaries",
            "bt2020",
            "-color_trc",
            "arib-std-b67",
            "-colorspace",
            "bt2020nc",
            &p("d_hdr.mov"),
        ]);
        // кириллица, пробелы, запятая, материал/слой/время в имени
        ff(&[
            "-f",
            "lavfi",
            "-i",
            "mandelbrot=s=1440x1080:r=30",
            "-t",
            "3",
            "-pix_fmt",
            "yuv420p",
            &p("Клип, №1 PETG 0.2 1h2m.mp4"),
        ]);
        // длинный исходник (для быстрого режима по ключевым кадрам)
        ff(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=1280x720:r=30:d=90",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
            &p("long.mp4"),
        ]);
        // битые файлы с «правильными» расширениями
        std::fs::write(dir.join("broken.mp4"), b"not a video at all, just bytes").unwrap();
        std::fs::write(dir.join("fake.png"), b"\x89PN").unwrap();
        // фото результата и лого с прозрачностью
        ff(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc=s=3024x4032",
            "-frames:v",
            "1",
            &p("photo.jpg"),
        ]);
        ff(&[
            "-f",
            "lavfi",
            "-i",
            "color=c=red@0.6:s=400x200,format=rgba",
            "-frames:v",
            "1",
            &p("logo.png"),
        ]);
        // музыка с ритмом 120 BPM
        ff(&[
            "-f",
            "lavfi",
            "-i",
            "sine=f=220:d=40",
            "-f",
            "lavfi",
            "-i",
            "aevalsrc='if(lt(mod(t\\,0.5)\\,0.04)\\,sin(2*PI*900*t)\\,0)':d=40",
            "-filter_complex",
            "[0][1]amix=inputs=2:weights=0.3 1",
            "-c:a",
            "libmp3lame",
            &p("music.mp3"),
        ]);
        Fx { dir }
    })
}

fn tools() -> Tools {
    Tools::discover(None).expect("ffmpeg в PATH")
}

/// Отдельная копия файлов для теста (тесты, архивирующие исходники, не мешают друг другу).
fn copy_set(names: &[&str]) -> (tempfile::TempDir, Vec<PathBuf>) {
    let t = tempfile::tempdir().unwrap();
    let v = names
        .iter()
        .map(|n| {
            let d = t.path().join(n);
            std::fs::copy(fixtures().dir.join(n), &d).unwrap();
            d
        })
        .collect();
    (t, v)
}

#[derive(Debug, serde::Deserialize)]
struct Probe {
    streams: Vec<serde_json::Value>,
    format: serde_json::Value,
}

fn probe_json(p: &Path) -> Probe {
    let o = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
        ])
        .arg(p)
        .output()
        .unwrap();
    serde_json::from_slice(&o.stdout).unwrap()
}

fn opts(out: &Path) -> BuildOptions {
    BuildOptions {
        cache_dir: out.join("cache"),
        default_out_dir: out.join("out"),
        font: None,
        draft_seconds: None,
        seed: Some(42),
        resources: tls_core::looks::Resources::from_root(&resources_root()),
        ..Default::default()
    }
}

fn resources_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/resources")
}

fn clip(p: &Path) -> Clip {
    Clip {
        id: p.file_name().unwrap().to_string_lossy().into(),
        path: p.into(),
        ..Default::default()
    }
}

fn collect_events() -> (
    std::sync::Arc<std::sync::Mutex<Vec<Event>>>,
    impl Fn(Event) + Sync,
) {
    let v = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
    let v2 = v.clone();
    (v, move |e| v2.lock().unwrap().push(e))
}

fn frame_rgb(video: &Path, t: f64, x: u32, y: u32) -> [u8; 3] {
    let o = Command::new("ffmpeg")
        .args(["-v", "error", "-ss", &format!("{t}"), "-i"])
        .arg(video)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("crop=1:1:{x}:{y},format=rgb24"),
            "-f",
            "rawvideo",
            "-",
        ])
        .output()
        .unwrap();
    [o.stdout[0], o.stdout[1], o.stdout[2]]
}

#[test]
fn full_build_mixed_inputs() {
    let fx = fixtures();
    let (src, files) = copy_set(&[
        "a_1080.mp4",
        "b_vert.mp4",
        "c_vfr.mp4",
        "Клип, №1 PETG 0.2 1h2m.mp4",
        "broken.mp4",
    ]);
    let mut p = Project::default();
    p.clips = files.iter().map(|f| clip(f)).collect();
    p.end_photos = vec![fx.dir.join("photo.jpg"), fx.dir.join("fake.png")];
    p.music.tracks = vec![fx.dir.join("music.mp3")];
    p.speed = Speed::Target { seconds: 8.0 };
    p.transition.kind = "fade".into();
    p.info.title = "Anycubic Kobra S1".into();
    p.style.hook_text = "12,5 часов печати: 100% 🔥 за 8 секунд — смотри до конца".into();
    p.style.channel_text = "my_channel".into();
    p.style.watermark = Some(fx.dir.join("logo.png"));
    p.style.progress_bar = true;
    p.style.seamless_loop = true;
    p.after = AfterAction::Archive {
        dir: src.path().join("archive"),
    };
    let out = tempfile::tempdir().unwrap();
    let (ev, on) = collect_events();
    let rep = build(&tools(), &p, &opts(out.path()), &Cancel::new(), &on).expect("сборка");

    assert!(rep.all_ok, "{rep:?}");
    assert_eq!(rep.outputs.len(), 2);
    assert!(
        rep.warnings.iter().any(|w| w.contains("broken.mp4")),
        "битый клип должен быть пропущен с предупреждением"
    );
    assert!(rep.warnings.iter().any(|w| w.contains("fake.png")));
    assert!(rep.warnings.iter().any(|w| w.contains("Эмодзи")));
    for (o, (w, h)) in rep.outputs.iter().zip([(1080, 1920), (1920, 1080)]) {
        let path = o.path.as_ref().unwrap();
        assert!(path.is_file());
        assert!(!path.with_extension("mp4.part").exists());
        let j = probe_json(path);
        let v = j
            .streams
            .iter()
            .find(|s| s["codec_type"] == "video")
            .unwrap();
        let a = j
            .streams
            .iter()
            .find(|s| s["codec_type"] == "audio")
            .unwrap();
        assert_eq!(
            (v["width"].as_u64().unwrap(), v["height"].as_u64().unwrap()),
            (w, h)
        );
        assert_eq!(v["color_space"], "bt709");
        assert_eq!(v["color_transfer"], "bt709");
        assert_eq!(
            a["sample_rate"], "48000",
            "звук должен быть 48 кГц (не 96/192)"
        );
        assert_eq!(a["channels"], 2);
        let dur: f64 = j.format["duration"].as_str().unwrap().parse().unwrap();
        assert!(
            (dur - rep.duration).abs() < 0.25,
            "длительность {dur} vs план {}",
            rep.duration
        );
        assert!(o.cover.as_ref().unwrap().is_file());
        let desc = o.description.as_ref().unwrap();
        assert!(
            desc.contains("#petg") && desc.contains("@my_channel") && desc.contains("1 ч 2 мин"),
            "{desc}"
        );
        assert!(path.with_extension("txt").is_file());
    }
    // исходники перенесены в архив, битый — нет (он не участвовал)
    for f in &files[..4] {
        assert!(!f.exists(), "{f:?} должен уйти в архив");
    }
    assert!(files[4].exists());
    assert!(ev
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, Event::Progress { value } if *value >= 1.0)));
}

#[test]
fn progress_bar_animates() {
    let fx = fixtures();
    let (_s, files) = copy_set(&["a_1080.mp4"]);
    let mut p = Project::default();
    p.clips = vec![clip(&files[0])];
    p.speed = Speed::None;
    p.targets = vec![Target::landscape()];
    p.style.info_overlay = false;
    p.style.progress_bar = true;
    p.style.accent_color = "FF0000".into();
    p.export.cover = false;
    let _ = fx;
    let out = tempfile::tempdir().unwrap();
    let rep = build(&tools(), &p, &opts(out.path()), &Cancel::new(), &|_| {}).unwrap();
    let v = rep.outputs[0].path.clone().unwrap();
    // в середине ролика: левая часть полосы закрашена, правая — нет
    let left = frame_rgb(&v, 2.0, 100, 1076);
    let right = frame_rgb(&v, 2.0, 1800, 1076);
    assert!(left[0] > 200 && left[1] < 80, "левая часть {left:?}");
    assert!(
        !(right[0] > 200 && right[1] < 80),
        "правая часть не должна быть закрашена {right:?}"
    );
}

#[test]
fn long_source_fast_mode() {
    let (_s, files) = copy_set(&["long.mp4"]);
    let mut p = Project::default();
    p.clips = vec![clip(&files[0])];
    p.speed = Speed::Target { seconds: 5.0 };
    p.targets = vec![Target::vertical()];
    let out = tempfile::tempdir().unwrap();
    let (ev, on) = collect_events();
    let t0 = std::time::Instant::now();
    let rep = build(&tools(), &p, &opts(out.path()), &Cancel::new(), &on).unwrap();
    assert!(rep.all_ok);
    assert!(rep.speed > 12.0);
    assert!((rep.duration - 5.0).abs() < 0.1);
    assert!(ev
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, Event::Log { line } if line.contains("ключевые кадры"))));
    eprintln!("long: {:?}", t0.elapsed());
}

#[test]
fn timelapse_fx_hdr_stabilize_deflicker_blend() {
    let (_s, files) = copy_set(&["d_hdr.mov", "a_1080.mp4"]);
    let mut p = Project::default();
    p.clips = files.iter().map(|f| clip(f)).collect();
    p.speed = Speed::Factor { factor: 2.0 };
    p.timelapse = TimelapseFx {
        deflicker: true,
        stabilize: true,
        frame_blend: true,
        hdr_tonemap: true,
    };
    p.targets = vec![Target::vertical()];
    p.export.codec = Codec::Hevc;
    let out = tempfile::tempdir().unwrap();
    let rep = build(&tools(), &p, &opts(out.path()), &Cancel::new(), &|_| {}).unwrap();
    assert!(rep.all_ok, "{rep:?}");
    let j = probe_json(rep.outputs[0].path.as_ref().unwrap());
    let v = j
        .streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .unwrap();
    assert_eq!(v["codec_name"], "hevc");
    assert_eq!(v["codec_tag_string"], "hvc1");
    assert_eq!(v["pix_fmt"], "yuv420p");
}

#[test]
fn cancel_leaves_everything_intact() {
    let (src, files) = copy_set(&["long.mp4"]);
    let mut p = Project::default();
    p.clips = vec![clip(&files[0])];
    p.speed = Speed::None;
    p.after = AfterAction::Archive {
        dir: src.path().join("archive"),
    };
    let out = tempfile::tempdir().unwrap();
    let cancel = Cancel::new();
    let c2 = cancel.clone();
    let on = move |e: Event| {
        if let Event::Progress { value } = e {
            if value > 0.02 {
                c2.cancel();
            }
        }
    };
    let r = build(&tools(), &p, &opts(out.path()), &cancel, &on);
    assert!(matches!(r, Err(tls_core::Error::Cancelled)), "{r:?}");
    assert!(files[0].exists(), "исходник на месте");
    let leftovers: Vec<_> = walk(out.path())
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e == "mp4" || e == "part"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "недособранные файлы удалены: {leftovers:?}"
    );
}

#[test]
fn failed_target_keeps_sources() {
    let (src, files) = copy_set(&["a_1080.mp4"]);
    let out = tempfile::tempdir().unwrap();
    // папка второго формата — на самом деле файл: этот формат упадёт
    let bad = out.path().join("im_a_file");
    std::fs::write(&bad, b"x").unwrap();
    let mut p = Project::default();
    p.clips = vec![clip(&files[0])];
    p.speed = Speed::None;
    let mut t2 = Target::landscape();
    t2.out_dir = bad.join("sub");
    p.targets = vec![Target::vertical(), t2];
    p.after = AfterAction::Trash;
    p.export.parallel = true;
    let rep = build(&tools(), &p, &opts(out.path()), &Cancel::new(), &|_| {}).unwrap();
    assert!(!rep.all_ok);
    assert!(rep.outputs[0].path.is_some() && rep.outputs[1].error.is_some());
    assert!(
        files[0].exists(),
        "при ошибке хотя бы одного формата исходники не трогаем"
    );
    assert!(rep
        .warnings
        .iter()
        .any(|w| w.contains("оставлены на месте")));
    let _ = src;
}

#[test]
fn draft_and_no_music() {
    let (_s, files) = copy_set(&["a_1080.mp4", "b_vert.mp4"]);
    let mut p = Project::default();
    p.clips = files.iter().map(|f| clip(f)).collect();
    p.speed = Speed::None;
    let out = tempfile::tempdir().unwrap();
    let mut o = opts(out.path());
    o.draft_seconds = Some(3.0);
    let rep = build(&tools(), &p, &o, &Cancel::new(), &|_| {}).unwrap();
    assert_eq!(rep.outputs.len(), 1);
    let path = rep.outputs[0].path.clone().unwrap();
    assert!(path.starts_with(out.path().join("cache")));
    let j = probe_json(&path);
    let v = j
        .streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .unwrap();
    assert_eq!(v["width"], 540);
    assert!(
        j.streams.iter().any(|s| s["codec_type"] == "audio"),
        "даже без музыки есть звуковая дорожка (тишина)"
    );
    let dur: f64 = j.format["duration"].as_str().unwrap().parse().unwrap();
    assert!((dur - 3.0).abs() < 0.2);
}

#[test]
fn no_clips_is_clear_error() {
    let fx = fixtures();
    let mut p = Project::default();
    p.clips = vec![clip(&fx.dir.join("broken.mp4"))];
    let out = tempfile::tempdir().unwrap();
    let r = build(&tools(), &p, &opts(out.path()), &Cancel::new(), &|_| {});
    assert!(matches!(r, Err(tls_core::Error::NoClips)));
}

#[test]
fn every_transition_and_fit_mode_renders() {
    let (_s, files) = copy_set(&["a_1080.mp4", "b_vert.mp4"]);
    for (i, kind) in TRANSITIONS.iter().enumerate() {
        let mut p = Project::default();
        p.clips = files.iter().map(|f| clip(f)).collect();
        p.speed = Speed::None;
        p.transition.kind = kind.to_string();
        p.style.fit = [FitMode::Blur, FitMode::Fill, FitMode::Black][i % 3];
        p.style.color_filter = tls_core::graph::COLOR_FILTERS
            [i % tls_core::graph::COLOR_FILTERS.len()]
        .0
        .into();
        let out = tempfile::tempdir().unwrap();
        let mut o = opts(out.path());
        o.draft_seconds = Some(4.0);
        let rep = build(&tools(), &p, &o, &Cancel::new(), &|_| {})
            .unwrap_or_else(|e| panic!("{kind}: {e}"));
        assert!(rep.all_ok, "{kind}");
    }
}

fn walk(d: &Path) -> Vec<PathBuf> {
    let mut v = vec![];
    if let Ok(rd) = std::fs::read_dir(d) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                v.extend(walk(&p));
            } else {
                v.push(p);
            }
        }
    }
    v
}

#[test]
fn preview_frame_works() {
    let (_s, files) = copy_set(&["a_1080.mp4", "b_vert.mp4"]);
    let mut p = Project::default();
    p.clips = files.iter().map(|f| clip(f)).collect();
    p.style.hook_text = "Проверка".into();
    let out = tempfile::tempdir().unwrap();
    let (jpg, _) = tls_core::pipeline::preview_frame(
        &tools(),
        &p,
        &opts(out.path()),
        "vertical",
        &tls_core::pipeline::PreviewOptions::default(),
    )
    .unwrap();
    assert!(jpg.is_file());
}

/// Образ (LUT) с силой, автокоррекция, шумоподавление, чёткость (CAS), встроенная музыка и встроенный шрифт.
#[test]
fn looks_builtin_music_and_fonts() {
    let (_s, files) = copy_set(&["a_1080.mp4"]);
    let mut p = Project::default();
    p.clips = vec![clip(&files[0])];
    p.speed = Speed::None;
    p.targets = vec![Target::vertical()];
    p.style.look = "teal_orange".into();
    p.style.look_strength = 0.6;
    p.style.auto_color = true;
    p.style.sharpen = true;
    p.style.denoise = "strong".into();
    p.style.font_family = "unbounded".into();
    p.style.hook_text = "Проверка шрифта".into();
    p.music.tracks = vec!["builtin:lofi_workshop".into()];
    let out = tempfile::tempdir().unwrap();
    let rep = build(&tools(), &p, &opts(out.path()), &Cancel::new(), &|_| {}).unwrap();
    assert!(rep.all_ok, "{rep:?}");
    assert!(rep.music.as_ref().unwrap().ends_with("lofi_workshop.mp3"));
    assert!(
        !rep.warnings.iter().any(|w| w.contains("образ")),
        "{:?}",
        rep.warnings
    );
    // все образы рендерятся
    for (id, _) in tls_core::looks::LOOKS {
        let mut q = p.clone();
        q.style.look = id.to_string();
        let o = tempfile::tempdir().unwrap();
        let po = tls_core::pipeline::PreviewOptions {
            bare: true,
            ..Default::default()
        };
        tls_core::pipeline::preview_frame(&tools(), &q, &opts(o.path()), "vertical", &po)
            .unwrap_or_else(|e| panic!("{id}: {e}"));
    }
}

/// Слои текста от интерфейса накладываются точно в кадр; хук исчезает после своего времени.
#[test]
fn overlay_layers_are_composited() {
    let (_s, files) = copy_set(&["a_1080.mp4"]);
    let dir = tempfile::tempdir().unwrap();
    let mk = |name: &str, color: &str, x: u32| {
        let p = dir.path().join(name);
        ff(&[
            "-f",
            "lavfi",
            "-i",
            &format!("color=c={color}:s=200x200,format=rgba"),
            "-vf",
            &format!("pad=1920:1080:{x}:100:color=black@0"),
            "-frames:v",
            "1",
            p.to_str().unwrap(),
        ]);
        std::fs::read(p).unwrap()
    };
    let mut p = Project::default();
    p.clips = vec![clip(&files[0])];
    p.speed = Speed::None;
    p.targets = vec![Target::landscape()];
    p.style.hook_seconds = 1.0;
    p.style.info_overlay = false;
    p.export.cover = false;
    let out = tempfile::tempdir().unwrap();
    let mut o = opts(out.path());
    o.overlays.insert(
        "landscape".into(),
        tls_core::graph::OverlayImages {
            static_png: Some(mk("s.png", "magenta", 100)),
            hook_png: Some(mk("h.png", "blue", 1500)),
        },
    );
    let rep = build(&tools(), &p, &o, &Cancel::new(), &|_| {}).unwrap();
    let v = rep.outputs[0].path.clone().unwrap();
    let red = frame_rgb(&v, 2.5, 200, 200);
    assert!(
        red[0] > 200 && red[1] < 60 && red[2] > 200,
        "постоянный слой {red:?}"
    );
    let blue_early = frame_rgb(&v, 0.3, 1600, 200);
    assert!(
        blue_early[2] > 200 && blue_early[0] < 60 && blue_early[1] < 60,
        "хук в начале {blue_early:?}"
    );
    let blue_late = frame_rgb(&v, 2.5, 1600, 200);
    assert!(
        !(blue_late[2] > 200 && blue_late[0] < 60 && blue_late[1] < 60),
        "хук исчез {blue_late:?}"
    );
}

#[test]
fn old_filters_migrate_to_looks() {
    let mut p = Project::default();
    p.style.color_filter = "cinema".into();
    p.sanitize();
    assert_eq!(p.style.look, "teal_orange");
    let mut q = Project::default();
    q.style.color_filter = "sharp".into();
    q.sanitize();
    assert!(q.style.sharpen);
    assert_eq!(q.style.look, "none");
}
