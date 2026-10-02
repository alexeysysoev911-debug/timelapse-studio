// Левая панель: клипы (порядок перетаскиванием), фото финала, музыка.
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, Eye, EyeOff, GripVertical, Image as ImageIcon, Music2, Plus, Trash2, Video } from "lucide-react";
import { pickFiles } from "../actions";
import { baseName, clipDur, fmtSec, move } from "../logic";
import { useStore } from "../store";
import type { Clip } from "../types";
import { Thumb } from "./Thumb";

const NO_TRACKS: import("../types").BuiltinTrack[] = [];

function ClipRow({ clip, index }: { clip: Clip; index: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: clip.id });
  const item = useStore((s) => s.media[clip.path]);
  const selected = useStore((s) => s.selectedClip === clip.id);
  const update = useStore((s) => s.edit);
  const info = item?.info;
  const d = clipDur(clip, info);
  const trimmed = clip.trim_start > 0 || clip.trim_end != null;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`clip-row ${selected ? "selected" : ""} ${clip.enabled ? "" : "off"} ${isDragging ? "dragging" : ""}`}
      onClick={() => useStore.getState().set({ selectedClip: clip.id, preview: "clip" })}
    >
      <button className="grip" aria-label="Перетащить" {...attributes} {...listeners} onClick={(e) => e.stopPropagation()}>
        <GripVertical size={14} />
      </button>
      <span className="idx">{index + 1}</span>
      {info ? <Thumb path={clip.path} at={Math.min(1, info.duration / 3)} width={160} /> : <div className="thumb broken"><AlertTriangle size={14} /></div>}
      <div className="clip-meta">
        <div className="name" data-tip={clip.path}>
          {baseName(clip.path)}
        </div>
        <div className="sub">
          {info ? (
            <>
              {fmtSec(d)}
              {trimmed && <span className="badge">обрезан</span>}
              {info.is_hdr && <span className="badge">HDR</span>}
              <span className="dim">
                {info.width}×{info.height}
              </span>
            </>
          ) : item ? (
            <span className="err" data-tip={item.error ?? ""}>
              не читается — будет пропущен
            </span>
          ) : (
            <span className="dim">проверяю…</span>
          )}
        </div>
      </div>
      <div className="row-actions">
        <button
          className="icon"
          data-tip={clip.enabled ? "Не использовать в ролике" : "Использовать"}
          onClick={(e) => {
            e.stopPropagation();
            update((p) => {
              const c = p.clips.find((x) => x.id === clip.id);
              if (c) c.enabled = !c.enabled;
            });
          }}
        >
          {clip.enabled ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        <button
          className="icon"
          data-tip="Убрать из проекта (файл не удаляется)"
          onClick={(e) => {
            e.stopPropagation();
            update((p) => {
              p.clips = p.clips.filter((x) => x.id !== clip.id);
            });
          }}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </li>
  );
}

export function Library() {
  const clips = useStore((s) => s.project.clips);
  const photos = useStore((s) => s.project.end_photos);
  const tracks = useStore((s) => s.project.music.tracks);
  const builtin = useStore((s) => s.appInfo?.builtin_music ?? NO_TRACKS);
  const trackName = (t: string) => builtin.find((b) => b.token === t)?.title ?? baseName(t);
  const media = useStore((s) => s.media);
  const update = useStore((s) => s.edit);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = clips.findIndex((c) => c.id === e.active.id);
    const to = clips.findIndex((c) => c.id === e.over!.id);
    update((p) => {
      p.clips = move(p.clips, from, to);
    });
  };
  const srcTotal = clips.filter((c) => c.enabled).reduce((a, c) => a + clipDur(c, media[c.path]?.info), 0);

  return (
    <aside className="library" aria-label="Материалы">
      <div className="panel-head">
        <Video size={16} />
        <h2>Клипы</h2>
        <span className="count">
          {clips.length ? `${clips.filter((c) => c.enabled).length} · ${fmtSec(srcTotal)}` : ""}
        </span>
        <button className="btn subtle sm" onClick={() => pickFiles("clips")}>
          <Plus size={14} /> Добавить
        </button>
      </div>
      {clips.length === 0 ? (
        <button className="dropzone" onClick={() => pickFiles("clips")}>
          <Video size={28} />
          <b>Перетащите клипы или папку сюда</b>
          <span>MP4, MOV, MKV, AVI, WEBM… Видео с телефона, HDR и любые разрешения — подходят.</span>
        </button>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={clips.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <ul className="clip-list">
              {clips.map((c, i) => (
                <ClipRow key={c.id} clip={c} index={i} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <div className="panel-head">
        <ImageIcon size={16} />
        <h2>Фото финала</h2>
        <span className="count">{photos.length || ""}</span>
        <button className="btn subtle sm" onClick={() => pickFiles("photos")}>
          <Plus size={14} /> Добавить
        </button>
      </div>
      {photos.length === 0 ? (
        <p className="empty">Фото готового результата в конце ролика — самый «сохраняемый» кадр.</p>
      ) : (
        <div className="photo-grid">
          {photos.map((ph) => (
            <figure key={ph} className={media[ph] && !media[ph].info ? "bad" : ""} data-tip={baseName(ph)}>
              <Thumb path={ph} width={200} />
              <button
                className="icon over"
                data-tip="Убрать"
                onClick={() =>
                  update((p) => {
                    p.end_photos = p.end_photos.filter((x) => x !== ph);
                  })
                }
              >
                <Trash2 size={13} />
              </button>
            </figure>
          ))}
        </div>
      )}

      <div className="panel-head">
        <Music2 size={16} />
        <h2>Музыка</h2>
        <span className="count">{tracks.length || ""}</span>
        <button className="btn subtle sm" onClick={() => pickFiles("music")}>
          <Plus size={14} /> Добавить
        </button>
      </div>
      {tracks.length === 0 ? (
        <p className="empty">Без музыки ролик будет беззвучным. Встроенные треки — на вкладке «Музыка» справа.</p>
      ) : (
        <ul className="track-list">
          {tracks.map((t) => (
            <li key={t} className={media[t] && !media[t].info ? "bad" : ""}>
              <Music2 size={13} />
              <span className="name" data-tip={t.startsWith("builtin:") ? "Встроенный трек программы" : t}>
                {trackName(t)}
              </span>
              <span className="dim">{media[t]?.info ? fmtSec(media[t].info!.duration) : media[t] ? "не читается" : ""}</span>
              <button
                className="icon"
                data-tip="Убрать"
                onClick={() =>
                  update((p) => {
                    p.music.tracks = p.music.tracks.filter((x) => x !== t);
                  })
                }
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
