// «Мои проекты»: библиотека проектов с обложками, поиском, дублированием и удалением в Корзину.
import { useEffect, useMemo, useState } from "react";
import { Copy, FilePlus2, FolderOpen, Search, Trash2, X } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { newProject, openFromLibrary, openProjectFile } from "../actions";
import { useStore } from "../store";
import type { ProjectMeta } from "../types";
import { Thumb } from "./Thumb";
import { Modal } from "./Modal";

function when(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `сегодня, ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `вчера, ${time}`;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export function Home() {
  const show = useStore((s) => s.showHome);
  const currentId = useStore((s) => s.project.id);
  const toast = useStore((s) => s.toast);
  const [items, setItems] = useState<ProjectMeta[] | null>(null);
  const [q, setQ] = useState("");
  const reload = () =>
    api
      .projectsList()
      .then(setItems)
      .catch(() => setItems([]));
  useEffect(() => {
    if (show) reload();
  }, [show]);
  const list = useMemo(() => (items ?? []).filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase())), [items, q]);
  if (!show) return null;
  const close = () => useStore.getState().set({ showHome: false });
  return (
    <Modal label="Мои проекты" onClose={close} className="home">
        <div className="dialog-head">
          <h2>Мои проекты</h2>
          <div className="search">
            <Search size={15} />
            <input type="text" placeholder="Поиск по названию" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </div>
          <span className="grow" />
          <button className="btn subtle" onClick={() => openProjectFile()} data-tip="Открыть проект из файла .tlsproj">
            <FolderOpen size={15} /> Из файла…
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              await newProject();
              close();
            }}
          >
            <FilePlus2 size={15} /> Новый проект
          </button>
          <button className="icon" onClick={close} aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>
        {items === null ? (
          <div className="home-grid">
            {[0, 1, 2].map((i) => (
              <div key={i} className="pcard skeleton" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <p className="empty-big">{q ? "Ничего не найдено" : "Проектов пока нет — создайте первый."}</p>
        ) : (
          <div className="home-grid">
            {list.map((p) => (
              <div key={p.id} className={`pcard ${p.id === currentId ? "current" : ""}`} onClick={() => openFromLibrary(p.id)} role="button" tabIndex={0} onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    openFromLibrary(p.id);
                  }
                }}
                aria-label={`Открыть проект «${p.name || "Без названия"}»`}
              >
                <div className="pcard-cover">{p.first_clip ? <Thumb path={p.first_clip} width={360} at={1} /> : <div className="thumb broken" />}</div>
                <div className="pcard-meta">
                  <b>{p.name || "Без названия"}</b>
                  <span className="dim">
                    {when(p.updated)} · клипов: {p.clips}
                  </span>
                </div>
                {p.id === currentId && <span className="pcard-badge">открыт</span>}
                <div className="pcard-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="icon sm"
                    data-tip="Дублировать"
                    onClick={async () => {
                      try {
                        await api.projectDuplicate(p.id);
                        reload();
                      } catch (e) {
                        toast("error", errorText(e));
                      }
                    }}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    className="icon sm"
                    data-tip={p.id === currentId ? "Открытый проект удалить нельзя — сначала откройте другой" : "Удалить в Корзину (видео не удаляются)"}
                    disabled={p.id === currentId}
                    onClick={async () => {
                      if (!(await ask(`Удалить проект «${p.name}» в Корзину? Видеофайлы останутся на месте.`, { title: "Timelapse Studio", kind: "warning" }))) return;
                      try {
                        await api.projectDelete(p.id);
                        reload();
                      } catch (e) {
                        toast("error", errorText(e));
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
    </Modal>
  );
}
