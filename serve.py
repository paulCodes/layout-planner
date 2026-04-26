#!/usr/bin/env python
"""
Layout Planner -- bidirectional realtime state sync server.

Vanilla Python stdlib only. Serves static files like SimpleHTTPRequestHandler
PLUS three sync endpoints:

  GET  /state    -> { version: int, state: object|null }
  POST /state    -> body { version: int, state: object } -> 200 { version }
                    or 409 with the canonical { version, state } if version
                    didn't match.
  GET  /events   -> SSE stream of state updates. Sends the current snapshot
                    immediately on connect. Heartbeats every 15s.

A background thread watches `current-state.json` for mtime changes so an
external editor (e.g. Claude Code in a terminal) can write the file and have
the change picked up + broadcast to browser clients.

Concurrency model:
  - One `state_lock` (threading.Lock) wraps the entire read-modify-write-
    broadcast critical section. POST /state holds it; the mtime watcher holds
    it. Browsers therefore never see a partial write.
  - `subscribers_lock` guards the SSE subscriber set. Never iterate the set
    while holding only this lock for mutation; we snapshot to a list.
  - `last_written_hash` is a self-write dedup: when the watcher sees a file
    whose hash matches what we just wrote, it knows it's our own write
    echoing back via mtime and skips the broadcast.

Launch:
  python serve.py [--port 8000] [--host 127.0.0.1] [--state current-state.json]

Default: http://127.0.0.1:8000/. The plain `python -m http.server 8000` mode
still works for static-only browsing, just without realtime sync.
"""

import argparse
import hashlib
import json
import os
import queue
import sys
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path

# ---------------------------------------------------------------------------
# Globals -- guarded by the locks below.
# ---------------------------------------------------------------------------
state_lock = threading.Lock()           # guards current_version, current_state, last_written_hash, file writes
current_version = 0                     # server-assigned monotonic version
current_state = None                    # parsed JSON state (the "state" field), or None
last_written_hash = None                # sha1 of the bytes we last wrote -- used by the mtime watcher to skip echoes

subscribers_lock = threading.Lock()     # guards the subscriber set
subscribers = set()                     # set of queue.Queue, one per live SSE client

shutdown_event = threading.Event()      # signaled on Ctrl+C so threads can exit cleanly

STATE_PATH = Path("current-state.json")  # overridden in main()
DOC_ROOT = Path(".").resolve()           # static files served from here


# ---------------------------------------------------------------------------
# State file helpers
# ---------------------------------------------------------------------------
def _read_state_file():
    """Read the state file as bytes + sha1. Returns (bytes, hash) or (None, None) if missing."""
    try:
        with open(STATE_PATH, "rb") as f:
            data = f.read()
        return data, hashlib.sha1(data).hexdigest()
    except FileNotFoundError:
        return None, None


def _atomic_write(payload_bytes):
    """Write payload to STATE_PATH atomically (write tmp + os.replace).

    Returns the sha1 of payload_bytes so the caller can update last_written_hash
    in the same critical section.
    """
    tmp = STATE_PATH.with_suffix(STATE_PATH.suffix + ".tmp")
    with open(tmp, "wb") as f:
        f.write(payload_bytes)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            # fsync can fail on some Windows configs; the os.replace is still atomic.
            pass
    os.replace(tmp, STATE_PATH)
    return hashlib.sha1(payload_bytes).hexdigest()


def _serialize(version, state_obj):
    """Pretty JSON for human-readable file + Claude-friendly diffs."""
    return json.dumps({"version": version, "state": state_obj}, indent=2).encode("utf-8")


def _load_initial_state():
    """Called once at startup. Reads the file if it exists, otherwise initializes."""
    global current_version, current_state, last_written_hash
    data, h = _read_state_file()
    if data is None:
        # File missing -- start at version 0, null state. Don't write the file
        # until something actually changes.
        current_version = 0
        current_state = None
        last_written_hash = None
        return
    try:
        obj = json.loads(data.decode("utf-8"))
        current_version = int(obj.get("version", 0))
        current_state = obj.get("state", None)
        last_written_hash = h
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as e:
        sys.stderr.write(f"[serve] WARN: could not parse {STATE_PATH} on startup: {e}. Starting fresh.\n")
        current_version = 0
        current_state = None
        last_written_hash = None


