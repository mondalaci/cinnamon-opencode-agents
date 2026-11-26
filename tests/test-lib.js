// Unit and integration tests for the applet's library modules, run under plain
// gjs (no Cinnamon). The mock opencode servers are started by run-tests.sh and
// announced through the environment.
//
//   tests/run-tests.sh          # starts mocks, runs this file, cleans up

const GLib = imports.gi.GLib;

const ROOT = GLib.getenv("OPENCODE_TEST_ROOT");
const APPLET_DIR = GLib.build_filenamev([ROOT, "opencode-agents@laci"]);
imports.searchPath.unshift(APPLET_DIR);

const Client = imports.lib.client;
const OpencodeClient = imports.lib.client.OpencodeClient;
const Discovery = imports.lib.discovery;
const Format = imports.lib.format;
const State = imports.lib.state;
const Tiles = imports.lib.tiles;
const Monitor = imports.lib.monitor.Monitor;
const AgentIcon = imports.lib.agenticon;
const Easing = imports.lib.easing;
const Procfs = imports.lib.procfs;

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
    checks++;
    if (condition) {
        print("ok   - " + name);
    } else {
        failures++;
        print("FAIL - " + name + (detail ? "  [" + detail + "]" : ""));
    }
}

function equal(name, actual, expected) {
    check(name, actual === expected, "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

function env(name) {
    let value = GLib.getenv(name);
    if (value === null || value === undefined) {
        throw new Error("missing test environment variable " + name);
    }
    return value;
}

function readFile(path) {
    try {
        let [ok, contents] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(contents) : null;
    } catch (e) {
        return null;
    }
}

function writeFile(path, text) {
    GLib.file_set_contents(path, text);
}

function sleep(ms) {
    return new Promise(function (resolve) { GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, function () { resolve(); return GLib.SOURCE_REMOVE; }); });
}

function dynamicPort() {
    return parseInt(readFile(env("OPENCODE_TEST_DYNAMIC_PORT_FILE")), 10);
}

// Resolves with the first model the monitor publishes, and stops it after.
function firstModel(monitor) {
    return new Promise(function (resolve, reject) {
        let guard = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20000, function () {
            reject(new Error("timed out waiting for a model"));
            return GLib.SOURCE_REMOVE;
        });
        monitor.onUpdate = function (model) {
            GLib.source_remove(guard);
            monitor.stop();
            resolve(model);
        };
        monitor.start();
    });
}

function until(condition, timeoutMs) {
    let deadline = Date.now() + (timeoutMs || 15000);
    return (async function poll() {
        while (Date.now() < deadline) {
            if (condition()) {
                return true;
            }
            await sleep(100);
        }
        return false;
    })();
}

function byId(list, id) {
    for (let i = 0; i < list.length; i++) {
        if (list[i].id === id) {
            return list[i];
        }
    }
    return null;
}

// ---------------------------------------------------------------- format

function testFormat() {
    equal("format: truncate keeps short text", Format.truncate("hello", 10), "hello");
    equal("format: truncate ellipsizes", Format.truncate("hello world", 8), "hello w\u2026");
    equal("format: shortDirectory keeps tail", Format.shortDirectory("/home/user/projects/example"), "\u2026/projects/example");
    equal("format: shortDirectory short path", Format.shortDirectory("/tmp"), "/tmp");
    equal("format: modelLabel strips provider path", Format.modelLabel({ id: "openrouter/deepseek/deepseek-v4.1-flash" }), "deepseek-v4.1-flash");
    equal("format: modelLabel of string", Format.modelLabel("openrouter/deepseek/deepseek-v4.1-flash"), "deepseek-v4.1-flash");
    equal("format: projectLabel takes the last segment", Format.projectLabel("/home/user/projects/example"), "example");
    equal("format: projectLabel of root", Format.projectLabel("/"), "root");
    equal("format: projectLabel of nothing", Format.projectLabel(""), "");
    equal("format: statusText", Format.statusText("working"), "working");
    equal("format: statusText of done", Format.statusText("done"), "done");
    equal("format: a permission block", Format.statusDetail({ blocked: true, blockedReason: "permission: bash", blockedDetail: "may I push?" }),
        "waiting for approval: may I push?");
    equal("format: a question block", Format.statusDetail({ blocked: true, blockedReason: "question", blockedDetail: "Which colour?" }),
        "waiting for an answer: Which colour?");
    equal("format: a block without detail", Format.statusDetail({ blocked: true, blockedReason: "question" }), "waiting for an answer");
    equal("format: a working session", Format.statusDetail({ status: "running" }), "working");
    equal("format: elapsed seconds", Format.elapsed(4200), "4s");
    equal("format: elapsed minutes", Format.elapsed(125000), "2m");
    equal("format: elapsed hours", Format.elapsed(3700000), "1h1m");
    equal("format: cost small", Format.formatCost(0.0123), "$0.01");
    equal("format: cost tiny", Format.formatCost(0.0004), "$0.0004");
    equal("format: cost zero", Format.formatCost(0), "$0");
    equal("format: tokens", Format.tokenCount({ tokens: { input: 100, output: 20 } }), 120);
    equal("format: no tokens", Format.tokenCount({}), null);
    equal("format: server summary of one", Format.serverSummary({ servers: [{ ok: true }] }), "1 server");
    equal("format: server summary of a dead one", Format.serverSummary({ servers: [{ ok: true }, { ok: false }] }), "2 servers (1 reachable)");
    equal("format: server summary of none", Format.serverSummary({ servers: [] }), "no opencode server found");
    equal("format: session menu label", Format.sessionMenuLabel({ title: "Fix the widget", agent: "build", model: "a/b/c" }, { showModel: true }),
        "Fix the widget  (build \u00b7 c)");

    let model = {
        active: 2, blocked: 1, working: 1,
        servers: [{ id: "127.0.0.1:1", ok: true }],
        sessions: [
            { title: "Fix the widget", project: "example", blocked: false, status: "running", directory: "/home/user/projects/example" },
            { title: "Pick a colour", project: "example", blocked: true, blockedReason: "question", blockedDetail: "Red or blue?" },
        ],
        errors: [],
    };
    let tooltip = Format.tooltipText(model, { maxLines: 5 });
    check("format: tooltip mentions counts", tooltip.indexOf("2 active (1 blocked, 1 working)") >= 0, tooltip);
    check("format: tooltip lists the session", tooltip.indexOf("Fix the widget") >= 0, tooltip);
    check("format: tooltip shows the project", tooltip.indexOf("example") >= 0, tooltip);
    check("format: tooltip shows the question", tooltip.indexOf("waiting for an answer: Red or blue?") >= 0, tooltip);
    check("format: tooltip names the applet", tooltip.indexOf("OpenCode Agents") >= 0, tooltip);
}

// ----------------------------------------------------------------- state

