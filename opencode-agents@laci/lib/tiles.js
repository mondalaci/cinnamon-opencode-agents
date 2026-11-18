// Works out how the panel tile row changes between two polls, so the applet can
// animate only what actually appeared or disappeared instead of rebuilding the
// whole row (a rebuild would restart every animation).
//
// The row is described as a list of ids. Sessions use their session id; the two
// non-session tiles use reserved ids so they animate like everything else:
//
//   IDLE     - shown when nothing is running
//   OVERFLOW - shown when more sessions run than the tile limit allows
//
// Pure: no Cinnamon, no actor - the test suite covers it directly.

var IDLE = "\u0000idle";
var OVERFLOW = "\u0000overflow";

// previous: ids currently in the row ([] on the first run)
// entries: the displayed entries, most interesting first, each with an `id`
// maxTiles: how many sessions fit in the row
function plan(previous, entries, maxTiles) {
    let limit = Math.max(1, maxTiles);
    let list = entries || [];
    let shown = list.slice(0, limit);
    let order = shown.map(function (entry) { return entry.id; });

    if (shown.length === 0) {
        order.push(IDLE);
    } else if (list.length > shown.length) {
        order.push(OVERFLOW);
    }

    let before = previous || [];
    let added = order.filter(function (id) { return before.indexOf(id) < 0; });
    let removed = before.filter(function (id) { return order.indexOf(id) < 0; });

    return {
        order: order,
        added: added,
        removed: removed,
        overflow: Math.max(0, list.length - shown.length),
        idle: shown.length === 0,
    };
}

// Reserved id for a session slot, or null when the id is a real session.
function isMarker(id) {
    return id === IDLE || id === OVERFLOW;
}

// Spreads a horizontal budget over the widths a row of tiles would like to
// have. Every tile gets at most its desire, and the slack a short tile leaves
// is handed to the greedy ones, so a row of brief projects does not starve the
// one long conversation that could use the room. Only when the budget cannot
// cover every desire does a tile fall short of it - which is exactly where its
// text starts to ellipsize. Pure, so the test suite covers it directly.
function fitWidths(desires, budget) {
    let list = desires || [];
    let count = list.length;
    let widths = new Array(count);
    if (count === 0) {
        return widths;
    }

    let wants = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
        let want = Math.max(0, list[i] || 0);
        wants.push(want);
        total += want;
    }

    let room = Math.max(0, budget);
    if (room >= total) {
        for (let i = 0; i < count; i++) {
            widths[i] = wants[i];
        }
        return widths;
    }

    // Water-filling: whoever fits under the current equal share takes their
    // desire and steps out; the rest split what is left, which lifts the share
    // for the ones still in. Repeat until the remaining wants are all larger
    // than the share they get.
    let undecided = [];
    for (let i = 0; i < count; i++) {
        undecided.push(i);
    }
    let remaining = room;
    while (undecided.length > 0) {
        let share = remaining / undecided.length;
        let settled = [];
        let rest = [];
        for (let k = 0; k < undecided.length; k++) {
            let i = undecided[k];
            (wants[i] <= share ? settled : rest).push(i);
        }
        if (settled.length === 0) {
            for (let k = 0; k < rest.length; k++) {
                widths[rest[k]] = share;
            }
            break;
        }
        for (let k = 0; k < settled.length; k++) {
            widths[settled[k]] = wants[settled[k]];
            remaining -= wants[settled[k]];
        }
        undecided = rest;
    }
    return widths;
}

// What the tile for an id should look like - used to notice that a kept tile
// needs its texts or dot refreshed.
function entryFor(id, entries) {
    if (isMarker(id)) {
        return null;
    }
    for (let i = 0; i < (entries || []).length; i++) {
        if (entries[i].id === id) {
            return entries[i];
        }
    }
    return null;
}
