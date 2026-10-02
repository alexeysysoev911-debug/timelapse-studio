// Рисование текстовых слоёв ролика на canvas.
// Один и тот же код рисует живой предпросмотр и PNG-слои, которые ядро накладывает на видео, —
// поэтому предпросмотр совпадает с роликом до пикселя (и работают эмодзи и любые шрифты).
import { fileUrl } from "./api";
import type { ClipInfoText, OverlayPayload, Project, Target } from "./types";
import { FONTS } from "./types";

const EMOJI_FALLBACK = `"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI", sans-serif`;
const loadedCustom = new Map<string, string>();

/** CSS-семейство для шрифта: встроенный id → «TS Montserrat», свой файл → загружается из файла. */
export async function fontFamily(id: string, customPath: string | null): Promise<string> {
  if (customPath) {
    const cached = loadedCustom.get(customPath);
    if (cached) return cached;
    const name = `TS-custom-${loadedCustom.size + 1}`;
    try {
      const face = new FontFace(name, `url("${fileUrl(customPath)}")`);
      await face.load();
      document.fonts.add(face);
      loadedCustom.set(customPath, name);
      return name;
    } catch {
      /* битый файл — используем встроенный */
    }
  }
  const f = FONTS.find((x) => x.id === id) ?? FONTS[0];
  const name = `TS ${f.label}`;
  try {
    await document.fonts.load(`32px "${name}"`, "АаZz");
  } catch {
    /* шрифт подхватится при следующей отрисовке */
  }
  return name;
}

export interface Layout {
  w: number;
  h: number;
  vertical: boolean;
}

