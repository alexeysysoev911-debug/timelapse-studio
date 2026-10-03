// Зеркало модели проекта из ядра (crates/tls-core/src/project.rs).

export type Speed =
  | { mode: "none" }
  | { mode: "factor"; factor: number }
  | { mode: "target"; seconds: number };

export type FitMode = "blur" | "fill" | "black";
export type Codec = "h264" | "hevc";
export type Quality = "high" | "balanced" | "small";
export type Hardware = "auto" | "cpu" | "nvenc" | "qsv" | "amf";
export type AfterAction = { mode: "keep" } | { mode: "archive"; dir: string } | { mode: "trash" };

export interface Clip {
  id: string;
  path: string;
  enabled: boolean;
  trim_start: number;
  trim_end: number | null;
}

export interface Music {
  tracks: string[];
  offset: number | null;
  volume: number;
  loudnorm: boolean;
  fade_in: number;
  fade_out: number;
  beat_sync: boolean;
}

export interface TimelapseFx {
  deflicker: boolean;
  stabilize: boolean;
  frame_blend: boolean;
  hdr_tonemap: boolean;
}

export interface Style {
  fit: FitMode;
  blur_sigma: number;
  color_filter: string;
  look: string;
  look_strength: number;
  auto_color: boolean;
  sharpen: boolean;
  font_family: string;
  hook_font_family: string;
  info_overlay: boolean;
  info_pos: number;
  show_time: boolean;
  hook_text: string;
  hook_seconds: number;
  channel_text: string;
  watermark: string | null;
  watermark_corner: string;
  watermark_scale: number;
  progress_bar: boolean;
  seamless_loop: boolean;
  safe_zone: boolean;
  photo_zoom: boolean;
  photo_seconds: number;
  font: string | null;
  accent_color: string;
}

export interface Target {
  id: string;
  enabled: boolean;
  label: string;
  width: number;
  height: number;
  out_dir: string;
}

export interface Export {
  codec: Codec;
  quality: Quality;
  fps: number;
  hardware: Hardware;
  parallel: boolean;
  cover: boolean;
  description: boolean;
}

export interface Project {
  schema: number;
  id: string;
  name: string;
  clips: Clip[];
  end_photos: string[];
  music: Music;
  speed: Speed;
  timelapse: TimelapseFx;
  transition: { kind: string; duration: number };
  style: Style;
  info: { profile: string; title: string; material: string; layer: string };
  targets: Target[];
  export: Export;
  after: AfterAction;
}

export type MediaKind = "video" | "audio" | "image" | "unknown";

export interface MediaInfo {
  path: string;
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  fps: number;
  has_video: boolean;
  has_audio: boolean;
  is_hdr: boolean;
  pix_fmt: string;
  codec: string;
  size_bytes: number;
}

export interface ProbeItem {
  path: string;
  kind: MediaKind;
  info: MediaInfo | null;
  error: string | null;
}

export interface CoreError {
  code: string;
  message: string;
  log: string[];
}

export type BuildEvent =
  | { type: "stage"; text: string }
  | { type: "progress"; value: number }
  | { type: "log"; line: string }
  | { type: "warning"; text: string };

export interface OutputResult {
  target_id: string;
  label: string;
  path: string | null;
  cover: string | null;
  description: string | null;
  error: CoreError | null;
}

export interface BuildReport {
  outputs: OutputResult[];
  warnings: string[];
  backend: string;
  duration: number;
  speed: number;
  music: string | null;
  after: string | null;
  all_ok: boolean;
}

export type BuildDone =
  | { status: "ok"; report: BuildReport; draft: boolean }
  | { status: "error"; error: CoreError; draft: boolean };

export interface AppInfo {
  version: string;
  ffmpeg: string | null;
  ffmpeg_error: string | null;
  default_out_dir: string;
  data_dir: string;
  log_dir: string;
  building: boolean;
  builtin_music: BuiltinTrack[];
  looks: [string, string][];
  fonts_dir: string | null;
  update_endpoint_default: string;
}

export interface BuiltinTrack {
  id: string;
  title: string;
  mood: string;
  genre: string;
  bpm: number;
  path: string;
  token: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  updated: number;
  clips: number;
  first_clip: string | null;
}

export interface LookThumb {
  id: string;
  label: string;
  path: string;
}

export interface UpdateInfo {
  current: string;
  available: boolean;
  version: string | null;
  notes: string | null;
  date: string | null;
}

export interface ClipInfoText {
  title: string;
  material: string | null;
  layer: string | null;
  specs: string;
  time: string;
}

