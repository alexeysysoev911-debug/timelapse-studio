//! Демонстрационная сборка: cargo run --example demo -- <папка с клипами> <выходная папка> [музыка.mp3]
use tls_core::pipeline::{build, BuildOptions, Event};
use tls_core::project::*;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let src = std::path::PathBuf::from(&a[1]);
    let out = std::path::PathBuf::from(&a[2]);
    let mut clips: Vec<_> = std::fs::read_dir(&src)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| tls_core::probe::kind_by_ext(p) == tls_core::probe::MediaKind::Video)
        .collect();
    tls_core::util::sort_paths_natural(&mut clips);
    let mut p = Project::default();
    p.clips = clips
        .iter()
        .map(|c| Clip {
            path: c.clone(),
            ..Default::default()
        })
        .collect();
    if let Some(m) = a.get(3) {
        p.music.tracks = vec![m.into()];
    }
    p.info.title = "Anycubic Kobra S1".into();
    p.style.hook_text = "12 часов печати за 20 секунд".into();
    p.style.channel_text = "3dprinteralesha".into();
    p.style.progress_bar = true;
    let tools = tls_core::tools::Tools::discover(None).unwrap();
    let opts = BuildOptions {
        cache_dir: out.join("cache"),
        default_out_dir: out.clone(),
        font: None,
        draft_seconds: None,
        seed: None,
        ..Default::default()
    };
    let r = build(&tools, &p, &opts, &tls_core::render::Cancel::new(), &|e| {
        if let Event::Stage { text } = e {
            eprintln!("{text}")
        }
    });
    println!("{r:#?}");
}
