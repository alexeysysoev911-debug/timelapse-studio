// Действия пользователя: импорт файлов, проекты, сборка, предпросмотр, обновления.
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "./api";
import { addUnique, baseName, classify, isNewer, newClip, plural, preflight } from "./logic";
import { renderOverlays } from "./overlay";
import { currentGen, saveNow, useStore } from "./store";
import { defaultProject, type Project } from "./types";

const st = () => useStore.getState();

const VIDEO = ["mp4", "mov", "mkv", "avi", "m4v", "webm", "ts", "mts", "m2ts", "wmv", "3gp"];
const IMAGE = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif"];
const AUDIO = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma"];

/** Новый проект: встроенный энергичный трек уже выбран — ролик звучит «из коробки». */
export const freshProject = () => defaultProject(st().appInfo?.builtin_music[0]?.token);

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
        files.push(p); // не папка и не медиа — покажем ошибку ниже
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
  s.edit((p) => {
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
  if (c.bad.length > 3) s.toast("error", `И ещё ${c.bad.length - 3} ${plural(c.bad.length - 3, ["файл не читается", "файла не читаются", "файлов не читаются"])}`);
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
  await api.allowFiles([r]);
  return r;
}

export async function pickFolder(): Promise<string | null> {
  const r = await open({ directory: true, multiple: false });
  return typeof r === "string" ? r : null;
}

/** Открыть проект в редакторе (с проверкой файлов). */
async function load(p: Project, path: string | null = null) {
  st().replace(p, path);
  await refreshMedia(p);
}

/** Новый проект. Предыдущий уже сохранён в библиотеке — к нему можно вернуться одной кнопкой. */
export async function newProject() {
  await saveNow();
  const prev = st().project;
  const empty = prev.clips.length === 0 && prev.end_photos.length === 0;
  st().replace(freshProject(), null);
  await saveNow();
  if (empty) {
    // пустой черновик не засоряет «Мои проекты»
    if (prev.id) api.projectDelete(prev.id).catch(() => {});
  } else if (prev.id) {
    st().toast("info", `Создан новый проект. «${prev.name}» сохранён в „Мои проекты“.`, {
      label: "Вернуть предыдущий",
      run: () => openFromLibrary(prev.id),
    });
  }
}

export async function openFromLibrary(id: string) {
  await saveNow();
  try {
    const p = await api.projectOpen(id);
    await load(p);
    st().set({ showHome: false });
  } catch (e) {
    st().toast("error", `Не удалось открыть проект: ${errorText(e)}`);
  }
}

/** Импорт проекта из файла .tlsproj (попадает в библиотеку как новый). */
export async function openProjectFile(path?: string) {
  const p = path ?? (await open({ multiple: false, filters: [{ name: "Проект Timelapse Studio", extensions: ["tlsproj"] }] }));
  if (!p || Array.isArray(p)) return;
  try {
    await saveNow();
    const proj = await api.loadProject(p);
    proj.id = "";
    await load(proj, p);
    await saveNow();
    st().set({ showHome: false });
    st().toast("ok", `Открыт проект «${proj.name}»`);
  } catch (e) {
    st().toast("error", `Не удалось открыть проект: ${errorText(e)}`);
  }
}

/** Экспорт проекта в файл (для переноса на другой компьютер). Ctrl+S просто подтверждает автосохранение. */
export async function saveProject(as = false) {
  await saveNow();
  if (!as && !st().filePath) {
    st().set({ dirty: false });
    st().toast("ok", "Проект сохранён в «Мои проекты»");
    return;
  }
  let path = st().filePath;
  if (!path || as) {
    const r = await save({ defaultPath: `${st().project.name || "Проект"}.tlsproj`, filters: [{ name: "Проект Timelapse Studio", extensions: ["tlsproj"] }] });
    if (!r) return;
    path = r;
  }
  try {
    await api.saveProject(path, st().project);
    st().set({ filePath: path, dirty: false });
    st().toast("ok", "Проект сохранён в файл");
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

async function freshInfo() {
  try {
    const info = await api.projectInfo(st().project);
    st().set({ info });
    return info;
  } catch {
    return st().info;
  }
}

export async function startBuild(draft = false) {
  const s = st();
  if (s.building || s.mandatory) return;
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
      project.targets = project.targets.slice(0, 1);
    }
    const overlays = await renderOverlays(project, await freshInfo());
    await api.startBuild(project, draft ? 8 : undefined, overlays);
  } catch (e) {
    s.set({ building: false, buildKind: null, stage: "" });
    s.toast("error", errorText(e));
  }
}

export async function cancelBuild() {
  await api.cancelBuild().catch(() => {});
  st().set({ stage: "Останавливаю…" });
}

/** Точный кадр через видеодвижок — со всем оформлением, как в итоговом ролике. */
export async function renderFrame() {
  const s = st();
  if (!s.project.clips.some((c) => c.enabled)) {
    s.toast("warn", "Добавьте клипы — тогда покажу кадр с оформлением");
    return;
  }
  s.set({ stage: "Рисую точный кадр…" });
  try {
    const project = structuredClone(s.project);
    project.targets = project.targets.map((t) => ({ ...t, enabled: t.id === s.previewTarget }));
    const overlays = await renderOverlays(project, await freshInfo());
    const gen = currentGen();
    const r = await api.previewFrame(project, s.previewTarget, { at: s.previewAt, scale: 0.5 }, overlays);
    if (gen !== currentGen()) return st().set({ stage: "" });
    st().set({ frame: { path: r.path, at: Date.now() }, stage: "", preview: "frame", showExact: true });
    r.warnings.slice(0, 2).forEach((w) => st().toast("warn", w));
  } catch (e) {
    st().set({ stage: "" });
    st().toast("error", errorText(e));
  }
}

/** Ключ «подложки»: всё, что влияет на картинку видео (без текстов). */
export function baseKey(p: Project, target: string, at: number | null): string {
  const clips = p.clips.filter((c) => c.enabled).map((c) => [c.path, c.trim_start, c.trim_end]);
  const s = p.style;
  return JSON.stringify([clips, p.end_photos, target, at, s.fit, s.blur_sigma, s.look, s.look_strength, s.auto_color, s.sharpen, p.speed, p.transition, p.timelapse.hdr_tonemap]);
}

let baseSeq = 0;
let baseInflight = "";
/** «Чистый» кадр для живого предпросмотра (+ кадр «до» для сравнения). */
export async function loadBase() {
  const s = st();
  if (!s.project.clips.some((c) => c.enabled && s.media[c.path]?.info)) return;
  const key = baseKey(s.project, s.previewTarget, s.previewAt);
  if (s.base?.key === key || key === baseInflight) return;
  baseInflight = key;
  const seq = ++baseSeq;
  const gen = currentGen();
  s.set({ baseLoading: true });
  try {
    const opt = { at: s.previewAt, bare: true, scale: 0.5 };
    const after = await api.previewFrame(s.project, s.previewTarget, opt);
    const needBefore = s.project.style.look !== "none" || s.project.style.auto_color || s.project.style.sharpen;
    let before: string | null = null;
    if (needBefore) {
      const b = structuredClone(s.project);
      b.style.auto_color = false;
      b.style.sharpen = false;
      before = (await api.previewFrame(b, s.previewTarget, { ...opt, look_override: "none" })).path;
    }
    if (seq === baseSeq && gen === currentGen()) st().set({ base: { path: after.path, before, key }, baseLoading: false });
  } catch (e) {
    if (seq === baseSeq && gen === currentGen()) {
      st().set({ baseLoading: false });
      st().toast("error", errorText(e));
    }
  } finally {
    if (baseInflight === key) baseInflight = "";
    if (seq === baseSeq && st().baseLoading) st().set({ baseLoading: false });
  }
}

let thumbsKey = "";
let thumbsSeq = 0;
export async function loadLookThumbs(force = false) {
  const s = st();
  const c = s.project.clips.find((x) => x.enabled && s.media[x.path]?.info);
  if (!c) return;
  const key = JSON.stringify([c.path, c.trim_start, s.previewTarget, s.project.style.fit]);
  if (!force && key === thumbsKey && s.lookThumbs.length) return;
  thumbsKey = key;
  const seq = ++thumbsSeq;
  try {
    const thumbs = await api.lookThumbs(s.project, s.previewTarget, s.previewAt ?? undefined);
    if (seq === thumbsSeq) st().set({ lookThumbs: thumbs });
  } catch {
    thumbsKey = "";
    /* без миниатюр — список названий всё равно работает */
  }
}

/** Реклама и сведения об обновлениях с сервера программы (панель управления). */
export async function loadRemote() {
  try {
    const r = await api.serverConfig();
    const cur = st().appInfo?.version ?? "0";
    const u = r.update;
    // блокируем только по свежему ответу сервера: без интернета обновиться всё равно нельзя
    const mandatory = r.fresh && u && u.kind === "mandatory" && isNewer(u.version, cur) ? { version: u.version, notes: u.notes } : null;
    st().set({ remote: r, mandatory });
  } catch {
    /* сервер недоступен — программа работает как обычно */
  }
}

/** Проверка обновлений. silent — при запуске: молчим, если обновлений нет или нет интернета. */
export async function checkUpdates(silent = false) {
  if (st().updateChecking) return;
  try {
    st().set({ updateError: null, updateChecking: true });
    const u = await api.updateCheck();
    st().set({ update: u });
    if (st().showAbout) return; // всё видно в окне «О программе»
    if (u.available) {
      st().toast("info", `Доступна версия ${u.version}`, { label: "Подробнее", run: () => st().set({ showAbout: true }) });
    } else if (!silent) {
      st().toast("ok", `У вас последняя версия ${u.current}`);
    }
  } catch (e) {
    st().set({ updateError: errorText(e) });
    if (!silent && !st().showAbout) st().toast("error", errorText(e));
  } finally {
    st().set({ updateChecking: false });
  }
}

export async function installUpdate() {
  if (st().building) {
    st().toast("warn", "Дождитесь окончания сборки — потом обновим программу.");
    return;
  }
  st().set({ updateProgress: 0 });
  try {
    await api.updateInstall(); // при успехе программа перезапустится сама
  } catch (e) {
    const m = st().mandatory;
    st().set({ updateProgress: null, mandatory: m ? { ...m, failed: (m.failed ?? 0) + 1 } : null });
    st().toast("error", errorText(e));
  }
}