export interface PreviewOptions {
  at?: number | null;
  bare?: boolean;
  look_override?: string | null;
  scale?: number | null;
}

export interface OverlayPayload {
  static_png?: string;
  hook_png?: string;
}

export interface Settings {
  theme: "system" | "dark" | "light";
  out_dir: string;
  archive_dir: string;
  recent: string[];
  notify: boolean;
  prevent_sleep: boolean;
  auto_update_check: boolean;
  update_endpoint: string;
  last_project: string;
}

export const TRANSITIONS: [string, string][] = [
  ["none", "Без перехода"],
  ["fade", "Затухание"],
  ["dissolve", "Растворение"],
  ["slideleft", "Сдвиг влево"],
  ["slideup", "Сдвиг вверх"],
  ["wipeleft", "Шторка"],
  ["circleopen", "Круг"],
  ["zoomin", "Наезд"],
];

export const LOOKS: [string, string][] = [
  ["none", "Без образа"],
  ["vivid", "Сочный"],
  ["clean_bright", "Чистый светлый"],
  ["warm_film", "Тёплая плёнка"],
  ["golden_hour", "Золотой час"],
  ["cool_tech", "Холодный техно"],
  ["teal_orange", "Кино: бирюза и оранж"],
  ["pastel", "Пастель"],
  ["matte", "Матовый"],
  ["bw_contrast", "Ч/Б контраст"],
];

/** Встроенные шрифты (файлы в public/fonts и в ресурсах программы). */
export const FONTS: { id: string; label: string; file: string; note: string }[] = [
  { id: "montserrat", label: "Montserrat", file: "Montserrat-Bold.ttf", note: "универсальный, популярный в соцсетях" },
  { id: "unbounded", label: "Unbounded", file: "Unbounded-Bold.ttf", note: "широкий, модный — для хуков" },
  { id: "rubik", label: "Rubik", file: "Rubik-Bold.ttf", note: "мягкий, дружелюбный" },
  { id: "oswald", label: "Oswald", file: "Oswald-Bold.ttf", note: "узкий, плакатный" },
  { id: "inter", label: "Inter", file: "Inter-Bold.ttf", note: "строгий, хорошо читается" },
  { id: "ptsans", label: "PT Sans", file: "PTSans-Bold.ttf", note: "классика с отличной кириллицей" },
];

export const PROFILES: [string, string, string][] = [
  ["3dprint", "3D-печать", "Модель принтера"],
  ["craft", "Рукоделие", "Что создаёте"],
  ["art", "Рисование", "Название работы"],
  ["cooking", "Кулинария", "Название блюда"],
  ["build", "Стройка и ремонт", "Объект"],
  ["other", "Другое", "Что на видео"],
];

export function defaultProject(builtinTrack?: string): Project {
  return {
    schema: 1,
    id: "",
    name: "Новый проект",
    clips: [],
    end_photos: [],
    music: { tracks: builtinTrack ? [builtinTrack] : [], offset: 0, volume: 1, loudnorm: true, fade_in: 0.3, fade_out: 1.5, beat_sync: true },
    speed: { mode: "target", seconds: 20 },
    timelapse: { deflicker: false, stabilize: false, frame_blend: false, hdr_tonemap: true },
    transition: { kind: "fade", duration: 0.4 },
    style: {
      fit: "blur",
      blur_sigma: 25,
      color_filter: "none",
      look: "none",
      look_strength: 1,
      auto_color: false,
      sharpen: false,
      font_family: "montserrat",
      hook_font_family: "unbounded",
      info_overlay: true,
      info_pos: 0.78,
      show_time: true,
      hook_text: "",
      hook_seconds: 2.5,
      channel_text: "",
      watermark: null,
      watermark_corner: "tr",
      watermark_scale: 0.16,
      progress_bar: false,
      seamless_loop: false,
      safe_zone: true,
      photo_zoom: true,
      photo_seconds: 1.5,
      font: null,
      accent_color: "FFC857",
    },
    info: { profile: "3dprint", title: "", material: "", layer: "" },
    targets: [
      { id: "vertical", enabled: true, label: "TikTok / Reels / Shorts", width: 1080, height: 1920, out_dir: "" },
      { id: "landscape", enabled: true, label: "Telegram / YouTube", width: 1920, height: 1080, out_dir: "" },
    ],
    export: { codec: "h264", quality: "balanced", fps: 30, hardware: "auto", parallel: true, cover: true, description: true },
    after: { mode: "keep" },
  };
}
