// Обязательное обновление (выпущено в панели как «Обязательное»): работа блокируется до установки.
import { Download, ExternalLink, ShieldAlert } from "lucide-react";
import { api } from "../api";
import { installUpdate } from "../actions";
import { useStore } from "../store";
import { Modal } from "./Modal";

export function MandatoryUpdate() {
  const m = useStore((s) => s.mandatory);
  const progress = useStore((s) => s.updateProgress);
  const current = useStore((s) => s.appInfo?.version);
  if (!m) return null;
  return (
    <Modal label="Требуется обновление" onClose={() => {}} className="mandatory">
      <h2>
        <ShieldAlert size={22} className="warn" /> Требуется обновление
      </h2>
      <p>
        Версия <b>{current}</b> больше не поддерживается. Установите версию <b>{m.version}</b> — это займёт меньше минуты, проекты и настройки сохранятся.
      </p>
      {m.notes && <pre className="notes-text">{m.notes}</pre>}
      {progress != null ? (
        <div className="update-progress">
          <span>Загружаю и устанавливаю… Программа перезапустится сама.</span>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <i style={{ width: `${Math.max(3, Math.round(progress * 100))}%` }} />
          </div>
        </div>
      ) : (
        <>
          {m.failed ? (
            <p className="err">
              Не получилось установить обновление автоматически. Скачайте установщик с сайта и запустите его — проекты и настройки сохранятся.
            </p>
          ) : null}
          <div className="dialog-foot">
            {m.failed ? (
              <button className="btn subtle" onClick={() => useStore.getState().set({ mandatory: null })} data-tip="Напомним при следующем запуске">
                Позже
              </button>
            ) : null}
            <span className="grow" />
            {m.failed ? (
              <button className="btn subtle" onClick={() => api.openDownloadPage().catch(() => {})}>
                <ExternalLink size={15} /> Скачать с сайта
              </button>
            ) : null}
            <button className="btn primary" onClick={() => installUpdate()} data-autofocus>
              <Download size={15} /> {m.failed ? "Попробовать ещё раз" : "Обновить сейчас"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
