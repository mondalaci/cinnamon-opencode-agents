#!/usr/bin/env python3
"""A tiny stand-in for an opencode v2 server, used by the applet's test suite.

It implements exactly the endpoints the applet reads, with the shapes the real
server produces:

    GET /api/info                                       -> {version, pid, urls, paths}
    GET /api/project[?archived=true]                    -> [{id, canonical, name?, time}]
    GET /api/session?limit&order&parentID&directory     -> {data: [Session.Info], cursor}
    GET /api/session/<id>                               -> {data: Session.Info}
    GET /api/session/active                             -> {data: {"<id>": {"type": "running"}}}
    GET /api/debug/location                             -> [{directory}]
    GET /api/permission/request?location[directory]=<d> -> {location, data: [Permission.Request]}
    GET /api/form?location[directory]=<d>               -> {location, data: [Form.Info]}

Who is running, and who waits for a human, is read from a state file on every
request, so tests can change the world while the server keeps running. `serve`
is accepted as a subcommand and the --port/--hostname flags are honoured
(including --port 0) so that the process looks like a real opencode server in
/proc. The server writes its own service file when asked, which is how the
applet discovers it.

State file shape:

    {
      "projects":     [{"id", "canonical", "name"?, "time": {...}}],
      "sessions":     [{"id", "directory", "title", "agent", "status", "updated"}],
      "permissions":  [{"id", "sessionID", "action", "resources", "directory"}],
      "forms":        [{"id", "sessionID", "title", "directory"}],
      "locations":    ["/dir", ...]        # optional; derived from sessions
    }
"""

import argparse
import base64
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DEFAULT_USER = "opencode"
DEFAULT_UPDATED = 1792396900000


def watch_parent(pid, interval=2.0):
    """Exit when the process that started us is gone.

    A test run that is killed (timeout, Ctrl-C, crash) must not leave mock
    servers behind: they look like real opencode servers to the applet.
    """
    while True:
        time.sleep(interval)
        try:
            os.kill(pid, 0)
        except OSError:
            os._exit(0)


