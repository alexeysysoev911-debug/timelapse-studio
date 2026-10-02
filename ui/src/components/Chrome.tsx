// Верхняя панель, нижняя панель сборки, окно результатов, уведомления, справка.
import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  FileText,
  FilePlus2,
  FolderOpen,
  HelpCircle,
  Info,
  LayoutGrid,
  Moon,
  Play,
  Redo2,
  Save,
  Square,
  Sun,
  Undo2,
  X,
  XCircle,
} from "lucide-react";
import { api, fileUrl } from "../api";
import { cancelBuild, newProject, openProjectFile, saveProject, startBuild } from "../actions";
import { baseName, estimate, fmtSec, preflight } from "../logic";
import { useStore } from "../store";

export function TopBar({ onHelp }: { onHelp: () => void }) {
  const name = useStore((s) => s.project.name);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const settings = useStore((s) => s.settings);
  const updateAvailable = useStore((s) => s.update?.available);
  const theme = settings?.theme ?? "system";
  const cycleTheme = () => {
    if (!settings) return;
    const next = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
    const s = { ...settings, theme: next as typeof theme };
    useStore.getState().set({ settings: s });
    api.settingsStore(s).catch(() => {});
  };
  return (
    <header className="topbar">
      <div className="brand">
        <img src="/icon.png" alt="" />
        <span>Timelapse Studio</span>
      </div>
      <div className="tb-group">
        <button className="tb-btn" data-tip="Мои проекты — все проекты с обложками" onClick={() => useStore.getState().set({ showHome: true })}>
          <LayoutGrid size={17} />
          <span>Проекты</span>
        </button>
        <span className="sep" />
        <button className="icon" data-tip="Новый проект (Ctrl+N)" onClick={() => newProject()}>
          <FilePlus2 size={17} />
        </button>
        <button className="icon" data-tip="Открыть проект из файла (Ctrl+O)" onClick={() => openProjectFile()}>
          <FolderOpen size={17} />
        </button>
        <button className="icon" data-tip="Сохранить (Ctrl+S) · Ctrl+Shift+S — сохранить в файл" onClick={() => saveProject()}>
          <Save size={17} />
        </button>
        <span className="sep" />
        <button className="icon" data-tip="Отменить (Ctrl+Z)" disabled={!canUndo} onClick={() => useStore.getState().undo()}>
          <Undo2 size={17} />
        </button>
        <button className="icon" data-tip="Повторить (Ctrl+Y)" disabled={!canRedo} onClick={() => useStore.getState().redo()}>
          <Redo2 size={17} />
        </button>
      </div>
      <input
        className="project-name"
        value={name}
        aria-label="Название проекта"
        data-tip="Название проекта — сохраняется автоматически"
        onChange={(e) => useStore.getState().edit((p) => void (p.name = e.target.value), "name")}
      />
      <span className="grow" />
      <button
        className="icon"
        data-tip={`Тема: ${theme === "system" ? "как в Windows" : theme === "dark" ? "тёмная" : "светлая"}`}
        onClick={cycleTheme}
      >
        {theme === "light" ? <Sun size={17} /> : <Moon size={17} />}
      </button>
      <button className="icon" data-tip="Справка и горячие клавиши (F1)" onClick={onHelp}>
        <HelpCircle size={17} />
      </button>
      <button className={`icon ${updateAvailable ? "badge-dot" : ""}`} data-tip={updateAvailable ? "Доступно обновление" : "О программе"} onClick={() => useStore.getState().set({ showAbout: true })}>
        <Info size={17} />
      </button>
    </header>
  );
}

