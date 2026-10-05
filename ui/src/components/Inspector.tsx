// Правая панель: все настройки проекта, сгруппированные по задачам.
import { useEffect, useRef, useState } from "react";
import { FolderOpen, Pause, Play as PlayIcon, Plus, X } from "lucide-react";
import { fileUrl } from "../api";
import { loadLookThumbs, pickFiles, pickFolder, pickSingle } from "../actions";
import { baseName, estimate, fmtSec } from "../logic";
import { useStore } from "../store";
import { FONTS, LOOKS, PROFILES, TRANSITIONS, type Codec, type Denoise, type FitMode, type Hardware, type Project, type Quality } from "../types";
import { Field, Section, Segmented, Select, Slider, TextInput, Toggle } from "./controls";

const NO_TRACKS: import("../types").BuiltinTrack[] = [];

type Tab = "video" | "text" | "look" | "music" | "export";

const useP = () => useStore((s) => s.project);
const upd = (fn: (p: Project) => void, key?: string) => useStore.getState().edit(fn, key);
const num = (v: number, d = 1) => v.toFixed(d).replace(".", ",");

function VideoTab() {
  const p = useP();
  const media = useStore((s) => s.media);
  const est = estimate(p, media);
  const mode = p.speed.mode;
  return (
    <>
      <Section title="Скорость">
        <Segmented
          value={mode}
          onChange={(m) =>
            upd((q) => {
              q.speed = m === "none" ? { mode: "none" } : m === "factor" ? { mode: "factor", factor: 4 } : { mode: "target", seconds: 20 };
            })
          }
          options={[
            ["target", "В N секунд"],
            ["factor", "В N раз"],
            ["none", "Как есть"],
          ]}
        />
        {p.speed.mode === "target" && (
          <Slider label="Длина ролика" min={5} max={180} step={1} value={p.speed.seconds} format={(v) => `${v} с`}
            onChange={(v) => upd((q) => void (q.speed = { mode: "target", seconds: v }), "speed")}
            hint="Программа сама подберёт ускорение. TikTok — 15–30 с, Reels — до 90 с, Shorts — до 3 мин." />
        )}
        {p.speed.mode === "factor" && (
          <Slider label="Ускорение" min={0.25} max={100} step={0.25} value={p.speed.factor} format={(v) => `×${num(v, v < 10 ? 2 : 0)}`}
            onChange={(v) => upd((q) => void (q.speed = { mode: "factor", factor: v }), "speed")} />
        )}
        {est.source > 0 && (
          <p className="note">
            Итог: <b>{fmtSec(est.total)}</b> при ускорении ×{num(est.speed, est.speed < 10 ? 1 : 0)}
            {est.speed >= 12 && " — включится быстрый режим для длинных записей"}
          </p>
        )}
      </Section>
      <Section title="Обработка таймлапса">
        <Toggle label="Убрать мерцание" hint="Выравнивает яркость между кадрами — убирает «моргание» от освещения и автоэкспозиции." checked={p.timelapse.deflicker} onChange={(v) => upd((q) => void (q.timelapse.deflicker = v))} />
        <Toggle label="Стабилизация" hint="Убирает дрожание камеры. Добавляет предварительный анализ — сборка дольше." checked={p.timelapse.stabilize} onChange={(v) => upd((q) => void (q.timelapse.stabilize = v))} />
        <Toggle label="Плавное ускорение" hint="Смешивает соседние кадры: движение плавное, без «рывков». Не используется при ускорении ×12 и больше." checked={p.timelapse.frame_blend} onChange={(v) => upd((q) => void (q.timelapse.frame_blend = v))} />
        <Toggle label="Коррекция HDR (iPhone)" hint="HDR-видео переводится в обычный цвет — без «выцветания» в соцсетях." checked={p.timelapse.hdr_tonemap} onChange={(v) => upd((q) => void (q.timelapse.hdr_tonemap = v))} />
      </Section>
      <Section title="Переходы">
        <Select label="Переход между клипами" value={p.transition.kind} options={TRANSITIONS} onChange={(v) => upd((q) => void (q.transition.kind = v))} />
        {p.transition.kind !== "none" && (
          <Slider label="Длительность перехода" min={0.1} max={1.5} step={0.05} value={p.transition.duration} format={(v) => `${num(v, 2)} с`}
            onChange={(v) => upd((q) => void (q.transition.duration = v), "xd")} />
        )}
      </Section>
    </>
  );
}