function testState() {
    equal("state: colours come from the studio", State.color("blocked"), "#f85149");
    equal("state: working colour", State.color("working"), "#d29922");
    equal("state: done colour", State.color("done"), "#3fb950");
    equal("state: idle colour", State.color("idle"), "#9b9b9b");
    equal("state: unknown colour falls back to idle", State.color("nonsense"), "#9b9b9b");
    equal("state: labels", State.label("done"), "done");
    // A tile that needs a human fills (red for a block, green for an unread
    // finish); work and idle keep the panel background.
    check("state: an unread finish fills its tile", State.fills("done") === true, "");
    check("state: a block fills its tile", State.fills("blocked") === true, "");
    check("state: work and idle keep the panel background",
        !State.fills("working") && !State.fills("idle"), "");
    check("state: the ink is dark", /^#[0-9a-f]{6}$/.test(State.ink()) &&
        parseInt(State.ink().slice(1, 3), 16) < 0x40, State.ink());
    // The working bar's track is the segment's amber, only dimmed, so the two
    // can never drift apart; an alpha is the only thing that changes.
    equal("state: a colour at an alpha", State.alpha("#d29922", 0.3), "rgba(210,153,34,0.3)");
    equal("state: an alpha above one is opaque", State.alpha("#d29922", 4), "rgba(210,153,34,1)");
    equal("state: an alpha below zero is invisible", State.alpha("#d29922", -1), "rgba(210,153,34,0)");
    equal("state: a string that is not a colour comes back untouched",
        State.alpha("rgba(1,2,3,0.5)", 0.3), "rgba(1,2,3,0.5)");

    let running = [{ id: "a", status: "running" }];
    equal("state: a running session works", State.resolve({}, running, {}).a, "working");
    equal("state: a blocked session", State.resolve({}, [{ id: "a", status: "running", blocked: true }], {}).a, "blocked");
    // Both ways a human gets asked - a permission request and a question
    // offering its choices - reach the same red, filled tile.
    equal("state: a permission block is red",
        State.fills(State.resolve({}, [{ id: "a", blocked: true, blockedReason: "permission: bash" }], {}).a), true);
    equal("state: a question with choices is red",
        State.fills(State.resolve({}, [{ id: "a", blocked: true, blockedReason: "question" }], {}).a), true);
    equal("state: an offline session waits like a blocked one",
        State.resolve({}, [{ id: "a", status: "offline" }], {}).a, "blocked");
    equal("state: a conversation the monitor marked finished is done",
        State.resolve({}, [{ id: "a", status: "idle", done: true }], {}).a, "done");
    equal("state: a marked finish can be acknowledged on the first poll",
        State.resolve({}, [{ id: "a", status: "idle", done: true }], { a: true }).a, "idle");
    equal("state: running again beats a marked finish",
        State.resolve({ a: "done" }, [{ id: "a", status: "running", done: false }], {}).a, "working");
    // The monitor reports the conversations that have been read as plain idle;
    // the panel must never turn one of those green out of its own history.
    equal("state: a reported finish that has been read stays idle",
        State.resolve({ a: "working" }, [{ id: "a", status: "idle", done: false, seen: true }], {}).a, "idle");
    equal("state: a reported read finish is not revived by an earlier state",
        State.resolve({ a: "done" }, [{ id: "a", status: "idle", done: false, seen: true }], {}).a, "idle");
    equal("state: a fresh idle session", State.resolve({}, [{ id: "a", status: "idle" }], {}).a, "idle");
    // A session the monitor still reports as idle - and does not flag as done -
    // is one whose finish has been read, so it is not shown. Only a session the
    // monitor has stopped mentioning keeps the finish it was heading for.
    equal("state: a reported idle session is not shown",
        State.resolve({ a: "working" }, [{ id: "a", status: "idle" }], {}).a, "idle");
    equal("state: a session that vanished is done", State.resolve({ a: "working" }, [], {}).a, "done");
    equal("state: done sticks", State.resolve({ a: "done" }, [], {}).a, "done");
    equal("state: acknowledging a done session clears it", State.resolve({ a: "done" }, [], { a: true }).a, "idle");
    equal("state: acknowledging an idle finish clears it",
        State.resolve({ a: "working" }, [{ id: "a", status: "idle" }], { a: true }).a, "idle");
    equal("state: running again wins over done", State.resolve({ a: "done" }, running, {}).a, "working");
    equal("state: blocked again wins over done", State.resolve({ a: "done" }, [{ id: "a", blocked: true }], {}).a, "blocked");

    equal("state: the worst of a set", State.worst(["idle", "done", "working"]), "working");
    equal("state: blocked is the worst", State.worst(["working", "blocked", "done"]), "blocked");
    equal("state: the worst of nothing", State.worst([]), "idle");

    let states = { a: "done", b: "working", c: "blocked", d: "idle" };
    let entries = State.display(states, [{ id: "a", updated: 10 }, { id: "b", updated: 20 }]);
    equal("state: display drops idle sessions", entries.length, 3);
    equal("state: display sorts by precedence", entries.map(function (e) { return e.id; }).join(","), "c,b,a");
    equal("state: display keeps the state", entries[0].state, "blocked");
    equal("state: display of nothing", State.display({}, []).length, 0);
}

// ----------------------------------------------------------------- tiles

function session(id, title) {
    return { id: id, title: title || id, status: "running" };
}

