import { describe, expect, it } from "vitest";
import { addUnique, baseName, classify, estimate, fmtSec, move, preflight } from "./logic";
import { defaultProject, type MediaInfo, type ProbeItem } from "./types";

const info = (path: string, kind: MediaInfo["kind"], duration = 10): ProbeItem => ({
  path,
  kind,
  error: null,
  info: { path, kind, duration, width: 1920, height: 1080, fps: 30, has_video: kind !== "audio", has_audio: kind === "audio", is_hdr: false, pix_fmt: "yuv420p", codec: "h264", size_bytes: 1 },
});

describe("logic", () => {
  it("baseName handles windows and unix paths", () => {
    expect(baseName("C:\\Видео\\клип 1.mp4")).toBe("клип 1.mp4");
    expect(baseName("/home/a/b.mp4")).toBe("b.mp4");
  });
  it("fmtSec", () => {
    expect(fmtSec(5.25)).toBe("5,3 с");
    expect(fmtSec(75)).toBe("1 мин 15 с");
    expect(fmtSec(3 * 3600 + 120)).toBe("3 ч 2 мин");
  });
  it("classify sorts by kind and keeps errors", () => {
    const r = classify([info("a.mp4", "video"), info("b.jpg", "image"), info("c.mp3", "audio"), { path: "x.mp4", kind: "video", info: null, error: "битый" }]);
    expect(r.clips).toEqual(["a.mp4"]);
    expect(r.photos).toEqual(["b.jpg"]);
    expect(r.music).toEqual(["c.mp3"]);
    expect(r.bad[0].error).toBe("битый");
  });
  it("estimate matches core: target seconds exact with transitions", () => {
    const p = defaultProject();
    p.clips = [
      { id: "1", path: "a", enabled: true, trim_start: 0, trim_end: null },
      { id: "2", path: "b", enabled: true, trim_start: 2, trim_end: 8 },
    ];
    p.speed = { mode: "target", seconds: 10 };
    const media = { a: info("a", "video", 10), b: info("b", "video", 10) };
    const e = estimate(p, media);
    expect(e.source).toBe(16);
    expect(Math.abs(e.total - 10)).toBeLessThan(1e-9);
  });
  it("estimate ignores disabled and unreadable clips", () => {
    const p = defaultProject();
    p.speed = { mode: "none" };
    p.transition.kind = "none";
    p.clips = [
      { id: "1", path: "a", enabled: false, trim_start: 0, trim_end: null },
      { id: "2", path: "b", enabled: true, trim_start: 0, trim_end: null },
      { id: "3", path: "c", enabled: true, trim_start: 0, trim_end: null },
    ];
    const media = { a: info("a", "video", 10), b: info("b", "video", 4), c: { path: "c", kind: "video", info: null, error: "x" } as ProbeItem };
    expect(estimate(p, media).total).toBe(4);
  });
  it("addUnique and move", () => {
    expect(addUnique([1, 2], [2, 3], String)).toEqual([1, 2, 3]);
    expect(move(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });
  it("preflight explains problems", () => {
    const p = defaultProject();
    expect(preflight(p, {})[0]).toContain("Добавьте");
    p.clips = [{ id: "1", path: "a", enabled: true, trim_start: 0, trim_end: null }];
    p.style.hook_text = "Огонь 🔥";
    // эмодзи теперь поддерживаются (текст рисует интерфейс) — предупреждения нет
    expect(preflight(p, { a: info("a", "video") })).toEqual([]);
  });
});

describe("speed", () => {
  it("target mode never slows down short sources", () => {
    const p = defaultProject();
    p.transition.kind = "none";
    p.clips = [{ id: "1", path: "a", enabled: true, trim_start: 0, trim_end: null }];
    p.speed = { mode: "target", seconds: 20 };
    const e = estimate(p, { a: info("a", "video", 9) });
    expect(e.speed).toBe(1);
    expect(e.total).toBe(9);
  });
});
