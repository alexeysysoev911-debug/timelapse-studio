// Центр: предпросмотр клипа с обрезкой, кадр оформления, пробный ролик, лента роликa.
import { useEffect, useRef, useState } from "react";
import { Clapperboard, Film, ImageIcon, RefreshCw, Scissors, Undo2 } from "lucide-react";
import { fileUrl } from "../api";
import { loadBase, renderFrame, startBuild } from "../actions";
import { drawExtras, drawHook, drawPlatformMask, drawStatic, layoutOf, resolveFonts, textModel } from "../overlay";
import { baseName, clipDur, estimate, fmtSec } from "../logic";
import { useStore, type PreviewMode } from "../store";
import { Segmented, Toggle } from "./controls";
import { Thumb } from "./Thumb";

const ratioLabel = (w: number, h: number) => (h > w ? (h / w > 1.5 ? "9:16" : "4:5") : w === h ? "1:1" : "16:9");

function TrimBar({ duration, start, end, time, onChange, onSeek }: { duration: number; start: number; end: number; time: number; onChange: (s: number, e: number) => void; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = (v: number) => `${(v / duration) * 100}%`;
  const toTime = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const drag = (which: "s" | "e") => (ev: React.PointerEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const el = ev.currentTarget as HTMLElement;
    el.setPointerCapture(ev.pointerId);
    const moveH = (e: PointerEvent) => {
      const t = Math.round(toTime(e.clientX) * 10) / 10;
      if (which === "s") onChange(Math.min(t, end - 0.2), end);
      else onChange(start, Math.max(t, start + 0.2));
      onSeek(t);
    };
    const up = () => {
      el.removeEventListener("pointermove", moveH);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", moveH);
    el.addEventListener("pointerup", up);
  };
  return (
    <div className="trimbar" ref={ref} onPointerDown={(e) => onSeek(toTime(e.clientX))} role="group" aria-label="Обрезка клипа">
      <div className="trim-sel" style={{ left: pct(start), width: pct(end - start) }} />
      <div className="playhead" style={{ left: pct(time) }} />
      <button className="handle" style={{ left: pct(start) }} onPointerDown={drag("s")} aria-label="Начало" data-tip="Начало клипа" />
      <button className="handle" style={{ left: pct(end) }} onPointerDown={drag("e")} aria-label="Конец" data-tip="Конец клипа" />
    </div>
  );
}

function ClipPreview() {
  const id = useStore((s) => s.selectedClip);
  const clip = useStore((s) => s.project.clips.find((c) => c.id === id) ?? s.project.clips[0]);
  const item = useStore((s) => (clip ? s.media[clip.path] : undefined));
  const update = useStore((s) => s.edit);
  const vref = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [cantPlay, setCantPlay] = useState(false);
  useEffect(() => setCantPlay(false), [clip?.path]);
  if (!clip)
    return (
      <div className="stage-empty">
        <Film size={40} />
        <h2>Начните с клипов</h2>
        <p>Перетащите видео в окно — программа сама разложит видео, фото и музыку.</p>
      </div>
    );
  const info = item?.info;
  const dur = info?.duration ?? 0;
  const start = clip.trim_start;
  const end = clip.trim_end ?? dur;
  const setTrim = (s: number, e: number) =>
    update(
      (p) => {
        const c = p.clips.find((x) => x.id === clip.id);
        if (!c) return;
        c.trim_start = Math.max(0, Math.round(s * 10) / 10);
        c.trim_end = e >= dur - 0.05 ? null : Math.round(e * 10) / 10;
      },
      `trim-${clip.id}`,
    );
  const seek = (t: number) => {
    if (vref.current) vref.current.currentTime = t;
    setTime(t);
  };
  return (
    <div className="clip-preview">
      <div className="player">
        {cantPlay || !info ? (
          <div className="noplay">
            {info && <Thumb path={clip.path} at={Math.min(dur / 2, 3)} width={640} />}
            <p>{info ? "Этот формат нельзя проиграть в окне, но в ролик он попадёт как обычно." : item?.error || "Файл проверяется…"}</p>
          </div>
        ) : (
          <video
            ref={vref}
            key={clip.path}
            src={fileUrl(clip.path)}
            controls
            muted
            preload="metadata"
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onError={() => setCantPlay(true)}
          />
        )}
      </div>
      {info && (
        <div className="trim">
          <div className="trim-head">
            <Scissors size={14} />
            <b data-tip={clip.path}>{baseName(clip.path)}</b>
            <span className="dim">
              {fmtSec(clipDur(clip, info))} из {fmtSec(dur)}
            </span>
            <span className="grow" />
            <button className="btn subtle sm" data-tip="Начало = текущая позиция (I)" onClick={() => setTrim(Math.min(time, end - 0.2), end)}>
              [ Начало здесь
            </button>
            <button className="btn subtle sm" data-tip="Конец = текущая позиция (O)" onClick={() => setTrim(start, Math.max(time, start + 0.2))}>
              Конец здесь ]
            </button>
            <button className="btn subtle sm" data-tip="Сбросить обрезку" onClick={() => setTrim(0, dur)} disabled={start === 0 && clip.trim_end == null}>
              <Undo2 size={14} />
            </button>
          </div>
          <TrimBar duration={dur} start={start} end={end} time={time} onChange={setTrim} onSeek={seek} />
        </div>
      )}
    </div>
  );
}

function LivePreview() {
  const project = useStore((s) => s.project);
  const info = useStore((s) => s.info);
  const base = useStore((s) => s.base);
  const baseLoading = useStore((s) => s.baseLoading);
  const target = useStore((s) => s.previewTarget);
  const showPlatform = useStore((s) => s.showPlatform);
  const compare = useStore((s) => s.compare);
  const previewAt = useStore((s) => s.previewAt);
  const frame = useStore((s) => s.frame);
  const stage = useStore((s) => s.stage);
  const media = useStore((s) => s.media);
  const set = useStore((s) => s.set);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(0.5);
  const [showExact, setShowExact] = useState(false);
  const imgs = useRef<{ after?: HTMLImageElement; before?: HTMLImageElement; logo?: HTMLImageElement | null; key?: string; logoPath?: string | null }>({});
  const [, force] = useState(0);
  const t = project.targets.find((x) => x.id === target) ?? project.targets[0];
  const L = layoutOf(t);
  const est = estimate(project, media);
  const hasLook = project.style.look !== "none" || project.style.auto_color || project.style.sharpen;

  // подложка (видео без текста) — перерисовывается видеодвижком только при изменении картинки
  useEffect(() => {
    const id = setTimeout(() => loadBase(), 350);
    return () => clearTimeout(id);
  }, [project, target, previewAt]);

  // загрузка картинок подложки и лого
  useEffect(() => {
    const load = (src: string) =>
      new Promise<HTMLImageElement>((res) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => res(im);
        im.src = src;
      });
    (async () => {
      if (base && imgs.current.key !== base.key + base.path) {
        imgs.current.after = await load(fileUrl(base.path));
        imgs.current.before = base.before ? await load(fileUrl(base.before)) : undefined;
        imgs.current.key = base.key + base.path;
        force((n) => n + 1);
      }
      const lp = project.style.watermark;
      if (lp !== imgs.current.logoPath) {
        imgs.current.logoPath = lp;
        imgs.current.logo = lp ? await load(fileUrl(lp)) : null;
        force((n) => n + 1);
      }
    })();
  }, [base, project.style.watermark]);

  // отрисовка: мгновенно при любом изменении текста/оформления
  useEffect(() => {
    let alive = true;
    (async () => {
      const c = canvas.current;
      if (!c) return;
      const fonts = await resolveFonts(project);
      if (!alive) return;
      const scale = 0.5;
      c.width = Math.round(L.w * scale);
      c.height = Math.round(L.h * scale);
      const ctx = c.getContext("2d")!;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, L.w, L.h);
      const { after, before } = imgs.current;
      if (after?.naturalWidth) ctx.drawImage(after, 0, 0, L.w, L.h);
      if (compare && hasLook && before?.naturalWidth) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, L.w * split, L.h);
        ctx.clip();
        ctx.drawImage(before, 0, 0, L.w, L.h);
        ctx.restore();
      }
      const m = textModel(project, info);
      drawStatic(ctx, project, m, L, fonts);
      const hookVisible = previewAt == null || previewAt <= project.style.hook_seconds;
      if (hookVisible) drawHook(ctx, m, L, fonts);
      drawExtras(ctx, project, L, imgs.current.logo ?? null, est.total > 0 && previewAt != null ? Math.min(1, previewAt / est.total) : 0.35);
      if (showPlatform) drawPlatformMask(ctx, L);
      if (compare && hasLook) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(L.w * split - 2, 0, 4, L.h);
        const fs = Math.round(Math.max(L.w, L.h) * 0.018);
        ctx.font = `600 ${fs}px "Segoe UI", sans-serif`;
        ctx.textBaseline = "bottom";
        const label = (t: string, x: number, align: CanvasTextAlign) => {
          ctx.textAlign = align;
          const w = ctx.measureText(t).width + fs;
          ctx.fillStyle = "rgba(0,0,0,0.6)";
          ctx.fillRect(align === "left" ? x : x - w, L.h - fs * 2.6, w, fs * 1.7);
          ctx.fillStyle = "#fff";
          ctx.fillText(t, align === "left" ? x + fs / 2 : x - fs / 2, L.h - fs * 1.15);
        };
        label("ДО", fs, "left");
        label("ПОСЛЕ", L.w - fs, "right");
      }
    })();
    return () => {
      alive = false;
    };
  });

  const dragSplit = (e: React.PointerEvent) => {
    if (!(compare && hasLook) || !canvas.current) return;
    const r = canvas.current.getBoundingClientRect();
    const move = (ev: PointerEvent) => setSplit(Math.min(0.98, Math.max(0.02, (ev.clientX - r.left) / r.width)));
    move(e.nativeEvent);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!project.clips.some((c) => c.enabled))
    return (
      <div className="stage-empty">
        <ImageIcon size={40} />
        <p>Добавьте клипы — здесь появится живой предпросмотр ролика со всем оформлением.</p>
      </div>
    );
  return (
    <div className="live">
      <div className="live-tools">
        <Toggle label="Интерфейс площадки" checked={showPlatform} onChange={(v) => set({ showPlatform: v })} disabled={!L.vertical} />
        <Toggle label="До / после" checked={compare} onChange={(v) => set({ compare: v })} disabled={!hasLook} />
        <span className="grow" />
        <button className={`btn subtle sm ${showExact ? "on" : ""}`} onClick={() => setShowExact(!showExact)} disabled={!frame} data-tip="Переключиться между живым предпросмотром и точным кадром видеодвижка">
          {showExact ? "Живой" : "Точный"}
        </button>
        <button
          className="btn subtle sm"
          onClick={async () => {
            await renderFrame();
            setShowExact(true);
          }}
          disabled={stage === "Рисую точный кадр…"}
          data-tip="Отрисовать кадр видеодвижком — ровно как в итоговом ролике (F5)"
        >
          <RefreshCw size={13} className={stage === "Рисую точный кадр…" ? "spin" : ""} /> Точный кадр
        </button>
      </div>
      <div className="live-canvas" ref={wrapRef}>
        {showExact && frame ? (
          <img src={`${fileUrl(frame.path)}?t=${frame.at}`} alt="Точный кадр ролика" style={{ aspectRatio: `${L.w} / ${L.h}` }} />
        ) : (
          <canvas ref={canvas} style={{ aspectRatio: `${L.w} / ${L.h}`, cursor: compare && hasLook ? "ew-resize" : undefined }} onPointerDown={dragSplit} />
        )}
        {baseLoading && !showExact && <div className="live-loading">обновляю кадр…</div>}
      </div>
      <div className="live-time">
        <span className="dim">Момент ролика</span>
        <input
          type="range"
          min={0}
          max={Math.max(1, est.total)}
          step={0.1}
          value={previewAt ?? Math.min(project.style.hook_seconds * 0.5, est.total * 0.3)}
          onChange={(e) => set({ previewAt: parseFloat(e.target.value) })}
          aria-label="Момент ролика"
        />
        <output>{fmtSec(previewAt ?? Math.min(project.style.hook_seconds * 0.5, est.total * 0.3))}</output>
      </div>
    </div>
  );
}

