#!/usr/bin/env python3
"""Home-box scheduler: heartbeat ping plus cron routines that wake the Sprite."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from shutil import which
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore[misc, assignment]

DEFAULT_INTERVAL = 7200
DEFAULT_PORT = 8787
DEFAULT_TZ = "America/New_York"
BUSY_RETRY_SECONDS = 300
FIELD_RE = re.compile(r"^(?:\*|\d+)(?:-\d+)?(?:/\d+)?(?:,(?:\*|\d+)(?:-\d+)?(?:/\d+)?)*$")
RANGES = (
    ("minute", 0, 59),
    ("hour", 0, 23),
    ("day-of-month", 1, 31),
    ("month", 1, 12),
    ("day-of-week", 0, 7),
)
ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,47}$")


def log(message: str) -> None:
    print(message, flush=True)


def state_dir() -> str:
    return os.environ.get("PI_PERSONAL_HOME_DIR") or os.getcwd()


def routines_path() -> str:
    return os.path.join(state_dir(), "routines.json")


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if raw.isdigit():
        return int(raw)
    return default


def load_routines() -> list[dict[str, Any]]:
    path = routines_path()
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return []
    except json.JSONDecodeError:
        log("routines.json is not valid JSON; starting empty")
        return []
    items = data.get("routines") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def save_routines(routines: list[dict[str, Any]]) -> None:
    path = routines_path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump({"routines": routines}, handle, indent=2)
        handle.write("\n")
    os.replace(tmp, path)


def validate_cron(expr: str) -> str | None:
    fields = expr.strip().split()
    if len(fields) != 5:
        return "Cron must be 5 fields: minute hour day-of-month month day-of-week."
    for i, (name, minimum, maximum) in enumerate(RANGES):
        error = validate_cron_field(fields[i], minimum, maximum, name)
        if error:
            return error
    return None


def validate_cron_field(expr: str, minimum: int, maximum: int, name: str) -> str | None:
    if not FIELD_RE.match(expr):
        return f"Invalid {name} cron field."
    try:
        expand_cron_field(expr, minimum, maximum)
    except ValueError as error:
        return str(error)
    return None


def expand_cron_field(expr: str, minimum: int, maximum: int) -> set[int]:
    values: set[int] = set()
    for part in expr.split(","):
        range_part, step_raw = (part.split("/", 1) + [None])[:2]
        step = 1 if step_raw is None else int(step_raw)
        if step < 1:
            raise ValueError("Cron step must be a positive integer.")
        if range_part == "*":
            start, end = minimum, maximum
        elif "-" in range_part:
            left, right = range_part.split("-", 1)
            start, end = int(left), int(right)
        else:
            start = end = int(range_part)
        if start < minimum or end > maximum or start > end:
            raise ValueError(f"Cron value out of range ({minimum}-{maximum}).")
        values.update(range(start, end + 1, step))
    return values


def cron_matches(expr: str, when: datetime, tz_name: str = DEFAULT_TZ) -> bool:
    error = validate_cron(expr)
    if error:
        return False
    local = when.astimezone(zone(tz_name))
    fields = expr.strip().split()
    minute, hour, month = expand_cron_field(fields[0], 0, 59), expand_cron_field(fields[1], 0, 23), expand_cron_field(
        fields[3], 1, 12
    )
    if local.minute not in minute or local.hour not in hour or local.month not in month:
        return False
    dom_star = fields[2] == "*"
    dow_star = fields[4] == "*"
    dom = expand_cron_field(fields[2], 1, 31)
    dow = expand_cron_field(fields[4], 0, 7)
    cron_dow = (local.weekday() + 1) % 7  # Sunday = 0
    dow_hit = cron_dow in dow or (cron_dow == 0 and 7 in dow)
    dom_hit = local.day in dom
    if not dom_star and not dow_star:
        return dom_hit or dow_hit
    if not dom_star and not dom_hit:
        return False
    if not dow_star and not dow_hit:
        return False
    return True


def zone(name: str):
    if ZoneInfo is None:
        return timezone.utc
    try:
        return ZoneInfo(name)
    except Exception:
        return timezone.utc


def sprite_base() -> str:
    return os.environ.get("SPRITE_URL", "").strip().rstrip("/")


def heartbeat_secret() -> str:
    return os.environ.get("HEARTBEAT_SECRET", "").strip()


def secrets_equal(provided: str, expected: str) -> bool:
    if len(provided) != len(expected):
        return False
    result = 0
    for left, right in zip(provided.encode("utf-8"), expected.encode("utf-8")):
        result |= left ^ right
    return result == 0


def authorize(handler: BaseHTTPRequestHandler) -> bool:
    expected = heartbeat_secret()
    if not expected:
        handler.send_error(503, "HEARTBEAT_SECRET unset")
        return False
    header = handler.headers.get("Authorization") or ""
    token = header[7:].strip() if header.lower().startswith("bearer ") else handler.headers.get("X-Heartbeat-Secret", "")
    if not secrets_equal(token.strip(), expected):
        handler.send_error(401, "unauthorized")
        return False
    return True


class RoutineHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        log("home-api " + (format % args))

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, "ok", "text/plain")
            return
        if self.path == "/routines":
            if not authorize(self):
                return
            self._send_json(200, {"routines": public_routines(load_routines())})
            return
        self.send_error(404, "not found")

    def do_PUT(self) -> None:  # noqa: N802
        routine_id = routine_id_from_path(self.path)
        if not routine_id:
            self.send_error(404, "not found")
            return
        if not authorize(self):
            return
        try:
            body = json.loads(self._read_body() or "{}")
        except json.JSONDecodeError:
            self.send_error(400, "invalid json")
            return
        if not isinstance(body, dict):
            self.send_error(400, "invalid json")
            return
        body["id"] = routine_id
        error = validate_routine(body)
        if error:
            self.send_error(400, error)
            return
        stored = load_routines()
        existing = next((item for item in stored if item.get("id") == routine_id), {})
        routines = [item for item in stored if item.get("id") != routine_id]
        body["lastFiredAt"] = existing.get("lastFiredAt")
        body["retryAfter"] = existing.get("retryAfter")
        routines.append(body)
        save_routines(routines)
        self._send_json(200, {"ok": True, "routine": public_routine(body)})

    def do_DELETE(self) -> None:  # noqa: N802
        routine_id = routine_id_from_path(self.path)
        if not routine_id:
            self.send_error(404, "not found")
            return
        if not authorize(self):
            return
        remaining = [item for item in load_routines() if item.get("id") != routine_id]
        save_routines(remaining)
        self._send_json(200, {"ok": True, "id": routine_id})

    def _read_body(self) -> str:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            return ""
        return self.rfile.read(length).decode("utf-8")

    def _send(self, status: int, body: str, content_type: str) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, status: int, payload: Any) -> None:
        self._send(status, json.dumps(payload), "application/json")


def routine_id_from_path(path: str) -> str | None:
    match = re.match(r"^/routines/([a-z][a-z0-9-]{0,47})$", path)
    return match.group(1) if match else None


def validate_routine(body: dict[str, Any]) -> str | None:
    routine_id = str(body.get("id") or "")
    if not ID_RE.match(routine_id):
        return "id is invalid"
    if not str(body.get("prompt") or "").strip():
        return "prompt is required"
    cron = str(body.get("cron") or "").strip()
    error = validate_cron(cron)
    if error:
        return error
    mode = body.get("mode") or "silent"
    if mode not in ("always", "silent"):
        return "mode must be always or silent"
    body["cron"] = cron
    body["prompt"] = str(body.get("prompt")).strip()
    body["title"] = str(body.get("title") or routine_id).strip()
    body["timezone"] = str(body.get("timezone") or DEFAULT_TZ).strip()
    body["mode"] = mode
    body["enabled"] = True if "enabled" not in body else bool(body.get("enabled"))
    return None


def public_routine(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item.get("id"),
        "title": item.get("title"),
        "cron": item.get("cron"),
        "timezone": item.get("timezone") or DEFAULT_TZ,
        "prompt": item.get("prompt"),
        "mode": item.get("mode") or "silent",
        "enabled": bool(item.get("enabled", True)),
    }


def public_routines(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [public_routine(item) for item in items]


def http_call(url: str, method: str = "GET", body: bytes | None = None, timeout: int = 30) -> tuple[int, str]:
    request = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except Exception as error:
        return 0, str(error)


def ping_heartbeat() -> None:
    sprite = sprite_base()
    secret = heartbeat_secret()
    if not sprite or not secret:
        log("heartbeat skipped (set SPRITE_URL and HEARTBEAT_SECRET)")
        return
    code, text = http_call(f"{sprite}/heartbeat/{secret}", timeout=600)
    if code == 200:
        log(f"heartbeat {text.strip() or 'ok'}")
    elif code == 0:
        log(f"heartbeat failed ({text})")
    else:
        log(f"heartbeat HTTP {code}")


def pull_catalog() -> None:
    sprite = sprite_base()
    secret = heartbeat_secret()
    if not sprite or not secret:
        return
    code, text = http_call(f"{sprite}/routines/{secret}", timeout=30)
    if code != 200:
        if code:
            log(f"routines pull HTTP {code}")
        return
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        log("routines pull was not JSON")
        return
    incoming = payload.get("routines") if isinstance(payload, dict) else None
    if not isinstance(incoming, list):
        return
    local = {str(item.get("id")): item for item in load_routines()}
    merged: list[dict[str, Any]] = []
    for item in incoming:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        error = validate_routine(item)
        if error:
            continue
        old = local.get(str(item["id"]), {})
        item["lastFiredAt"] = old.get("lastFiredAt")
        item["retryAfter"] = old.get("retryAfter")
        merged.append(item)
    save_routines(merged)
    log(f"routines pull {len(merged)}")


def fire_due_routines(now: datetime | None = None) -> None:
    current = now or datetime.now(timezone.utc)
    routines = load_routines()
    changed = False
    for item in routines:
        if not routine_due(item, current):
            continue
        result = fire_routine(item)
        changed = True
        log(f"routine {item.get('id')} {result}")
    if changed:
        save_routines(routines)


def routine_due(item: dict[str, Any], now: datetime) -> bool:
    if not item.get("enabled", True):
        return False
    retry_after = item.get("retryAfter")
    if isinstance(retry_after, (int, float)) and time.time() < retry_after:
        return False
    cron = str(item.get("cron") or "")
    tz_name = str(item.get("timezone") or DEFAULT_TZ)
    if not cron_matches(cron, now, tz_name):
        return False
    last = item.get("lastFiredAt")
    if isinstance(last, str) and last:
        try:
            last_dt = datetime.fromisoformat(last)
        except ValueError:
            last_dt = None
        if last_dt is not None:
            tzinfo = zone(tz_name)
            if last_dt.astimezone(tzinfo).strftime("%Y%m%d%H%M") == now.astimezone(tzinfo).strftime("%Y%m%d%H%M"):
                return False
    return True


def fire_routine(item: dict[str, Any]) -> str:
    sprite = sprite_base()
    secret = heartbeat_secret()
    if not sprite or not secret:
        return "skipped"
    payload = json.dumps(
        {
            "id": item.get("id"),
            "prompt": item.get("prompt"),
            "mode": item.get("mode") or "silent",
        }
    ).encode("utf-8")
    code, text = http_call(f"{sprite}/routine/{secret}", method="POST", body=payload, timeout=600)
    if code == 200 and text.strip() == "busy":
        item["retryAfter"] = time.time() + BUSY_RETRY_SECONDS
        return "busy"
    if code == 200:
        item["lastFiredAt"] = datetime.now(timezone.utc).isoformat()
        item.pop("retryAfter", None)
        return text.strip() or "ok"
    return f"HTTP {code}" if code else text


def advertise_exit_node() -> None:
    binary = tailscale_bin()
    if not binary:
        log("tailscale missing")
        return
    try:
        subprocess.run([binary, "set", "--advertise-exit-node"], check=False, capture_output=True, timeout=20)
    except Exception as error:
        log(f"tailscale advertise failed ({error})")


def tailscale_bin() -> str | None:
    for candidate in (
        "tailscale",
        "/usr/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ):
        if candidate == "tailscale":
            found = which("tailscale")
            if found:
                return found
            continue
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def tailscale_ipv4() -> str | None:
    binary = tailscale_bin()
    if not binary:
        return None
    try:
        raw = subprocess.check_output([binary, "status", "--json"], timeout=15)
        data = json.loads(raw)
    except Exception:
        return None
    ips = ((data.get("Self") or {}).get("TailscaleIPs")) or []
    for ip in ips:
        if str(ip).startswith("100."):
            return str(ip)
    return str(ips[0]) if ips else None


def bind_host() -> str:
    override = os.environ.get("HOME_DAEMON_BIND", "").strip()
    if override:
        return override
    return tailscale_ipv4() or "127.0.0.1"


def start_http() -> ThreadingHTTPServer | None:
    host = bind_host()
    port = env_int("HOME_DAEMON_PORT", DEFAULT_PORT)
    try:
        server = ThreadingHTTPServer((host, port), RoutineHandler)
    except OSError as error:
        log(f"home api bind {host}:{port} failed ({error})")
        return None
    thread = threading.Thread(target=server.serve_forever, name="home-api", daemon=True)
    thread.start()
    log(f"home api on {host}:{port}")
    return server


def run_daemon() -> None:
    interval = env_int("HEARTBEAT_INTERVAL_SECONDS", DEFAULT_INTERVAL)
    last_heartbeat = 0.0
    server = start_http()
    log("home daemon running")
    while True:
        advertise_exit_node()
        now = time.time()
        if now - last_heartbeat >= interval:
            ping_heartbeat()
            pull_catalog()
            last_heartbeat = now
            if server is None:
                server = start_http()
        fire_due_routines()
        time.sleep(20)


def self_test() -> int:
    monday_8 = datetime(2026, 11, 9, 13, 0, tzinfo=timezone.utc)  # 08:00 America/New_York EST
    monday_9 = datetime(2026, 11, 9, 14, 0, tzinfo=timezone.utc)
    friday_8 = datetime(2026, 11, 13, 13, 0, tzinfo=timezone.utc)
    assert cron_matches("0 8 * * 1", monday_8, DEFAULT_TZ)
    assert not cron_matches("0 8 * * 1", monday_9, DEFAULT_TZ)
    assert cron_matches("0 8 * * 1,5", friday_8, DEFAULT_TZ)
    assert cron_matches("*/15 * * * *", datetime(2026, 11, 9, 15, 15, tzinfo=timezone.utc), DEFAULT_TZ)
    assert not cron_matches("*/15 * * * *", datetime(2026, 11, 9, 15, 16, tzinfo=timezone.utc), DEFAULT_TZ)
    first = datetime(2026, 12, 1, 0, 0, tzinfo=zone(DEFAULT_TZ))  # Tuesday the 1st
    monday = datetime(2026, 11, 9, 0, 0, tzinfo=zone(DEFAULT_TZ))  # Monday, not the 1st
    assert cron_matches("0 0 1 * 1", first, DEFAULT_TZ)
    assert cron_matches("0 0 1 * 1", monday, DEFAULT_TZ)
    assert validate_cron("every monday") is not None
    assert validate_cron("0 8 * * 1") is None
    log("home-daemon self-test ok")
    return 0


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "daemon"
    if command == "self-test":
        return self_test()
    if command == "daemon":
        run_daemon()
        return 0
    log("Usage: home-daemon.py [daemon|self-test]")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