function testTiles() {
    let a = session("ses_a", "First");
    let b = session("ses_b", "Second");
    let c = session("ses_c", "Third");

    // first poll: everything is new, nothing to remove
    let empty = Tiles.plan([], [a], 3);
    equal("tiles: first session is added", empty.added.join(","), "ses_a");
    equal("tiles: nothing removed on the first poll", empty.removed.length, 0);
    equal("tiles: order", empty.order.join(","), "ses_a");
    check("tiles: not idle", empty.idle === false);

    // a second session starts: only it is added, the first tile is kept
    let grown = Tiles.plan(["ses_a"], [a, b], 3);
    equal("tiles: new session slides in", grown.added.join(","), "ses_b");
    equal("tiles: kept sessions are untouched", grown.removed.length, 0);
    equal("tiles: order follows the model", grown.order.join(","), "ses_a,ses_b");

    // a session ends: it is the only thing removed
    let shrunk = Tiles.plan(["ses_a", "ses_b"], [a], 3);
    equal("tiles: finished session slides out", shrunk.removed.join(","), "ses_b");
    equal("tiles: nothing added", shrunk.added.length, 0);
    equal("tiles: order", shrunk.order.join(","), "ses_a");

    // reordering is neither an add nor a remove, just a new order
    let reordered = Tiles.plan(["ses_a", "ses_b"], [b, a], 3);
    equal("tiles: reorder adds nothing", reordered.added.length, 0);
    equal("tiles: reorder removes nothing", reordered.removed.length, 0);
    equal("tiles: reorder keeps both", reordered.order.join(","), "ses_b,ses_a");

    // more sessions than tiles: the extra ones leave the row, an overflow tile appears
    let capped = Tiles.plan(["ses_a", "ses_b", "ses_c"], [a, b, c, session("ses_d"), session("ses_e")], 3);
    equal("tiles: capped order", capped.order.join(","), "ses_a,ses_b,ses_c," + Tiles.OVERFLOW);
    equal("tiles: overflow count", capped.overflow, 2);
    equal("tiles: overflow tile is added", capped.added.indexOf(Tiles.OVERFLOW) >= 0, true);
    equal("tiles: nothing removed when the cap hides one", capped.removed.length, 0);

    // the overflow tile goes away again when sessions finish
    let uncapped = Tiles.plan(["ses_a", "ses_b", "ses_c", Tiles.OVERFLOW], [a, b], 3);
    equal("tiles: overflow tile is removed", uncapped.removed.join(","), "ses_c," + Tiles.OVERFLOW);
    equal("tiles: overflow count cleared", uncapped.overflow, 0);

    // nothing running: the idle tile takes over, and leaves again
    let idle = Tiles.plan(["ses_a"], [], 3);
    equal("tiles: idle tile replaces the session", idle.order.join(","), Tiles.IDLE);
    equal("tiles: idle removes the session", idle.removed.join(","), "ses_a");
    check("tiles: idle flag", idle.idle === true);
    let waking = Tiles.plan([Tiles.IDLE], [a], 3);
    equal("tiles: session replaces the idle tile", waking.removed.join(","), Tiles.IDLE);
    equal("tiles: session is added", waking.added.join(","), "ses_a");
    check("tiles: no longer idle", waking.idle === false);

    // the limit is at least one tile, and markers are not sessions
    equal("tiles: zero limit still shows one", Tiles.plan([], [a, b], 0).order.join(","), "ses_a," + Tiles.OVERFLOW);
    check("tiles: markers are recognised", Tiles.isMarker(Tiles.IDLE) && Tiles.isMarker(Tiles.OVERFLOW));
    check("tiles: session ids are not markers", Tiles.isMarker("ses_a") === false);
    equal("tiles: entry lookup by id", Tiles.entryFor("ses_b", [a, b]).title, "Second");
    equal("tiles: entry lookup for a marker", Tiles.entryFor(Tiles.OVERFLOW, [a, b]), null);
    equal("tiles: entry lookup for something gone", Tiles.entryFor("ses_z", [a, b]), null);

    // A fill that ends stays in the row while it retracts: the tile keeps its
    // position so the sweep does not happen on a row that is reflowing under it.
    let held = {};
    let kept = Tiles.hold(["ses_a", "ses_b"], [a], { ses_b: true }, held);
    equal("tiles: a retracting tile is held in place", kept.map(function (e) { return e.id; }).join(","), "ses_a,ses_b");
    equal("tiles: the held tile is idle", kept[1].state, "idle");
    check("tiles: the hold is recorded", held.ses_b === true);
    // A tile that is still in the list needs no hold, and a marker never does.
    let notHeld = {};
    equal("tiles: a listed tile is not held",
        Tiles.hold(["ses_a"], [a], { ses_a: true }, notHeld).map(function (e) { return e.id; }).join(","), "ses_a");
    equal("tiles: nothing recorded for a listed tile", Object.keys(notHeld).length, 0);
    let markerHeld = {};
    equal("tiles: a marker is never held",
        Tiles.hold([Tiles.IDLE], [], { }, markerHeld).map(function (e) { return e.id; }).join(","), "");
    equal("tiles: nothing recorded for a marker", Object.keys(markerHeld).length, 0);
    let markerFilled = {};
    let markerFill = {};
    markerFill[Tiles.IDLE] = true;
    equal("tiles: a marker is never held even if it looks filled",
        Tiles.hold([Tiles.IDLE], [], markerFill, markerFilled).map(function (e) { return e.id; }).join(","), "");
    equal("tiles: nothing recorded for a filled marker", Object.keys(markerFilled).length, 0);

    // width fitting: every tile keeps its natural width while there is room
    equal("widths: room to spare", Tiles.fitWidths([40, 60], 200).join(","), "40,60");
    equal("widths: exactly enough", Tiles.fitWidths([40, 60], 100).join(","), "40,60");
    // too little: the modest tile keeps its size, the greedy one takes the rest
    equal("widths: slack goes to the greedy tile", Tiles.fitWidths([40, 60], 80).join(","), "40,40");
    equal("widths: a cheap tile does not shrink the others", Tiles.fitWidths([10, 90], 60).join(","), "10,50");
    // nothing fits: an equal cut
    equal("widths: equal cut when nothing fits", Tiles.fitWidths([40, 60], 50).join(","), "25,25");
    equal("widths: many equal desires", Tiles.fitWidths([10, 10, 10], 15).join(","), "5,5,5");
    equal("widths: no tiles", Tiles.fitWidths([], 100).length, 0);
    equal("widths: zero budget", Tiles.fitWidths([40, 60], 0).join(","), "0,0");
    equal("widths: never negative", Tiles.fitWidths([40], -10).join(","), "0");
}

// ----------------------------------------------------------------- easing

function testEasing() {
    equal("easing: start of a curve", Easing.progress(0, 250, Easing.EASE_OUT), 0);
    equal("easing: end of a curve", Easing.progress(250, 250, Easing.EASE_OUT), 1);
    equal("easing: past the end", Easing.progress(400, 250, Easing.EASE_IN), 1);
    equal("easing: zero duration is instantaneous", Easing.progress(0, 0, Easing.EASE_OUT), 1);
    equal("easing: linear half way", Easing.progress(50, 100, Easing.LINEAR), 0.5);
    equal("easing: ease-out half way", Easing.progress(50, 100, Easing.EASE_OUT), 0.75);
    equal("easing: ease-in half way", Easing.progress(50, 100, Easing.EASE_IN), 0.25);
    equal("easing: ease-out is ahead of ease-in early", Easing.progress(20, 100, Easing.EASE_OUT) > Easing.progress(20, 100, Easing.EASE_IN), true);
    equal("easing: interpolate", Easing.value(-48, 0, 0.5), -24);
    equal("easing: interpolate upwards", Easing.value(0, 255, 0.25), 63.75);

    // the working bar sweeps: a stretch enters from behind one end, crosses the
    // bar and leaves behind the other, then starts again
    let half = Easing.barSweep(Easing.BAR_PERIOD_MS / 2, 100);
    equal("easing: the stretch is centred half way", Math.round(half.start), 34);
    equal("easing: the stretch is a share of the length", Math.round(half.length), 32);
    equal("easing: the sweep starts off the start", Math.round(Easing.barSweep(0, 100).length), 0);
    equal("easing: the sweep comes back", Math.round(Easing.barSweep(Easing.BAR_PERIOD_MS, 100).length), 0);
    let entering = Easing.barSweep(Easing.BAR_PERIOD_MS * 0.1, 100);
    equal("easing: an entering stretch is cut at the start", Math.round(entering.start), 0);
    check("easing: the entering stretch is partial",
        entering.length > 0 && entering.length < half.length, String(entering.length));
    let leaving = Easing.barSweep(Easing.BAR_PERIOD_MS * 0.9, 100);
    check("easing: a leaving stretch is cut at the end",
        leaving.start + leaving.length <= 100 && leaving.length < half.length,
        leaving.start + "+" + leaving.length);
    // A long bar gets a longer stretch, a short one a shorter, and a bar with no
    // length at all has nothing to draw.
    equal("easing: the stretch scales with the bar",
        Math.round(Easing.barSweep(Easing.BAR_PERIOD_MS / 2, 50).length), 16);
    equal("easing: a bar with no length", Easing.barSweep(0, 0).length, 0);
    check("easing: the stretch never leaves the bar", (function () {
        for (let ms = 0; ms <= Easing.BAR_PERIOD_MS; ms += 20) {
            let part = Easing.barSweep(ms, 100);
            if (part.start < 0 || part.length < 0 || part.start + part.length > 100.0001) {
                return false;
            }
        }
        return true;
    })(), "");

    // the curves only ever move forward
    let monotonic = true;
    let previous = -1;
    for (let ms = 0; ms <= 250; ms += 10) {
        let p = Easing.progress(ms, 250, Easing.EASE_OUT);
        if (p < previous) {
            monotonic = false;
        }
        previous = p;
    }
    check("easing: ease-out never goes backwards", monotonic, "");
}

