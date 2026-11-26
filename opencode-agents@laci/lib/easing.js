// Easing curves for the tile animations.
//
// The animations are driven by the applet itself rather than by Clutter's
// easing, because Cinnamon applies an actor's final value immediately when
// desktop animations are switched off (St.Settings.animations_enabled is false
// by default on many installs, and every ease()/transition is then a no-op).
// A plain frame loop keeps the slide visible regardless, and stays switchable
// through the applet's own setting.
//
// Pure: the test suite checks the curves directly.

var LINEAR = "linear";
var EASE_OUT = "ease-out";     // fast start, gentle arrival - for tiles entering
var EASE_IN = "ease-in";       // gentle start, fast exit - for tiles leaving

// progress(elapsed, duration, curve) -> 0..1
function progress(elapsed, duration, curve) {
    if (duration <= 0) {
        return 1;
    }
    let t = elapsed / duration;
    if (t <= 0) {
        return 0;
    }
    if (t >= 1) {
        return 1;
    }
    if (curve === EASE_OUT) {
        return t * (2 - t);            // quadratic ease-out
    }
    if (curve === EASE_IN) {
        return t * t;                  // quadratic ease-in
    }
    return t;
}

// value(from, to, progress) -> interpolated value
function value(from, to, p) {
    return from + (to - from) * p;
}

// The working bar sweeps: a bright segment crosses the tile from left to right
// and starts again, forever, the indeterminate progress bar the panel shows
// while an agent works. Both ends run off the tile, so what is left is a
// segment that grows out of the left edge, crosses and shrinks into the right
// one. Returns the visible stretch as { x, width } in the tile's pixels -
// already cut at the edges, so the applet can clip a full-width layer with it
// without ever touching the tile's allocation.
var BAR_PERIOD_MS = 1400;   // one crossing, from off the left to off the right
var BAR_SEGMENT = 0.32;     // the bright part's share of the tile's width

function barSegment(elapsed, width, segment) {
    let tile = Math.max(0, width || 0);
    if (tile <= 0) {
        return { x: 0, width: 0 };
    }
    let share = segment > 0 && segment <= 1 ? segment : BAR_SEGMENT;
    let length = Math.max(4, tile * share);
    let period = BAR_PERIOD_MS;
    let t = ((elapsed % period) + period) % period / period;
    // -length .. width: the segment enters from behind the left edge and leaves
    // behind the right one, so the sweep has no dead moment at the wrap.
    let start = -length + t * (tile + length);
    let left = Math.max(0, start);
    let right = Math.min(tile, start + length);
    if (right <= left) {
        return { x: 0, width: 0 };
    }
    return { x: left, width: right - left };
}