# ---------------------------------------------------------------------------
# Broadcast
# ---------------------------------------------------------------------------
def _broadcast(version, state_obj):
    """Push a state event to every live SSE subscriber. Failures are tolerated;
    the SSE handler removes its own queue when its socket dies. We just put."""
    payload = {"version": version, "state": state_obj}
    with subscribers_lock:
        # snapshot so we don't iterate the live set
        snapshot = list(subscribers)
    for q in snapshot:
        try:
            q.put_nowait(payload)
        except queue.Full:
            # If a subscriber's queue is wedged, drop the event. Their next
            # snapshot fetch on reconnect will reconcile.
            pass


# ---------------------------------------------------------------------------
# Background mtime watcher
#
# Polls every 250ms. On mtime change: read bytes, hash. If hash == last_written_hash,
# it's our own write echo -- ignore. Otherwise parse, validate, increment server
# version, rewrite file with the bumped version, broadcast.
# ---------------------------------------------------------------------------
def _watcher_loop():
    global current_version, current_state, last_written_hash
    last_mtime = None
    while not shutdown_event.is_set():
        try:
            st = STATE_PATH.stat()
            mtime = st.st_mtime_ns
        except FileNotFoundError:
            mtime = None

        if mtime is not None and mtime != last_mtime:
            last_mtime = mtime
            data, h = _read_state_file()
            if data is None:
                continue

            # Self-write echo? Skip.
            with state_lock:
                if h == last_written_hash:
                    continue

            # External write. Try to parse; on JSONDecodeError, the writer may
            # still be flushing -- sleep 50ms and retry once.
            obj = None
            for attempt in range(2):
                try:
                    obj = json.loads(data.decode("utf-8"))
                    break
                except (json.JSONDecodeError, UnicodeDecodeError):
                    if attempt == 0:
                        time.sleep(0.05)
                        data, h = _read_state_file()
                        if data is None:
                            break
                        # And re-check echo with the newly read bytes
                        with state_lock:
                            if h == last_written_hash:
                                obj = None
                                break
                    else:
                        sys.stderr.write(f"[serve] WARN: {STATE_PATH} unparseable, skipping watcher tick\n")
                        obj = None
            if obj is None:
                continue

            ext_state = obj.get("state", None)
            # Hold the lock for the full read-modify-write-broadcast.
            with state_lock:
                # Re-check echo under lock (POST may have just landed)
                if h == last_written_hash:
                    continue
                current_version += 1
                current_state = ext_state
                payload_bytes = _serialize(current_version, current_state)
                last_written_hash = _atomic_write(payload_bytes)
                # mtime will tick again from our own write -- the next iteration
                # will see hash == last_written_hash and skip.
                last_mtime = STATE_PATH.stat().st_mtime_ns
                broadcast_version = current_version
                broadcast_state = current_state
            _broadcast(broadcast_version, broadcast_state)

        # 250ms poll. Sleep in small chunks so shutdown is responsive.
        for _ in range(5):
            if shutdown_event.is_set():
                return
            time.sleep(0.05)