export function BuildBar() {
  const s = useStore();
  const est = estimate(s.project, s.media);
  const warn = preflight(s.project, s.media);
  const [showLog, setShowLog] = useState(false);
  return (
    <footer className={`buildbar ${showLog ? "with-log" : ""}`}>
      {showLog && (
        <pre className="log" aria-label="Журнал сборки">
          {s.log.length ? s.log.join("\n") : "Журнал пуст — он заполнится во время сборки."}
        </pre>
      )}
      <div className="bb-row">
        {s.building ? (
          <button className="btn danger lg" onClick={() => cancelBuild()} data-tip="Остановить (Esc). Исходники не пострадают">
            <Square size={16} /> Остановить
          </button>
        ) : (
          <button className="btn primary lg" onClick={() => startBuild(false)} data-tip="Собрать ролики (Ctrl+Enter)">
            <Play size={16} /> Собрать ролики
          </button>
        )}
        <div className="bb-status">
          {s.building || s.stage ? (
            <>
              <div className="bb-stage">
                <span>{s.stage || "Подготовка"}</span>
                {s.building && <b>{Math.round(s.progress * 100)}%</b>}
              </div>
              {s.building && (
                <div className="progress" role="progressbar" aria-valuenow={Math.round(s.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <i style={{ width: `${s.progress * 100}%` }} />
                </div>
              )}
            </>
          ) : warn.length ? (
            <div className="bb-warn" data-tip={warn.join("\n")}>
              <AlertTriangle size={15} /> {warn[0]}
            </div>
          ) : (
            <div className="bb-ready">
              Готово к сборке: <b>{s.project.targets.filter((t) => t.enabled).length}</b> формат(а), ~<b>{fmtSec(est.total)}</b>
            </div>
          )}
        </div>
        {s.report && !s.building && (
          <button className="btn subtle" onClick={() => useStore.getState().set({ showResults: true })}>
            Последний результат
          </button>
        )}
        <button className={`btn subtle ${showLog ? "on" : ""}`} onClick={() => setShowLog(!showLog)} data-tip="Подробный журнал сборки">
          <FileText size={15} /> Журнал
        </button>
      </div>
    </footer>
  );
}

export function Results() {
  const report = useStore((s) => s.report);
  const show = useStore((s) => s.showResults);
  const toast = useStore((s) => s.toast);
  const onClose = () => useStore.getState().set({ showResults: false });
  if (!report || !show) return null;
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Результат сборки" onClick={onClose}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          {report.all_ok ? <CheckCircle2 className="ok" size={22} /> : <AlertTriangle className="warn" size={22} />}
          <h2>{report.all_ok ? "Ролики готовы" : "Сборка завершилась с ошибками"}</h2>
          <span className="dim">
            {fmtSec(report.duration)} · {report.backend === "cpu" ? "процессор" : report.backend.toUpperCase()}
          </span>
          <span className="grow" />
          <button className="icon" onClick={onClose} aria-label="Закрыть" data-tip="Закрыть (Esc)">
            <X size={18} />
          </button>
        </div>
        <div className="results">
          {report.outputs.map((o) => (
            <div className="result" key={o.target_id}>
              <div className="result-media">
                {o.path ? (
                  <video src={fileUrl(o.path)} poster={o.cover ? fileUrl(o.cover) : undefined} controls muted preload="metadata" />
                ) : (
                  <div className="noplay">
                    <XCircle size={28} />
                  </div>
                )}
              </div>
              <div className="result-info">
                <b>{o.label}</b>
                {o.path ? (
                  <span className="dim" data-tip={o.path}>
                    {baseName(o.path)}
                  </span>
                ) : (
                  <span className="err">{o.error?.message}</span>
                )}
                {o.path && (
                  <div className="result-actions">
                    <button className="btn primary sm" onClick={() => api.openPath(o.path!)}>
                      <Play size={13} /> Открыть
                    </button>
                    <button className="btn subtle sm" onClick={() => api.reveal(o.path!)}>
                      <FolderOpen size={13} /> Показать в папке
                    </button>
                  </div>
                )}
                {o.description && (
                  <div className="desc">
                    <pre>{o.description}</pre>
                    <button className="btn subtle sm" onClick={() => navigator.clipboard.writeText(o.description!).then(() => toast("ok", "Описание скопировано"))}>
                      <Copy size={13} /> Скопировать описание
                    </button>
                  </div>
                )}
                {o.error?.log?.length ? (
                  <details>
                    <summary>Подробности</summary>
                    <pre className="log small">{o.error.log.join("\n")}</pre>
                  </details>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        {(report.warnings.length > 0 || report.after) && (
          <ul className="notes">
            {report.after && (
              <li>
                <Info size={14} /> {report.after}
              </li>
            )}
            {report.warnings.map((w, i) => (
              <li key={i}>
                <AlertTriangle size={14} /> {w}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "ok" ? <CheckCircle2 size={16} /> : t.kind === "error" ? <XCircle size={16} /> : t.kind === "warn" ? <AlertTriangle size={16} /> : <Info size={16} />}
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button
              className="btn primary sm"
              onClick={() => {
                dismiss(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon sm" aria-label="Закрыть" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Help({ onClose }: { onClose: () => void }) {
  const keys: [string, string][] = [
    ["Ctrl+Enter", "Собрать ролики"],
    ["Ctrl+Shift+Enter", "Пробный ролик"],
    ["Ctrl+Z / Ctrl+Y", "Отменить / повторить"],
    ["Ctrl+S", "Сохранить проект"],
    ["Ctrl+Shift+S", "Сохранить проект в файл"],
    ["Ctrl+O / Ctrl+N", "Открыть из файла / новый проект"],
    ["Ctrl+P", "Мои проекты"],
    ["F5", "Точный кадр оформления"],
    ["Esc", "Остановить сборку / закрыть окно"],
  ];
  return (
    <div className="modal" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>Справка</h2>
          <span className="grow" />
          <button className="icon" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>
        <p>
          Перетащите клипы, фото результата и музыку прямо в окно — программа сама разложит файлы. Настройте вид справа, следите за результатом во вкладке «Оформление» и нажмите
          «Собрать ролики». Всё обрабатывается на вашем компьютере.
        </p>
        <h3>Горячие клавиши</h3>
        <table className="keys">
          <tbody>
            {keys.map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Подсказки</h3>
        <p className="dim">
          Материал и слой берутся из имени файла: <code>Spool_PETG_0.2.mp4</code>. Время процесса — из <code>3h1m33s</code> или <code>45m10s</code>.
        </p>
      </div>
    </div>
  );
}
