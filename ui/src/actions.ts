// Действия пользователя: импорт файлов, проекты, сборка.
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "./api";
import { addUnique, baseName, classify, newClip, preflight } from "./logic";
import { useStore } from "./store";
import { defaultProject, type Project } from "./types";

const st = () => useStore.getState();

const VIDEO = ["mp4", "mov", "mkv", "avi", "m4v", "webm", "ts", "mts", "m2ts", "wmv", "3gp"];
const IMAGE = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif"];
const AUDIO = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma"];

/** Импорт путей (файлы и папки): проверка ffprobe, раскладка по типам. */
export async function importPaths(paths: string[], forceKind?: "clips" | "photos" | "music") {
  if (!paths.length) return;
  const files: string[] = [];
  for (const p of paths) {
    const ext = (p.split(".").pop() || "").toLowerCase();
    if ([...VIDEO, ...IMAGE, ...AUDIO].includes(ext)) files.push(p);
    else {
      try {
        files.push(...(await api.listFolder(p)));
      } catch {
        /* не папка и не медиа — отметим ниже */
        files.push(p);
      }
    }
  }
  st().set({ stage: `Проверяю файлы (${files.length})…` });
  let items;
  try {
    items = await api.probe(files);
  } catch (e) {
    st().toast("error", errorText(e));
    st().set({ stage: "" });
    return;
  }
  st().setMedia(items);
  const c = classify(items);
  const s = st();
  s.update((p) => {
    if (forceKind === "music") {
      p.music.tracks = addUnique(p.music.tracks, c.music, (x) => x);
      return;
    }
    if (forceKind === "photos") {
      p.end_photos = addUnique(p.end_photos, c.photos, (x) => x);
      return;
    }
    p.clips = addUnique(p.clips, c.clips.map(newClip), (x) => x.path);
    p.end_photos = addUnique(p.end_photos, c.photos, (x) => x);
    p.music.tracks = addUnique(p.music.tracks, c.music, (x) => x);
  });
  const added = [c.clips.length && `клипов: ${c.clips.length}`, c.photos.length && `фото: ${c.photos.length}`, c.music.length && `треков: ${c.music.length}`]
    .filter(Boolean)
    .join(", ");
  if (added) s.toast("ok", `Добавлено — ${added}`);
  for (const b of c.bad.slice(0, 3)) s.toast("error", `${baseName(b.path)}: ${b.error}`);
  if (c.bad.length > 3) s.toast("error", `И ещё ${c.bad.length - 3} файл(ов) не читаются`);
  if (!st().selectedClip && st().project.clips.length) st().set({ selectedClip: st().project.clips[0].id });
  st().set({ stage: "" });
}

export async function pickFiles(kind: "clips" | "photos" | "music") {
  const filters = {
    clips: [{ name: "Видео", extensions: VIDEO }],
    photos: [{ name: "Изображения", extensions: IMAGE }],
    music: [{ name: "Аудио", extensions: AUDIO }],
  }[kind];
  const r = await open({ multiple: true, filters });
  if (!r) return;
  await importPaths(Array.isArray(r) ? r : [r], kind);
}

export async function pickSingle(kind: "image" | "font"): Promise<string | null> {
  const filters = kind === "image" ? [{ name: "Изображения", extensions: ["png", "webp", "jpg", "jpeg"] }] : [{ name: "Шрифты", extensions: ["ttf", "otf"] }];
  const r = await open({ multiple: false, filters });
  if (!r || Array.isArray(r)) return null;
  if (kind === "image") await api.allowFiles([r]);
  return r;
}

export async function pickFolder(): Promise<string | null> {
  const r = await open({ directory: true, multiple: false });
  return typeof r === "string" ? r : null;
}

async function confirmDiscard(): Promise<boolean> {
  if (!st().dirty || !st().filePath) return true;
  return ask("В проекте есть несохранённые изменения. Продолжить без сохранения?", { title: "Timelapse Studio", kind: "warning" });
}

export async function newProject() {
  if (!(await confirmDiscard())) return;
  st().replace(defaultProject(), null);
}

export async function openProject(path?: string) {
  if (!(await confirmDiscard())) return;
  const p = path ?? (await open({ multiple: false, filters: [{ name: "Проект Timelapse Studio", extensions: ["tlsproj"] }] }));
  if (!p || Array.isArray(p)) return;
  try {
    const proj = await api.loadProject(p);
    st().replace(proj, p);
    await refreshMedia(proj);
    st().toast("ok", `Открыт проект «${proj.name}»`);
  } catch (e) {
    st().toast("error", `Не удалось открыть проект: ${errorText(e)}`);
  }
}

export async function saveProject(as = false) {
  let path = st().filePath;
  if (!path || as) {
    const r = await save({ defaultPath: `${st().project.name || "Проект"}.tlsproj`, filters: [{ name: "Проект Timelapse Studio", extensions: ["tlsproj"] }] });
    if (!r) return;
    path = r;
  }
  try {
    await api.saveProject(path, st().project);
    st().set({ filePath: path, dirty: false });
    st().toast("ok", "Проект сохранён");
  } catch (e) {
    st().toast("error", `Не удалось сохранить: ${errorText(e)}`);
  }
}

/** Повторная проверка файлов проекта (после открытия/автовосстановления). */
export async function refreshMedia(p: Project) {
  const all = [...p.clips.map((c) => c.path), ...p.end_photos, ...p.music.tracks, ...(p.style.watermark ? [p.style.watermark] : [])];
  if (!all.length) return;
  try {
    st().setMedia(await api.probe(all));
  } catch {
    /* ffmpeg недоступен — покажет экран ошибки */
  }
}

export async function startBuild(draft = false) {
  const s = st();
  if (s.building) return;
  const problems = preflight(s.project, s.media);
  const blocking = problems.filter((w) => w.startsWith("Добавьте") || w.startsWith("Выберите"));
  if (blocking.length) {
    blocking.forEach((w) => s.toast("warn", w));
    return;
  }
  s.set({ building: true, buildKind: draft ? "draft" : "full", progress: 0, stage: "Подготовка", log: [], warnings: [], report: draft ? s.report : null });
  try {
    let project = s.project;
    if (draft) {
      // пробный ролик — в формате, выбранном в предпросмотре
      project = structuredClone(project);
      const i = project.targets.findIndex((t) => t.id === s.previewTarget);
      if (i > 0) project.targets.unshift(...project.targets.splice(i, 1));
      project.targets[0].enabled = true;
    }
    await api.startBuild(project, draft ? 8 : undefined);
  } catch (e) {
    s.set({ building: false, buildKind: null, stage: "" });
    s.toast("error", errorText(e));
  }
}

export async function cancelBuild() {
  await api.cancelBuild().catch(() => {});
  st().set({ stage: "Останавливаю…" });
}

export async function renderFrame() {
  const s = st();
  if (!s.project.clips.some((c) => c.enabled)) {
    s.toast("warn", "Добавьте клипы — тогда покажу кадр с оформлением");
    return;
  }
  s.set({ stage: "Рисую кадр…" });
  try {
    const r = await api.previewFrame(s.project, s.previewTarget);
    st().set({ frame: { path: r.path, at: Date.now() }, preview: "frame", stage: "" });
    r.warnings.slice(0, 2).forEach((w) => st().toast("warn", w));
  } catch (e) {
    st().set({ stage: "" });
    st().toast("error", errorText(e));
  }
}
