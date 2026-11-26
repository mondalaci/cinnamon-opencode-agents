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

// A rectangle part of the way from one to another, for the screen-border frame
// that closes in on a tile. Both rectangles are { x, y, width, height } in stage
// pixels; the result is too, with a width and height that never go negative.
// Pure, so the test suite covers it directly.
function rect(from, to, p) {
    return {
        x: value(from.x, to.x, p),
        y: value(from.y, to.y, p),
        width: Math.max(0, value(from.width, to.width, p)),
        height: Math.max(0, value(from.height, to.height, p)),
    };
}

// The working bar sweeps: a bright stretch travels the bar's length in one
// direction and starts again, forever, the indeterminate progress indicator the
// panel shows while an agent works. It runs in from behind the start and out
// behind the end, so the wrap has no dead moment. Returns the visible part as
// { start, length } in the bar's pixels - already cut at the ends, so the applet
// can clip a full-length layer with it without touching the tile's allocation.
var BAR_PERIOD_MS = 1400;   // one crossing, from off one end to off the other
var BAR_SEGMENT = 0.32;     // the bright part's share of the bar's length

function barSweep(elapsed, length, segment) {
    let span = Math.max(0, length || 0);
    if (span <= 0) {
        return { start: 0, length: 0 };
    }
    let share = segment > 0 && segment <= 1 ? segment : BAR_SEGMENT;
    let bright = Math.max(4, span * share);
    let period = BAR_PERIOD_MS;
    let t = ((elapsed % period) + period) % period / period;
    // -bright .. span: the stretch enters from behind the start and leaves
    // behind the end.
    let start = -bright + t * (span + bright);
    let from = Math.max(0, start);
    let to = Math.min(span, start + bright);
    if (to <= from) {
        return { start: 0, length: 0 };
    }
    return { start: from, length: to - from };
}