function FontPicker({ label, value, onChange, hint, overridden }: { label: string; value: string; onChange: (v: string) => void; hint?: string; overridden?: boolean }) {
  return (
    <Field label={label} hint={hint}>
      {overridden && <p className="note">Сейчас используется свой шрифт — встроенные включатся, если его убрать.</p>}
      <div className={`font-grid ${overridden ? "muted" : ""}`} role="radiogroup" aria-label={label}>
        {FONTS.map((f) => (
          <button key={f.id} role="radio" aria-checked={value === f.id} className={`font-chip ${value === f.id ? "on" : ""}`} style={{ fontFamily: `"TS ${f.label}"` }} onClick={() => onChange(f.id)} data-tip={f.note}>
            {f.label}
            <small>Аа Бб 123</small>
          </button>
        ))}
      </div>
    </Field>
  );
}

function TextTab() {
  const p = useP();
  const info = useStore((s) => s.info);
  const prof = PROFILES.find((x) => x[0] === p.info.profile) ?? PROFILES[0];
  const detMat = info?.material ? `${info.material} (из имени)` : "не найден";
  const detLayer = info?.layer ? `${info.layer} (из имени)` : "не найден";
  return (
    <>
      <Section title="О чём ролик">
        <Select label="Тематика" hint="Меняет подписи полей, слова и хэштеги в описании поста." value={p.info.profile} options={PROFILES.map(([a, b]) => [a, b] as [string, string])} onChange={(v) => upd((q) => void (q.info.profile = v))} />
        <TextInput label={prof[2]} hint="Первая строка плашки на видео и начало описания поста." value={p.info.title} placeholder={p.info.profile === "3dprint" ? "Anycubic Kobra S1" : ""} maxLength={80} onChange={(v) => upd((q) => void (q.info.title = v), "title")} />
        {p.info.profile === "3dprint" && (
          <div className="row2">
            <TextInput label="Материал" placeholder={detMat} value={p.info.material} maxLength={20} onChange={(v) => upd((q) => void (q.info.material = v), "mat")} hint="Пусто — программа найдёт материал в имени файла: Spool_PETG_0.2.mp4 → PETG. Впишите, чтобы задать вручную." />
            <TextInput label="Слой, мм" placeholder={detLayer} value={p.info.layer} maxLength={6} onChange={(v) => upd((q) => void (q.info.layer = v), "layer")} hint="Пусто — из имени файла (…_0.2.mp4 → 0.2 мм)." />
          </div>
        )}
        {info?.time && <p className="note">⏱ Время процесса из имён файлов: <b>{info.time}</b></p>}
      </Section>
      <Section title="Плашка с информацией">
        <Toggle label="Показывать плашку" checked={p.style.info_overlay} onChange={(v) => upd((q) => void (q.style.info_overlay = v))} />
        {p.style.info_overlay && (
          <>
            <Toggle label="Время процесса" hint="Из имён файлов: 3h1m33s, 45m10s…" checked={p.style.show_time} onChange={(v) => upd((q) => void (q.style.show_time = v))} />
            <Slider label="Положение по высоте" hint="0% — верх кадра, 100% — низ. В вертикальном ролике плашка не опустится под кнопки площадки." min={0.1} max={0.92} step={0.01} value={p.style.info_pos} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => upd((q) => void (q.style.info_pos = v), "pos")} />
          </>
        )}
      </Section>
      <Section title="Хук и ник">
        <TextInput label="Хук в начале" hint="Крупная фраза в первые секунды — по ней зритель решает, смотреть ли дальше. Эмодзи поддерживаются 🔥" placeholder="12 часов печати за 20 секунд 🔥" maxLength={90} value={p.style.hook_text} onChange={(v) => upd((q) => void (q.style.hook_text = v), "hook")} />
        {p.style.hook_text && (
          <Slider label="Сколько показывать" min={1} max={6} step={0.5} value={p.style.hook_seconds} format={(v) => `${num(v)} с`} onChange={(v) => upd((q) => void (q.style.hook_seconds = v), "hooks")} />
        )}
        <TextInput label="Ник канала" hint="Показывается вверху кадра весь ролик и добавляется в описание." placeholder="@my_channel" maxLength={40} value={p.style.channel_text} onChange={(v) => upd((q) => void (q.style.channel_text = v), "ch")} />
      </Section>
      <Section title="Шрифты и цвет">
        <FontPicker label="Шрифт хука" value={p.style.hook_font_family} onChange={(v) => upd((q) => void (q.style.hook_font_family = v))} hint="Крупная фраза в начале ролика." overridden={!!p.style.font} />
        <FontPicker label="Шрифт плашки и ника" value={p.style.font_family} onChange={(v) => upd((q) => void (q.style.font_family = v))} overridden={!!p.style.font} />
        <Field label="Свой шрифт" hint="TTF/OTF с кириллицей. Если выбран — заменяет оба шрифта выше.">
          <div className="file-pick">
            <span className="dim">{p.style.font ? baseName(p.style.font) : "Не выбран"}</span>
            <button className="btn subtle sm" onClick={async () => { const f = await pickSingle("font"); if (f) upd((q) => void (q.style.font = f)); }}>Выбрать…</button>
            {p.style.font && <button className="icon" data-tip="Убрать свой шрифт" onClick={() => upd((q) => void (q.style.font = null))}><X size={14} /></button>}
          </div>
        </Field>
        <Field label="Акцентный цвет" hint="Цвет строки с материалом и полосы прогресса.">
          <input type="color" value={`#${p.style.accent_color}`} aria-label="Акцентный цвет" onChange={(e) => upd((q) => void (q.style.accent_color = e.target.value.slice(1).toUpperCase()), "accent")} />
        </Field>
      </Section>
    </>
  );
}

