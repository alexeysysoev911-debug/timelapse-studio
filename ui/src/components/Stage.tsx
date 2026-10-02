// Центр: предпросмотр клипа с обрезкой, кадр оформления, пробный ролик, лента роликa.
import { useEffect, useRef, useState } from "react";
import { Clapperboard, Film, ImageIcon, RefreshCw, Scissors, Undo2 } from "lucide-react";
import { fileUrl } from "../api";
import { renderFrame, startBuild } from "../actions";
import { baseName, clipDur, estimate, fmtSec } from "../logic";
import { useStore, type PreviewMode } from "../store";
import { Segmented } from "./controls";
import { Thumb } from "./Thumb";

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
      <button className="handle" style={{ left: pct(start) }} onPointerDown={drag("s")} aria-label="Начало" title="Начало клипа" />
      <button className="handle" style={{ left: pct(end) }} onPointerDown={drag("e")} aria-label="Конец" title="Конец клипа" />
    </div>
  );
}

function ClipPreview() {
  const id = useStore((s) => s.selectedClip);
  const clip = useStore((s) => s.project.clips.find((c) => c.id === id) ?? s.project.clips[0]);
  const item = useStore((s) => (clip ? s.media[clip.path] : undefined));
  const update = useStore((s) => s.update);
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
            <b title={clip.path}>{baseName(clip.path)}</b>
            <span className="dim">
              {fmtSec(clipDur(clip, info))} из {fmtSec(dur)}
            </span>
            <span className="grow" />
            <button className="btn subtle sm" title="Начало = текущая позиция (I)" onClick={() => setTrim(Math.min(time, end - 0.2), end)}>
              [ Начало здесь
            </button>
            <button className="btn subtle sm" title="Конец = текущая позиция (O)" onClick={() => setTrim(start, Math.max(time, start + 0.2))}>
              Конец здесь ]
            </button>
            <button className="btn subtle sm" title="Сбросить обрезку" onClick={() => setTrim(0, dur)} disabled={start === 0 && clip.trim_end == null}>
              <Undo2 size={14} />
            </button>
          </div>
          <TrimBar duration={dur} start={start} end={end} time={time} onChange={setTrim} onSeek={seek} />
        </div>
      )}
    </div>
  );
}

function FramePreview() {
  const frame = useStore((s) => s.frame);
  const stage = useStore((s) => s.stage);
  return (
    <div className="frame-preview">
      {frame ? <img src={`${fileUrl(frame.path)}?t=${frame.at}`} alt="Кадр будущего ролика" /> : <div className="stage-empty"><ImageIcon size={40} /><p>Покажу кадр будущего ролика со всем оформлением.</p></div>}
      <button className="btn primary" onClick={() => renderFrame()} disabled={stage === "Рисую кадр…"}>
        <RefreshCw size={15} className={stage === "Рисую кадр…" ? "spin" : ""} /> {frame ? "Обновить кадр" : "Показать кадр"}
      </button>
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
            title={baseName(s.path)}
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
          <Segmented value={target} onChange={(v) => set({ previewTarget: v, frame: null })} options={targets.map((t) => [t.id, t.height > t.width ? "9:16" : t.width === t.height ? "1:1" : "16:9"] as [string, string])} />
        )}
      </div>
      <div className="stage-body">{mode === "clip" ? <ClipPreview /> : mode === "frame" ? <FramePreview /> : <DraftPreview />}</div>
      <Strip />
    </main>
  );
}