export const layoutOf = (t: Pick<Target, "width" | "height">): Layout => ({ w: t.width, h: t.height, vertical: t.height > t.width });

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(test).width > maxW) {
      lines.push(cur);
      cur = w;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Блок текста по центру: плашка со скруглением + тень. Возвращает высоту блока. */
function textBlock(ctx: CanvasRenderingContext2D, lines: string[], cx: number, top: number, fs: number, color: string, family: string): number {
  if (!lines.length) return 0;
  ctx.font = `${fs}px "${family}", ${EMOJI_FALLBACK}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const pad = Math.max(6, Math.round(fs * 0.35));
  const lh = Math.round(fs * 1.25);
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const bw = widest + pad * 2;
  const bh = lines.length * lh + pad * 2 - Math.round(fs * 0.1);
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  roundRect(ctx, cx - bw / 2, top, bw, bh, Math.round(fs * 0.28));
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  ctx.shadowBlur = 2;
  ctx.fillStyle = color;
  lines.forEach((l, i) => ctx.fillText(l, cx, top + pad + lh * i + lh / 2));
  ctx.restore();
  return bh;
}

export interface TextModel {
  info: { text: string; accent: boolean }[];
  channel: string;
  hook: string;
}

/** Те же строки, что и в ядре (pipeline::texts_for). */
export function textModel(p: Project, it: ClipInfoText | null): TextModel {
  const info: { text: string; accent: boolean }[] = [];
  if (p.style.info_overlay && it) {
    if (it.title) info.push({ text: it.title, accent: false });
    if (it.specs) info.push({ text: it.specs, accent: true });
    if (p.style.show_time && it.time) info.push({ text: it.time, accent: false });
  } else if (p.style.info_overlay && p.info.title.trim()) {
    info.push({ text: p.info.title.trim(), accent: false });
  }
  const ch = p.style.channel_text.trim();
  return { info, channel: ch ? (ch.startsWith("@") ? ch : `@${ch}`) : "", hook: p.style.hook_text.trim() };
}

export interface Fonts {
  info: string;
  hook: string;
}

export async function resolveFonts(p: Project): Promise<Fonts> {
  const [info, hook] = await Promise.all([fontFamily(p.style.font_family, p.style.font), fontFamily(p.style.hook_font_family, p.style.font)]);
  return { info, hook };
}

/** Постоянный слой: плашка с информацией и ник канала. */
export function drawStatic(ctx: CanvasRenderingContext2D, p: Project, m: TextModel, L: Layout, fonts: Fonts) {
  const { w, h, vertical } = L;
  const big = Math.max(w, h);
  const accent = `#${p.style.accent_color}`;
  if (m.info.length) {
    let pos = p.style.info_pos;
    if (vertical && p.style.safe_zone) pos = Math.min(pos, 0.62);
    const gap = Math.max(4, h * 0.01);
    // сначала меряем блок, чтобы он целиком влез в кадр
    const items = m.info.map((l, k) => {
      const fs = Math.max(10, Math.round(big * (k === 0 ? 0.03 : 0.023)));
      ctx.font = `${fs}px "${fonts.info}", ${EMOJI_FALLBACK}`;
      const lines = wrap(ctx, l.text, w * 0.84);
      const pad = Math.max(6, Math.round(fs * 0.35));
      const bh = lines.length * Math.round(fs * 1.25) + pad * 2 - Math.round(fs * 0.1);
      return { lines, fs, color: l.accent ? accent : "#ffffff", bh };
    });
    const blockH = items.reduce((a, i) => a + i.bh + gap, 0);
    const bottom = h * (vertical && p.style.safe_zone ? 0.8 : 0.96);
    let y = Math.max(h * 0.05, Math.min(h * pos, bottom - blockH));
    for (const it of items) {
      textBlock(ctx, it.lines, w / 2, y, it.fs, it.color, fonts.info);
      y += it.bh + gap;
    }
  }
  if (m.channel) {
    const fs = Math.max(10, Math.round(big * 0.022));
    const y = h * (vertical && p.style.safe_zone ? 0.085 : 0.045);
    textBlock(ctx, [m.channel], w / 2, y, fs, "#ffffff", fonts.info);
  }
}

/** Слой хука: крупная фраза в центре, в первые секунды. */
export function drawHook(ctx: CanvasRenderingContext2D, m: TextModel, L: Layout, fonts: Fonts) {
  if (!m.hook) return;
  const { w, h } = L;
  const big = Math.max(w, h);
  let fs = big * 0.045;
  let lines: string[] = [];
  for (;;) {
    ctx.font = `${Math.round(fs)}px "${fonts.hook}", ${EMOJI_FALLBACK}`;
    lines = wrap(ctx, m.hook, w * 0.86);
    if (lines.length <= 3 || fs <= big * 0.028) break;
    fs *= 0.9;
  }
  const f = Math.max(12, Math.round(fs));
  const pad = Math.max(6, Math.round(f * 0.35));
  const bh = lines.length * Math.round(f * 1.25) + pad * 2;
  textBlock(ctx, lines, w / 2, h * 0.4 - bh / 2, f, "#ffffff", fonts.hook);
}

/** Лого и полоса прогресса — только для живого предпросмотра (в ролике их накладывает ядро). */
export function drawExtras(ctx: CanvasRenderingContext2D, p: Project, L: Layout, logo: HTMLImageElement | null, progress = 0.35) {
  const { w, h, vertical } = L;
  if (logo && logo.naturalWidth) {
    const ww = Math.max(24, Math.round(w * p.style.watermark_scale));
    const hh = Math.round((ww * logo.naturalHeight) / logo.naturalWidth);
    const m = Math.round(Math.min(w, h) * 0.04);
    const top = vertical && p.style.safe_zone ? Math.round(h * 0.075) : m;
    const c = p.style.watermark_corner;
    const x = c === "tl" || c === "bl" ? m : w - ww - m;
    const y = c === "bl" || c === "br" ? h - hh - m : top;
    ctx.drawImage(logo, x, y, ww, hh);
  }
  if (p.style.progress_bar) {
    const bh = Math.max(4, Math.round(h * 0.008));
    ctx.fillStyle = `#${p.style.accent_color}`;
    ctx.globalAlpha = 0.95;
    ctx.fillRect(0, h - bh, w * progress, bh);
    ctx.globalAlpha = 1;
  }
}

/** Схематичный интерфейс площадки (без чужих логотипов): кнопки справа, подпись снизу, вкладки сверху. */
export function drawPlatformMask(ctx: CanvasRenderingContext2D, L: Layout) {
  const { w, h, vertical } = L;
  if (!vertical) return;
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  const r = w * 0.045;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(w * 0.92, h * (0.5 + i * 0.075), r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  roundRect(ctx, w * 0.04, h * 0.835, w * 0.45, h * 0.018, 6);
  ctx.fill();
  roundRect(ctx, w * 0.04, h * 0.865, w * 0.7, h * 0.016, 6);
  ctx.fill();
  roundRect(ctx, w * 0.04, h * 0.892, w * 0.55, h * 0.016, 6);
  ctx.fill();
  roundRect(ctx, w * 0.3, h * 0.035, w * 0.16, h * 0.014, 6);
  ctx.fill();
  roundRect(ctx, w * 0.54, h * 0.035, w * 0.16, h * 0.014, 6);
  ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(0, h * 0.82, w, h * 0.18);
  ctx.restore();
}

function canvasOf(L: Layout): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = L.w;
  c.height = L.h;
  return [c, c.getContext("2d")!];
}

/** PNG-слои для ядра по всем включённым форматам. */
export async function renderOverlays(p: Project, it: ClipInfoText | null): Promise<Record<string, OverlayPayload>> {
  const fonts = await resolveFonts(p);
  const m = textModel(p, it);
  const out: Record<string, OverlayPayload> = {};
  for (const t of p.targets.filter((x) => x.enabled)) {
    const L = layoutOf(t);
    const payload: OverlayPayload = {};
    if (m.info.length || m.channel) {
      const [c, ctx] = canvasOf(L);
      drawStatic(ctx, p, m, L, fonts);
      payload.static_png = c.toDataURL("image/png");
    }
    if (m.hook) {
      const [c, ctx] = canvasOf(L);
      drawHook(ctx, m, L, fonts);
      payload.hook_png = c.toDataURL("image/png");
    }
    out[t.id] = payload;
  }
  return out;
}
