import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { AlertOctagon, Upload } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errorText, onBuildDone, onBuildEvent, onCloseRequested, onUpdateProgress } from "./api";
import { cancelBuild, checkUpdates, importPaths, newProject, openProjectFile, refreshMedia, renderFrame, saveProject, startBuild } from "./actions";
import { enableAutosave, saveNow, useStore } from "./store";
import { About } from "./components/About";
import { Home } from "./components/Home";
import { TooltipLayer } from "./components/Tooltip";
import { defaultProject, type AppInfo } from "./types";
import { isTyping } from "./logic";
import { BuildBar, Help, Results, Toasts, TopBar } from "./components/Chrome";
import { Inspector } from "./components/Inspector";
import { Library } from "./components/Library";
import { Stage } from "./components/Stage";

function useTheme() {
  const theme = useStore((s) => s.settings?.theme ?? "system");
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      try {
        localStorage.setItem("tls-theme", dark ? "dark" : "light"); // для первого кадра без вспышки
      } catch {
        /* хранилище недоступно — не страшно */
      }
      // заголовок окна Windows — в цвет темы программы
      getCurrentWindow()
        .setTheme(theme === "system" ? null : dark ? "dark" : "light")
        .catch(() => {});
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
}

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  useTheme();

  // запуск: проверка движка, настройки, восстановление последнего проекта
  useEffect(() => {
    (async () => {
      try {
        const i = await api.appInfo();
        setInfo(i);
        useStore.getState().set({ appInfo: i });
        if (!i.ffmpeg) {
          setFatal(i.ffmpeg_error || "Видеодвижок (ffmpeg) не найден.");
          return;
        }
        const settings = await api.settingsLoad();
        useStore.getState().set({ settings });
        const saved = await api.autosaveLoad();
        const proj = saved ?? defaultProject(i.builtin_music[0]?.token);
        useStore.getState().replace(proj, null);
        await refreshMedia(proj);
        enableAutosave();
        if (!saved) await saveNow();
        // программу открыли двойным щелчком по файлу проекта
        const file = await api.startupFile().catch(() => null);
        if (file) await openProjectFile(file);
        if (settings.auto_update_check) setTimeout(() => checkUpdates(true), 4000);
      } catch (e) {
        setFatal(errorText(e));
      }
    })();
  }, []);

  // события сборки
  useEffect(() => {
    const un1 = onBuildEvent((e) => {
      const s = useStore.getState();
      if (e.type === "progress") s.set({ progress: e.value });
      else if (e.type === "stage") s.set({ stage: e.text });
      else if (e.type === "log") s.set({ log: [...s.log, e.line].slice(-2000) });
      else if (e.type === "warning") s.set({ warnings: [...s.warnings, e.text] });
    });
    const un2 = onBuildDone((d) => {
      const s = useStore.getState();
      s.set({ building: false, buildKind: null, stage: "", progress: 0 });
      if (d.status === "error") {
        if (d.error.code === "cancelled") s.toast("info", "Сборка остановлена. Исходники не тронуты.");
        else s.toast("error", d.error.message);
        if (d.error.log?.length) s.set({ log: [...s.log, ...d.error.log] });
        return;
      }
      if (d.draft) {
        const p = d.report.outputs[0]?.path;
        if (p) s.set({ draft: p, preview: "draft" });
        else s.toast("error", d.report.outputs[0]?.error?.message ?? "Пробный ролик не собрался");
        return;
      }
      s.set({ report: d.report, showResults: true });
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
    };
  }, []);

  // прогресс загрузки обновления
  useEffect(() => {
    const un = onUpdateProgress(({ downloaded, total }) => useStore.getState().set({ updateProgress: total ? downloaded / total : 0.5 }));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // закрытие окна во время сборки
  useEffect(() => {
    const un = onCloseRequested(async () => {
      const yes = await ask("Идёт сборка роликов. Остановить её и закрыть программу?\nИсходники не пострадают.", {
        title: "Timelapse Studio",
        kind: "warning",
        okLabel: "Остановить и закрыть",
        cancelLabel: "Продолжить сборку",
      });
      if (yes) await api.quitAfterCancel();
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // перетаскивание файлов и папок в окно
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((ev) => {
      const t = ev.payload.type;
      if (t === "enter" || t === "over") setDragOver(true);
      else if (t === "leave") setDragOver(false);
      else if (t === "drop") {
        setDragOver(false);
        importPaths(ev.payload.paths);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // горячие клавиши. e.code — физическая клавиша: работает и в русской раскладке (Ctrl+Я = Ctrl+Z)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const typing = isTyping(e.target);
      const ctrl = e.ctrlKey || e.metaKey;
      const code = e.code;
      if (ctrl && code === "Enter") {
        e.preventDefault();
        if (!e.repeat) startBuild(e.shiftKey);
      } else if (ctrl && !e.shiftKey && code === "KeyZ" && !typing) {
        e.preventDefault();
        s.undo();
      } else if (ctrl && (code === "KeyY" || (e.shiftKey && code === "KeyZ")) && !typing) {
        e.preventDefault();
        s.redo();
      } else if (ctrl && code === "KeyS") {
        e.preventDefault();
        if (!e.repeat) saveProject(e.shiftKey);
      } else if (ctrl && code === "KeyO") {
        e.preventDefault();
        if (!e.repeat) openProjectFile();
      } else if (ctrl && code === "KeyN") {
        e.preventDefault();
        if (!e.repeat) newProject();
      } else if (ctrl && code === "KeyP") {
        e.preventDefault();
        s.set({ showHome: true });
      } else if (e.key === "F5") {
        e.preventDefault();
        if (!e.repeat) renderFrame();
      } else if (e.key === "F1") {
        e.preventDefault();
        setHelp(true);
      } else if (e.key === "Escape") {
        if (s.showAbout) s.set({ showAbout: false });
        else if (s.showHome) s.set({ showHome: false });
        else if (s.showResults) s.set({ showResults: false });
        else if (help) setHelp(false);
        else if (s.building && !typing && !e.repeat) {
          // сборка может идти минутами — случайный Esc не должен её обрывать
          ask("Остановить сборку роликов?", { title: "Timelapse Studio", kind: "warning", okLabel: "Остановить", cancelLabel: "Продолжить" }).then((yes) => {
            if (yes) cancelBuild();
          });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [help]);

  // свой шрифт не загрузился — ролик соберётся встроенным, но пользователь должен об этом знать
  useEffect(() => {
    const f = (e: Event) =>
      useStore.getState().toast("warn", `Шрифт «${(e as CustomEvent<string>).detail}» не загрузился — использую встроенный. Выберите другой файл на вкладке «Текст».`);
    window.addEventListener("tls-font-failed", f);
    return () => window.removeEventListener("tls-font-failed", f);
  }, []);

  // двойной щелчок по файлу .tlsproj, когда программа уже открыта
  useEffect(() => {
    const un = listen<string>("open-file", (e) => openProjectFile(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // запрет контекстного меню браузера (кроме полей ввода) — окно ведёт себя как программа
  useEffect(() => {
    const f = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!["INPUT", "TEXTAREA"].includes(t.tagName)) e.preventDefault();
    };
    window.addEventListener("contextmenu", f);
    return () => window.removeEventListener("contextmenu", f);
  }, []);

  if (fatal)
    return (
      <div className="fatal">
        <AlertOctagon size={44} />
        <h1>Программа не может начать работу</h1>
        <p>{fatal}</p>
        <p className="dim">Переустановите Timelapse Studio — видеодвижок входит в установщик. Если не помогло, отправьте журнал из папки: {info?.log_dir}</p>
      </div>
    );

  return (
    <div className="app">
      <TopBar onHelp={() => setHelp(true)} />
      <div className="workspace">
        <Library />
        <Stage />
        <Inspector />
      </div>
      <BuildBar />
      <Results />
      {help && <Help onClose={() => setHelp(false)} />}
      <About />
      <Home />
      <TooltipLayer />
      {dragOver && (
        <div className="drop-overlay">
          <div>
            <Upload size={34} />
            <b>Отпустите файлы</b>
            <span>видео → клипы · фото → финал · аудио → музыка · папки тоже можно</span>
          </div>
        </div>
      )}
      <Toasts />
    </div>
  );
}
