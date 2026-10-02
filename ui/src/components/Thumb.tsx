import { useEffect, useState } from "react";
import { api, fileUrl } from "../api";
import { useStore } from "../store";

/** Миниатюра файла (кэшируется ядром на диске и в памяти интерфейса). */
export function Thumb({ path, at = 0, width = 320, className }: { path: string; at?: number; width?: number; className?: string }) {
  const key = `${path}|${at}|${width}`;
  const cached = useStore((s) => s.thumbs[key]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (cached || failed) return;
    let alive = true;
    api
      .thumbnail(path, at, width)
      .then((p) => alive && useStore.getState().set({ thumbs: { ...useStore.getState().thumbs, [key]: fileUrl(p) } }))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [key, cached, failed, path, at, width]);
  if (failed) return <div className={`thumb broken ${className ?? ""}`}>?</div>;
  if (!cached) return <div className={`thumb loading ${className ?? ""}`} />;
  return <img className={`thumb ${className ?? ""}`} src={cached} alt="" draggable={false} />;
}