function LookTab() {
  const p = useP();
  const thumbs = useStore((s) => s.lookThumbs);
  const clipsKey = useStore((s) => s.project.clips.filter((c) => c.enabled).map((c) => `${c.path}|${c.trim_start}`).join("|"));
  const target = useStore((s) => s.previewTarget);
  const fit = useStore((s) => s.project.style.fit);
  const hasClips = clipsKey.length > 0;
  useEffect(() => {
    const id = setTimeout(() => loadLookThumbs(), 500);
    return () => clearTimeout(id);
  }, [clipsKey, target, fit]);
  return (
    <>
      <Section title="Цветовой образ">
        {!hasClips && <p className="note">Добавьте клип — на плитках появится ваш кадр в каждом образе.</p>}
        <div className="look-grid" role="radiogroup" aria-label="Цветовой образ">
          {LOOKS.map(([id, label]) => {
            const th = thumbs.find((t) => t.id === id);
            return (
              <button key={id} role="radio" aria-checked={p.style.look === id} className={`look-chip ${p.style.look === id ? "on" : ""}`} onClick={() => upd((q) => void (q.style.look = id))} data-tip={label}>
                {th ? <img src={fileUrl(th.path)} alt="" /> : <span className="look-ph" />}
                <span>{label}</span>
              </button>
            );
          })}
        </div>
        {p.style.look !== "none" && (
          <Slider label="Сила образа" min={0} max={1} step={0.05} value={p.style.look_strength} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => upd((q) => void (q.style.look_strength = v), "lookk")} />
        )}
        <Toggle label="Автокоррекция" hint="Выравнивает уровни и баланс белого — тусклое видео становится чище." checked={p.style.auto_color} onChange={(v) => upd((q) => void (q.style.auto_color = v))} />
        <Segmented<Denoise> label="Шумоподавление" hint="Убирает «зерно» тёмной камеры. Чистое видео меньше портится при сжатии в TikTok и Reels." value={p.style.denoise} onChange={(v) => upd((q) => void (q.style.denoise = v))}
          options={[["off", "Выкл"], ["light", "Слабое"], ["strong", "Сильное"]]} />
        <Toggle label="Чёткость" hint="Умная резкость (CAS): подчёркивает детали модели без ореолов и без усиления шума." checked={p.style.sharpen} onChange={(v) => upd((q) => void (q.style.sharpen = v))} />
        <p className="note">Сравнить «до / после» можно во вкладке «Оформление» по центру.</p>
      </Section>
      <Section title="Кадр">
        <Segmented<FitMode> label="Если пропорции не совпадают" value={p.style.fit} onChange={(v) => upd((q) => void (q.style.fit = v))}
          options={[["blur", "Размытый фон"], ["fill", "Обрезать"], ["black", "Поля"]]} />
        {p.style.fit === "blur" && (
          <Slider label="Сила размытия" min={5} max={60} step={1} value={p.style.blur_sigma} onChange={(v) => upd((q) => void (q.style.blur_sigma = v), "blur")} />
        )}
      </Section>
      <Section title="Финал">
        <Slider label="Каждое фото в конце" min={0} max={5} step={0.5} value={p.style.photo_seconds} format={(v) => (v ? `${num(v)} с` : "не показывать")} onChange={(v) => upd((q) => void (q.style.photo_seconds = v), "phs")} />
        <Toggle label="Наезд камеры на фото" checked={p.style.photo_zoom} onChange={(v) => upd((q) => void (q.style.photo_zoom = v))} />
        <Toggle label="Бесшовный повтор" hint="Конец плавно перетекает в начало — ролик смотрят по кругу." checked={p.style.seamless_loop} onChange={(v) => upd((q) => void (q.style.seamless_loop = v))} />
        <Toggle label="Полоса прогресса" hint="Тонкая полоса внизу показывает, сколько осталось — ролики досматривают чаще." checked={p.style.progress_bar} onChange={(v) => upd((q) => void (q.style.progress_bar = v))} />
        <Toggle label="Безопасная зона TikTok/Reels" hint="Тексты и лого не попадут под кнопки и подпись площадки." checked={p.style.safe_zone} onChange={(v) => upd((q) => void (q.style.safe_zone = v))} />
      </Section>
      <Section title="Логотип">
        <Field label="Файл (PNG с прозрачностью)">
          <div className="file-pick">
            <span className="dim">{p.style.watermark ? baseName(p.style.watermark) : "Не выбран"}</span>
            <button className="btn subtle sm" onClick={async () => { const f = await pickSingle("image"); if (f) upd((q) => void (q.style.watermark = f)); }}>Выбрать…</button>
            {p.style.watermark && <button className="icon" data-tip="Убрать" onClick={() => upd((q) => void (q.style.watermark = null))}><X size={14} /></button>}
          </div>
        </Field>
        {p.style.watermark && (
          <>
            <Segmented label="Угол" value={p.style.watermark_corner} onChange={(v) => upd((q) => void (q.style.watermark_corner = v))}
              options={[["tl", "↖"], ["tr", "↗"], ["bl", "↙"], ["br", "↘"]]} />
            <Slider label="Размер" min={0.05} max={0.4} step={0.01} value={p.style.watermark_scale} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => upd((q) => void (q.style.watermark_scale = v), "wms")} />
          </>
        )}
      </Section>
    </>
  );
}

