#!/usr/bin/env python3
"""Timelapse Studio — сервер программы и сайта.

Что делает:
  * сайт программы (папка site/): главная, «Конфиденциальность», «Лицензия», 404;
  * панель управления в браузере (/admin): выпуск версий, реклама в программе и на сайте,
    статистика запусков, посещений и скачиваний, история и откат версий;
  * обновления для программы: /updates/latest.json (формат Tauri, подпись проверяет программа);
  * установщики: /downloads/<версия>/<файл>, /downloads/latest (с докачкой);
  * настройки для программы при запуске: /api/app/config (реклама + сведения об обновлении)
    и анонимный счётчик запусков.

Безопасность: сессия панели — cookie HttpOnly + Secure + SameSite=Strict, защита от CSRF
(обязательный заголовок + проверка Origin), строгий CSP без inline-скриптов, ограничение
попыток входа, проверка размеров и сигнатур всех загружаемых файлов, атомарная запись данных.
IP-адреса посетителей на диск не пишутся (только необратимый хэш с ежедневно меняющимся ключом).

Только стандартная библиотека Python 3.9+, без pip. Работает за nginx на 127.0.0.1:8787.

Команды:
  python3 server.py                 — запустить
  python3 server.py init URL        — первая настройка (адрес сайта, пароль панели, ключ для CI)
  python3 server.py password        — сменить пароль панели
  python3 server.py deploy-key      — показать ключ для GitHub
"""
import base64
import email.utils
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import socket
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

SERVER_VERSION = "1.1"
HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("TLS_DATA", HERE / "data")).resolve()
SITE = Path(os.environ.get("TLS_SITE", HERE / "site")).resolve()
ADMIN = HERE / "admin"
HOST = os.environ.get("TLS_HOST", "127.0.0.1")
PORT = int(os.environ.get("TLS_PORT", "8787"))

MAX_INSTALLER = 600 * 1024 * 1024
MAX_SIG = 16 * 1024
MAX_IMAGE = 5 * 1024 * 1024
MAX_JSON = 256 * 1024
TOKEN_TTL = 12 * 3600
COOKIE = "tls_session"
IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
VERSION_RE = re.compile(r"^\d{1,4}\.\d{1,4}\.\d{1,6}$")
KINDS = ("normal", "major", "mandatory")
PLACES = ("app", "site")
SLOTS = ("1", "2")
# Открытый ключ подписи обновлений (из src-tauri/tauri.conf.json). Сервер проверяет им каждый
# установщик перед выпуском — неподписанный или подменённый файл выпустить нельзя.
UPDATER_PUBKEY = os.environ.get("TLS_UPDATER_PUBKEY") or "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDAzN0EzRkNDQzdFMzNDOEIKUldTTFBPUEh6RDk2QXphYVBTUTlKTXBHYUs2WlUva3JrbFlodTBaM3IxQUxCR2JGajZYQXh0UlEK"

LOCK = threading.RLock()
TOKENS = {}  # токен сессии -> срок действия
FAILS = {}  # ip -> [неудачных попыток, заблокирован до]
GLOBAL_FAILS = []  # время неудачных входов со всех адресов (защита от перебора с многих IP)
STATS_CACHE = {}  # days -> (время, результат)
IP_HITS = {}  # ip -> [начало окна, запросов] — защита статистики от накрутки

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".woff2": "font/woff2",
}
TEMPLATED = {".html", ".txt", ".xml"}  # подстановка %%SITE%% (адрес сайта)

CSP_SITE = (
    "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; "
    "connect-src 'self'; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; "
    "form-action 'none'; frame-ancestors 'none'"
)
CSP_ADMIN = (
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; "
    "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
)


# ---------------------------------------------------------------- хранилище


def p(*parts):
    return DATA.joinpath(*parts)


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except ValueError:
        # испорченный файл не затираем молча — откладываем копию для разбора
        # (прочие ошибки чтения — нет прав, кончились дескрипторы — не повод трогать данные)
        try:
            os.replace(path, str(path) + ".bad")
        except OSError:
            pass
        return default


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # данные (в т.ч. ключи) — только владельцу
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def append_line(path, rec):
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def config():
    return read_json(p("config.json"), {})


def ads(place):
    d = read_json(p("ads.json" if place == "app" else "site_ads.json"), {})
    for slot in SLOTS:
        d.setdefault(slot, {"enabled": False, "title": "", "text": "", "url": "", "img": "", "alt": ""})
    return d


def save_ads(place, d):
    write_json(p("ads.json" if place == "app" else "site_ads.json"), d)


def releases():
    d = read_json(p("releases.json"), {})
    d.setdefault("current", None)
    d.setdefault("items", [])
    return d


def current_release():
    r = releases()
    return next((x for x in r["items"] if x["version"] == r["current"]), None)


def staging():
    return read_json(p("staging", "staging.json"), {})


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def vkey(v):
    try:
        return tuple(int(x) for x in str(v).split("."))
    except ValueError:
        return (0,)


def public_url():
    return config().get("public_url", "").rstrip("/")


def is_https():
    return public_url().startswith("https://")


def hash_password(pw, salt=None, iters=310_000):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), iters).hex()
    return f"pbkdf2${iters}${salt}${h}"


def check_password(pw, stored):
    try:
        _, iters, salt, h = stored.split("$")
        got = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), int(iters)).hex()
        return hmac.compare_digest(got, h)
    except (ValueError, AttributeError):
        return False


def version_from_name(name):
    m = re.search(r"(\d+\.\d+\.\d+)", name or "")
    return m.group(1) if m else ""


