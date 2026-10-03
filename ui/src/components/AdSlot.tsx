// Рекламный блок, которым управляет панель на сервере. Три вида: текст, картинка или всё вместе.
// Пустой или выключенный блок не показывается вовсе.
import { ExternalLink } from "lucide-react";
import { api, fileUrl } from "../api";
import { useStore } from "../store";

export function AdSlot({ slot, className }: { slot: "1" | "2"; className?: string }) {
  const ad = useStore((s) => s.remote?.ads[slot]);
  if (!ad) return null;
  const title = ad.title.trim();
  const text = ad.text.trim();
  const img = ad.img_path ? fileUrl(ad.img_path) : null;
  if (!title && !text && !img) return null;
  const open = () => {
    if (ad.url) api.openAd(ad.url).catch(() => useStore.getState().toast("error", "Не удалось открыть ссылку"));
  };
  const onlyImg = !title && !text;
  return (
    <aside className={`ad-slot ${onlyImg ? "img-only" : ""} ${ad.url ? "link" : ""} ${className ?? ""}`} aria-label="Реклама">
      <button type="button" className="ad-body" onClick={open} disabled={!ad.url} data-tip={ad.url ? ad.url.replace(/^https:\/\//, "") : undefined}>
        {img && <img src={img} alt={ad.alt || title || "Реклама"} draggable={false} />}
        {!onlyImg && (
          <span className="ad-tx">
            {title && <b>{title}</b>}
            {text && <span>{text}</span>}
          </span>
        )}
        {ad.url && !onlyImg && <ExternalLink size={13} className="ad-go" aria-hidden />}
      </button>
      <span className="ad-tag">Реклама</span>
    </aside>
  );
}
