import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppInfo, BuildDone, BuildEvent, CoreError, ProbeItem, Project, Settings } from "./types";

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  probe: (paths: string[]) => invoke<ProbeItem[]>("probe_files", { paths }),
  listFolder: (path: string) => invoke<string[]>("list_folder", { path }),
  thumbnail: (path: string, at = 0, width = 320) => invoke<string>("thumbnail", { path, at, width }),
  previewFrame: (project: Project, targetId: string, at?: number) =>
    invoke<{ path: string; warnings: string[] }>("preview_frame", { project, targetId, at: at ?? null }),
  startBuild: (project: Project, draftSeconds?: number) => invoke<void>("start_build", { project, draftSeconds: draftSeconds ?? null }),
  cancelBuild: () => invoke<void>("cancel_build"),
  loadProject: (path: string) => invoke<Project>("load_project", { path }),
  saveProject: (path: string, project: Project) => invoke<void>("save_project", { path, project }),
  autosaveLoad: () => invoke<Project | null>("autosave_load"),
  autosaveStore: (project: Project) => invoke<void>("autosave_store", { project }),
  settingsLoad: () => invoke<Settings>("settings_load"),
  settingsStore: (settings: Settings) => invoke<void>("settings_store", { settings }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  readLog: () => invoke<string>("read_log"),
  quitAfterCancel: () => invoke<void>("quit_after_cancel"),
  allowFiles: (paths: string[]) => invoke<void>("allow_files", { paths }),
};

export const onBuildEvent = (f: (e: BuildEvent) => void): Promise<UnlistenFn> => listen<BuildEvent>("build-event", (e) => f(e.payload));
export const onBuildDone = (f: (e: BuildDone) => void): Promise<UnlistenFn> => listen<BuildDone>("build-done", (e) => f(e.payload));

export const onCloseRequested = (f: () => void): Promise<UnlistenFn> => listen("close-requested", () => f());

/** Адрес локального файла для <img>/<video>. */
export const fileUrl = (path: string) => convertFileSrc(path);

export function errorText(e: unknown): string {
  if (!e) return "Неизвестная ошибка";
  if (typeof e === "string") return e;
  const ce = e as Partial<CoreError>;
  if (ce.message) return ce.message;
  return String(e);
}
