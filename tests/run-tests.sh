#!/usr/bin/env bash
# Test suite for the opencode-agents Cinnamon applet.
#
# Starts a handful of mock opencode v2 servers (one password-less, one that
# requires auth on an OS-assigned port, one announced by a service file) and
# runs the gjs test harnesses against them, with libsoup 3 and with libsoup 2.4.

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d /tmp/opencode-agents-tests.XXXXXX)
PIDS=()

cleanup() {
    for pid in "${PIDS[@]:-}"; do
        kill "$pid" 2>/dev/null
    done
    # belt and braces: every mock names this run's work directory on its command line
    pkill -f -- "$WORK" 2>/dev/null
    wait 2>/dev/null
    rm -rf "$WORK"
}
# Any way of dying must take the mock servers with it: a stray double would
# show up as a phantom agent in a running applet.
trap cleanup EXIT INT TERM HUP

free_port() {
    python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

FIXED_PORT=$(free_port)
SERVICE_PORT=$(free_port)
DEAD_PORT=$(free_port)

mkdir -p "$WORK/proj-a" "$WORK/proj-b"
STATE="$WORK/state.json"
STATE_B="$WORK/state-b.json"
STATE_D="$WORK/state-service.json"
SERVICE_FILE="$WORK/service.json"

# Each mock owns its own sessions, so a session's server attribution is
# deterministic. ses_shared_x appears on two servers on purpose: the monitor
# has to merge it into one row, and the blocked report has to win.
cat > "$STATE" <<JSON
{
  "projects": [
    {"id": "proj-a", "canonical": "$WORK/proj-a", "name": "Proj A", "time": {"created": 1, "updated": 200, "active": 200}},
    {"id": "proj-b", "canonical": "$WORK/proj-b", "time": {"created": 1, "updated": 100, "active": 100}}
  ],
  "sessions": [
    {"id": "ses_busy_a", "directory": "$WORK/proj-a", "status": "running", "title": "Fix the widget", "agent": "build", "updated": 5000},
    {"id": "ses_idle_e", "directory": "$WORK/proj-a", "status": "idle", "title": "Finished already", "agent": "build", "updated": 4000},
    {"id": "ses_shared_x", "directory": "$WORK/proj-a", "status": "running", "title": "Seen by two servers", "agent": "build", "updated": 3000}
  ],
  "locations": ["$WORK/proj-a"]
}
JSON

cat > "$STATE_B" <<JSON
{
  "projects": [
    {"id": "proj-a", "canonical": "$WORK/proj-a", "name": "Proj A", "time": {"created": 1, "updated": 200, "active": 200}},
    {"id": "proj-b", "canonical": "$WORK/proj-b", "time": {"created": 1, "updated": 100, "active": 100}},
    {"id": "proj-c", "canonical": "$WORK/proj-c", "name": "Proj C", "time": {"created": 1, "updated": 90, "active": 90}},
    {"id": "proj-d", "canonical": "$WORK/proj-d", "name": "Proj D", "time": {"created": 1, "updated": 80, "active": 80}}
  ],
  "sessions": [
    {"id": "ses_blocked_b", "directory": "$WORK/proj-b", "status": "running", "title": "Approve the upload", "agent": "build", "updated": 8000},
    {"id": "ses_question_c", "directory": "$WORK/proj-b", "status": "running", "title": "Pick a colour", "agent": "ask", "updated": 7000},
    {"id": "ses_idle_question_d", "directory": "$WORK/proj-b", "status": "idle", "title": "Ask then idle", "agent": "ask", "updated": 6000},
    {"id": "ses_shared_x", "directory": "$WORK/proj-a", "status": "running", "title": "Seen by two servers", "agent": "build", "updated": 3000},
    {"id": "ses_finished_h", "directory": "$WORK/proj-c", "status": "idle", "title": "Finished on its own", "agent": "build", "updated": 50,
     "time": {"created": 1, "updated": 50, "idle": 1}},
    {"id": "ses_viewed_i", "directory": "$WORK/proj-d", "status": "idle", "title": "Already looked at", "agent": "build", "updated": 60,
     "time": {"created": 1, "updated": 60, "idle": 1, "viewed": 2}}
  ],
  "locations": ["$WORK/proj-a", "$WORK/proj-b"],
  "permissions": [
    {"id": "per_b", "sessionID": "ses_blocked_b", "action": "bash", "resources": ["git push"], "message": "may I push?", "directory": "$WORK/proj-b"}
  ],
  "forms": [
    {"id": "frm_c", "sessionID": "ses_question_c", "title": "Which colour?", "fields": [], "directory": "$WORK/proj-b"},
    {"id": "frm_d", "sessionID": "ses_idle_question_d", "title": "Still there?", "fields": [], "directory": "$WORK/proj-b"},
    {"id": "frm_x", "sessionID": "ses_shared_x", "title": "Shared ask", "fields": [], "directory": "$WORK/proj-a"}
  ]
}
JSON

cat > "$STATE_D" <<JSON
{
  "projects": [
    {"id": "proj-a", "canonical": "$WORK/proj-a", "name": "Proj A", "time": {"created": 1, "updated": 200, "active": 200}}
  ],
  "sessions": [
    {"id": "ses_service_d", "directory": "$WORK/proj-a", "status": "running", "title": "Service session", "agent": "build", "updated": 9000}
  ],
  "locations": ["$WORK/proj-a"]
}
JSON

export MOCK_SERVER="$ROOT/tests/mock-opencode-server.py"
OPENCODE_BIN="$ROOT/tests/bin/opencode"
chmod +x "$OPENCODE_BIN"

# 1. plain server on a fixed port
"$OPENCODE_BIN" serve --port "$FIXED_PORT" --hostname 127.0.0.1 --state "$STATE" --parent-pid $$ >"$WORK/mock-a.log" 2>&1 &
PIDS+=($!)

# 2. server started with --port 0 that requires auth
MOCK_PASSWORD=test-secret-123 "$OPENCODE_BIN" serve --port 0 --hostname 127.0.0.1 --parent-pid $$ \
    --state "$STATE_B" --require-auth --port-file "$WORK/port-b" >"$WORK/mock-b.log" 2>&1 &
PIDS+=($!)

# 3. the service-file server (own state, own password, writes its registration)
MOCK_PASSWORD=service-secret "$OPENCODE_BIN" serve --port "$SERVICE_PORT" --hostname 127.0.0.1 --parent-pid $$ \
    --state "$STATE_D" --require-auth --service-file "$SERVICE_FILE" >"$WORK/mock-d.log" 2>&1 &
PIDS+=($!)

# 4. a shell whose command line merely mentions a server: it must never be
#    mistaken for one (a terminal running `opencode serve` looks the same)
FAKE_SHELL_PORT=$(free_port)
env OPENCODE=1 bash -c "exec -a bash sleep 60 serve --port $FAKE_SHELL_PORT" >"$WORK/fake-shell.log" 2>&1 &
PIDS+=($!)
export OPENCODE_TEST_FAKE_SHELL_PORT="$FAKE_SHELL_PORT"

# wait for both dynamic and fixed ports to answer
for _ in $(seq 1 100); do
    if [ -f "$WORK/port-b" ] && curl -s -o /dev/null "http://127.0.0.1:$FIXED_PORT/api/info"; then
        break
    fi
    sleep 0.1
done
if [ ! -f "$WORK/port-b" ]; then
    echo "mock servers did not start:" >&2
    cat "$WORK"/mock-*.log >&2
    exit 1
fi

export OPENCODE_TEST_ROOT="$ROOT"
export OPENCODE_TEST_WORK="$WORK"
export OPENCODE_TEST_STATE="$STATE"
export OPENCODE_TEST_PROJ_A="$WORK/proj-a"
export OPENCODE_TEST_PROJ_B="$WORK/proj-b"
export OPENCODE_TEST_FIXED_PORT="$FIXED_PORT"
export OPENCODE_TEST_SERVICE_PORT="$SERVICE_PORT"
export OPENCODE_TEST_SERVICE_FILE="$SERVICE_FILE"
export OPENCODE_TEST_DEAD_PORT="$DEAD_PORT"
export OPENCODE_TEST_DYNAMIC_PORT_FILE="$WORK/port-b"

echo "=== lib tests (libsoup 3) ==="
gjs "$ROOT/tests/test-lib.js"
STATUS_LIB=$?

echo
echo "=== client tests (libsoup 2.4) ==="
gjs "$ROOT/tests/test-client-soup2.js"
STATUS_SOUP2=$?

echo
if [ "$STATUS_LIB" -eq 0 ] && [ "$STATUS_SOUP2" -eq 0 ]; then
    echo "ALL TESTS PASSED"
    exit 0
fi
echo "TESTS FAILED (lib=$STATUS_LIB soup2=$STATUS_SOUP2)"
exit 1
