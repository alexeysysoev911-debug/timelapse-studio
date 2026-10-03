// Состояние приложения: проект с историей изменений (Ctrl+Z / Ctrl+Y), автосохранение в библиотеку.
import { create } from "zustand";
import { api } from "./api";
import type { AppInfo, BuildReport, ClipInfoText, LookThumb, ProbeItem, Project, Settings, UpdateInfo } from "./types";
import { defaultProject } from "./types";

const HISTORY_LIMIT = 200;

export interface Toast {
  id: number;
  kind: "info" | "ok" | "warn" | "error";
  text: string;
  action?: { label: string; run: () => void };
}

export type PreviewMode = "clip" | "frame" | "draft";

interface S {
  project: Project;
  past: Project[];
  future: Project[];
  /** ключ «слияния» — серия быстрых изменений одного поля = один шаг отмены */
  lastKey: string | null;
  lastAt: number;
  filePath: string | null;
  dirty: boolean;
  media: Record<string, ProbeItem>;
  thumbs: Record<string, string>;
  info: ClipInfoText | null;
  appInfo: AppInfo | null;
  selectedClip: string | null;
  preview: PreviewMode;
  previewTarget: string;
  /** «Чистый» кадр (без текста) для живого предпросмотра и кадр «до» для сравнения. */
  base: { path: string; before: string | null; key: string } | null;
  baseLoading: boolean;
  previewAt: number | null;
  showPlatform: boolean;
  compare: boolean;
  lookThumbs: LookThumb[];
  frame: { path: string; at: number } | null;
  /** Показан точный кадр видеодвижка вместо живого предпросмотра. */
  showExact: boolean;
  draft: string | null;
  settings: Settings | null;
  building: boolean;
  buildKind: "full" | "draft" | null;
  progress: number;
  stage: string;
  log: string[];
  warnings: string[];
  report: BuildReport | null;
  showResults: boolean;
  showHome: boolean;
  showAbout: boolean;
  update: UpdateInfo | null;
  updateError: string | null;
  updateChecking: boolean;
  updateProgress: number | null;
  toasts: Toast[];

  edit: (fn: (p: Project) => void, key?: string) => void;
  replace: (p: Project, path?: string | null) => void;
  undo: () => void;
  redo: () => void;
  setMedia: (items: ProbeItem[]) => void;
  set: (part: Partial<S>) => void;
  toast: (kind: Toast["kind"], text: string, action?: Toast["action"], ms?: number) => void;
  dismiss: (id: number) => void;
}

let toastId = 0;
let toastHover = false;
export const setToastHover = (v: boolean) => {
  toastHover = v;
};
/** Меняется при каждом открытии другого проекта — запоздавшие ответы старого проекта игнорируются. */
let projectGen = 0;
export const currentGen = () => projectGen;

export const useStore = create<S>((set, get) => ({
  project: defaultProject(),
  past: [],
  future: [],
  lastKey: null,
  lastAt: 0,
  filePath: null,
  dirty: false,
  media: {},
  thumbs: {},
  info: null,
  appInfo: null,
  selectedClip: null,
  preview: "clip",
  previewTarget: "vertical",
  base: null,
  baseLoading: false,
  previewAt: null,
  showPlatform: false,
  compare: false,
  lookThumbs: [],
  frame: null,
  showExact: false,
  draft: null,
  settings: null,
  building: false,
  buildKind: null,
  progress: 0,
  stage: "",
  log: [],
  warnings: [],
  report: null,
  showResults: false,
  showHome: false,
  showAbout: false,
  update: null,
  updateError: null,
  updateChecking: false,
  updateProgress: null,
  toasts: [],

  edit: (fn, key) => {
    const s = get();
    const next: Project = structuredClone(s.project);
    fn(next);
    const now = Date.now();
    const merge = key != null && key === s.lastKey && now - s.lastAt < 1200;
    set({
      project: next,
      past: merge ? s.past : [...s.past, s.project].slice(-HISTORY_LIMIT),
      future: [],
      lastKey: key ?? null,
      lastAt: now,
      dirty: true,
    });
  },
  replace: (p, path) => {
    // несохранённая правка уходящего проекта (автосохранение ещё ждёт таймера) — сохраняем сразу
    if (autosaveTimer && autosaveEnabled) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
      api.projectStore(get().project).catch(() => {});
    }
    projectGen++;
    set({
      project: p,
      past: [],
      future: [],
      filePath: path === undefined ? get().filePath : path,
      dirty: false,
      selectedClip: p.clips[0]?.id ?? null,
      frame: null,
      draft: null,
      base: null,
      lookThumbs: [],
      info: null,
      showExact: false,
    });
  },
  undo: () => {
    const s = get();
    if (!s.past.length) return;
    set({ project: s.past[s.past.length - 1], past: s.past.slice(0, -1), future: [s.project, ...s.future], lastKey: null, dirty: true });
  },
  redo: () => {
    const s = get();
    if (!s.future.length) return;
    set({ project: s.future[0], future: s.future.slice(1), past: [...s.past, s.project], lastKey: null, dirty: true });
  },
  setMedia: (items) => set({ media: { ...get().media, ...Object.fromEntries(items.map((i) => [i.path, i])) } }),
  set: (part) => set(part as S),
  toast: (kind, text, action, ms) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, text, action }].slice(-5) });
    // пока курсор над уведомлениями, они не исчезают — можно дочитать и нажать кнопку
    const tick = () => (toastHover ? setTimeout(tick, 1500) : get().dismiss(id));
    setTimeout(tick, ms ?? (action ? 10000 : kind === "error" ? 9000 : 4500));
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Совместимость со старым именем. */
export const update = (fn: (p: Project) => void, key?: string) => useStore.getState().edit(fn, key);

// Автосохранение в библиотеку проектов (защита от сбоев и случайного закрытия).
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let autosaveEnabled = false;
export const enableAutosave = () => {
  autosaveEnabled = true;
};
export async function saveNow() {
  autosaveTimer = null;
  const gen = projectGen;
  const p = useStore.getState().project;
  try {
    const id = await api.projectStore(p);
    // пока сохраняли, могли открыть другой проект — его id не трогаем
    if (gen !== projectGen) return;
    const cur = useStore.getState().project;
    if (cur.id !== id) useStore.setState({ project: { ...cur, id } });
  } catch {
    /* повторим при следующем изменении */
  }
}
useStore.subscribe((s, prev) => {
  if (s.project === prev.project || !autosaveEnabled) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveNow, 700);
});

// Что найдено в именах файлов (материал, слой, время) — обновляется при изменении клипов/инфо.
let infoTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((s, prev) => {
  if (s.project.clips === prev.project.clips && s.project.info === prev.project.info && s.project.style === prev.project.style && s.info) return;
  if (infoTimer) clearTimeout(infoTimer);
  infoTimer = setTimeout(() => {
    api
      .projectInfo(useStore.getState().project)
      .then((info) => useStore.setState({ info }))
      .catch(() => {});
  }, 350);
});
