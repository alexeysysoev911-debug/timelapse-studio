// «О программе»: версия, разработчик со ссылкой на Telegram, обновления, лицензии, журнал.
import { useEffect } from "react";
import { Copy, Download, ExternalLink, RefreshCw, Send, X } from "lucide-react";
import { api, TELEGRAM_AUTHOR, TELEGRAM_CHANNEL } from "../api";
import { checkUpdates, installUpdate } from "../actions";
import { useStore } from "../store";
import { Toggle } from "./controls";

declare const __BUILD_DATE__: string;

export function About() {
  const show = useStore((s) => s.showAbout);
  const info = useStore((s) => s.appInfo);
  const update = useStore((s) => s.update);
  const updateError = useStore((s) => s.updateError);
  const progress = useStore((s) => s.updateProgress);
  const settings = useStore((s) => s.settings);
  const toast = useStore((s) => s.toast);
  const close = () => useStore.getState().set({ showAbout: false });
  useEffect(() => {
    if (show && !update && !updateError) checkUpdates(true);
  }, [show]);
  if (!show) return null;
  const link = (url: string) => api.openLink(url).catch(() => toast("error", "Не удалось открыть ссылку"));
  const setSetting = (patch: Partial<NonNullable<typeof settings>>) => {
    if (!settings) return;
    const s = { ...settings, ...patch };
    useStore.getState().set({ settings: s });
    api.settingsStore(s).catch(() => {});
  };
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="О программе" onClick={close}>
      <div className="dialog about" onClick={(e) => e.stopPropagation()}>
        <button className="icon close" onClick={close} aria-label="Закрыть">
          <X size={18} />
        </button>
        <div className="about-head">
          <img src="/icon.png" alt="" />
          <div>
            <h2>Timelapse Studio</h2>
            <div className="dim">
              Версия {info?.version ?? "—"} · сборка {__BUILD_DATE__}
            </div>
          </div>
        </div>
        <p>Готовые ролики для TikTok, Reels, Shorts и Telegram из таймлапс-клипов: музыка, переходы в такт, стабилизация, цветовые образы, тексты с эмодзи, обложки и описания.</p>

        <div className="about-card">
          <div className="about-row">
            <span className="dim">Разработчик</span>
            <button className="linkish" onClick={() => link(TELEGRAM_AUTHOR)} data-tip="Написать автору в Telegram">
              Alexey S. <Send size={13} />
            </button>
          </div>
          <div className="about-row">
            <span className="dim">Вопросы и пожелания</span>
            <button className="linkish" onClick={() => link(TELEGRAM_AUTHOR)}>
              t.me/alexeyalesha8 <ExternalLink size={13} />
            </button>
          </div>
          <div className="about-row">
            <span className="dim">Канал</span>
            <button className="linkish" onClick={() => link(TELEGRAM_CHANNEL)}>
              t.me/3dprinteralesha <ExternalLink size={13} />
            </button>
          </div>
        </div>

        <h3>Обновления</h3>
        <div className="about-card">
          {progress != null ? (
            <div className="update-progress">
              <span>Загружаю и устанавливаю обновление… Программа перезапустится сама.</span>
              <div className="progress">
                <i style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            </div>
          ) : update?.available ? (
            <div className="update-available">
              <b>Доступна версия {update.version}</b>
              {update.notes && <pre className="notes-text">{update.notes}</pre>}
              <button className="btn primary" onClick={() => installUpdate()}>
                <Download size={15} /> Обновить и перезапустить
              </button>
            </div>
          ) : (
            <div className="about-row">
              <span className={updateError ? "err" : ""} data-tip={updateError ?? undefined}>
                {update ? `У вас последняя версия ${update.current}` : updateError ? "Сервер обновлений недоступен" : "Проверяю…"}
              </span>
              <button className="btn subtle sm" onClick={() => checkUpdates(false)}>
                <RefreshCw size={13} /> Проверить обновления
              </button>
            </div>
          )}
          {settings && <Toggle label="Проверять обновления при запуске" checked={settings.auto_update_check} onChange={(v) => setSetting({ auto_update_check: v })} />}
          {settings && (
            <div className="field">
              <div className="field-label">
                <span>Сервер обновлений</span>
              </div>
              <input
                type="text"
                placeholder={info?.update_endpoint_default ?? ""}
                value={settings.update_endpoint}
                onChange={(e) => setSetting({ update_endpoint: e.target.value.trim() })}
                data-tip="Адрес файла latest.json. Пусто — стандартный (GitHub Releases). Обновления всегда проверяются по цифровой подписи."
              />
            </div>
          )}
        </div>

        <div className="dialog-foot">
          <button
            className="btn subtle"
            onClick={async () => {
              await navigator.clipboard.writeText(await api.readLog());
              toast("ok", "Журнал скопирован — отправьте его разработчику");
            }}
          >
            <Copy size={14} /> Скопировать журнал для поддержки
          </button>
          <span className="grow" />
          <span className="dim small-print" data-tip="Шрифты — SIL Open Font License; ffmpeg — GPL v3 (отдельная программа); музыка и цветовые образы — собственные">
            Лицензии: MIT · OFL · GPL v3
          </span>
        </div>
      </div>
    </div>
  );
}