// ------------------------------------------------------------ agent icons

function testAgentIcon() {
    let normal = AgentIcon.pathFor(APPLET_DIR);
    let svg = readFile(normal);

    check("icons: the icon file exists", svg !== null, normal);
    check("icons: the icon is an SVG", !!svg && svg.indexOf("<svg") >= 0, "");
    check("icons: the icon carries its licence", !!svg && svg.indexOf("(ISC)") >= 0, "");
    check("icons: the icon is tinted (no currentColor)", !!svg && svg.indexOf("currentColor") < 0, "");
    check("icons: the icon is in the panel tone", !!svg && svg.indexOf("#c6cdd6") >= 0, "");
    equal("icons: the icon name", AgentIcon.ICON_FILE, "lucide-bot");

    // the standalone inverted artwork is gone: the tiles carry the state now
    check("icons: there is no inverted twin any more", readFile(APPLET_DIR + "/icons/lucide-bot-inverted.svg") === null, "");
    check("icons: the module no longer offers an inverted path", AgentIcon.invertedPathFor === undefined, "");

    // the path stays inside the applet, whatever the applet path looks like
    let appletRoot = APPLET_DIR + "/";
    check("icons: path is inside the applet", normal.indexOf(appletRoot + "icons/") === 0, normal);
    check("icons: path tolerates a trailing slash", AgentIcon.pathFor(APPLET_DIR + "/") === normal, AgentIcon.pathFor(APPLET_DIR + "/"));
    check("icons: theme fallback name", AgentIcon.FALLBACK_ICON_NAME.indexOf("symbolic") > 0, AgentIcon.FALLBACK_ICON_NAME);

    // there is no icon chooser: the settings offer no icon key
    let schema = JSON.parse(readFile(APPLET_DIR + "/settings-schema.json"));
    check("icons: no icon chooser in the settings", schema["agent-icon"] === undefined, Object.keys(schema).join(","));
}

// --------------------------------------------------------- look and feel

// The tile look is split between the stylesheet (the tile, the working bar, the
// two lines) and the applet (the state colours and the sweep), so both are
// checked.
function testLookAndFeel() {
    let css = readFile(APPLET_DIR + "/stylesheet.css");
    check("look: the stylesheet defines the tile", !!css && css.indexOf(".opencode-agents-tile") >= 0, "");
    check("look: the stylesheet defines the working bar",
        !!css && css.indexOf(".opencode-agents-bar") >= 0 && css.indexOf(".opencode-agents-bar-track") >= 0, "");
    check("look: the stylesheet defines the project line", !!css && css.indexOf(".opencode-agents-tile-project") >= 0, "");
    check("look: the stylesheet defines the subject line", !!css && css.indexOf(".opencode-agents-tile-subject") >= 0, "");
    // The panel theme centres text; a label wider than its line would centre
    // it, so the tile must left-align its own two lines.
    check("look: the tile text is left aligned",
        !!css && /\.opencode-agents-tile-text\s*\{[^}]*text-align:\s*left/.test(css), "");
    // The two lines are one block: the project is only quieter, not smaller.
    let projectSize = css && (css.match(/\.opencode-agents-tile-project\s*\{[^}]*font-size:\s*([^;]+);/) || [])[1];
    let subjectSize = css && (css.match(/\.opencode-agents-tile-subject\s*\{[^}]*font-size:\s*([^;]+);/) || [])[1];
    check("look: the project and subject share a font size",
        !!projectSize && projectSize.trim() === (subjectSize || "").trim(), projectSize + " vs " + subjectSize);
    // The padding must live on the tile, not on any come-and-go class, or the
    // row would shuffle on every poll.
    check("look: the tile owns its padding",
        !!css && /\.opencode-agents-tile\s*\{[^}]*padding/.test(css), "");

    let applet = readFile(APPLET_DIR + "/applet.js");
    check("look: the applet paints the bar from the state",
        !!applet && applet.indexOf("State.color") >= 0 && applet.indexOf("State.alpha") >= 0, "");
    check("look: an unread finish fills the whole tile",
        !!applet && applet.indexOf("_paintTile") >= 0 && applet.indexOf("State.fills") >= 0 &&
        !!css && css.indexOf(".opencode-agents-tile-fill") >= 0, "");
    check("look: the applet sweeps the working bar",
        !!applet && applet.indexOf("barSweep") >= 0 && applet.indexOf("_syncBar") >= 0, "");
    // The bar overlays the tile. A row of its own would push two lines that
    // already fill the panel over its edge.
    check("look: the working bar costs no layout height",
        !!applet && applet.indexOf("bar-area") < 0 && !!css && css.indexOf("bar-area") < 0, "");
    check("look: the applet keeps two lines per tile", !!applet && applet.indexOf("opencode-agents-tile-project") >= 0 &&
        applet.indexOf("opencode-agents-tile-subject") >= 0, "");
    check("look: clicking a tile acknowledges it", !!applet && applet.indexOf("_acknowledge") >= 0, "");
    check("look: a finished agent stays until acknowledged", !!applet && applet.indexOf("State.resolve") >= 0, "");
    // A fill that ends retracts in place over the studio's six seconds, and the
    // tile is held in the row until the sweep is done, so the read-status
    // transition reads the same as the studio's sidebar.
    check("look: an ending fill retracts in place",
        !!applet && applet.indexOf("_coolTile") >= 0 && applet.indexOf("COOL_MS") >= 0 &&
        applet.indexOf("_endCooling") >= 0, "");
    check("look: a retracting tile is held in the row",
        !!applet && applet.indexOf("this._cooling") >= 0 && applet.indexOf("_cooling[id]") >= 0, "");
}

// Every setting the applet binds must exist in the schema, or the binding
// silently fails at load.
function testSettingsSchema() {
    let schema = JSON.parse(readFile(APPLET_DIR + "/settings-schema.json"));
    let metadata = JSON.parse(readFile(APPLET_DIR + "/metadata.json"));
    let applet = readFile(APPLET_DIR + "/applet.js");

    equal("settings: the metadata uuid", metadata.uuid, "opencode-agents@laci");
    equal("settings: the applet name", metadata.name, "OpenCode Agents");

    let bound = [];
    let regex = /settings\.bind\("([^"]+)"/g;
    let match;
    while ((match = regex.exec(applet)) !== null) {
        bound.push(match[1]);
    }
    check("settings: the applet binds something", bound.length >= 10, String(bound.length));

    let missing = bound.filter(function (key) { return schema[key] === undefined; });
    equal("settings: every bound key is in the schema", missing.join(","), "");

    check("settings: the removed dot size is gone", schema["dot-size"] === undefined, "");
    check("settings: there is no text-length cap any more",
        schema["tile-project-length"] === undefined && schema["tile-subject-length"] === undefined,
        Object.keys(schema).filter(function (key) { return key.indexOf("tile-") === 0; }).join(","));
    check("settings: the sweep is documented", schema["animate-tiles"].tooltip.indexOf("sweeps") >= 0, schema["animate-tiles"].tooltip);
    check("settings: the service file is offered", !!schema["use-service"] && !!schema["service-file"], "");
}

