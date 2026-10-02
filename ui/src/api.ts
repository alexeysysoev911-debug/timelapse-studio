import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  BuildDone,
  BuildEvent,
  ClipInfoText,
  CoreError,
  LookThumb,
  OverlayPayload,
  PreviewOptions,
  ProbeItem,
  Project,
  ProjectMeta,
  Settings,
  UpdateInfo,
} from "./types";

type Overlays = Record<string, OverlayPayload>;

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  probe: (paths: string[]) => invoke<ProbeItem[]>("probe_files", { paths }),
  listFolder: (path: string) => invoke<string[]>("list_folder", { path }),
  thumbnail: (path: string, at = 0, width = 320) => invoke<string>("thumbnail", { path, at, width }),
  previewFrame: (project: Project, targetId: string, options: PreviewOptions, overlays?: Overlays) =>
    invoke<{ path: string; warnings: string[] }>("preview_frame", { project, targetId, options, overlays: overlays ?? null }),
  lookThumbs: (project: Project, targetId: string, at?: number) =>
    invoke<LookThumb[]>("look_thumbs", { project, targetId, at: at ?? null }),
  startBuild: (project: Project, draftSeconds: number | undefined, overlays: Overlays) =>
    invoke<void>("start_build", { project, draftSeconds: draftSeconds ?? null, overlays }),
  cancelBuild: () => invoke<void>("cancel_build"),
  loadProject: (path: string) => invoke<Project>("load_project", { path }),
  saveProject: (path: string, project: Project) => invoke<void>("save_project", { path, project }),
  autosaveLoad: () => invoke<Project | null>("autosave_load"),
  projectsList: () => invoke<ProjectMeta[]>("projects_list"),
  projectOpen: (id: string) => invoke<Project>("project_open", { id }),
  projectStore: (project: Project) => invoke<string>("project_store", { project }),
  projectDelete: (id: string) => invoke<void>("project_delete", { id }),
  projectDuplicate: (id: string) => invoke<Project>("project_duplicate", { id }),
  projectInfo: (project: Project) => invoke<ClipInfoText>("project_info", { project }),
  settingsLoad: () => invoke<Settings>("settings_load"),
  settingsStore: (settings: Settings) => invoke<void>("settings_store", { settings }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  openLink: (url: string) => invoke<void>("open_link", { url }),
  readLog: () => invoke<string>("read_log"),
  quitAfterCancel: () => invoke<void>("quit_after_cancel"),
  allowFiles: (paths: string[]) => invoke<void>("allow_files", { paths }),
  updateCheck: () => invoke<UpdateInfo>("update_check"),
  updateInstall: () => invoke<void>("update_install"),
};

export const onBuildEvent = (f: (e: BuildEvent) => void): Promise<UnlistenFn> => listen<BuildEvent>("build-event", (e) => f(e.payload));
export const onBuildDone = (f: (e: BuildDone) => void): Promise<UnlistenFn> => listen<BuildDone>("build-done", (e) => f(e.payload));
export const onCloseRequested = (f: () => void): Promise<UnlistenFn> => listen("close-requested", () => f());
export const onUpdateProgress = (f: (p: { downloaded: number; total: number | null }) => void): Promise<UnlistenFn> =>
  listen<{ downloaded: number; total: number | null }>("update-progress", (e) => f(e.payload));

/** Адрес локального файла для <img>/<video>/<audio>. «builtin:» — через путь из app_info. */
export const fileUrl = (path: string) => convertFileSrc(path);

export function errorText(e: unknown): string {
  if (!e) return "Неизвестная ошибка";
  if (typeof e === "string") return e;
  const ce = e as Partial<CoreError>;
  if (ce.message) return ce.message;
  return String(e);
}

export const TELEGRAM_AUTHOR = "https://t.me/alexeyalesha8";
export const TELEGRAM_CHANNEL = "https://t.me/3dprinteralesha";
