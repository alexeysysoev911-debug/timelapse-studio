//! Определение сетки битов трека (beat-sync переходов).
use crate::tools::{run_with_timeout, Tools};
use std::path::Path;
use std::time::Duration;

const SR: usize = 22050;

/// (время первого бита в треке, период в секундах) или None.
pub fn detect(tools: &Tools, path: &Path, start: f64, analyze: f64) -> Option<(f64, f64)> {
    let mut c = tools.ffmpeg_cmd();
    c.args([
        "-v",
        "error",
        "-ss",
        &format!("{:.3}", start.max(0.0)),
        "-t",
        &format!("{analyze:.1}"),
        "-i",
    ])
    .arg(path)
    .args([
        "-vn",
        "-ac",
        "1",
        "-ar",
        &SR.to_string(),
        "-f",
        "f32le",
        "-",
    ]);
    let out = run_with_timeout(c, Duration::from_secs(90), "анализ бита").ok()?;
    if !out.ok() {
        return None;
    }
    let x: Vec<f32> = out
        .stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    analyze_pcm(&x).map(|(t0, p)| (start + t0, p))
}

/// Чистая функция над PCM (моно, 22050 Гц) — тестируется без ffmpeg.
pub fn analyze_pcm(x: &[f32]) -> Option<(f64, f64)> {
    let (hop, win) = (512usize, 1024usize);
    if x.len() < SR * 5 {
        return None;
    }
    let n = (x.len() - win) / hop;
    if n < 200 {
        return None;
    }
    let e: Vec<f64> = (0..n)
        .map(|i| {
            let s: f64 = x[i * hop..i * hop + win]
                .iter()
                .map(|v| (*v as f64) * (*v as f64))
                .sum();
            s.ln_1p()
        })
        .collect();
    let flux: Vec<f64> = e.windows(2).map(|w| (w[1] - w[0]).max(0.0)).collect();
    let mean = flux.iter().sum::<f64>() / flux.len() as f64;
    let var = flux.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / flux.len() as f64;
    let thr = mean + 1.4 * var.sqrt();
    let min_gap = (0.28 * SR as f64 / hop as f64) as usize;
    let mut onsets: Vec<usize> = vec![];
    for i in 1..flux.len().saturating_sub(1) {
        if flux[i] > thr
            && flux[i] >= flux[i - 1]
            && flux[i] >= flux[i + 1]
            && onsets.last().is_none_or(|l| i - l > min_gap)
        {
            onsets.push(i);
        }
    }
    if onsets.len() < 8 {
        return None;
    }
    let times: Vec<f64> = onsets
        .iter()
        .map(|&i| i as f64 * hop as f64 / SR as f64)
        .collect();
    let mut ioi: Vec<f64> = times
        .windows(2)
        .map(|w| w[1] - w[0])
        .filter(|d| *d > 0.28 && *d < 1.5)
        .collect();
    if ioi.len() < 4 {
        return None;
    }
    ioi.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut period = ioi[ioi.len() / 2];
    while period < 0.34 {
        period *= 2.0;
    }
    while period > 1.2 {
        period /= 2.0;
    }
    Some((times[0], period))
}

/// Подгоняет длительности клипов (после ускорения) так, чтобы переходы попадали в бит.
/// Сдвиг каждого стыка −0.5…+0.2 с, клип не короче 0.6 с.
pub fn align_to_beats(durs: &mut [f64], xfade: f64, beats: (f64, f64)) {
    let (t0, period) = beats;
    if period <= 0.2 || durs.len() < 2 {
        return;
    }
    let mut t = 0.0;
    for k in 0..durs.len() - 1 {
        let cut = t + durs[k] - xfade;
        let n = ((cut - t0) / period).round();
        let delta = (t0 + n * period - cut).clamp(-0.5, 0.2);
        if durs[k] + delta >= 0.6 {
            durs[k] += delta;
        }
        t += durs[k] - xfade;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_120bpm() {
        // щелчки каждые 0.5 с поверх тишины — 120 BPM
        let mut x = vec![0f32; SR * 20];
        let mut t = 0.25;
        while t < 19.5 {
            let i = (t * SR as f64) as usize;
            for k in 0..400 {
                x[i + k] = ((k as f32) * 0.3).sin() * 0.9;
            }
            t += 0.5;
        }
        let (t0, p) = analyze_pcm(&x).expect("beats");
        assert!((p - 0.5).abs() < 0.03, "period {p}");
        assert!(t0 < 0.4);
    }

    #[test]
    fn silence_none() {
        assert!(analyze_pcm(&vec![0f32; SR * 10]).is_none());
    }

    #[test]
    fn align_moves_cuts_onto_grid() {
        let mut d = vec![2.1, 2.1, 2.1];
        align_to_beats(&mut d, 0.0, (0.0, 0.5));
        let cut1 = d[0];
        let cut2 = d[0] + d[1];
        assert!((cut1 / 0.5 - (cut1 / 0.5).round()).abs() < 1e-6);
        assert!((cut2 / 0.5 - (cut2 / 0.5).round()).abs() < 1e-6);
    }
}
