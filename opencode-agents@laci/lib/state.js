// Conversation states for the panel tiles.
//
// The vocabulary, the precedence and the colours come from
// opencode-projects-studio, whose sidebar carries one dot per conversation:
//
//     blocked  an agent waits for a human (a permission request or a question)
//     working  a turn is running
//     done     the turn finished and the user has not acknowledged it yet
//     idle     nothing to do
//
// Precedence is blocked > working > done > idle, and the colours are the
// studio's dark-theme ones (--git-deleted / --git-modified / --git-added and
// its neutral grey), which is what the panel's own dark tone wants. A blocked
// tile is filled with that red and a `done` one with the green, so both stand
// out from the working tiles and their amber bar.
//
// Pure: no Cinnamon, no I/O, so the test suite covers it directly.

var PRECEDENCE = ["blocked", "working", "done", "idle"];

var COLORS = {
    blocked: "#f85149",
    working: "#d29922",
    done: "#3fb950",
    idle: "#9b9b9b",
};

var LABELS = {
    blocked: "blocked",
    working: "working",
    done: "done",
    idle: "idle",
};

// The ink a filled tile writes in. The panel's own text is light on the dark
// theme, which would vanish on a solid status colour, so a filled tile turns
// dark the way it has to.
var INK = "#0d1117";

function color(state) {
    return COLORS[state] || COLORS.idle;
}

// A state colour at the given alpha, as a css "rgba(...)" string. The working
// bar's track is the same amber as its segment, only dim enough to read as the
// path the segment runs along, instead of a second competing line. A string
// that is not a hex colour comes back untouched.
function alpha(colour, value) {
    let rgb = parseHex(colour);
    if (!rgb) {
        return colour;
    }
    let a = value <= 0 ? 0 : (value >= 1 ? 1 : value);
    return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + a + ")";
}

function label(state) {
    return LABELS[state] || "idle";
}

function ink() {
    return INK;
}

// Only the states that need a human fill their whole tile with the state's
// colour: a block, because the agent cannot go on without an answer (a
// permission request, or a question with its choices), and an unread finish,
// because the answer arrived while the user was looking elsewhere. Both have to
// be visible from across the room. Work and idle keep the panel background -
// the working bar says all there is to say about a running turn, and a row of
// filled working tiles would be a wall of colour that shouts about nothing new.
function fills(state) {
    return state === "blocked" || state === "done";
}

// Rank for sorting: the most actionable first.
function rank(state) {
    let index = PRECEDENCE.indexOf(state);
    return index < 0 ? PRECEDENCE.length : index;
}

// The live state of a single session, ignoring history. A session waiting for a
// human is blocked, whatever else it claims; an offline session waits on the
// network and so needs the user the same way. `session.done` is the monitor's
// mark for a conversation that finished recently and has not been seen since,
// which is what gives it a green tile even on the applet's first poll. Anything
// the server is not running right now is idle.
function rawState(session) {
    if (!session) {
        return "idle";
    }
    if (session.blocked) {
        return "blocked";
    }
    let status = session.status;
    if (status === "running" || status === "busy" || status === "retry") {
        return "working";
    }
    if (status === "offline") {
        return "blocked";
    }
    if (session.done) {
        return "done";
    }
    return "idle";
}

// Folds the live sessions and the previous pass into the states the panel
// shows.
//
// What the monitor reports decides the state: a session waiting for a human is
// blocked, one that is running is working, one whose finish nobody has read
// carries `done`, and everything else it reports is idle - including a finish
// that *has* been read, which is why a conversation the studio shows grey can
// never turn green here. `acknowledged` is the set of ids the user has
// dismissed, so an acknowledged finished session drops to idle and leaves the
// panel.
//
// Only a session the monitor has stopped mentioning at all falls back on the
// previous pass: it was live a moment ago and is gone now, so the finish it was
// heading for is kept on screen until it is acknowledged.
//
// `previous` and the return value are both { sessionID: state }.
function resolve(previous, sessions, acknowledged) {
    let prev = previous || {};
    let seen = acknowledged || {};
    let states = {};
    let present = {};

    for (let i = 0; i < sessions.length; i++) {
        let session = sessions[i];
        present[session.id] = true;
        let state = rawState(session);
        if (state === "done" && seen[session.id]) {
            state = "idle";
        }
        states[session.id] = state;
    }

    for (let id in prev) {
        if (present[id]) {
            continue;
        }
        let was = prev[id];
        if (was === "blocked" || was === "working" || was === "done") {
            states[id] = seen[id] ? "idle" : "done";
        }
    }

    return states;
}

// The ids that should appear in the panel, most actionable first, each paired
// with its state. Idle sessions are left out: an idle conversation has nothing
// to say in a panel about what is running. `sessions` is the live session list,
// used only to sort the equally-ranked ones by recency.
function display(states, sessions) {
    let updated = {};
    for (let i = 0; i < (sessions || []).length; i++) {
        updated[sessions[i].id] = sessions[i].updated || 0;
    }
    let ids = Object.keys(states || {});
    ids.sort(function (a, b) {
        let byRank = rank(states[a]) - rank(states[b]);
        if (byRank !== 0) {
            return byRank;
        }
        return (updated[b] || 0) - (updated[a] || 0);
    });
    let entries = [];
    for (let i = 0; i < ids.length; i++) {
        let id = ids[i];
        if (states[id] === "idle") {
            continue;
        }
        entries.push({ id: id, state: states[id] });
    }
    return entries;
}

// The worst (most actionable) state in a set - what a badge would show.
function worst(states) {
    let best = "idle";
    for (let i = 0; i < (states || []).length; i++) {
        if (rank(states[i]) < rank(best)) {
            best = states[i];
        }
    }
    return best;
}

// A colour part of the way from one to another, for the fill cooldown: a tile's
// ink turns back into the panel's text colour while its fill retracts, so the
// two never sit at odds. Both are "#rrggbb" (or "#rgb"), and so is the result.
// Pure, so the test suite covers it directly.
function mix(from, to, p) {
    let a = parseHex(from);
    let b = parseHex(to);
    if (!a || !b) {
        return p >= 0.5 ? to : from;
    }
    let t = p <= 0 ? 0 : (p >= 1 ? 1 : p);
    return "#" + hexChannel(a[0] + (b[0] - a[0]) * t) +
        hexChannel(a[1] + (b[1] - a[1]) * t) +
        hexChannel(a[2] + (b[2] - a[2]) * t);
}

// "#rrggbb" or "#rgb" -> [r, g, b], or null when the string is not a colour.
function parseHex(value) {
    if (typeof value !== "string") {
        return null;
    }
    let text = value.trim();
    if (text.charAt(0) === "#") {
        text = text.slice(1);
    }
    if (text.length === 3) {
        text = text.charAt(0) + text.charAt(0) + text.charAt(1) + text.charAt(1) +
            text.charAt(2) + text.charAt(2);
    }
    if (text.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(text)) {
        return null;
    }
    return [
        parseInt(text.slice(0, 2), 16),
        parseInt(text.slice(2, 4), 16),
        parseInt(text.slice(4, 6), 16),
    ];
}

// One 0..255 channel as two hex digits.
function hexChannel(value) {
    let n = Math.round(value);
    if (n < 0) {
        n = 0;
    }
    if (n > 255) {
        n = 255;
    }
    let text = n.toString(16);
    return text.length < 2 ? "0" + text : text;
}
