#!/usr/bin/env bash
# Regenerates docs/panel.png from a running Cinnamon applet.
#
# The image must not carry real session data, so the tiles it shows come from a
# mock opencode server with example titles: the mock is marked
# (OPENCODE_AGENTS_MOCK), which keeps it invisible to /proc discovery, and it is
# plugged in through the applet's own "Additional servers" setting - the applet
# renders it through its normal data path, nothing is injected into a live
# applet. The service file and /proc discovery are switched off for the shot so
# the real sessions do not join in, and restored afterwards.
#
# The capture is checked before it is written: an off-target crop produced a
# nearly black image once, and a README screenshot is not worth re-checking by
# eye. Requires a running Cinnamon with the applet loaded, ImageMagick's
# `import`, python3 and Pillow.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID="opencode-agents@laci"
# a fresh free port by default: a leftover mock on the usual one would silently
# serve the image instead of this run's
PORT="${PORT:-$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')}"
SETTINGS="${XDG_CONFIG_HOME:-$HOME/.config}/cinnamon/spices/$UUID/$UUID.json"
WORK=$(mktemp -d /tmp/opencode-agents-shot.XXXXXX)
OUT="$ROOT/docs/panel.png"
EXAMPLE_DIR="/home/user/projects/example"
LEGACY_DIR="/home/user/projects/legacy"
# a finished conversation keeps its green dot only inside "Keep finished
# agents for", so the mock's idle stamp has to be recent
NOW_MS=$(date +%s%3N)
IDLE_MS=$((NOW_MS - 300000))

if [ ! -f "$SETTINGS" ]; then
    echo "no applet settings at $SETTINGS - is the applet installed and loaded?" >&2
    exit 1
fi

cat > "$WORK/state.json" <<JSON
{
  "projects": [
    {"id": "example", "canonical": "$EXAMPLE_DIR", "time": {"created": 1, "updated": 2, "active": 2}},
    {"id": "legacy", "canonical": "$LEGACY_DIR", "time": {"created": 1, "updated": 2, "active": 2}}
  ],
  "sessions": [
    {"id": "ses_shot_1", "directory": "$EXAMPLE_DIR", "status": "running", "title": "Refactor the payment adapter", "agent": "build", "updated": 4102444800000},
    {"id": "ses_shot_2", "directory": "$EXAMPLE_DIR", "status": "running", "title": "Approve the deploy", "agent": "build", "updated": 4102444799000},
    {"id": "ses_shot_3", "directory": "$EXAMPLE_DIR", "status": "running", "title": "Fix the widget tests", "agent": "build", "updated": 4102444798000},
    {"id": "ses_shot_4", "directory": "$LEGACY_DIR", "status": "idle", "title": "Review the pull request", "agent": "build", "updated": $IDLE_MS,
     "time": {"created": 4102444700000, "updated": $IDLE_MS, "idle": $IDLE_MS}}
  ],
  "locations": ["$EXAMPLE_DIR", "$LEGACY_DIR"],
  "permissions": [
    {"id": "per_shot", "sessionID": "ses_shot_2", "action": "bash", "resources": ["deploy.sh"], "message": "may I deploy?", "directory": "$EXAMPLE_DIR"}
  ]
}
JSON

MOCK_SERVER="$ROOT/tests/mock-opencode-server.py" "$ROOT/tests/bin/opencode" serve \
    --port "$PORT" --hostname 127.0.0.1 --state "$WORK/state.json" >"$WORK/mock.log" 2>&1 &
MOCK_PID=$!

# the mock must be up before the applet is pointed at it
ready=0
for _ in $(seq 1 50); do
    if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/info"; then
        ready=1
        break
    fi
    sleep 0.1
done
if [ "$ready" != "1" ]; then
    echo "the mock server did not come up on port $PORT" >&2
    cat "$WORK/mock.log" >&2 || true
    exit 1
fi

read_setting() {
    python3 - "$SETTINGS" "$1" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))[sys.argv[2]]["value"])
PY
}

js_bool() {
    if [ "$1" = "True" ]; then echo "true"; else echo "false"; fi
}

eval_applet() {
    dbus-send --session --dest=org.Cinnamon --print-reply /org/Cinnamon org.Cinnamon.Eval \
        "string:const ap = imports.ui.appletManager.definitions.filter(function(x){return x.uuid === \"$UUID\"})[0].applet; if (ap) { $1; } \"ok\"" \
        >/dev/null 2>&1 || true
}

PREV_EXTRA=$(read_setting extra-servers)
PREV_SERVICE=$(read_setting use-service)
PREV_PROC=$(read_setting use-proc)
PREV_SERVICE_JS=$(js_bool "$PREV_SERVICE")
PREV_PROC_JS=$(js_bool "$PREV_PROC")