def image_kind(head):
    """Настоящий тип картинки по первым байтам (а не по заявленному Content-Type)."""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


# ---------------------------------------------------------------- подпись обновлений (minisign / Ed25519)

_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_I = pow(2, (_P - 1) // 4, _P)


def _xrecover(y):
    xx = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P)
    x = pow(xx, (_P + 3) // 8, _P)
    if (x * x - xx) % _P:
        x = x * _I % _P
    if (x * x - xx) % _P:
        return None
    return _P - x if x % 2 else x


_BY = 4 * pow(5, _P - 2, _P) % _P
_BX = _xrecover(_BY)
_BASE = (_BX, _BY, 1, _BX * _BY % _P)


def _padd(a, b):
    x1, y1, z1, t1 = a
    x2, y2, z2, t2 = b
    A = (y1 - x1) * (y2 - x2) % _P
    B = (y1 + x1) * (y2 + x2) % _P
    C = 2 * t1 * t2 * _D % _P
    Dd = 2 * z1 * z2 % _P
    E, F, G, H = B - A, Dd - C, Dd + C, B + A
    return (E * F % _P, G * H % _P, F * G % _P, E * H % _P)


def _pmul(s, pt):
    q = (0, 1, 1, 0)
    while s:
        if s & 1:
            q = _padd(q, pt)
        pt = _padd(pt, pt)
        s >>= 1
    return q


def _pdecode(b):
    if len(b) != 32:
        return None
    y = int.from_bytes(b, "little")
    sign, y = y >> 255, y & ((1 << 255) - 1)
    if y >= _P:
        return None
    x = _xrecover(y)
    if x is None or (x == 0 and sign):
        return None
    if (x & 1) != sign:
        x = _P - x
    return (x, y, 1, x * y % _P)


def ed25519_verify(pub, msg, sig):
    """Проверка подписи Ed25519 (RFC 8032) — только стандартная библиотека."""
    if len(sig) != 64:
        return False
    A, R = _pdecode(pub), _pdecode(sig[:32])
    if A is None or R is None:
        return False
    s = int.from_bytes(sig[32:], "little")
    if s >= _L:
        return False
    h = int.from_bytes(hashlib.sha512(sig[:32] + pub + msg).digest(), "little") % _L
    left, right = _pmul(s, _BASE), _padd(R, _pmul(h, A))
    return (left[0] * right[2] - right[0] * left[2]) % _P == 0 and (left[1] * right[2] - right[1] * left[2]) % _P == 0


def verify_update_signature(sig_text, path):
    """Подпись .sig от `tauri signer` (minisign) подходит к файлу и к ключу программы?"""
    try:
        pk_lines = [x for x in base64.b64decode(UPDATER_PUBKEY).decode().splitlines() if x and not x.startswith("untrusted comment")]
        pk = base64.b64decode(pk_lines[0])
        lines = base64.b64decode(sig_text).decode().splitlines()
        sig = base64.b64decode(lines[1])
    except (ValueError, IndexError, UnicodeDecodeError):
        return False
    if len(pk) != 42 or pk[:2] != b"Ed" or len(sig) != 74 or sig[2:10] != pk[2:10]:
        return False
    if sig[:2] == b"ED":  # подпись хэша BLAKE2b-512 файла (так подписывает Tauri)
        h = hashlib.blake2b(digest_size=64)
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        msg = h.digest()
    elif sig[:2] == b"Ed":
        msg = Path(path).read_bytes()
    else:
        return False
    return ed25519_verify(pk[10:42], msg, sig[10:74])


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- статистика


SEEN = set()  # хэши устройств, уже запускавших программу
SEEN_LOADED = False


def load_seen():
    global SEEN_LOADED
    if SEEN_LOADED:
        return
    try:
        with open(p("hits.jsonl"), "r", encoding="utf-8") as f:
            for line in f:
                try:
                    SEEN.add(json.loads(line).get("d"))
                except ValueError:
                    continue
    except FileNotFoundError:
        pass
    SEEN_LOADED = True


def ip_key(ip):
    """IPv6 — по сети /64 (у одного абонента их миллионы адресов), IPv4 — целиком."""
    if ":" in ip:
        try:
            return socket.inet_pton(socket.AF_INET6, ip)[:8].hex()
        except OSError:
            return ip
    return ip


NEW_DEVICES = []  # время регистрации новых устройств — защита от раздувания статистики


def allow_count(ip, limit):
    """Не больше `limit` учтённых событий с одного IP в час (IP хранится только в памяти)."""
    now = time.time()
    ip = ip_key(ip)
    start, n = IP_HITS.get(ip, [now, 0])
    if now - start > 3600:
        start, n = now, 0
    IP_HITS[ip] = [start, n + 1]
    if len(IP_HITS) > 100_000:
        IP_HITS.clear()
    return n < limit


def record_launch(device, version):
    if not re.fullmatch(r"[A-Za-z0-9_\-]{8,80}", device or "") or not re.fullmatch(r"[0-9A-Za-z.\-]{1,20}", version or ""):
        return
    salt = config().get("salt", "")
    d = hashlib.sha256((salt + device).encode()).hexdigest()[:16]
    with LOCK:
        load_seen()
        new = d not in SEEN
        if new:
            now = time.time()
            NEW_DEVICES[:] = [t for t in NEW_DEVICES if now - t < 3600]
            if len(NEW_DEVICES) >= 3000:  # больше 3000 «новых установок» в час — это накрутка
                return
            NEW_DEVICES.append(now)
        SEEN.add(d)
        append_line(p("hits.jsonl"), {"t": int(time.time()), "d": d, "v": version, "n": 1 if new else 0})


def record_visit(ip):
    # ключ меняется каждый день: по хэшу нельзя восстановить IP или связать дни между собой
    day = datetime.now().strftime("%Y-%m-%d")
    salt = config().get("salt", "")
    h = hashlib.sha256(f"{salt}|{day}|{ip_key(ip)}".encode()).hexdigest()[:16]
    with LOCK:
        append_line(p("visits.jsonl"), {"t": int(time.time()), "h": h})


def record_download(version):
    with LOCK:
        d = read_json(p("downloads.json"), {})
        d[version] = int(d.get(version, 0)) + 1
        write_json(p("downloads.json"), d)


def day_of(ts):
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def read_lines(name):
    try:
        with open(p(name), "r", encoding="utf-8") as f:
            for line in f:
                try:
                    yield json.loads(line)
                except ValueError:
                    continue
    except FileNotFoundError:
        return


def stats(days=30):
    days = max(1, min(int(days), 365))
    hit = STATS_CACHE.get(days)
    if hit and time.time() - hit[0] < 30:
        return hit[1]
    res = _stats(days)
    STATS_CACHE[days] = (time.time(), res)
    return res


def _stats(days):
    now = time.time()
    since = now - days * 86400
    today = datetime.now().strftime("%Y-%m-%d")
    total, new_total = 0, 0
    devices, today_dev, by_version, by_day = set(), set(), {}, {}
    for r in read_lines("hits.jsonl"):
        total += 1
        devices.add(r.get("d"))
        new_total += r.get("n", 0)
        day = day_of(r.get("t", 0))
        if day == today:
            today_dev.add(r.get("d"))
        if r.get("t", 0) >= since:
            b = by_day.setdefault(day, {"launches": 0, "devices": set(), "new": 0})
            b["launches"] += 1
            b["devices"].add(r.get("d"))
            b["new"] += r.get("n", 0)
            by_version.setdefault(r.get("v", "?"), set()).add(r.get("d"))
    visits_day, visits_total, visitors_today = {}, 0, set()
    for r in read_lines("visits.jsonl"):
        visits_total += 1
        day = day_of(r.get("t", 0))
        if day == today:
            visitors_today.add(r.get("h"))
        if r.get("t", 0) >= since:
            visits_day.setdefault(day, set()).add(r.get("h"))
    series = []
    for i in range(days - 1, -1, -1):
        day = datetime.fromtimestamp(now - i * 86400).strftime("%Y-%m-%d")
        b = by_day.get(day)
        series.append(
            {
                "day": day,
                "launches": b["launches"] if b else 0,
                "devices": len(b["devices"]) if b else 0,
                "new": b["new"] if b else 0,
                "visitors": len(visits_day.get(day, ())),
            }
        )
    versions = sorted(((v, len(s)) for v, s in by_version.items()), key=lambda x: vkey(x[0]), reverse=True)
    dls = read_json(p("downloads.json"), {})
    return {
        "launches": total,
        "devices": len(devices),
        "new": new_total,
        "today": len(today_dev),
        "visitors_today": len(visitors_today),
        "visitors_period": sum(x["visitors"] for x in series),
        "visits_total": visits_total,
        "downloads": sum(int(v) for v in dls.values()),
        "downloads_by_version": sorted(([k, int(v)] for k, v in dls.items()), key=lambda x: vkey(x[0]), reverse=True),
        "days": series,
        "versions": [{"version": v, "devices": n} for v, n in versions],
    }


# ---------------------------------------------------------------- обновления и реклама


def manifest():
    """latest.json в формате обновлятора Tauri."""
    cur = current_release()
    if not cur:
        return None
    url = f"{public_url()}/downloads/{quote(cur['version'])}/{quote(cur['file'])}"
    plat = {"signature": cur["signature"], "url": url}
    return {
        "version": cur["version"],
        "notes": cur.get("notes", ""),
        "pub_date": cur["date"],
        "platforms": {"windows-x86_64": plat, "windows-x86_64-nsis": plat},
    }


def public_ads(place):
    """Только включённые и непустые блоки, картинки — полными адресами."""
    out = {}
    base = public_url() if place == "app" else ""
    for slot, a in ads(place).items():
        if slot not in SLOTS or not a.get("enabled"):
            continue
        title, text, img = a.get("title", "").strip(), a.get("text", "").strip(), a.get("img", "")
        if not (title or text or img):
            continue
        out[slot] = {
            "title": title,
            "text": text,
            "url": a.get("url", ""),
            "img": f"{base}/media/{quote(img)}" if img else "",
            "alt": a.get("alt", "") or title or "Реклама",
        }
    return out


def app_config(client_version=""):
    out = {"ads": public_ads("app"), "update": None, "server": SERVER_VERSION}
    cur = current_release()
    if cur:
        kind = cur.get("kind", "normal")
        # обязательное обновление не «теряется», если после него вышла обычная версия
        if client_version and kind != "mandatory":
            cv = vkey(client_version)
            if any(x.get("kind") == "mandatory" and cv < vkey(x["version"]) <= vkey(cur["version"]) for x in releases()["items"]):
                kind = "mandatory"
        out["update"] = {"version": cur["version"], "kind": kind, "notes": cur.get("notes", "")}
    return out


def site_info():
    cur = current_release()
    out = {"version": None, "ads": public_ads("site")}
    if cur:
        out.update(
            {
                "version": cur["version"],
                "file": cur["file"],
                "mb": max(1, round(cur.get("size", 0) / 1024 / 1024)),
                "date": cur["date"],
            }
        )
    return out


def do_release(version, kind, notes):
    if kind not in KINDS:
        kind = "normal"
    with LOCK:
        st = staging()
        f = p("staging", st.get("file", "-"))
        if not st.get("file") or not f.is_file():
            raise ApiError(400, "Сначала загрузите установщик (.exe)")
        if not st.get("signature"):
            raise ApiError(400, "Нет файла подписи .sig — без него программы не примут обновление")
        if st.get("sig_sha256") != st.get("sha256") or sha256_file(f) != st.get("sha256"):
            raise ApiError(409, "Файлы изменились во время выпуска — загрузите установщик и подпись заново")
        if not verify_update_signature(st["signature"], f):
            raise ApiError(400, "Подпись .sig не подходит к установщику или ключу программы — выпуск остановлен")
        version = (version or st.get("version") or "").strip()
        if not VERSION_RE.match(version):
            raise ApiError(400, "Версия должна быть вида 3.0.1")
        r = releases()
        if any(x["version"] == version for x in r["items"]):
            raise ApiError(409, f"Версия {version} уже выпускалась — увеличьте номер")
        newest = max((x["version"] for x in r["items"]), key=vkey, default=None)
        if newest and vkey(version) <= vkey(newest):
            raise ApiError(400, f"Новая версия должна быть больше {newest}, иначе программы её не увидят")
        dest = p("releases", version)
        dest.mkdir(parents=True, exist_ok=True)
        fname = f"TimelapseStudio_{version}_x64-setup.exe"
        shutil.move(str(p("staging", st["file"])), str(dest / fname))
        item = {
            "version": version,
            "kind": kind,
            "notes": (notes or "").strip()[:4000],
            "date": now_iso(),
            "file": fname,
            "size": (dest / fname).stat().st_size,
            "sha256": st.get("sha256", ""),
            "signature": st["signature"],
        }
        r["items"].insert(0, item)
        r["current"] = version
        write_json(p("releases.json"), r)
        shutil.rmtree(p("staging"), ignore_errors=True)
        return item


# ---------------------------------------------------------------- HTTP


class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


class Handler(BaseHTTPRequestHandler):
    server_version = "TimelapseServer"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = 60  # медленный или зависший клиент не держит поток вечно

    # ---------- служебное
    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, TimeoutError, socket.timeout):
            pass  # клиент ушёл — это не ошибка сервера

    def log_message(self, fmt, *args):
        # без IP и параметров запроса — только метод и путь
        sys.stderr.write("%s %s %s\n" % (self.command, self.path.split("?")[0][:200], args[1] if len(args) > 1 else ""))

    def log_request(self, code="-", size="-"):
        if isinstance(code, int) and code >= 400:
            self.log_message("", self.requestline, code)

    def ip(self):
        return self.headers.get("X-Real-IP") or self.client_address[0]

    def security_headers(self, admin=False):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer" if admin else "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        if is_https():
            self.send_header("Strict-Transport-Security", "max-age=31536000")

    def send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        extra = dict(extra or {})
        extra.setdefault("Cache-Control", "no-store")
        if self.close_connection or (code >= 400 and self.command in ("POST", "PUT", "DELETE")):
            # тело запроса могло остаться непрочитанным — закрываем соединение, чтобы его
            # остаток не был принят за следующий запрос
            extra["Connection"] = "close"
            self.close_connection = True
        for k, v in extra.items():
            if isinstance(v, list):
                for item in v:
                    self.send_header(k, item)
            else:
                self.send_header(k, v)
        self.security_headers(admin=self.path.startswith(("/api/", "/admin")))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_file(self, path, ctype, cache="public, max-age=3600", download_name=None, csp=None, template=False, admin=False, status=200):
        st = path.stat()
        mtime = email.utils.formatdate(st.st_mtime, usegmt=True)
        etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
        if template:
            data = path.read_bytes().replace(b"%%SITE%%", public_url().encode())
            size = len(data)
        else:
            data, size = None, st.st_size
        if status == 200 and not template and (self.headers.get("If-None-Match") == etag):
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self.security_headers(admin)
            self.end_headers()
            return
        start, end = 0, size - 1
        rng = self.headers.get("Range", "")
        partial = False
        if rng and data is None and status == 200:
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
            if not m or (not m.group(1) and not m.group(2)):
                return self.send(416, b"", "text/plain", {"Content-Range": f"bytes */{size}"})
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:  # последние N байт
                start = max(0, size - int(m.group(2)))
            if start > end or start >= size:
                return self.send(416, b"", "text/plain", {"Content-Range": f"bytes */{size}"})
            partial = True
        self.send_response(206 if partial else status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", cache)
        self.send_header("Accept-Ranges", "bytes")
        if not template:
            self.send_header("ETag", etag)
            self.send_header("Last-Modified", mtime)
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download_name:
            self.send_header("Content-Disposition", f"attachment; filename=\"{download_name}\"")
        if csp:
            self.send_header("Content-Security-Policy", csp)
        self.security_headers(admin)
        self.end_headers()
        if self.command == "HEAD":
            return
        if data is not None:
            self.wfile.write(data)
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def length(self):
        v = (self.headers.get("Content-Length") or "0").strip()
        if not re.fullmatch(r"\d{1,12}", v):
            raise ApiError(400, "Неверная длина запроса")
        return int(v)

    def body_json(self):
        n = self.length()
        if n > MAX_JSON:
            raise ApiError(413, "Слишком большой запрос")
        try:
            d = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            raise ApiError(400, "Неверный JSON")
        if not isinstance(d, dict):
            raise ApiError(400, "Неверный JSON")
        return d

    def body_to_file(self, dest, limit, check=None):
        n = self.length()
        if n <= 0:
            raise ApiError(400, "Пустой файл")
        if n > limit:
            raise ApiError(413, f"Файл больше {limit // (1024 * 1024)} МБ")
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + f".{secrets.token_hex(4)}.part")
        h = hashlib.sha256()
        left = n
        first = b""
        try:
            with open(tmp, "wb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(1 << 20, left))
                    if not chunk:
                        break
                    if not first:
                        first = chunk[:16]
                    h.update(chunk)
                    f.write(chunk)
                    left -= len(chunk)
            if left:
                raise ApiError(400, "Загрузка прервалась")
            if check:
                check(first)
            os.replace(tmp, dest)
        finally:
            if tmp.exists():
                tmp.unlink()
        return n, h.hexdigest()

    def session(self):
        raw = self.headers.get("Cookie", "")
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                exp = TOKENS.get(v)
                if exp and exp > time.time():
                    return v
        return None

    def csrf_ok(self):
        # браузер не даст чужому сайту поставить этот заголовок без разрешения CORS (а его нет)
        if self.headers.get("X-TLS-CSRF") != "1":
            return False
        origin = self.headers.get("Origin")
        if origin:
            host = self.headers.get("Host", "")
            return urlparse(origin).netloc == host
        return True

    def authed(self, allow_deploy=False):
        if allow_deploy:
            key = config().get("deploy_key", "")
            got = self.headers.get("X-Deploy-Key", "")
            if key and got and hmac.compare_digest(key.encode(), got.encode("latin-1", "replace")):
                return "deploy"
        if self.session():
            if self.command not in ("GET", "HEAD") and not self.csrf_ok():
                raise ApiError(403, "Запрос отклонён (защита от подделки)")
            return "panel"
        raise ApiError(401, "Нужно войти в панель")

    def cookie(self, value, max_age):
        flags = "HttpOnly; SameSite=Strict; Path=/"
        if is_https():
            flags += "; Secure"
        return f"{COOKIE}={value}; Max-Age={max_age}; {flags}"

    # ---------- маршруты
    def do_HEAD(self):
        self.route("GET")

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def do_OPTIONS(self):
        self.send(405, {"error": "Метод не поддерживается"}, extra={"Allow": "GET, HEAD, POST, PUT, DELETE"})

    def route(self, method):
        u = urlparse(self.path)
        path = u.path
        if path != "/" and path.endswith("/"):
            path = path.rstrip("/")
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if len(self.path) > 2048:
                raise ApiError(414, "Слишком длинный адрес")
            if self.headers.get("Transfer-Encoding"):
                # тела «кусками» не принимаем: иначе остаток был бы прочитан как новый запрос
                self.close_connection = True
                raise ApiError(411, "Нужен заголовок Content-Length")
            if method == "GET" and (self.headers.get("Content-Length") or "0") != "0":
                self.close_connection = True
            h = ROUTES.get((method, path))
            if h:
                return h(self, q)
            for (m, prefix), fn in PREFIX_ROUTES:
                if m == method and path.startswith(prefix):
                    return fn(self, path[len(prefix):], q)
            if method == "GET":
                return r_site(self, path, q)
            raise ApiError(405 if any(k[1] == path for k in ROUTES) else 404, "Не найдено")
        except ApiError as e:
            if path.startswith("/api/"):
                self.send(e.code, {"error": e.msg})
            elif e.code == 404 and method == "GET":
                self.not_found()
            else:
                self.send(e.code, e.msg, "text/plain; charset=utf-8")
        except (BrokenPipeError, ConnectionResetError, TimeoutError, socket.timeout):
            self.close_connection = True
        except Exception as e:  # noqa: BLE001 — сервер не должен падать от одного запроса
            sys.stderr.write(f"ERROR {method} {path}: {e!r}\n")
            try:
                self.send(500, {"error": "Внутренняя ошибка сервера"})
            except OSError:
                pass

    def not_found(self):
        f = SITE / "404.html"
        if f.is_file():
            return self.send_file(f, MIME[".html"], cache="no-cache", csp=CSP_SITE, template=True, status=404)
        self.send(404, "Не найдено", "text/plain; charset=utf-8")


# ---------- сайт


def r_site(h, path, q):
    if path == "/":
        rel = "index.html"
    elif path in ("/privacy", "/license"):
        rel = path[1:] + ".html"
    else:
        rel = path.lstrip("/")
    # только безопасные имена: никаких «..», скрытых файлов и шаблонов
    if not re.fullmatch(r"(assets/)?[A-Za-z0-9][A-Za-z0-9_\-]*\.[a-z0-9]{2,12}", rel) or rel == "404.html":
        raise ApiError(404, "Не найдено")
    f = (SITE / rel).resolve()
    if SITE not in f.parents or not f.is_file():
        raise ApiError(404, "Не найдено")
    ext = f.suffix.lower()
    ctype = MIME.get(ext)
    if not ctype:
        raise ApiError(404, "Не найдено")
    html = ext == ".html"
    cache = "no-cache" if html or ext in (".txt", ".xml", ".webmanifest") else "public, max-age=86400"
    h.send_file(f, ctype, cache=cache, csp=CSP_SITE if html else None, template=ext in TEMPLATED)


def r_site_info(h, q):
    if h.command == "GET" and allow_count(h.ip(), 120):
        record_visit(h.ip())
    h.send(200, site_info())


# ---------- программа


def r_health(h, q):
    h.send(200, {"ok": True, "server": SERVER_VERSION})


def r_latest(h, q):
    m = manifest()
    if not m:
        # 404, а не 204: тогда программа спросит запасной источник (GitHub Releases)
        raise ApiError(404, "Версия ещё не выпущена")
    h.send(200, m)


def r_app_config(h, q):
    if h.command == "GET" and q.get("id") and allow_count(h.ip(), 30):
        record_launch(q.get("id", ""), q.get("v", ""))
    v = q.get("v", "")
    h.send(200, app_config(v if VERSION_RE.match(v) else ""))


def r_download(h, rest, q):
    rest = rest.strip("/")
    r = releases()
    if rest in ("", "latest"):
        cur = current_release()
        if not cur:
            raise ApiError(404, "Установщик ещё не выпущен")
        loc = f"/downloads/{quote(cur['version'])}/{quote(cur['file'])}"
        return h.send(302, b"", extra={"Location": loc})
    parts = rest.split("/")
    if len(parts) != 2:
        raise ApiError(404, "Не найдено")
    ver, name = parts
    item = next((x for x in r["items"] if x["version"] == ver and x["file"] == name), None)
    f = p("releases", ver, name) if item else None
    if not f or not f.is_file():
        raise ApiError(404, "Файл не найден")
    rng = h.headers.get("Range", "")
    if h.command == "GET" and (not rng or rng.startswith("bytes=0-")) and allow_count("dl:" + h.ip(), 20):
        record_download(ver)
    h.send_file(f, "application/octet-stream", cache="public, max-age=86400, immutable", download_name=name)


def r_media(h, rest, q):
    name = rest.strip("/")
    if not re.fullmatch(r"(app|site)\d-[a-f0-9]{12}\.(png|jpg|webp)", name):
        raise ApiError(404, "Не найдено")
    f = p("media", name)
    if not f.is_file():
        raise ApiError(404, "Не найдено")
    ext = name.rsplit(".", 1)[1]
    h.send_file(f, {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}[ext], cache="public, max-age=31536000, immutable")


# ---------- панель: страница и вход


def r_admin(h, rest, q):
    rest = rest.strip("/")
    files = {"": ("panel.html", MIME[".html"]), "panel.css": ("panel.css", MIME[".css"]), "panel.js": ("panel.js", MIME[".js"])}
    if rest not in files:
        raise ApiError(404, "Не найдено")
    name, ctype = files[rest]
    h.send_file(ADMIN / name, ctype, cache="no-store", csp=CSP_ADMIN if name.endswith(".html") else None, admin=True)


def r_login(h, q):
    ip = ip_key(h.ip())
    n, until = FAILS.get(ip, [0, 0])
    if until > time.time():
        raise ApiError(429, f"Слишком много попыток. Подождите {int(until - time.time()) + 1} с")
    now = time.time()
    GLOBAL_FAILS[:] = [t for t in GLOBAL_FAILS if now - t < 60]
    if len(GLOBAL_FAILS) >= 30:  # перебор с множества адресов — притормаживаем всех
        raise ApiError(429, "Слишком много попыток входа. Подождите минуту")
    if h.headers.get("X-TLS-CSRF") != "1":
        raise ApiError(403, "Запрос отклонён")
    body = h.body_json()
    stored = config().get("password", "")
    if not stored:
        raise ApiError(503, "Пароль панели не задан: выполните на сервере  python3 server.py password")
    if not check_password(str(body.get("password", ""))[:256], stored):
        n += 1
        FAILS[ip] = [n, time.time() + 60 * min(2 ** (n - 5), 60) if n >= 5 else 0]
        GLOBAL_FAILS.append(time.time())
        if len(FAILS) > 10_000:  # выбрасываем самые старые записи, а не все блокировки сразу
            for k in sorted(FAILS, key=lambda k: FAILS[k][1])[:2000]:
                FAILS.pop(k, None)
        time.sleep(0.8)
        raise ApiError(403, "Неверный пароль")
    FAILS.pop(ip, None)
    for t, exp in list(TOKENS.items()):
        if exp < time.time():
            TOKENS.pop(t, None)
    tok = secrets.token_urlsafe(32)
    TOKENS[tok] = time.time() + TOKEN_TTL
    h.send(200, {"ok": True}, extra={"Set-Cookie": h.cookie(tok, TOKEN_TTL)})


def r_logout(h, q):
    t = h.session()
    if t:
        TOKENS.pop(t, None)
    h.send(200, {"ok": True}, extra={"Set-Cookie": h.cookie("", 0)})


def r_session(h, q):
    h.send(200, {"authed": bool(h.session()), "server": SERVER_VERSION})


# ---------- панель: данные


def ad_view(place):
    a = ads(place)
    for slot in a.values():
        slot["img_url"] = f"/media/{quote(slot['img'])}" if slot.get("img") else ""
    return a


def r_state(h, q):
    h.authed()
    r = releases()
    s = stats(30)
    cfg = config()
    h.send(
        200,
        {
            "server": SERVER_VERSION,
            "public_url": public_url(),
            "current": r["current"],
            "releases": r["items"],
            "staging": staging(),
            "ads": {"app": ad_view("app"), "site": ad_view("site")},
            "stats": {k: s[k] for k in ("launches", "devices", "new", "today", "visitors_today", "downloads")},
            "has_deploy_key": bool(cfg.get("deploy_key")),
        },
    )


def r_upload(h, q):
    h.authed(allow_deploy=True)
    kind = q.get("kind", "")
    name = os.path.basename(q.get("name", "") or h.headers.get("X-File-Name", ""))[:200]
    if kind == "installer":
        if not name.lower().endswith(".exe"):
            raise ApiError(400, "Нужен установщик .exe")

        def is_exe(head):
            if head[:2] != b"MZ":
                raise ApiError(400, "Это не программа Windows (.exe)")

        # приём файла — без общей блокировки: медленная загрузка не тормозит сайт и программы
        tmp = p("staging", f"upload-{secrets.token_hex(6)}.exe")
        size, sha = h.body_to_file(tmp, MAX_INSTALLER, is_exe)
        with LOCK:
            os.replace(tmp, p("staging", "setup.exe"))
            # новый установщик всегда сбрасывает подпись: она относилась к другому файлу
            st = {"file": "setup.exe", "name": name, "size": size, "sha256": sha, "uploaded": now_iso(), "version": version_from_name(name)}
            write_json(p("staging", "staging.json"), st)
    elif kind == "signature":
        n = h.length()
        if n <= 0 or n > MAX_SIG:
            raise ApiError(400, "Файл подписи .sig не похож на настоящий")
        sig = h.rfile.read(n).decode("utf-8", "replace").strip()
        if not re.fullmatch(r"[A-Za-z0-9+/=\s]+", sig):
            raise ApiError(400, "Файл подписи .sig повреждён")
        with LOCK:
            st = staging()
            f = p("staging", st.get("file", "-"))
            if not st.get("file") or not f.is_file():
                raise ApiError(400, "Сначала загрузите установщик .exe, потом его подпись .sig")
            for_name = name[:-4] if name.lower().endswith(".sig") else name
            if for_name != st.get("name"):
                raise ApiError(400, f"Подпись от другого файла: {for_name}, а установщик — {st.get('name')}")
            if not verify_update_signature(sig, f):
                raise ApiError(400, "Подпись не подходит к этому установщику или к ключу программы")
            st.update({"signature": sig, "sig_for": for_name, "sig_sha256": st.get("sha256"), "sig_uploaded": now_iso()})
            write_json(p("staging", "staging.json"), st)
    else:
        raise ApiError(400, "kind = installer | signature")
    h.send(200, {"ok": True, "staging": st})


def r_staging_clear(h, q):
    h.authed()
    with LOCK:
        shutil.rmtree(p("staging"), ignore_errors=True)
    h.send(200, {"ok": True})


def r_release(h, q):
    h.authed()
    b = h.body_json()
    item = do_release(str(b.get("version", "")), str(b.get("kind", "normal")), str(b.get("notes", "")))
    h.send(200, {"ok": True, "release": item})


def r_rollback(h, q):
    h.authed()
    v = str(h.body_json().get("version", ""))
    with LOCK:
        r = releases()
        if not any(x["version"] == v for x in r["items"]):
            raise ApiError(404, "Нет такой версии")
        if not p("releases", v).is_dir():
            raise ApiError(410, "Файл этой версии удалён")
        r["current"] = v
        write_json(p("releases.json"), r)
    h.send(200, {"ok": True, "current": v})


def r_release_delete(h, q):
    h.authed()
    v = q.get("version", "")
    with LOCK:
        r = releases()
        if v == r["current"]:
            raise ApiError(400, "Текущую версию удалить нельзя — сначала выпустите или откатите другую")
        if not VERSION_RE.match(v) or not any(x["version"] == v for x in r["items"]):
            raise ApiError(404, "Нет такой версии")
        r["items"] = [x for x in r["items"] if x["version"] != v]
        write_json(p("releases.json"), r)
        shutil.rmtree(p("releases", v), ignore_errors=True)
    h.send(200, {"ok": True})


def place_slot(q_or_b):
    place, slot = str(q_or_b.get("place", "app")), str(q_or_b.get("slot", ""))
    if place not in PLACES or slot not in SLOTS:
        raise ApiError(400, "Блок: place = app | site, slot = 1 | 2")
    return place, slot


def r_ad(h, q):
    h.authed()
    b = h.body_json()
    place, slot = place_slot(b)
    url = str(b.get("url", "")).strip()
    if url and (len(url) > 500 or not re.fullmatch(r"https://[^\s<>\"'`\\]+", url)):
        raise ApiError(400, "Ссылка должна начинаться с https:// и не содержать пробелов")
    with LOCK:
        a = ads(place)
        s = a[slot]
        s["enabled"] = bool(b.get("enabled"))
        s["title"] = str(b.get("title", "")).strip()[:90]
        s["text"] = str(b.get("text", "")).strip()[:240]
        s["url"] = url
        s["alt"] = str(b.get("alt", "")).strip()[:120]
        s["updated"] = now_iso()
        save_ads(place, a)
    h.send(200, {"ok": True, "ad": s})


def r_ad_image(h, q):
    h.authed()
    place, slot = place_slot(q)
    found = {}

    def check(head):
        k = image_kind(head)
        if not k:
            raise ApiError(400, "Картинка PNG, JPG или WEBP")
        found["ext"] = k

    tmp_name = f"{place}{slot}-{secrets.token_hex(6)}"
    tmp = p("media", tmp_name + ".upload")
    h.body_to_file(tmp, MAX_IMAGE, check)
    name = f"{tmp_name}.{found['ext']}"
    os.replace(tmp, p("media", name))
    with LOCK:
        a = ads(place)
        old = a[slot].get("img")
        a[slot]["img"] = name
        a[slot]["updated"] = now_iso()
        save_ads(place, a)
        if old and old != name:
            p("media", os.path.basename(old)).unlink(missing_ok=True)
    h.send(200, {"ok": True, "img": name, "img_url": f"/media/{name}"})


def r_ad_image_delete(h, q):
    h.authed()
    place, slot = place_slot(q)
    with LOCK:
        a = ads(place)
        old = a[slot].get("img")
        a[slot]["img"] = ""
        save_ads(place, a)
        if old:
            p("media", os.path.basename(old)).unlink(missing_ok=True)
    h.send(200, {"ok": True})


def r_stats(h, q):
    h.authed()
    try:
        days = int(q.get("days", "30") or 30)
    except ValueError:
        days = 30
    h.send(200, stats(days))


def r_password(h, q):
    h.authed()
    b = h.body_json()
    cfg = config()
    if not check_password(str(b.get("old", ""))[:256], cfg.get("password", "")):
        time.sleep(0.8)
        raise ApiError(403, "Текущий пароль неверный")
    new = str(b.get("new", ""))
    if len(new) < 10 or len(new) > 256:
        raise ApiError(400, "Новый пароль — от 10 символов")
    with LOCK:
        cfg["password"] = hash_password(new)
        write_json(p("config.json"), cfg)
    TOKENS.clear()  # все сессии (и чужие) завершаются
    h.send(200, {"ok": True}, extra={"Set-Cookie": h.cookie("", 0)})


def r_deploy_key(h, q):
    h.authed()
    with LOCK:
        cfg = config()
        cfg["deploy_key"] = secrets.token_urlsafe(32)
        write_json(p("config.json"), cfg)
    h.send(200, {"deploy_key": cfg["deploy_key"]})


ROUTES = {
    ("GET", "/health"): r_health,
    ("GET", "/updates/latest.json"): r_latest,
    ("GET", "/downloads"): lambda h, q: r_download(h, "", q),
    ("GET", "/admin"): lambda h, q: r_admin(h, "", q),
    ("GET", "/api/app/config"): r_app_config,
    ("GET", "/api/site"): r_site_info,
    ("GET", "/api/session"): r_session,
    ("POST", "/api/login"): r_login,
    ("POST", "/api/logout"): r_logout,
    ("GET", "/api/state"): r_state,
    ("PUT", "/api/upload"): r_upload,
    ("DELETE", "/api/staging"): r_staging_clear,
    ("POST", "/api/release"): r_release,
    ("POST", "/api/rollback"): r_rollback,
    ("DELETE", "/api/release"): r_release_delete,
    ("POST", "/api/ad"): r_ad,
    ("PUT", "/api/ad-image"): r_ad_image,
    ("DELETE", "/api/ad-image"): r_ad_image_delete,
    ("GET", "/api/stats"): r_stats,
    ("POST", "/api/password"): r_password,
    ("POST", "/api/deploy-key"): r_deploy_key,
}
PREFIX_ROUTES = [
    (("GET", "/downloads/"), r_download),
    (("GET", "/media/"), r_media),
    (("GET", "/admin/"), r_admin),
]


# ---------------------------------------------------------------- команды


def fix_owner(path):
    """Команду запустили от root — файл остаётся у владельца папки данных (службы)."""
    try:
        st = os.stat(DATA)
        if os.geteuid() == 0 and st.st_uid != 0:
            os.chown(path, st.st_uid, st.st_gid)
    except (OSError, AttributeError):
        pass


def cmd_init(url):
    DATA.mkdir(parents=True, exist_ok=True)
    cfg = config()
    if url:
        if not re.fullmatch(r"https://[A-Za-z0-9.\-]+(:\d+)?", url.rstrip("/")):
            sys.exit("Адрес должен быть вида https://домен")
        cfg["public_url"] = url.rstrip("/")
    cfg.setdefault("salt", secrets.token_hex(16))
    cfg.setdefault("deploy_key", secrets.token_urlsafe(32))
    write_json(p("config.json"), cfg)
    fix_owner(p("config.json"))
    if not cfg.get("password"):
        cmd_password()
    print(f"Готово. Данные: {DATA}")


def cmd_password():
    pw = os.environ.get("TLS_PANEL_PASSWORD") or ""
    while len(pw) < 10:
        pw = getpass.getpass("Пароль панели (минимум 10 символов): ")
        if len(pw) < 10:
            print("Слишком короткий")
            continue
        if getpass.getpass("Ещё раз: ") != pw:
            print("Пароли не совпали")
            pw = ""
    cfg = config()
    cfg["password"] = hash_password(pw)
    write_json(p("config.json"), cfg)
    fix_owner(p("config.json"))
    print("Пароль панели сохранён.")


def main():
    args = sys.argv[1:]
    if args[:1] == ["init"]:
        return cmd_init(args[1] if len(args) > 1 else "")
    if args[:1] == ["password"]:
        return cmd_password()
    if args[:1] == ["deploy-key"]:
        print(config().get("deploy_key", "(не задан — выполните init)"))
        return
    DATA.mkdir(parents=True, exist_ok=True)
    if not config().get("public_url"):
        print("Внимание: адрес сайта не задан — выполните  python3 server.py init https://ваш-домен", file=sys.stderr)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    srv.request_queue_size = 128
    print(f"Timelapse Studio server {SERVER_VERSION}: http://{HOST}:{PORT}  данные: {DATA}  сайт: {SITE}", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