function MusicTab() {
  const p = useP();
  const m = p.music;
  const builtin = useStore((s) => s.appInfo?.builtin_music ?? NO_TRACKS);
  const media = useStore((s) => s.media);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const play = (key: string, path: string) => {
    if (playing === key) {
      audio.current?.pause();
      setPlaying(null);
      return;
    }
    audio.current?.pause();
    const a = new Audio(fileUrl(path));
    a.volume = 0.8;
    a.onended = () => setPlaying(null);
    a.play().catch(() => {
      setPlaying(null);
      useStore.getState().toast("error", "Не удалось воспроизвести трек — проверьте звук в Windows");
    });
    audio.current = a;
    setPlaying(key);
  };
  const toggleTrack = (token: string, on: boolean) =>
    upd((q) => {
      q.music.tracks = on ? [...q.music.tracks.filter((x) => x !== token), token] : q.music.tracks.filter((x) => x !== token);
    });
  const own = m.tracks.filter((t) => !t.startsWith("builtin:"));
  return (
    <>
      <Section title="Встроенная музыка">
        <p className="note">Оригинальные треки программы — можно использовать в любых роликах, без претензий от площадок.</p>
        {builtin.length === 0 && <p className="note err">Встроенная музыка не найдена — переустановите программу. Свои треки работают как обычно.</p>}
        <ul className="music-lib">
          {builtin.map((t) => {
            const on = m.tracks.includes(t.token);
            return (
              <li key={t.id} className={on ? "on" : ""}>
                <button className="icon play" onClick={() => play(t.id, t.path)} data-tip={playing === t.id ? "Пауза" : "Прослушать"} aria-label={playing === t.id ? `Пауза «${t.title}»` : `Прослушать «${t.title}»`}>
                  {playing === t.id ? <Pause size={15} /> : <PlayIcon size={15} />}
                </button>
                <div className="music-meta">
                  <b>{t.title}</b>
                  <span className="dim">{t.mood} · {t.genre} · {t.bpm} BPM</span>
                </div>
                <label className="check" data-tip={on ? "Убрать из проекта" : "Использовать в ролике"}>
                  <input type="checkbox" checked={on} onChange={(e) => toggleTrack(t.token, e.target.checked)} />
                  <span />
                </label>
              </li>
            );
          })}
        </ul>
      </Section>
      <Section title="Свои треки">
        {own.length === 0 ? (
          <p className="note">Перетащите аудиофайлы в окно или добавьте кнопкой — они появятся здесь.</p>
        ) : (
          <ul className="music-lib">
            {own.map((t) => (
              <li key={t} className="on">
                <button className="icon play" onClick={() => play(t, t)} data-tip={playing === t ? "Пауза" : "Прослушать"} aria-label="Прослушать">
                  {playing === t ? <Pause size={15} /> : <PlayIcon size={15} />}
                </button>
                <div className="music-meta">
                  <b data-tip={t}>{baseName(t)}</b>
                  <span className="dim">{media[t]?.info ? fmtSec(media[t].info!.duration) : media[t] ? "не читается" : ""}</span>
                </div>
                <button className="icon" data-tip="Убрать из проекта (файл не удаляется)" onClick={() => toggleTrack(t, false)}>
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <button className="btn subtle sm" onClick={() => pickFiles("music")}>
          <Plus size={14} /> Добавить свой трек
        </button>
        {m.tracks.length > 1 && <p className="note">Выбрано треков: {m.tracks.length} — для каждого ролика берётся случайный.</p>}
      </Section>
      <Section title="Звук">
        <Toggle label="Начинать со случайного места" hint="Каждый ролик звучит по-разному даже с одним треком." checked={m.offset == null} onChange={(v) => upd((q) => void (q.music.offset = v ? null : 0))} />
        {m.offset != null && (
          <Slider label="Начало трека" min={0} max={240} step={1} value={m.offset} format={(v) => fmtSec(v)} onChange={(v) => upd((q) => void (q.music.offset = v), "off")} />
        )}
        <Slider label="Громкость" min={0} max={2} step={0.05} value={m.volume} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => upd((q) => void (q.music.volume = v), "vol")} />
        <Toggle label="Выравнивать громкость (−14 LUFS)" hint="Стандарт стриминга: ролики не «орут» и не «шепчут»." checked={m.loudnorm} onChange={(v) => upd((q) => void (q.music.loudnorm = v))} />
        <Toggle label="Переходы в такт музыке" hint="Анализирует ритм и подгоняет моменты переходов под бит." checked={m.beat_sync} onChange={(v) => upd((q) => void (q.music.beat_sync = v))} />
        <Slider label="Плавное начало" min={0} max={3} step={0.1} value={m.fade_in} format={(v) => `${num(v)} с`} onChange={(v) => upd((q) => void (q.music.fade_in = v), "fi")} />
        <Slider label="Затухание в конце" min={0} max={5} step={0.1} value={m.fade_out} format={(v) => `${num(v)} с`} onChange={(v) => upd((q) => void (q.music.fade_out = v), "fo")} />
      </Section>
    </>
  );
}

const SIZES: Record<string, [number, number, string]> = {
  "9:16": [1080, 1920, "TikTok / Reels / Shorts"],
  "16:9": [1920, 1080, "Telegram / YouTube"],
  "1:1": [1080, 1080, "Квадрат"],
  "4:5": [1080, 1350, "Лента Instagram"],
};

function ExportTab() {
  const p = useP();
  const settings = useStore((s) => s.settings);
  const after = p.after;
  return (
    <>
      <Section title="Форматы">
        {p.targets.map((t, i) => {
          const key = Object.entries(SIZES).find(([, v]) => v[0] === t.width && v[1] === t.height)?.[0] ?? "9:16";
          return (
            <div className="target" key={t.id}>
              <Toggle label={t.label} checked={t.enabled} onChange={(v) => upd((q) => void (q.targets[i].enabled = v))} />
              <Segmented value={key} onChange={(k) => upd((q) => { const [w, h, l] = SIZES[k]; Object.assign(q.targets[i], { width: w, height: h, label: l }); })}
                options={Object.keys(SIZES).map((k) => [k, k] as [string, string])} />
              <div className="file-pick">
                <FolderOpen size={14} />
                <span className="dim" data-tip={t.out_dir}>{t.out_dir ? t.out_dir : `Папка по умолчанию${settings?.out_dir ? "" : " (Видео\\Timelapse Studio)"}`}</span>
                <button className="btn subtle sm" onClick={async () => { const d = await pickFolder(); if (d) upd((q) => void (q.targets[i].out_dir = d)); }}>Изменить…</button>
                {t.out_dir && <button className="icon" data-tip="По умолчанию" onClick={() => upd((q) => void (q.targets[i].out_dir = ""))}><X size={14} /></button>}
              </div>
            </div>
          );
        })}
      </Section>
      <Section title="Качество">
        <Segmented<Quality> label="Качество / размер файла" value={p.export.quality} onChange={(v) => upd((q) => void (q.export.quality = v))}
          options={[["high", "Высокое"], ["balanced", "Оптимальное"], ["small", "Компактное"]]} />
        <div className="row2">
          <Select<Codec> label="Кодек" value={p.export.codec} onChange={(v) => upd((q) => void (q.export.codec = v))} options={[["h264", "H.264 (везде)"], ["hevc", "HEVC (меньше файл)"]]} />
          <Select label="Кадров/с" value={String(p.export.fps)} onChange={(v) => upd((q) => void (q.export.fps = parseInt(v)))} options={[["24", "24"], ["25", "25"], ["30", "30"], ["50", "50"], ["60", "60"]]} />
        </div>
        <Select<Hardware> label="Ускорение видеокартой" hint="«Авто» проверит вашу видеокарту и использует её, если она работает." value={p.export.hardware} onChange={(v) => upd((q) => void (q.export.hardware = v))}
          options={[["auto", "Авто"], ["cpu", "Только процессор"], ["nvenc", "NVIDIA"], ["qsv", "Intel"], ["amf", "AMD"]]} />
        <Toggle label="Собирать форматы одновременно" hint="Быстрее на мощных ПК." checked={p.export.parallel} onChange={(v) => upd((q) => void (q.export.parallel = v))} />
      </Section>
      <Section title="Вместе с роликом">
        <Toggle label="Обложка (.jpg)" checked={p.export.cover} onChange={(v) => upd((q) => void (q.export.cover = v))} />
        <Toggle label="Описание с хэштегами (.txt)" checked={p.export.description} onChange={(v) => upd((q) => void (q.export.description = v))} />
      </Section>
      <Section title="Исходники после сборки">
        <Segmented value={after.mode} onChange={(m) => upd((q) => void (q.after = m === "archive" ? { mode: "archive", dir: "" } : m === "trash" ? { mode: "trash" } : { mode: "keep" }))}
          options={[["keep", "Оставить"], ["archive", "В архив"], ["trash", "В Корзину"]]} />
        <p className="note">Исходники трогаются, только если <b>все</b> форматы собрались успешно.</p>
        {after.mode === "archive" && (
          <div className="file-pick">
            <FolderOpen size={14} />
            <span className="dim">{after.dir || "Папка по умолчанию (рядом с роликами)"}</span>
            <button className="btn subtle sm" onClick={async () => { const d = await pickFolder(); if (d) upd((q) => void (q.after = { mode: "archive", dir: d })); }}>Изменить…</button>
          </div>
        )}
      </Section>
    </>
  );
}

export function Inspector() {
  const [tab, setTabRaw] = useState<Tab>("video");
  // текст и цвет видны только в предпросмотре оформления — переключаемся на него сами
  const setTab = (t: Tab) => {
    setTabRaw(t);
    const s = useStore.getState();
    if ((t === "text" || t === "look") && s.preview === "clip" && s.project.clips.some((c) => c.enabled)) s.set({ preview: "frame" });
  };
  return (
    <aside className="inspector" aria-label="Настройки">
      <div className="tabs" role="tablist">
        {(
          [
            ["video", "Видео"],
            ["text", "Текст"],
            ["look", "Цвет"],
            ["music", "Музыка"],
            ["export", "Экспорт"],
          ] as [Tab, string][]
        ).map(([k, t]) => (
          <button key={k} id={`tab-${k}`} role="tab" aria-selected={tab === k} aria-controls="inspector-panel" className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {t}
          </button>
        ))}
      </div>
      <div className="inspector-body" id="inspector-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "video" && <VideoTab />}
        {tab === "text" && <TextTab />}
        {tab === "look" && <LookTab />}
        {tab === "music" && <MusicTab />}
        {tab === "export" && <ExportTab />}
      </div>
    </aside>
  );
}
