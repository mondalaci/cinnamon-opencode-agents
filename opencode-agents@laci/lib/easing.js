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

// The working dot pulses: its opacity breathes between MIN and MAX over PERIOD
// milliseconds, in phase, so every working tile blinks together. Returns the
// opacity (0..255) at `elapsed` ms into the cycle.
var PULSE_MAX_OPACITY = 255;
var PULSE_MIN_OPACITY = 96;
var PULSE_PERIOD_MS = 1400;

function pulseOpacity(elapsed) {
    let period = PULSE_PERIOD_MS;
    let t = ((elapsed % period) + period) % period / period;
    // cosine: starts at the bright end, dips once per period
    let phase = (1 - Math.cos(2 * Math.PI * t)) / 2;
    return Math.round(PULSE_MAX_OPACITY - (PULSE_MAX_OPACITY - PULSE_MIN_OPACITY) * phase);
}