def load_state(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def session_info(session, viewed=None):
    model = session.get("model") or {}
    times = dict(session.get("time", {"created": DEFAULT_UPDATED - 900000, "updated": session.get("updated", DEFAULT_UPDATED)}))
    # A view posted through POST /api/session/<id>/view lands here, exactly as
    # the real server's `time.viewed` does.
    if viewed and session["id"] in viewed:
        times["viewed"] = viewed[session["id"]]
    info = {
        "id": session["id"],
        "projectID": session.get("projectID", "test-project"),
        "agent": session.get("agent", "build"),
        "model": {
            "id": model.get("id", "openrouter/deepseek/deepseek-v4.1-flash"),
            "providerID": model.get("providerID", "openrouter"),
            "variant": model.get("variant", "default"),
        },
        "cost": session.get("cost", 0.0123),
        "tokens": session.get("tokens", {"input": 1200, "output": 300, "reasoning": 50,
                                         "cache": {"read": 0, "write": 0}}),
        "time": times,
        "title": session.get("title", "untitled session"),
        "location": {"directory": session.get("directory")},
    }
    if session.get("parentID"):
        info["parentID"] = session["parentID"]
    return info


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("MOCK_VERBOSE"):
            sys.stderr.write("mock: " + fmt % args + "\n")

    def _send(self, payload, status=200):
        body = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        if not self.server.require_auth:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:]).decode()
        except Exception:
            return False
        user, _, password = decoded.partition(":")
        return user == self.server.user and password == self.server.password

    def do_POST(self):
        if not self._authorized():
            self._send({"error": "unauthorized"}, 401)
            return

        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode() or "{}")
        except ValueError:
            self._send({"error": "invalid json"}, 400)
            return

        if path.startswith("/api/session/") and path.endswith("/view"):
            session_id = path[len("/api/session/"):-len("/view")]
            idle = body.get("idle")
            if not isinstance(idle, (int, float)):
                # The real server rejects a view without the idle it observed.
                self._send({"error": "invalid request: idle is required"}, 400)
                return
            self.server.viewed[session_id] = idle
            self._send(None, 204)
            return

        self._send({"error": "not found", "path": path}, 404)

    def do_GET(self):
        if not self._authorized():
            self._send({"error": "unauthorized"}, 401)
            return

        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        path = parsed.path
        state = load_state(self.server.state_file)
        sessions = state.get("sessions", [])
        by_id = {s["id"]: s for s in sessions}

        if path == "/api/info":
            self._send({"version": "9.9.9-test", "pid": os.getpid(),
                        "urls": ["http://%s:%d" % (self.server.server_address[0], self.server.server_address[1])],
                        "paths": {"tmp": "/tmp"}})
            return

        if path == "/api/project":
            projects = []
            for project in state.get("projects", []):
                entry = dict(project)
                entry.setdefault("time", {"created": 1, "updated": DEFAULT_UPDATED, "active": DEFAULT_UPDATED})
                projects.append(entry)
            self._send(projects)
            return

        if path == "/api/session/active":
            data = {}
            for session in sessions:
                if session.get("status", "running") == "running":
                    data[session["id"]] = {"type": "running"}
            self._send({"data": data})
            return

        if path == "/api/debug/location":
            directories = state.get("locations")
            if directories is None:
                directories = sorted({s.get("directory") for s in sessions if s.get("directory")})
            self._send([{"directory": directory} for directory in directories])
            return

        if path == "/api/session":
            directory = query.get("directory", [None])[0]
            roots_only = query.get("parentID", [None])[0] == "null"
            order = query.get("order", ["desc"])[0]
            limit = int(query.get("limit", ["50"])[0])
            selected = [s for s in sessions
                        if (directory is None or s.get("directory") == directory)
                        and (not roots_only or not s.get("parentID"))]
            selected.sort(key=lambda s: s.get("updated", DEFAULT_UPDATED), reverse=(order != "asc"))
            self._send({"data": [session_info(s, self.server.viewed) for s in selected[:limit]],
                        "cursor": {"previous": None, "next": None}})
            return

        if path.startswith("/api/session/"):
            session_id = path[len("/api/session/"):]
            if session_id in by_id:
                self._send({"data": session_info(by_id[session_id], self.server.viewed)})
            else:
                self._send({"error": "not found", "sessionID": session_id}, 404)
            return

        if path in ("/api/permission/request", "/api/form"):
            directory = query.get("location[directory]", [None])[0]
            if path == "/api/permission/request":
                items = [dict(entry) for entry in state.get("permissions", [])
                         if entry.get("directory") == directory]
            else:
                items = [dict(entry) for entry in state.get("forms", [])
                         if entry.get("directory") == directory]
            self._send({"location": {"directory": directory}, "data": items})
            return

        self._send({"error": "not found", "path": path}, 404)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", default="serve")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--hostname", default="127.0.0.1")
    parser.add_argument("--state", required=True)
    parser.add_argument("--port-file", default=None)
    parser.add_argument("--service-file", default=None)
    parser.add_argument("--require-auth", action="store_true")
    parser.add_argument("--user", default=DEFAULT_USER)
    parser.add_argument("--password", default=os.environ.get("OPENCODE_SERVER_PASSWORD", ""))
    parser.add_argument("--parent-pid", type=int, default=None)
    args, _unknown = parser.parse_known_args()

    if args.parent_pid:
        threading.Thread(target=watch_parent, args=(args.parent_pid,), daemon=True).start()

    server = ThreadingHTTPServer((args.hostname, args.port), Handler)
    server.state_file = args.state
    server.require_auth = args.require_auth
    server.user = args.user
    server.password = args.password
    # sessionID -> the idle transition a client has marked as viewed
    server.viewed = {}

    port = server.server_address[1]
    url = "http://%s:%d" % (args.hostname, port)
    if args.port_file:
        with open(args.port_file, "w") as handle:
            handle.write(str(port))
    if args.service_file:
        with open(args.service_file, "w") as handle:
            json.dump({"id": "mock-service", "version": "9.9.9-test", "url": url,
                       "pid": os.getpid(), "password": args.password or "unused"}, handle)

    sys.stderr.write("mock opencode server on %s (auth=%s, state=%s)\n"
                     % (url, args.require_auth, args.state))
    sys.stderr.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()