// ------------------------------------------------------------- discovery

function testServerSpecs() {
    let servers = Discovery.parseExtraServers("127.0.0.1:4097\n# comment\nhttp://127.0.0.1:27183\n\n10.0.0.5:9999:opencode:s3cret\n");
    equal("discovery: parsed extra servers", servers.length, 3);
    equal("discovery: first host", servers[0].host, "127.0.0.1");
    equal("discovery: first port", servers[0].port, 4097);
    equal("discovery: url form port", servers[1].port, 27183);
    equal("discovery: credentials parsed", servers[2].password, "s3cret");
    equal("discovery: default username", servers[0].username, "opencode");
    equal("discovery: id", servers[0].id, "127.0.0.1:4097");
    equal("discovery: garbage ignored", Discovery.parseExtraServers("nonsense").length, 0);
}

function testServiceFile() {
    let written = Discovery.fromServiceFile(env("OPENCODE_TEST_SERVICE_FILE"));
    equal("discovery: the mock's own service file parses", written.length, 1);
    equal("discovery: its port", written[0].port, parseInt(env("OPENCODE_TEST_SERVICE_PORT"), 10));
    equal("discovery: its password", written[0].password, "service-secret");
    equal("discovery: its source", written[0].source, "service");

    let path = GLib.build_filenamev([env("OPENCODE_TEST_WORK"), "service-manual.json"]);
    writeFile(path, JSON.stringify({ url: "http://127.0.0.1:4099", pid: 4242, password: "pw" }));
    let servers = Discovery.fromServiceFile(path);
    equal("discovery: a hand-written service file parses", servers.length, 1);
    equal("discovery: its port", servers[0].port, 4099);
    equal("discovery: its pid", servers[0].pid, 4242);

    let broken = GLib.build_filenamev([env("OPENCODE_TEST_WORK"), "service-broken.json"]);
    writeFile(broken, "{not json");
    equal("discovery: a broken service file is ignored", Discovery.fromServiceFile(broken).length, 0);
    equal("discovery: a missing service file is ignored", Discovery.fromServiceFile("/nonexistent/service.json").length, 0);
    check("discovery: the default service file lives under state",
        Discovery.defaultServiceFile().indexOf("opencode/service.json") > 0, Discovery.defaultServiceFile());
}

function testProcDiscovery() {
    let servers = Discovery.fromProc({ includeMocks: true });
    let ports = servers.map(function (server) { return server.port; });
    let fixedPort = parseInt(env("OPENCODE_TEST_FIXED_PORT"), 10);
    let dyn = dynamicPort();

    check("proc: fixed-port server found (" + fixedPort + ")", ports.indexOf(fixedPort) >= 0, ports.join(","));
    check("proc: --port 0 server resolved via /proc/net/tcp (" + dyn + ")", ports.indexOf(dyn) >= 0, ports.join(","));

    let byPort = {};
    for (let i = 0; i < servers.length; i++) {
        byPort[servers[i].port] = servers[i];
    }
    check("proc: password-less server has no password", byPort[fixedPort] && byPort[fixedPort].password === null,
        byPort[fixedPort] ? String(byPort[fixedPort].password) : "missing");
    equal("proc: password read from environ", byPort[dyn] && byPort[dyn].password, "test-secret-123");
    equal("proc: source", byPort[fixedPort] && byPort[fixedPort].source, "proc");
    check("proc: pid recorded", byPort[fixedPort] && byPort[fixedPort].pid > 0, String(byPort[fixedPort] && byPort[fixedPort].pid));
    check("proc: our own process is not reported", ports.indexOf(Procfs.selfPid()) < 0, String(Procfs.selfPid()));
}

// A shell command line that mentions a server (and inherits OPENCODE from the
// environment) must not be reported as a server.
function testShellsAreNotServers() {
    let fakePort = parseInt(env("OPENCODE_TEST_FAKE_SHELL_PORT"), 10);
    let servers = Discovery.fromProc({ includeMocks: true });
    let ports = servers.map(function (server) { return server.port; });
    check("proc: a shell mentioning a server is not one", ports.indexOf(fakePort) < 0, ports.join(","));

    let commands = servers.map(function (server) { return server.cmdline || ""; });
    let shells = commands.filter(function (cmdline) { return /(^|\/)(bash|sh|dash|zsh) /.test(cmdline); });
    equal("proc: no shell command lines reported", shells.join(" | "), "");
}

async function testMocksAreSkipped() {
    let fixedPort = parseInt(env("OPENCODE_TEST_FIXED_PORT"), 10);
    let dyn = dynamicPort();

    // what the applet does: no service file, no markers, so no test double may show up
    let appletView = Discovery.discover({ useService: false, useProc: true, extraServers: "" });
    let ports = appletView.map(function (server) { return server.port; });
    check("mocks: fixed-port double is skipped", ports.indexOf(fixedPort) < 0, ports.join(","));
    check("mocks: dynamic-port double is skipped", ports.indexOf(dyn) < 0, ports.join(","));

    // the doubles really are running and reachable - the skip is what hides them
    let client = new OpencodeClient({ host: "127.0.0.1", port: fixedPort });
    let projects = await client.projects();
    check("mocks: the skipped double still answers", projects.length >= 2, JSON.stringify(projects.length));

    // and the test suite can still see them on request
    let testing = Discovery.discover({ useService: false, useProc: true, extraServers: "", includeMocks: true });
    let testingPorts = testing.map(function (server) { return server.port; });
    check("mocks: opt-in brings them back", testingPorts.indexOf(fixedPort) >= 0 && testingPorts.indexOf(dyn) >= 0,
        testingPorts.join(","));
}

function testMerge() {
    let servers = Discovery.discover({
        useService: true,
        serviceFile: env("OPENCODE_TEST_SERVICE_FILE"),
        useProc: true,
        extraServers: "127.0.0.1:" + env("OPENCODE_TEST_FIXED_PORT") + "\n127.0.0.1:1",
        includeMocks: true,
    });
    let ids = servers.map(function (server) { return server.id; });
    let fixedId = "127.0.0.1:" + env("OPENCODE_TEST_FIXED_PORT");
    equal("discovery: duplicates merged", ids.filter(function (id) { return id === fixedId; }).length, 1);
    check("discovery: proc server kept", ids.indexOf(fixedId) >= 0, ids.join(","));
    check("discovery: service server kept", ids.indexOf("127.0.0.1:" + env("OPENCODE_TEST_SERVICE_PORT")) >= 0, ids.join(","));
    check("discovery: configured-only server kept", ids.indexOf("127.0.0.1:1") >= 0, ids.join(","));
    check("discovery: sorted by port", servers.length > 1 && servers[0].port <= servers[servers.length - 1].port, ids.join(","));
}

// ---------------------------------------------------------------- client