function DraftPreview() {
  const draft = useStore((s) => s.draft);
  const building = useStore((s) => s.building && s.buildKind === "draft");
  return (
    <div className="frame-preview">
      {draft ? <video src={fileUrl(draft)} controls autoPlay /> : <div className="stage-empty"><Clapperboard size={40} /><p>Пробный ролик — первые 8 секунд с музыкой и переходами, в половинном качестве. Собирается за секунды.</p></div>}
      <button className="btn primary" onClick={() => startBuild(true)} disabled={useStore.getState().building}>
        <Clapperboard size={15} /> {building ? "Собираю…" : draft ? "Собрать заново" : "Собрать пробный ролик"}
      </button>
    </div>
  );
}

function Strip() {
  const p = useStore((s) => s.project);
  const media = useStore((s) => s.media);
  const sel = useStore((s) => s.selectedClip);
  const est = estimate(p, media);
  const clips = p.clips.filter((c) => c.enabled && media[c.path]?.info);
  const photos = p.end_photos.filter((ph) => media[ph]?.info);
  if (!clips.length) return null;
  const segs = [
    ...clips.map((c) => ({ id: c.id, w: clipDur(c, media[c.path]!.info) / est.speed, path: c.path, photo: false })),
    ...photos.map((ph) => ({ id: ph, w: p.style.photo_seconds, path: ph, photo: true })),
  ];
  const sum = segs.reduce((a, s) => a + s.w, 0) || 1;
  return (
    <div className="strip" aria-label="Лента ролика">
      <div className="strip-head">
        <span>Ролик: <b>{fmtSec(est.total)}</b></span>
        <span className="dim">исходник {fmtSec(est.source)} · ускорение ×{est.speed.toFixed(est.speed < 10 ? 1 : 0).replace(".", ",")}</span>
      </div>
      <div className="strip-bar">
        {segs.map((s) => (
          <button
            key={s.id}
            className={`seg ${s.photo ? "photo" : ""} ${s.id === sel ? "on" : ""}`}
            style={{ flexGrow: s.w / sum }}
            data-tip={baseName(s.path)}
            onClick={() => !s.photo && useStore.getState().set({ selectedClip: s.id, preview: "clip" })}
          >
            <Thumb path={s.path} width={120} at={0} />
          </button>
        ))}
      </div>
    </div>
  );
}

export function Stage() {
  const mode = useStore((s) => s.preview);
  const target = useStore((s) => s.previewTarget);
  const targets = useStore((s) => s.project.targets);
  const set = useStore((s) => s.set);
  return (
    <main className="stage">
      <div className="stage-tabs">
        <Segmented<PreviewMode>
          value={mode}
          onChange={(v) => set({ preview: v })}
          options={[
            ["clip", "Клип и обрезка"],
            ["frame", "Оформление"],
            ["draft", "Пробный ролик"],
          ]}
        />
        {mode !== "clip" && (
          <Segmented value={target} onChange={(v) => set({ previewTarget: v, frame: null, base: null })} options={targets.map((t) => [t.id, ratioLabel(t.width, t.height)] as [string, string])} />
        )}
      </div>
      <div className="stage-body">{mode === "clip" ? <ClipPreview /> : mode === "frame" ? <LivePreview /> : <DraftPreview />}</div>
      <Strip />
    </main>
  );
}
