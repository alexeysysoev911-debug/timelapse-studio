// «О программе»: версия, разработчик со ссылкой на Telegram, обновления, лицензии, журнал.
import { useEffect } from "react";
import { Copy, Download, ExternalLink, RefreshCw, Send, X } from "lucide-react";
import { api, TELEGRAM_AUTHOR, TELEGRAM_CHANNEL } from "../api";
import { checkUpdates, installUpdate } from "../actions";
import { useStore } from "../store";
import { Toggle } from "./controls";
import { Modal } from "./Modal";

declare const __BUILD_DATE__: string;

export function About() {
  const show = useStore((s) => s.showAbout);
  const info = useStore((s) => s.appInfo);
  const update = useStore((s) => s.update);
  const updateError = useStore((s) => s.updateError);
  const progress = useStore((s) => s.updateProgress);
  const checking = useStore((s) => s.updateChecking);
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
    <Modal label="О программе" onClose={close} className="about">
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
              <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                <i style={{ width: `${Math.max(3, Math.round(progress * 100))}%` }} />
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
                {checking ? "Проверяю…" : update ? `У вас последняя версия ${update.current}` : updateError ? "Не удалось проверить обновления" : "Проверяю…"}
              </span>
              <button className="btn subtle sm" onClick={() => checkUpdates(false)} disabled={checking}>
                <RefreshCw size={13} className={checking ? "spin" : ""} /> Проверить обновления
              </button>
            </div>
          )}
          {settings && <Toggle label="Проверять обновления при запуске" checked={settings.auto_update_check} onChange={(v) => setSetting({ auto_update_check: v })} />}
          {settings && (
            <Toggle
              label="Анонимная статистика запусков"
              hint="Только версия программы и случайный номер установки — без файлов, имён и IP. Помогает понять, сколько людей пользуется программой."
              checked={settings.telemetry}
              onChange={(v) => setSetting({ telemetry: v })}
            />
          )}
          {settings && (
            <div className="field">
              <div className="field-label">
                <span>Сервер программы</span>
              </div>
              <input
                type="text"
                placeholder={info?.server_default ?? ""}
                value={settings.server_url}
                onChange={(e) => setSetting({ server_url: e.target.value.trim() })}
                data-tip="Откуда приходят обновления и новости программы. Пусто — стандартный. Если сервер недоступен, обновления берутся с GitHub. Установщик всегда проверяется по цифровой подписи."
              />
            </div>
          )}
        </div>

        <div className="dialog-foot">
          <button
            className="btn subtle"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(await api.readLog());
                toast("ok", "Журнал скопирован — отправьте его разработчику в Telegram");
              } catch {
                toast("error", "Не удалось скопировать журнал");
              }
            }}
          >
            <Copy size={14} /> Скопировать журнал для поддержки
          </button>
          <span className="grow" />
          <span className="dim small-print" data-tip="Шрифты — SIL Open Font License; ffmpeg — GPL v3 (отдельная программа); музыка и цветовые образы — собственные">
            Лицензии: MIT · OFL · GPL v3
          </span>
        </div>
    </Modal>
  );
}
