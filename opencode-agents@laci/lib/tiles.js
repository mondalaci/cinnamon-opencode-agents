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