async function testClient() {
    let fixedPort = parseInt(env("OPENCODE_TEST_FIXED_PORT"), 10);
    let dyn = dynamicPort();

    let open = new OpencodeClient({ host: "127.0.0.1", port: fixedPort });
    let info = await open.info();
    equal("client: /api/info names a version", info && info.version, "9.9.9-test");

    let projects = await open.projects();
    check("client: /api/project returns the mocked projects", projects.length >= 2, JSON.stringify(projects));
    equal("client: a project keeps its name", byId(projects, "proj-a") && byId(projects, "proj-a").name, "Proj A");

    let active = await open.activeSessions();
    equal("client: /api/session/active lists the running ones", active["ses_busy_a"] && active["ses_busy_a"].type, "running");
    check("client: an idle session is not active", active["ses_idle_e"] === undefined, JSON.stringify(active));

    let directories = await open.locations();
    check("client: /api/debug/location lists the project", directories.indexOf(env("OPENCODE_TEST_PROJ_A")) >= 0, directories.join(","));

    let session = await open.session("ses_busy_a");
    equal("client: /api/session/<id> returns the info", session && session.title, "Fix the widget");
    equal("client: its model id", session.model && session.model.id, "openrouter/deepseek/deepseek-v4.1-flash");

    let list = await open.sessions({ limit: 5, directory: env("OPENCODE_TEST_PROJ_A") });
    check("client: /api/session returns a page", Array.isArray(list) && list.length >= 1, JSON.stringify(list.length));
    equal("client: newest first", list[0].id, "ses_busy_a");
    let roots = await open.sessions({ limit: 5, directory: env("OPENCODE_TEST_PROJ_A") });
    check("client: roots only", roots.every(function (item) { return !item.parentID; }), "");

    equal("client: no pending permissions in proj-a", (await open.permissions(env("OPENCODE_TEST_PROJ_A"))).length, 0);

    let asked = new OpencodeClient({ host: "127.0.0.1", port: dyn, password: "test-secret-123" });
    let permissions = await asked.permissions(env("OPENCODE_TEST_PROJ_B"));
    equal("client: /api/permission/request returns the pending one", permissions.length, 1);
    equal("client: the permission names its session", permissions[0].sessionID, "ses_blocked_b");
    equal("client: the permission names its action", permissions[0].action, "bash");

    let forms = await asked.forms(env("OPENCODE_TEST_PROJ_B"));
    equal("client: /api/form returns the pending questions", forms.length, 2);
    check("client: a form names its session", forms.some(function (form) { return form.sessionID === "ses_question_c"; }), JSON.stringify(forms));
    equal("client: a form carries its title", byId(forms.map(function (f) { return { id: f.sessionID, title: f.title }; }), "ses_question_c").title, "Which colour?");

    // the per-location scoping really is per location
    equal("client: permissions are scoped to the directory",
        (await asked.permissions(env("OPENCODE_TEST_PROJ_A"))).length, 0);
    equal("client: forms are scoped to the directory",
        (await asked.forms(env("OPENCODE_TEST_PROJ_A"))).filter(function (f) { return f.sessionID === "ses_shared_x"; }).length, 1);

    // The view marker: a viewer posts the idle transition it has looked at, and
    // the server keeps it in time.viewed for every other client to read.
    equal("client: viewSession answers 204 (no body)", await asked.viewSession("ses_blocked_b", 8000), null);
    let marked = await asked.session("ses_blocked_b");
    equal("client: the view is recorded as time.viewed", marked.time.viewed, 8000);

    let anonymous = new OpencodeClient({ host: "127.0.0.1", port: dyn });
    let unauthorized = null;
    try {
        await anonymous.projects();
    } catch (e) {
        unauthorized = e;
    }
    check("client: 401 without credentials", unauthorized !== null && unauthorized.status === 401,
        unauthorized ? String(unauthorized.status) : "no error");

    let authenticated = new OpencodeClient({ host: "127.0.0.1", port: dyn, password: "test-secret-123" });
    check("client: authenticated request works", (await authenticated.projects()).length >= 2, "");

    let missing = new OpencodeClient({ host: "127.0.0.1", port: fixedPort });
    let error404 = null;
    try {
        await missing.getJson("/api/nope");
    } catch (e) {
        error404 = e;
    }
    check("client: 404 raises", error404 !== null && error404.status === 404, error404 ? String(error404.status) : "no error");

    let empty = await missing.session("ses_does_not_exist");
    equal("client: a missing session is null", empty, null);

    let dead = new OpencodeClient({ host: "127.0.0.1", port: parseInt(env("OPENCODE_TEST_DEAD_PORT"), 10), timeoutSeconds: 2 });
    let refused = null;
    try {
        await dead.projects();
    } catch (e) {
        refused = e;
    }
    check("client: connection refused raises", refused !== null, String(refused));
}

// --------------------------------------------------------------- monitor

function monitorOptions(overrides) {
    let options = {
        intervalSeconds: 1,
        metadataTtlSeconds: 0,
        maxLocations: 20,
        discoverOptions: {
            useService: false,
            useProc: false,
            extraServers: "",
        },
        log: function () {},
        onError: function (e) { print("monitor error: " + e.message); },
    };
    for (let key in (overrides || {})) {
        options[key] = overrides[key];
    }
    return options;
}

async function testMonitorWithProcDiscovery() {
    let monitor = new Monitor(monitorOptions({
        discoverOptions: { useService: false, useProc: true, extraServers: "", includeMocks: true },
    }));
    let model = await firstModel(monitor);

    let fixedPort = parseInt(env("OPENCODE_TEST_FIXED_PORT"), 10);
    let dyn = dynamicPort();
    let serverIds = model.servers.map(function (server) { return server.id; });
    check("monitor: discovered the mock servers", serverIds.length >= 2, serverIds.join(","));

    let byServer = {};
    for (let i = 0; i < model.servers.length; i++) {
        byServer[model.servers[i].id] = model.servers[i];
    }
    let fixed = byServer["127.0.0.1:" + fixedPort];
    let dynamic = byServer["127.0.0.1:" + dyn];
    check("monitor: unauthenticated server reachable", fixed && fixed.ok, fixed ? String(fixed.error) : "missing");
    check("monitor: authenticated server reachable (password from /proc)", dynamic && dynamic.ok,
        dynamic ? String(dynamic.error) : "missing");

    let busy = byId(model.sessions, "ses_busy_a");
    check("monitor: busy session present", !!busy);
    if (busy) {
        equal("monitor: status", busy.status, "running");
        equal("monitor: metadata joined (title)", busy.title, "Fix the widget");
        equal("monitor: metadata joined (agent)", busy.agent, "build");
        equal("monitor: metadata joined (model)", busy.model, "openrouter/deepseek/deepseek-v4.1-flash");
        equal("monitor: metadata joined (project)", busy.project, "Proj A");
        equal("monitor: directory from session info", busy.directory, env("OPENCODE_TEST_PROJ_A"));
        check("monitor: server attribution", busy.serverId === "127.0.0.1:" + fixedPort, busy.serverId);
        check("monitor: updated timestamp joined", busy.updated > 0, String(busy.updated));
    }
}

