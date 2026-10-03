// Чистая логика интерфейса (покрыта тестами): оценка длительности, раскладка файлов, форматирование.
import type { Clip, MediaInfo, ProbeItem, Project } from "./types";

export function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

export function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}

export function fmtSec(s: number): string {
  if (!isFinite(s) || s <= 0) return "0 с";
  if (s < 60) return `${s < 10 ? s.toFixed(1).replace(".", ",") : Math.round(s)} с`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  if (m < 60) return `${m} мин ${r} с`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

export function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1).replace(".", ",")} ГБ`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} МБ`;
  return `${Math.max(1, Math.round(b / 1e3))} КБ`;
}

/** Длительность клипа после обрезки (сек исходника). */
export function clipDur(c: Clip, info?: MediaInfo | null): number {
  if (!info) return 0;
  const end = c.trim_end != null ? Math.min(c.trim_end, info.duration) : info.duration;
  return Math.max(0, end - c.trim_start);
}

export interface Estimate {
  source: number;
  speed: number;
  total: number;
}

/** Оценка итоговой длительности — та же формула, что в ядре (resolve_speed). */
export function estimate(p: Project, media: Record<string, ProbeItem>): Estimate {
  const clips = p.clips.filter((c) => c.enabled && media[c.path]?.info);
  const durs = clips.map((c) => clipDur(c, media[c.path]!.info));
  const source = durs.reduce((a, b) => a + b, 0);
  const photos = p.end_photos.filter((ph) => media[ph]?.info).length;
  const photoSec = photos > 0 ? p.style.photo_seconds : 0;
  if (source <= 0) return { source: 0, speed: 1, total: photoSec * photos };
  let speed = 1;
  if (p.speed.mode === "factor") speed = Math.max(0.1, p.speed.factor);
  if (p.speed.mode === "target") speed = Math.max(1, source / Math.max(1, p.speed.seconds)); // предел, не замедляем
  const segs = durs.map((d) => d / speed).concat(Array(photos).fill(photoSec));
  const xfade = (s: number[]) => {
    if (p.transition.kind === "none" || s.length < 2) return 0;
    const x = Math.min(p.transition.duration, Math.min(...s) * 0.3);
    return x < 0.1 ? 0 : x;
  };
  let xd = xfade(segs);
  if (p.speed.mode === "target") {
    const want = p.speed.seconds - photoSec * photos + xd * (segs.length - 1);
    if (want > 0.5) {
      speed = Math.max(1, source / want);
      const segs2 = durs.map((d) => d / speed).concat(Array(photos).fill(photoSec));
      xd = xfade(segs2);
      return { source, speed, total: segs2.reduce((a, b) => a + b, 0) - xd * (segs2.length - 1) };
    }
  }
  return { source, speed, total: segs.reduce((a, b) => a + b, 0) - xd * (segs.length - 1) };
}

export interface Sorted {
  clips: string[];
  photos: string[];
  music: string[];
  bad: { path: string; error: string }[];
}

/** Раскладка проверенных файлов по назначению. */
export function classify(items: ProbeItem[]): Sorted {
  const r: Sorted = { clips: [], photos: [], music: [], bad: [] };
  for (const it of items) {
    if (!it.info) {
      r.bad.push({ path: it.path, error: it.error || "не читается" });
      continue;
    }
    if (it.info.kind === "video") r.clips.push(it.path);
    else if (it.info.kind === "image") r.photos.push(it.path);
    else if (it.info.kind === "audio") r.music.push(it.path);
    else r.bad.push({ path: it.path, error: "неподдерживаемый тип" });
  }
  return r;
}

let idCounter = 0;
export function newClip(path: string): Clip {
  idCounter += 1;
  return { id: `${Date.now().toString(36)}-${idCounter}`, path, enabled: true, trim_start: 0, trim_end: null };
}

/** Добавить без дублей (по пути). */
export function addUnique<T>(list: T[], items: T[], key: (x: T) => string): T[] {
  const seen = new Set(list.map(key));
  const out = [...list];
  for (const it of items) {
    const k = key(it);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

export function move<T>(arr: T[], from: number, to: number): T[] {
  const a = [...arr];
  const [x] = a.splice(from, 1);
  a.splice(to, 0, x);
  return a;
}

/** Предупреждения до сборки — понятным языком. */
export function preflight(p: Project, media: Record<string, ProbeItem>): string[] {
  const w: string[] = [];
  const active = p.clips.filter((c) => c.enabled);
  if (!active.length) w.push("Добавьте хотя бы один клип.");
  if (active.some((c) => media[c.path] && !media[c.path].info)) w.push("Некоторые клипы не читаются — они будут пропущены.");
  if (!p.targets.some((t) => t.enabled)) w.push("Выберите хотя бы один формат на вкладке «Экспорт».");
  const est = estimate(p, media);
  if (est.total > 0 && p.targets.some((t) => t.enabled && t.height > t.width) && est.total > 180)
    w.push(`Ролик получится ${fmtSec(est.total)} — для Reels и Shorts лучше до 3 минут.`);
  return w;
}