cleanup() {
    python3 - "$SETTINGS" "$PREV_EXTRA" "$PREV_SERVICE" "$PREV_PROC" <<'PY' 2>/dev/null || true
import json, sys
path, extra, service, proc = sys.argv[1:5]
data = json.load(open(path))
data["extra-servers"]["value"] = extra
data["use-service"]["value"] = service == "True"
data["use-proc"]["value"] = proc == "True"
with open(path, "w") as handle:
    json.dump(data, handle, indent=4)
PY
    # tell the applet, not just the settings file, so it goes back to the real
    # servers on its next sweep instead of keeping the dead mock in its model
    eval_applet "ap.settings.remoteUpdate(\"extra-servers\", \"$PREV_EXTRA\")"
    eval_applet "ap.settings.remoteUpdate(\"use-service\", $PREV_SERVICE_JS)"
    eval_applet "ap.settings.remoteUpdate(\"use-proc\", $PREV_PROC_JS)"
    # let the applet pick the real servers back up, then drop the example tiles
    # the mock put on the panel (only those - never the real finished ones)
    drop_mock_tiles() {
        eval_applet 'Object.keys(ap._states).forEach(function (id) { if (id.indexOf("ses_shot_") === 0) { ap._acknowledged[id] = true; ap._states[id] = "idle"; delete ap._known[id]; } }); ap._renderTiles(ap._model);'
    }
    sleep 4
    drop_mock_tiles
    sleep 1
    drop_mock_tiles
    kill "$MOCK_PID" 2>/dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT INT TERM HUP

# plug the mock in through the applet's own settings, exactly like the settings
# dialog: the mock as the only server, so only the example sessions show
python3 - "$SETTINGS" "127.0.0.1:$PORT" <<'PY'
import json, sys
path, value = sys.argv[1], sys.argv[2]
data = json.load(open(path))
data["extra-servers"]["value"] = value
data["use-service"]["value"] = False
data["use-proc"]["value"] = False
with open(path, "w") as handle:
    json.dump(data, handle, indent=4)
PY

eval_applet 'ap.settings.remoteUpdate("use-service", false)'
eval_applet 'ap.settings.remoteUpdate("use-proc", false)'
eval_applet 'ap.settings.remoteUpdate("extra-servers", "127.0.0.1:'"$PORT"'")'
# drop any agent that was live a moment ago and is now "done", so the shot is
# only the example sessions
eval_applet 'ap._acknowledgeAll()'
echo "plugged the mock in as 127.0.0.1:$PORT; waiting for the row to settle"
sleep 3

# Wait for the row to settle (no tile mid-animation) and be exactly the example
# sessions. The check has to hold across a whole poll: changing the settings
# restarts the monitor, and a refresh that was already in flight can land one
# more model - with the real sessions - right after a first good reading.
shot_eval() {
    # anything that is not one of the mock's sessions is a leftover from the
    # real server - drop it, whatever state it is in (a session that was working
    # a moment ago turns green as the applet switches servers)
    eval_applet 'const keep = {ses_shot_1: 1, ses_shot_2: 1, ses_shot_3: 1, ses_shot_4: 1}; Object.keys(ap._states).forEach(function (id) { if (!keep[id]) { ap._acknowledged[id] = true; ap._states[id] = "idle"; delete ap._known[id]; } }); ap._renderTiles(ap._model);'
    eval_applet 'const p = ap.actor.get_transformed_position(); const s = ap.actor.get_transformed_size(); const still = ap._tilesBox.get_children().every(function (a) { return a.opacity === 255 && a.translation_x === 0; }); imports.gi.GLib.file_set_contents("/tmp/opencode-agents-shot-geo.json", JSON.stringify({geo: [Math.round(p[0]), Math.round(p[1]), Math.round(s[0]), Math.round(s[1])], settled: still, tiles: ap._tileIds.length, titles: ap._model.sessions.map(function (m) { return m.title; }), states: ap._states, acks: Object.keys(ap._acknowledged)}))'
}

shot_ready() {
    shot_eval
    python3 - <<'PY'
import json
expected = {"Refactor the payment adapter", "Approve the deploy",
            "Fix the widget tests", "Review the pull request"}
try:
    state = json.load(open('/tmp/opencode-agents-shot-geo.json'))
except (OSError, ValueError):
    raise SystemExit(1)
# exactly the example sessions: one blocked, two working, one finished, no overflow
raise SystemExit(0 if state["settled"] and state["tiles"] == 4 and set(state["titles"]) == expected else 1)
PY
}

settled=0
for _ in $(seq 1 40); do
    if shot_ready; then
        sleep 3
        if shot_ready; then
            settled=1
            echo "the tile row settled"
            break
        fi
    fi
    sleep 0.3
done
if [ "$settled" != "1" ]; then
    echo "the tile row never settled with the example sessions" >&2
    python3 -c "import json;print(json.load(open('/tmp/opencode-agents-shot-geo.json')))" >&2 || true
    exit 1
fi

python3 - "$OUT" <<'PY'
import json, subprocess, sys
from PIL import Image

out = sys.argv[1]
state = json.load(open('/tmp/opencode-agents-shot-geo.json'))
x, y, w, h = state["geo"]
subprocess.run(["import", "-window", "root", "-crop", "%dx%d+%d+%d" % (w + 16, h + 4, max(0, x - 8), max(0, y - 2)),
                "+repage", "/tmp/opencode-agents-shot.png"], check=True)
image = Image.open('/tmp/opencode-agents-shot.png').convert("RGB")
pixels = list(image.getdata())
mean = sum(sum(c) / 3 for c in pixels) / len(pixels)
bright = sum(1 for c in pixels if sum(c) / 3 > 120)
print("captured %dx%d, mean %.1f, %d bright pixels (%.1f%%)" % (image.width, image.height, mean, bright, 100 * bright / len(pixels)))
if bright < 500 or mean < 25:
    raise SystemExit("refusing to write a dim/empty screenshot")
image.resize((image.width * 2, image.height * 2), Image.NEAREST).save(out)
print("wrote", out)
PY
