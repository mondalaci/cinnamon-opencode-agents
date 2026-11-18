// The idle icon: one ready-made robot icon shipped with the applet.
//
// icons/lucide-bot.svg is Lucide's "bot" (ISC), recoloured to the panel tone.
// It is only shown while no agent is working - the running agents are drawn as
// their own tiles, each with a status dot and two lines of text. Nothing is
// drawn in code: the applet renders the file as a normal scalable icon so it
// stays smooth at any size.
//
// To use a different icon, drop an SVG with the same file name into icons/ -
// there is deliberately no icon chooser in the settings.
//
// This module only resolves paths; it is pure and importable outside Cinnamon
// so the test suite can check the shipped artwork.

var ICON_FILE = "lucide-bot";
var DIR = "icons";

// Theme icon used if the shipped file cannot be loaded.
var FALLBACK_ICON_NAME = "avatar-default-symbolic";

// Absolute path of the icon file, always inside the applet's icons/ directory.
function pathFor(appletPath) {
    return appletPath.replace(/\/+$/, "") + "/" + DIR + "/" + ICON_FILE + ".svg";
}