async function testMonitorSessions() {
    let fixedPort = env("OPENCODE_TEST_FIXED_PORT");
    let dyn = dynamicPort();
    let monitor = new Monitor(monitorOptions({
        discoverOptions: {
            useService: false,
            useProc: false,
            extraServers: "127.0.0.1:" + fixedPort + "\n127.0.0.1:" + dyn + ":opencode:test-secret-123",
        },
    }));
    let model = await firstModel(monitor);

    equal("monitor: both configured servers", model.servers.length, 2);
    check("monitor: both reachable", model.servers.every(function (s) { return s.ok; }),
        model.servers.map(function (s) { return s.id + "=" + s.ok; }).join(","));

    // A permission request names the session that waits, and carries its reason.
    let blocked = byId(model.sessions, "ses_blocked_b");
    check("monitor: a permission-blocked session is present", !!blocked);
    if (blocked) {
        equal("monitor: it is blocked", blocked.blocked, true);
        equal("monitor: its reason", blocked.blockedReason, "permission: bash");
        equal("monitor: its detail", blocked.blockedDetail, "may I push?");
        check("monitor: it details as an approval",
            Format.statusDetail(blocked).indexOf("waiting for approval") >= 0, Format.statusDetail(blocked));
    }

    // A question is a block of its own.
    let asked = byId(model.sessions, "ses_question_c");
    check("monitor: a question-blocked session is present", !!asked);
    if (asked) {
        equal("monitor: it is blocked too", asked.blocked, true);
        equal("monitor: its reason", asked.blockedReason, "question");
        equal("monitor: its detail", asked.blockedDetail, "Which colour?");
    }

    // A question can outlive the status that reported it, so a session whose
    // own status is idle is still surfaced while it waits.
    let askedIdle = byId(model.sessions, "ses_idle_question_d");
    check("monitor: a question surfaces a session whose status is idle", !!askedIdle,
        model.sessions.map(function (s) { return s.id; }).join(","));
    if (askedIdle) {
        equal("monitor: the idle-but-asking session is blocked", askedIdle.blocked, true);
        equal("monitor: it keeps its name", askedIdle.title, "Ask then idle");
        equal("monitor: it keeps its directory", askedIdle.directory, env("OPENCODE_TEST_PROJ_B"));
        equal("monitor: its status is still idle underneath", askedIdle.status, "idle");
    }

    equal("monitor: blocked count", model.blocked, 4);
    equal("monitor: working count", model.working, 1);
    equal("monitor: active total", model.active, 5);
    equal("monitor: the active total is the sum", model.active, model.blocked + model.working);
    check("monitor: every reported session is a dot, a read finish, or idle from a block",
        model.sessions.every(function (s) { return s.blocked || s.status === "running" || s.done || s.seen; }));
    check("monitor: an idle session with nothing pending is gone", byId(model.sessions, "ses_idle_e") === null,
        model.sessions.map(function (s) { return s.id; }).join(","));

    // A conversation that stopped inside the window is the studio's green dot:
    // the applet never watched it run, but it still gets a tile.
    let finished = byId(model.sessions, "ses_finished_h");
    check("monitor: a recently finished conversation is reported", !!finished,
        model.sessions.map(function (s) { return s.id; }).join(","));
    if (finished) {
        equal("monitor: it is marked done", finished.done, true);
        equal("monitor: its status stays idle underneath", finished.status, "idle");
        equal("monitor: its project name is joined", finished.project, "Proj C");
        equal("monitor: its title is joined", finished.title, "Finished on its own");
    }
    equal("monitor: the done count", model.done, 1);
    let readRow = byId(model.sessions, "ses_viewed_i");
    check("monitor: a conversation somebody has viewed is reported as read",
        !!readRow && readRow.seen === true && readRow.done === false,
        JSON.stringify(readRow && { done: readRow.done, seen: readRow.seen }));
    check("monitor: a read conversation is not a done dot", model.done === 1, String(model.done));
    let ids = model.sessions.map(function (s) { return s.id; });
    check("monitor: an unread finish sorts after the live ones",
        ids.indexOf("ses_finished_h") > ids.indexOf("ses_busy_a"), ids.join(","));
    check("monitor: and before the finish that has been read",
        ids.indexOf("ses_finished_h") < ids.indexOf("ses_viewed_i"), ids.join(","));
    equal("monitor: the finished one is not counted as active", model.active, 5);

    // ses_shared_x lives in both mock servers' state on purpose: the model must
    // hold exactly one row for it, record both servers, and let the blocked
    // report win over the running one.
    let shared = model.sessions.filter(function (session) { return session.id === "ses_shared_x"; });
    equal("monitor: duplicate session rows merged", shared.length, 1);
    if (shared.length === 1) {
        equal("monitor: the blocked report wins", shared[0].blocked, true);
        check("monitor: merged row records both servers",
            (shared[0].reportedBy || []).indexOf("127.0.0.1:" + fixedPort) >= 0 &&
            (shared[0].reportedBy || []).indexOf("127.0.0.1:" + dyn) >= 0,
            JSON.stringify(shared[0].reportedBy));
    }
    check("monitor: waiting sessions sort first", model.sessions[0].blocked === true,
        model.sessions.map(function (s) { return s.id + "=" + s.blocked; }).join(","));
    check("monitor: server tallies add up",
        model.servers.reduce(function (sum, s) { return sum + s.activeCount; }, 0) === model.active,
        JSON.stringify(model.servers.map(function (s) { return s.activeCount; })));
    return model;
}

// The finished-conversation window: with it closed, only a finish the applet
// itself watched can turn green.
// A finish somebody has looked at - marked through the server's own `viewed`
// marker - stops being a green dot, which is what keeps the panel and the
// studio in step.
async function testMonitorViewedMarker() {
    let fixedPort = env("OPENCODE_TEST_FIXED_PORT");
    let dyn = dynamicPort();
    let options = {
        discoverOptions: {
            useService: false,
            useProc: false,
            extraServers: "127.0.0.1:" + fixedPort + "\n127.0.0.1:" + dyn + ":opencode:test-secret-123",
        },
    };

    let monitor = new Monitor(monitorOptions(options));
    let model = await firstModel(monitor);
    equal("monitor: the unviewed finish is a green dot", model.done, 1);

    // mark it viewed, exactly as the panel does when the tile is clicked
    let client = new OpencodeClient({ host: "127.0.0.1", port: dyn, password: "test-secret-123" });
    await client.viewSession("ses_finished_h", 1);

    let after = new Monitor(monitorOptions(options));
    let viewed = await firstModel(after);
    equal("monitor: a viewed finish is no longer a green dot", viewed.done, 0);
    let read = byId(viewed.sessions, "ses_finished_h");
    check("monitor: the viewed conversation is still reported, as plain idle", !!read,
        viewed.sessions.map(function (s) { return s.id; }).join(","));
    if (read) {
        equal("monitor: it is not marked done", read.done, false);
        equal("monitor: it is marked seen", read.seen, true);
        equal("monitor: its status is idle", read.status, "idle");
        equal("monitor: the panel would not show it as a dot", State.rawState(read), "idle");
    }
    equal("monitor: the live sessions are unaffected", viewed.active, 5);

    // the view has to carry the idle transition it is about
    let rejected = null;
    try {
        await client.postJson("/api/session/ses_finished_h/view", {});
    } catch (e) {
        rejected = e;
    }
    check("monitor: a view without an idle stamp is rejected", rejected !== null && rejected.status === 400,
        rejected ? String(rejected.status) : "no error");
}

