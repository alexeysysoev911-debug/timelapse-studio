// Состояние приложения: проект с историей изменений (Ctrl+Z / Ctrl+Y) и автосохранением.
import { create } from "zustand";
import { api } from "./api";
import type { BuildReport, ProbeItem, Project, Settings } from "./types";
import { defaultProject } from "./types";

const HISTORY_LIMIT = 200;

export interface Toast {
  id: number;
  kind: "info" | "ok" | "warn" | "error";
  text: string;
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
  selectedClip: string | null;
  preview: PreviewMode;
  previewTarget: string;
  frame: { path: string; at: number } | null;
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
  toasts: Toast[];

  update: (fn: (p: Project) => void, key?: string) => void;
  replace: (p: Project, path?: string | null) => void;
  undo: () => void;
  redo: () => void;
  setMedia: (items: ProbeItem[]) => void;
  set: (part: Partial<S>) => void;
  toast: (kind: Toast["kind"], text: string) => void;
  dismiss: (id: number) => void;
}

let toastId = 0;

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
  selectedClip: null,
  preview: "clip",
  previewTarget: "vertical",
  frame: null,
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
  toasts: [],

  update: (fn, key) => {
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
  replace: (p, path) =>
    set({ project: p, past: [], future: [], filePath: path === undefined ? get().filePath : path, dirty: false, selectedClip: null, frame: null, draft: null }),
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
  toast: (kind, text) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, text }].slice(-5) });
    setTimeout(() => get().dismiss(id), kind === "error" ? 9000 : 4500);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

// автосохранение (защита от сбоев и случайного закрытия)
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((s, prev) => {
  if (s.project === prev.project) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    api.autosaveStore(useStore.getState().project).catch(() => {});
  }, 800);
});