# ---------------------------------------------------------------------------
# HTTP request handler
# ---------------------------------------------------------------------------
class SyncHandler(SimpleHTTPRequestHandler):
    # SimpleHTTPRequestHandler resolves paths relative to its `directory` arg
    # (Python 3.7+). We pass DOC_ROOT in the server factory below.

    # Quieter logging -- the default prints every request.
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s - %s\n" % (self.log_date_time_string(), self.address_string(), fmt % args))

    # ------- routing -------
    def do_GET(self):
        if self.path == "/state":
            return self._handle_get_state()
        if self.path == "/events" or self.path.startswith("/events?"):
            return self._handle_sse()
        return super().do_GET()

    def do_POST(self):
        if self.path == "/state":
            return self._handle_post_state()
        self.send_error(404, "Not Found")

    # ------- /state GET -------
    def _handle_get_state(self):
        with state_lock:
            payload = json.dumps({"version": current_version, "state": current_state}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    # ------- /state POST -------
    def _handle_post_state(self):
        global current_version, current_state, last_written_hash
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > 8 * 1024 * 1024:  # 8 MB cap
            self.send_error(400, "Body required (and <=8 MB)")
            return
        try:
            raw = self.rfile.read(length)
            body = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as e:
            self.send_error(400, f"Bad JSON: {e}")
            return

        proposed_version = body.get("version")
        proposed_state = body.get("state")
        if not isinstance(proposed_version, int):
            self.send_error(400, "version (int) required")
            return

        # Critical section: validate version, write, broadcast -- all under one lock.
        with state_lock:
            if proposed_version != current_version:
                # Conflict. Return canonical state so browser can reconcile.
                payload = json.dumps({"version": current_version, "state": current_state}).encode("utf-8")
                self.send_response(409)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(payload)
                return

            current_version += 1
            current_state = proposed_state
            payload_bytes = _serialize(current_version, current_state)
            last_written_hash = _atomic_write(payload_bytes)
            broadcast_version = current_version
            broadcast_state = current_state

        # Broadcast outside the lock; subscribers' Queue.put is non-blocking.
        _broadcast(broadcast_version, broadcast_state)

        resp = json.dumps({"version": broadcast_version}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(resp)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(resp)

    # ------- /events SSE -------
    def _handle_sse(self):
        # Open the stream. Headers per the SSE spec.
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")  # disable nginx buffering if proxied
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

        q = queue.Queue(maxsize=64)
        with subscribers_lock:
            subscribers.add(q)

        # Initial snapshot so the client gets state immediately on connect.
        with state_lock:
            init_payload = {"version": current_version, "state": current_state}
        try:
            self._write_sse_event(init_payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            self._unsubscribe(q)
            return

        last_heartbeat = time.time()
        try:
            while not shutdown_event.is_set():
                # Block briefly so heartbeats fire on schedule.
                try:
                    payload = q.get(timeout=1.0)
                    self._write_sse_event(payload)
                    last_heartbeat = time.time()
                except queue.Empty:
                    pass

                # Heartbeat every 15s. Keeps proxies + Windows from idle-killing the conn.
                now = time.time()
                if now - last_heartbeat >= 15.0:
                    try:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        break
                    last_heartbeat = now
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self._unsubscribe(q)

    def _write_sse_event(self, payload):
        """Write one `event: state` SSE message. Raises on socket error."""
        data = json.dumps(payload)
        msg = f"id: {payload['version']}\nevent: state\ndata: {data}\n\n".encode("utf-8")
        self.wfile.write(msg)
        self.wfile.flush()

    def _unsubscribe(self, q):
        with subscribers_lock:
            subscribers.discard(q)


# ---------------------------------------------------------------------------
# Threading server
# ---------------------------------------------------------------------------
class ThreadingHttpServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _make_handler():
    """Return a SyncHandler bound to DOC_ROOT for static file serving."""
    doc_root = str(DOC_ROOT)
    class _Bound(SyncHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=doc_root, **kwargs)
    return _Bound


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    global STATE_PATH, DOC_ROOT
    ap = argparse.ArgumentParser(description="Layout Planner realtime sync server (stdlib only).")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--state", default="current-state.json", help="path to state file")
    args = ap.parse_args()

    STATE_PATH = Path(args.state).resolve()
    DOC_ROOT = Path(__file__).resolve().parent

    _load_initial_state()

    watcher = threading.Thread(target=_watcher_loop, name="state-watcher", daemon=True)
    watcher.start()

    server = ThreadingHttpServer((args.host, args.port), _make_handler())

    print(f"Layout Planner serving http://{args.host}:{args.port}/")
    print(f"  doc root:   {DOC_ROOT}")
    print(f"  state file: {STATE_PATH}")
    print(f"  Note: `python -m http.server {args.port}` still works for static-only mode (no realtime sync).")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[serve] shutting down...")
    finally:
        shutdown_event.set()
        server.server_close()


if __name__ == "__main__":
    main()