// A conversation is given its title a moment after it starts, so a record that
// arrived without one has to be re-read on the next poll instead of being
// trusted for the whole metadata TTL - otherwise the tile keeps showing the
// session id long after the server has named the conversation.
async function testMonitorRefreshesTitle() {
    let fixedPort = env("OPENCODE_TEST_FIXED_PORT");
    let stateFile = env("OPENCODE_TEST_STATE");
    let original = readFile(stateFile);

    let state = JSON.parse(original);
    byId(state.sessions, "ses_busy_a").title = "";
    writeFile(stateFile, JSON.stringify(state));

    let monitor = new Monitor(monitorOptions({
        intervalSeconds: 1,
        metadataTtlSeconds: 30,
        discoverOptions: { useService: false, useProc: false, extraServers: "127.0.0.1:" + fixedPort },
    }));
    let models = [];
    monitor.onUpdate = function (model) { models.push(model); };
    monitor.start();

    check("monitor: the unnamed sweep arrives", await until(function () { return models.length >= 1; }, 20000), "no model");
    let unnamed = models.length ? byId(models[0].sessions, "ses_busy_a") : null;
    equal("monitor: an unnamed conversation falls back to its id", unnamed && unnamed.title, "ses_busy_a");

    // the server names it, well inside the 30 s metadata TTL
    state = JSON.parse(original);
    byId(state.sessions, "ses_busy_a").title = "Fix the widget";
    writeFile(stateFile, JSON.stringify(state));

    let named = null;
    await until(function () {
        for (let i = models.length - 1; i >= 0; i--) {
            let session = byId(models[i].sessions, "ses_busy_a");
            if (session && session.title === "Fix the widget") {
                named = session;
                return true;
            }
        }
        return false;
    }, 6000);
    monitor.stop();
    check("monitor: the title is re-read without waiting out the TTL", !!named,
        named ? named.title : "still " + (unnamed && unnamed.title));

    writeFile(stateFile, original);
}

async function testMonitorExtraServersAndErrors() {
    let deadPort = parseInt(env("OPENCODE_TEST_DEAD_PORT"), 10);
    let fixedPort = env("OPENCODE_TEST_FIXED_PORT");
    let dyn = readFile(env("OPENCODE_TEST_DYNAMIC_PORT_FILE")).trim();
    let monitor = new Monitor(monitorOptions({
        discoverOptions: {
            useService: false,
            useProc: false,
            extraServers: "127.0.0.1:" + fixedPort + "\n127.0.0.1:" + dyn + ":opencode:test-secret-123\n127.0.0.1:" + deadPort,
        },
    }));
    let model = await firstModel(monitor);

    equal("monitor: three configured servers", model.servers.length, 3);
    let dead = model.servers.filter(function (server) { return server.port === deadPort; })[0];
    check("monitor: dead server reported", !!dead && dead.ok === false, dead ? String(dead.error) : "missing");
    check("monitor: dead server error surfaced", model.errors.length === 1, model.errors.join("; "));
    check("monitor: other servers unaffected", model.servers.filter(function (server) { return server.ok; }).length === 2,
        model.servers.map(function (s) { return s.id + "=" + s.ok; }).join(","));
    check("monitor: sessions from reachable servers only", model.active >= 1, String(model.active));
    let authenticated = model.servers.filter(function (server) { return server.port === parseInt(dyn, 10); })[0];
    check("monitor: authenticated server via config password", authenticated && authenticated.ok,
        authenticated ? String(authenticated.error) : "missing");
}

async function testMonitorReactsToStateChanges() {
    let stateFile = env("OPENCODE_TEST_STATE");
    let original = readFile(stateFile);

    let monitor = new Monitor(monitorOptions({
        intervalSeconds: 1,
        discoverOptions: {
            useService: true,
            serviceFile: env("OPENCODE_TEST_SERVICE_FILE"),
            useProc: true,
            extraServers: "",
            includeMocks: true,
        },
    }));

    let models = [];
    let resolveSecond = null;
    let secondModel = new Promise(function (resolve) { resolveSecond = resolve; });
    monitor.onUpdate = function (model) {
        models.push(model);
        if (models.length === 2) {
            resolveSecond(model);
        }
    };
    monitor.start();
    check("monitor: first sweep arrives", await until(function () { return models.length >= 1; }, 20000), "no model");

    // ses_busy_a stops working and ses_new_a starts.
    let state = JSON.parse(original);
    state.sessions[0].status = "idle";
    state.sessions.push({
        id: "ses_new_a",
        directory: env("OPENCODE_TEST_PROJ_A"),
        status: "running",
        title: "Second session",
        agent: "ask",
        updated: 9999,
    });
    writeFile(stateFile, JSON.stringify(state));

    let model = await secondModel;
    monitor.stop();

    let ids = model.sessions.map(function (session) { return session.id; });
    check("monitor: finished session dropped", ids.indexOf("ses_busy_a") < 0, ids.join(","));
    check("monitor: new session picked up without restart", ids.indexOf("ses_new_a") >= 0, ids.join(","));
    let fresh = byId(model.sessions, "ses_new_a");
    equal("monitor: new session metadata", fresh && fresh.title, "Second session");
    equal("monitor: the service file's server contributes its sessions",
        model.sessions.filter(function (session) { return session.id === "ses_service_d"; }).length, 1);
    check("monitor: the service file's server is marked ok",
        model.servers.filter(function (server) { return server.port === parseInt(env("OPENCODE_TEST_SERVICE_PORT"), 10); })[0].ok === true);

    writeFile(stateFile, original);
}

async function testMonitorStop() {
    let monitor = new Monitor(monitorOptions({ intervalSeconds: 1 }));
    let count = 0;
    monitor.onUpdate = function () { count++; };
    monitor.start();
    await until(function () { return count >= 1; }, 20000);
    monitor.stop();
    let afterStop = count;
    await sleep(2500);
    equal("monitor: no sweeps after stop", count, afterStop);
    check("monitor: running flag cleared", monitor.running === false);
}

// ------------------------------------------------------------------ main

async function run() {
    print("libsoup major version: " + Client.LIBSOUP_MAJOR + ", send_and_read_async: " + Client.HAS_SEND_AND_READ);

    testFormat();
    testState();
    testTiles();
    testEasing();
    testAgentIcon();
    testLookAndFeel();
    testSettingsSchema();
    testServerSpecs();
    testServiceFile();

    let anyOpencode = Discovery.fromProc({ includeMocks: true });
    check("proc: finds opencode-ish processes at all", anyOpencode.length >= 2, "found " + anyOpencode.length);
    testProcDiscovery();
    testMerge();
    testShellsAreNotServers();
    await testMocksAreSkipped();

    await testClient();
    await testMonitorWithProcDiscovery();
    await testMonitorSessions();
    await testMonitorViewedMarker();
    await testMonitorRefreshesTitle();
    await testMonitorExtraServersAndErrors();
    await testMonitorReactsToStateChanges();
    await testMonitorStop();

    print("");
    print(checks + " checks, " + failures + " failures");
    return failures === 0;
}

let loop = new GLib.MainLoop(null, false);
let ok = false;
run().then(function (result) {
    ok = result;
}, function (error) {
    print("ERROR: " + error.message);
    print(error.stack ? error.stack : "");
}).then(function () {
    loop.quit();
});
loop.run();

if (!ok) {
    imports.system.exit(1);
}
