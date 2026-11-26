// Cinnamon panel applet showing the opencode v2 agents that are working right
// now.
//
// The panel lists one tile per live conversation, side by side. A tile is two
// lines of text, project over conversation subject, with a thin progress bar
// along its top edge while the agent works:
//
//     ▔▔▔▔▔▔▔▔▔▔▔▔▔
//      uhk.io
//      Fix the widget tests
//
// The tile carries the state, with the vocabulary and colours of the opencode
// project studio: red blocked (an agent waits for you), amber working, green
// finished but not yet acknowledged, grey nothing to do. While an agent works
// an amber segment sweeps along the bar, a tile that waits for a human burns red
// and one whose answer nobody has read turns green, and clicking such a tile
// acknowledges it, so it slides away.
//
// The menu has the details (project, agent, model, status, cost) and the
// per-session actions. See lib/state.js for the tile states and lib/monitor.js
// for the polling.

const Applet = imports.ui.applet;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Main = imports.ui.main;
const Pango = imports.gi.Pango;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Util = imports.misc.util;

const UUID = "opencode-agents@laci";

// Make this applet's own lib/ directory importable.
const APPLET_PATH = imports.ui.appletManager.appletMeta[UUID].path;
imports.searchPath.unshift(APPLET_PATH);

const Discovery = imports.lib.discovery;
const Format = imports.lib.format;
const AgentIcon = imports.lib.agenticon;
const State = imports.lib.state;
const Tiles = imports.lib.tiles;
const Easing = imports.lib.easing;
const Monitor = imports.lib.monitor.Monitor;

const REFRESH_ICON = "view-refresh-symbolic";
const SETTINGS_ICON = "preferences-system-symbolic";
const SEEN_ICON = "object-select-symbolic";
const OVERFLOW_STYLE = "opencode-agents-tile-overflow";
const BAR_STYLE = "opencode-agents-bar";
const BAR_TRACK_STYLE = "opencode-agents-bar-track";
const FILL_STYLE = "opencode-agents-tile-fill";
const FRAME_STYLE = "opencode-agents-screen-frame";
const IN_ANIMATION_MS = 250;
const OUT_ANIMATION_MS = 200;
// How long a fill takes to retract once its tile stops waiting for a human.
// Kept in step with the studio's sidebar, which sweeps the same 6 s.
const COOL_MS = 6000;
const FRAME_MS = 16;
const IDLE_ICON_SIZE = 20;
// The working bar is a thin band along the tile's top edge, coloured in the
// state's amber. It is drawn over the tile instead of taking a row of its own,
// so it never costs the two text lines any height. It is meant to be felt, not
// stared at: the track is the amber at roughly a third of its strength and the
// travelling stretch only a little stronger, so the motion is what catches the
// eye and the colour does not.
const BAR_THICKNESS = 1;        // CSS pixels; the applet scales it for the clip
const BAR_TRACK_ALPHA = 0.36;
const BAR_SEGMENT_ALPHA = 0.55;
// A clip past an actor's own bounds - the actor itself still bounds the paint,
// so this simply means "the whole length" without measuring a tile that may not
// have been allocated yet.
const BAR_CLIP_END = 100000;
// How far a tile travels when it slides in or out: a step of its own, enough to
// read as motion without waiting for a full tile width.
const SLIDE_DISTANCE = 24;
// Device pixels kept free beside the other panel applets, so a full row never
// reaches the point where the panel starts squeezing every box to its minimum.
const PANEL_MARGIN = 8;

// The screen-border alert: a green or red tile is announced by a frame around
// the whole monitor, which then closes in on the tile and fades out. It is a
// short sequence - long enough to catch the eye from across the room, short
// enough not to stand between the user and the panel.
const ALERT_HOLD_MS = 90;      // the frame sits on the screen border, full size
const ALERT_TRAVEL_MS = 480;   // then closes in on the tile
const ALERT_SETTLE_MS = 220;   // rests on the tile so the eye lands there
const ALERT_FADE_MS = 220;     // and is gone
const ALERT_TOTAL_MS = ALERT_HOLD_MS + ALERT_TRAVEL_MS + ALERT_SETTLE_MS + ALERT_FADE_MS;
// The frame sits this many device pixels outside the tile, so it surrounds the
// tile instead of drawing its border over the tile's own edge.
const ALERT_GAP = 1;

// What the panel is about: a session waiting for a human, one that is running,
// or a finish nobody has read yet. The monitor also reports the conversations
// that *have* been read, but only so a green tile can never be invented for
// them.
function isWorthListing(session) {
    return !!(session && (session.blocked || session.done || session.status === "running"));
}

// The stage scale factor: stylesheet lengths are logical pixels while actor
// coordinates are device pixels, so a length like the bar's thickness has to be
// multiplied by this to clip or size an actor by it.
function stageScale() {
    try {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    } catch (e) {
        return 1;
    }
}

// The band's thickness in the device pixels a clip is given.
function barThickness() {
    return Math.max(1, Math.round(BAR_THICKNESS * stageScale()));
}

// St.Icon multiplies icon_size by the stage scale factor, while the sizes in the
// applet's settings are plain pixels, so undo that here.
function iconSizeFor(pixels) {
    return Math.max(1, Math.round(pixels / stageScale()));
}

// The idle icon, rendered as a scalable icon so it stays smooth at any size.
// Falls back to a theme icon if the shipped file cannot be loaded.
function createAgentIcon(size) {
    let path = AgentIcon.pathFor(APPLET_PATH);
    let iconSize = iconSizeFor(size);
    try {
        if (Gio.file_new_for_path(path).query_exists(null)) {
            return new St.Icon({
                style_class: "opencode-agents-idle-icon",
                gicon: Gio.icon_new_for_string(path),
                icon_size: iconSize,
            });
        }
        global.logWarning(UUID + ": missing icon " + path + ", using " + AgentIcon.FALLBACK_ICON_NAME);
    } catch (e) {
        global.logError(UUID + ": cannot load icon " + path + ": " + e.message);
    }
    return new St.Icon({
        style_class: "opencode-agents-idle-icon",
        icon_name: AgentIcon.FALLBACK_ICON_NAME,
        icon_type: St.IconType.SYMBOLIC,
        icon_size: iconSize,
    });
}

class OpencodeAgentsApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this._metadata = metadata;
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this._vertical = orientation === St.Side.LEFT || orientation === St.Side.RIGHT;

        this._model = null;
        this._monitor = null;
        this._animations = [];    // frame timers of running tile animations
        this._tiles = {};         // session id (or marker id) -> tile actor
        this._tileIds = [];       // the row as currently drawn, left to right
        this._tilesAppearance = null;
        this._tilesRendered = false;
        this._states = {};        // session id -> tile state (blocked/working/done/idle)
        this._known = {};         // session id -> last known session info
        this._acknowledged = {};  // session id -> true, once the user has seen it
        this._cooling = {};       // session id -> true, while its fill retracts
        this._alerted = {};       // session id -> the fill last announced on screen
        this._frames = [];        // screen-border alert actors still animating
        this._barTimer = 0;
        this._resizeQueued = false;
        this._resizeIdle = 0;
        this._panelSignals = [];  // [actor, handler id] for the panel resize watch

        this._tilesBox = new St.BoxLayout({
            style_class: "opencode-agents-tiles",
            vertical: this._vertical,
            reactive: false,
        });
        this._tilesBox.set_x_align(Clutter.ActorAlign.CENTER);
        this._tilesBox.set_y_align(Clutter.ActorAlign.CENTER);
        this.actor.add_child(this._tilesBox);

        this._bindSettings(metadata, instanceId);
        this._buildMenu();

        this._log("loading " + UUID + " (libsoup " + imports.lib.client.LIBSOUP_MAJOR + ".x)");
        this._startMonitor();
    }

    // The panel hands the applet only as much room as its contents ask for, so
    // the row claims the space the other applets leave. That room changes while
    // the applet runs (a window list grows, a panel is resized), hence the
    // watch on both the panel and the box that holds us.
    on_applet_added_to_panel() {
        this._watchWidth(this.panel && this.panel.actor);
        this._watchWidth(this._panelLocation);
        this._queueResize();
    }

    _watchWidth(actor) {
        if (!actor) {
            return;
        }
        let id = actor.connect("notify::width", () => this._queueResize());
        this._panelSignals.push({ actor: actor, id: id });
    }

    // Coalesces the resize watches into one re-measure per idle turn.
    _queueResize() {
        if (this._resizeQueued) {
            return;
        }
        this._resizeQueued = true;
        this._resizeIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._resizeIdle = 0;
            this._resizeQueued = false;
            this._resizeTiles(this._tileIds);
            return GLib.SOURCE_REMOVE;
        });
    }

    _log(message) {
        global.log(message);
    }

    _error(message, error) {
        global.logError(UUID + ": " + message + (error ? ": " + error.message : ""));
    }

    // ---- settings ------------------------------------------------------

    _bindSettings(metadata, instanceId) {
        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);

        this.settings.bind("poll-interval", "pollInterval", this._onMonitorSettingsChanged);
        this.settings.bind("metadata-refresh", "metadataRefresh", this._onMonitorSettingsChanged);
        this.settings.bind("max-locations", "maxLocations", this._onMonitorSettingsChanged);
        this.settings.bind("use-service", "useService", this._onMonitorSettingsChanged);
        this.settings.bind("service-file", "serviceFile", this._onMonitorSettingsChanged);
        this.settings.bind("use-proc", "useProc", this._onMonitorSettingsChanged);
        this.settings.bind("extra-servers", "extraServers", this._onMonitorSettingsChanged);

        this.settings.bind("tiles-max", "tilesMax", this._onAppearanceChanged);
        this.settings.bind("tile-show-project", "tileShowProject", this._onAppearanceChanged);
        this.settings.bind("tile-show-subject", "tileShowSubject", this._onAppearanceChanged);
        this.settings.bind("hide-when-idle", "hideWhenIdle", this._onAppearanceChanged);
        this.settings.bind("animate-tiles", "animateTiles", this._onAppearanceChanged);
        this.settings.bind("tooltip-lines", "tooltipLines", this._onAppearanceChanged);

        this.settings.bind("menu-title-length", "menuTitleLength", this._onAppearanceChanged);
        this.settings.bind("menu-show-model", "menuShowModel", this._onAppearanceChanged);
        this.settings.bind("menu-show-directory", "menuShowDirectory", this._onAppearanceChanged);
        this.settings.bind("menu-show-cost", "menuShowCost", this._onAppearanceChanged);
        this.settings.bind("menu-show-idle-servers", "menuShowIdleServers", this._onAppearanceChanged);

        this.settings.bind("click-action", "clickAction", null);
        this.settings.bind("click-command", "clickCommand", null);
    }

    _onMonitorSettingsChanged() {
        // Restarting is the simplest correct reaction to a discovery or
        // cadence change: it drops the caches and re-scans immediately.
        this._startMonitor();
    }

    _onAppearanceChanged() {
        this._applyModel(this._model);
    }

    // ---- monitor -------------------------------------------------------

    _startMonitor() {
        if (this._monitor) {
            this._monitor.stop();
            this._monitor = null;
        }
        this._monitor = new Monitor({
            intervalSeconds: this.pollInterval,
            metadataTtlSeconds: this.metadataRefresh,
            maxLocations: this.maxLocations,
            discoverOptions: {
                useService: this.useService,
                serviceFile: this.serviceFile ? this.serviceFile : Discovery.defaultServiceFile(),
                useProc: this.useProc,
                extraServers: this.extraServers,
                log: (message) => this._log(message),
            },
            onUpdate: (model) => this._onModel(model),
            onError: (error) => this._error("monitor failed", error),
            log: (message) => this._log(message),
        });
        this._monitor.start();
    }

    _onModel(model) {
        this._model = model;
        this._advanceStates(model);
        this._applyModel(model);
    }

    // Folds the live sessions into the tile states, keeping a finished agent
    // visible until the user acknowledges it. See lib/state.js.
    _advanceStates(model) {
        let sessions = model ? model.sessions : [];
        let present = {};
        for (let i = 0; i < sessions.length; i++) {
            let session = sessions[i];
            present[session.id] = true;
            this._known[session.id] = session;
            // A session that runs again needs no acknowledgement any more.
            let raw = State.rawState(session);
            if (raw === "blocked" || raw === "working") {
                delete this._acknowledged[session.id];
            }
        }
        this._states = State.resolve(this._states, sessions, this._acknowledged);
        for (let id in this._states) {
            if (this._states[id] === "idle") {
                delete this._states[id];
                delete this._known[id];
            }
        }
        // An acknowledgement has to outlive a poll: the monitor keeps reporting
        // a recently finished conversation, so it is only forgotten once the
        // session has left the model entirely.
        for (let id in this._acknowledged) {
            if (!present[id]) {
                delete this._acknowledged[id];
            }
        }
    }

    // ---- panel ---------------------------------------------------------

    _applyModel(model) {
        this.set_applet_tooltip(Format.tooltipText(model, {
            maxLines: this.tooltipLines,
            showDirectory: true,
        }));
        this._renderTiles(model);
        this._renderMenu(model);
    }

    _entries() {
        let sessions = this._model ? this._model.sessions : [];
        let entries = State.display(this._states, sessions);
        if (!this.animateTiles) {
            return entries;
        }
        // A tile whose fill is ending stays in the row while the colour retracts,
        // so the read-status transition reads like the studio's sidebar: the fill
        // sweeps away in place instead of the whole tile leaving at once. See
        // Tiles.hold; _endCooling drops the tile when the sweep finishes.
        let filled = {};
        for (let id in this._tiles) {
            let tile = this._tiles[id];
            if (tile && (tile._ocFilled || this._cooling[id])) {
                filled[id] = true;
            }
        }
        return Tiles.hold(this._tileIds, entries, filled, this._cooling);
    }

    // The tile row is diffed against the previous poll and animated: a session
    // that starts slides in, one that leaves slides out, and tiles that stay
    // are only moved and refreshed.
    _renderTiles(model) {
        let appearance = [this.tilesMax, this.tileShowProject,
                          this.tileShowSubject, this.hideWhenIdle].join("|");

        if (appearance !== this._tilesAppearance) {
            // A visual setting changed: rebuild instantly, nothing to animate.
            this._tilesAppearance = appearance;
            this._dropTiles();
        }

        // Read after the rebuild: a dropped row has no fill to hold, and a held
        // tile would only be re-created as a plain idle one.
        let entries = this._entries();

        let plan = Tiles.plan(this._tileIds, entries, this.tilesMax);
        // the first render is not a transition: nothing to animate yet
        let animate = this.animateTiles && this._tilesRendered;

        for (let i = 0; i < plan.removed.length; i++) {
            this._removeTile(plan.removed[i], animate);
        }
        for (let index = 0; index < plan.order.length; index++) {
            let id = plan.order[index];
            let actor = this._tiles[id];
            let entry = Tiles.entryFor(id, entries);
            if (!actor) {
                actor = this._createTile(id, entry, plan.overflow);
                this._tiles[id] = actor;
                this._tilesBox.add_child(actor);
                this._animateIn(actor, id, animate);
            } else {
                this._refreshTile(actor, id, entry, plan.overflow);
            }
            this._tilesBox.set_child_at_index(actor, index);
        }
        this._tileIds = plan.order.slice();
        this._resizeTiles(plan.order);
        // After the row is in place, so the tile the frame closes in on has an
        // allocation to be measured.
        this._alertTiles(entries, plan.order, animate);
        this._tilesRendered = true;
        this._tilesBox.visible = !(entries.length === 0 && this.hideWhenIdle);
        this._syncBar();
    }

    // A green or red tile is an interruption, so when one appears its colour
    // sweeps in from the border of the monitor the panel lives on and settles
    // around the tile (see _flashFrame). Only a fill that was not on screen in
    // the previous render starts the sequence: a tile that stayed red or green
    // has already been announced, and the first render after the applet starts
    // is not a transition. A tile beyond the row's limit has no rectangle to
    // aim at, so it does not flash.
    _alertTiles(entries, order, animate) {
        let filled = {};
        for (let i = 0; i < order.length; i++) {
            let id = order[i];
            let entry = Tiles.entryFor(id, entries);
            if (!entry || !State.fills(entry.state)) {
                continue;
            }
            filled[id] = entry.state;
            if (!animate || this._alerted[id] === entry.state) {
                continue;
            }
            let tile = this._tiles[id];
            if (tile) {
                this._flashFrame(tile, entry.state);
            }
        }
        this._alerted = filled;
    }

    // Fits the tile row into the room the panel leaves beside the other
    // applets. A tile is as wide as its project and subject need - there is no
    // length cap - and only when the row as a whole runs out of room do the
    // tiles shrink and their text ellipsize. When there is no panel to measure
    // (the library tests, the first render before the applet is added) every
    // line keeps its natural width, so nothing is ever cut short for lack of a
    // measurement.
    _resizeTiles(order) {
        let ids = order || this._tileIds || [];
        let tiles = [];
        for (let i = 0; i < ids.length; i++) {
            let tile = this._tiles[ids[i]];
            if (tile) {
                tiles.push(tile);
            }
        }
        if (tiles.length === 0) {
            return;
        }

        // Measure at the natural width: a width forced on a line last time
        // would otherwise be what we read back as its need.
        for (let i = 0; i < tiles.length; i++) {
            this._setTileLineWidths(tiles[i], -1);
        }

        let budget = this._availableRowWidth();
        if (budget <= 0) {
            return;
        }

        let gaps = this._tileSpacing() * Math.max(0, tiles.length - 1);
        let room = Math.max(0, budget - PANEL_MARGIN - this._actorPadding() - gaps);

        // The marker tiles (the idle icon, the +N count) keep their natural size;
        // only the tiles that actually carry text take part in the split. What a
        // tile spends on its padding is not up for sharing, so it comes off the
        // budget before the text is fitted.
        let flexible = [];
        let desires = [];
        let minimums = [];
        let chrome = 0;
        let fixed = 0;
        for (let i = 0; i < tiles.length; i++) {
            let tile = tiles[i];
            if (this._tileHasText(tile)) {
                let text = tile._ocText;
                let natural = text.get_preferred_width(-1)[1];
                let overhead = Math.max(0, tile.get_preferred_width(-1)[1] - natural);
                flexible.push(tile);
                desires.push(natural);
                minimums.push(text.get_preferred_width(-1)[0]);
                chrome += overhead;
            } else {
                fixed += tile.get_preferred_width(-1)[1];
            }
        }

        let widths = Tiles.fitWidths(desires, Math.max(0, room - chrome - fixed));
        for (let i = 0; i < flexible.length; i++) {
            // Never below the tile's own minimum: a squeezed line should
            // ellipsize, not collapse to nothing.
            let width = Math.max(minimums[i], Math.round(widths[i]));
            this._setTileLineWidths(flexible[i], width);
        }
    }

    // The two text layers carry the same lines, so a width forced on one has to
    // be forced on its dark copy too - otherwise the copy would ellipsize at a
    // different point than the line it covers.
    _setTileLineWidths(tile, width) {
        this._setLineWidth(tile._ocProject, width);
        this._setLineWidth(tile._ocProjectInk, width);
        this._setLineWidth(tile._ocSubject, width);
        this._setLineWidth(tile._ocSubjectInk, width);
    }

    _setLineWidth(label, width) {
        if (label) {
            label.set_width(width);
        }
    }

    _tileHasText(tile) {
        return !!(tile._ocText && tile._ocText.visible && tile._ocText.get_children().length > 0);
    }

    // The horizontal room the applet may take: what is left of the panel once
    // the other two boxes, the other applets in our own box, and the box's own
    // spacing are accounted for. -1 when there is no panel to measure (the
    // library tests, the first render before the applet is added).
    _availableRowWidth() {
        let panel = this.panel;
        let box = this._panelLocation;
        if (!panel || !panel.actor || !box) {
            return -1;
        }
        let total = panel.actor.get_width();
        if (!total || total <= 0) {
            return -1;
        }
        let boxes = [panel._leftBox, panel._centerBox, panel._rightBox];
        let others = 0;
        for (let i = 0; i < boxes.length; i++) {
            if (boxes[i] && boxes[i] !== box) {
                others += boxes[i].get_preferred_width(-1)[1];
            }
        }
        // `mine - ours` is everything in our box that is not us: the applets
        // that share it and the spacing around them. It cancels out of the
        // measurement, so the answer does not depend on how wide we are.
        let mine = box.get_preferred_width(-1)[1];
        let ours = this.actor.get_preferred_width(-1)[1];
        return total - others - Math.max(0, mine - ours);
    }

    // The applet's own padding, so the row can be given the inside of it.
    _actorPadding() {
        let actor = this.actor.get_preferred_width(-1)[1];
        let box = this._tilesBox.get_preferred_width(-1)[1];
        return Math.max(0, actor - box);
    }

    _dropTiles() {
        this._stopBar();
        for (let id in this._tiles) {
            this._stopCooling(this._tiles[id]);
            this._tiles[id].destroy();
        }
        this._tiles = {};
        this._tileIds = [];
        this._cooling = {};
    }

    _createTile(id, entry, overflow) {
        if (id === Tiles.IDLE) {
            return this._idleTile();
        }
        if (id === Tiles.OVERFLOW) {
            let box = new St.BoxLayout({ style_class: "opencode-agents-tile", reactive: false });
            box.set_y_align(Clutter.ActorAlign.CENTER);
            box.add_child(new St.Label({
                text: "+" + overflow,
                style_class: OVERFLOW_STYLE,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }
        return this._sessionTile(id, entry);
    }

    // One agent: the project over the conversation subject, with the working
    // bar as a thin band along the tile's top edge.
    //
    // The tile is a bin, not a row: the fill layer sits behind the row's content.
    // The fill has to be its own actor, because the cooldown retracts it while
    // the text stays readable on the uncovered side - a clip on the tile itself
    // would sweep the text away with the colour.
    _sessionTile(id, entry) {
        let tile = new St.Widget({
            style_class: "opencode-agents-tile opencode-agents-tile-session",
            reactive: true,
        });
        tile.set_layout_manager(new Clutter.BinLayout());
        tile.set_y_align(Clutter.ActorAlign.CENTER);
        tile.set_x_align(Clutter.ActorAlign.CENTER);

        let fill = new St.Widget({
            style_class: FILL_STYLE,
            reactive: false,
        });
        fill.set_x_align(Clutter.ActorAlign.FILL);
        fill.set_y_align(Clutter.ActorAlign.FILL);
        // A bin layout only honours FILL for a child that asks to expand;
        // without these the layer would be centred at its own (zero) size.
        fill.set_x_expand(true);
        fill.set_y_expand(true);
        fill.visible = false;
        tile.add_child(fill);
        tile._ocFill = fill;

        // The working bar: a thin band along the tile's top edge, with a bright
        // stretch travelling across it. Both layers span the whole tile and are
        // clipped to the band: a bin child cannot be pinned to an edge (the bin
        // layout centres it, whatever its align says), and a clip costs the
        // layout nothing, so the bar takes no height from the two text lines.
        let track = new St.Widget({
            style_class: BAR_TRACK_STYLE,
            reactive: false,
        });
        track.set_x_align(Clutter.ActorAlign.FILL);
        track.set_y_align(Clutter.ActorAlign.FILL);
        track.set_x_expand(true);
        track.set_y_expand(true);
        track.visible = false;
        tile.add_child(track);
        tile._ocBarTrack = track;

        let bar = new St.Widget({
            style_class: BAR_STYLE,
            reactive: false,
        });
        bar.set_x_align(Clutter.ActorAlign.FILL);
        bar.set_y_align(Clutter.ActorAlign.FILL);
        bar.set_x_expand(true);
        bar.set_y_expand(true);
        bar.visible = false;
        tile.add_child(bar);
        tile._ocBar = bar;

        // The lines are drawn twice, in two layers that span the tile alike: the
        // panel's own bright text underneath, and the dark ink that reads on the
        // fill above it. Each layer is clipped to the stretch its colour belongs
        // to (see _splitText), so where a fill ends the two meet at its edge -
        // the text is never dark on the panel or bright on the colour.
        let bright = this._createTextLayer(tile);
        tile._ocText = bright.text;
        tile._ocTextRow = bright.row;
        let dark = this._createTextLayer(tile);
        dark.text.set_style("color: " + State.ink() + ";");
        tile._ocInk = dark.text;
        tile._ocInkRow = dark.row;
        // Nothing is filled yet: the dark layer starts clipped to nothing and
        // transparent.
        dark.row.set_clip(0, 0, 0, BAR_CLIP_END);
        dark.row.set_opacity(0);
        tile._ocProject = null;
        tile._ocSubject = null;
        tile._ocProjectInk = null;
        tile._ocSubjectInk = null;
        tile._ocId = id;
        tile._ocFilled = false;
        tile._ocCooling = false;
        tile._ocCoolId = 0;

        // Clicking a tile acknowledges its finished agent (the green fill) and
        // opens the menu, so the user can act on the session.
        tile.connect("button-release-event", () => {
            this._acknowledge(id);
            if (!this.menu.isOpen) {
                this.menu.open();
            }
            return true;
        });

        this._refreshTile(tile, id, entry, 0);
        return tile;
    }

    // One text layer: the two lines, left-aligned, in a row that spans the tile
    // so both layers are clipped in the same coordinates. The caller adds the
    // labels; the dark layer carries the ink colour on the inner box, which the
    // labels inherit, so a state change never has to restyle them. The row is
    // the layer's full-tile frame - it is what _splitText clips, because the
    // inner box is inset by the row's own padding and would be off by it.
    _createTextLayer(tile) {
        let row = new St.BoxLayout({
            style_class: "opencode-agents-tile-content",
            reactive: false,
        });
        row.set_x_align(Clutter.ActorAlign.FILL);
        row.set_y_align(Clutter.ActorAlign.FILL);
        row.set_x_expand(true);
        row.set_y_expand(true);
        tile.add_child(row);

        let text = new St.BoxLayout({
            style_class: "opencode-agents-tile-text",
            vertical: true,
            reactive: false,
        });
        text.set_y_align(Clutter.ActorAlign.CENTER);
        text.set_x_align(Clutter.ActorAlign.START);
        row.add_child(text);
        return { row: row, text: text };
    }

    // The idle marker: a dimmed robot icon, or nothing when the row is hidden.
    _idleTile() {
        let tile = new St.BoxLayout({ style_class: "opencode-agents-tile opencode-agents-tile-idle", reactive: false });
        tile.set_y_align(Clutter.ActorAlign.CENTER);
        tile.add_child(createAgentIcon(IDLE_ICON_SIZE));
        return tile;
    }

    // Keeps a tile that is still there in step with its session.
    _refreshTile(actor, id, entry, overflow) {
        if (id === Tiles.OVERFLOW) {
            let label = actor.get_children()[0];
            label.set_text("+" + overflow);
            return;
        }
        if (id === Tiles.IDLE || !entry) {
            return;
        }
        let state = entry.state;
        if (this._cooling[id] && state !== "working") {
            // The tile is holding its place while its fill retracts: keep the
            // text it had when the fill ended (the session is already forgotten)
            // and let the cooldown own the fill's colour. A conversation that
            // starts working again is no longer forgotten, so it falls through
            // and gets its current lines and its amber bar.
            this._paintTile(actor, state);
            return;
        }
        let session = this._known[id] || null;

        let text = actor._ocText;
        if (!text) {
            return;
        }
        let wantsProject = this.tileShowProject && session && session.project;
        let wantsSubject = this.tileShowSubject && session && session.title;
        // No length cap: the tile takes the room it needs and the row ellipsizes
        // only when the panel has none left to give.
        this._syncLabel(actor, "_ocProject", wantsProject ? session.project : null,
            "opencode-agents-tile-project", 0);
        this._syncLabel(actor, "_ocSubject", wantsSubject ? session.title : null,
            "opencode-agents-tile-subject", 1);
        text.visible = !!(wantsProject || wantsSubject);
        this._paintTile(actor, state);
    }

    // Adds, updates or drops one of a tile's two lines, in both text layers, so
    // a setting change or a missing value does not leave a stale label behind
    // and the dark copy never disagrees with the line it covers.
    _syncLabel(tile, slot, wanted, styleClass, index) {
        this._syncLine(tile, tile._ocText, slot, wanted, styleClass, index);
        this._syncLine(tile, tile._ocInk, slot + "Ink", wanted, styleClass, index);
    }

    _syncLine(tile, text, slot, wanted, styleClass, index) {
        if (!text) {
            return;
        }
        let label = tile[slot];
        if (wanted === null || wanted === "") {
            if (label) {
                text.remove_child(label);
                label.destroy();
                tile[slot] = null;
            }
            return;
        }
        if (!label) {
            label = new St.Label({ text: wanted, style_class: styleClass });
            label.set_x_align(Clutter.ActorAlign.START);
            // The row decides how wide the tile is, so a line longer than the
            // room it was given is truncated here rather than overflowing into
            // the next tile.
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            tile[slot] = label;
            text.insert_child_at_index(label, Math.min(index, text.get_children().length));
        } else if (label.get_text() !== wanted) {
            label.set_text(wanted);
        }
    }

    // The working bar: a dim amber band along the tile's top edge, with the
    // bright stretch travelling across it. Only a working agent shows it - a
    // blocked or unread tile is already filled with its colour, and every other
    // state has nothing to say about the bar. The stretch comes from
    // Easing.barSweep each frame; with the animation switched off the whole bar
    // stays lit, the steady counterpart of the old steady dot.
    _paintBar(tile, state) {
        let track = tile._ocBarTrack;
        let bar = tile._ocBar;
        if (!track || !bar) {
            return;
        }
        // A fill owns the tile while it is on or retracting; the bar is the
        // working tile's own tell, so it waits until the tile is plain again -
        // and a conversation that goes back to work clears its fill at once
        // (see _paintTile), so the bar never waits on a retraction.
        let working = state === "working" && !(tile._ocFill && tile._ocFill.visible);
        track.visible = working;
        bar.visible = working;
        if (!working) {
            track.remove_clip();
            bar.remove_clip();
            return;
        }
        let colour = State.color("working");
        track.set_style("background-color: " + State.alpha(colour, BAR_TRACK_ALPHA) + ";");
        bar.set_style("background-color: " + State.alpha(colour, BAR_SEGMENT_ALPHA) + ";");
        // Both layers span the tile; the clip narrows them to the band, which
        // is the top few pixels of the tile - over the content's top padding.
        track.set_clip(0, 0, BAR_CLIP_END, barThickness());
        if (!this.animateTiles) {
            bar.set_clip(0, 0, BAR_CLIP_END, barThickness());
        }
    }

    // A tile that waits for a human (red) or whose answer nobody has read yet
    // (green) fills with the state's colour; the fill layer behind the text
    // carries it and the dark text layer covers the bright one, because the
    // panel's own text is light and would vanish on it. Every other state clears
    // all of that, so a tile that starts working, is acknowledged or drops to
    // idle goes back to the panel background - except that a fill which has just
    // ended retracts instead of vanishing (see _coolTile). A conversation that
    // goes straight from a block back to work is the exception to the
    // exception: the amber bar is the display now, so the fill goes at once
    // rather than sweeping red or green over a turn that is already running.
    _paintTile(tile, state) {
        let filled = State.fills(state);
        let fill = tile._ocFill;
        if (fill) {
            if (filled) {
                this._stopCooling(tile);
                // A fill that came back is on the row's own list again, so the
                // row no longer has to hold the tile in place.
                if (tile._ocId) {
                    delete this._cooling[tile._ocId];
                }
                fill.set_style("background-color: " + State.color(state) + ";");
                fill.remove_clip();
                fill.visible = true;
            } else if (state === "working") {
                // The session went on to work: cancel any retraction and clear
                // the fill so the working bar owns the tile from this frame on.
                this._stopCooling(tile);
                if (tile._ocId) {
                    delete this._cooling[tile._ocId];
                }
                this._clearFill(fill, tile);
            } else if (tile._ocCooling) {
                // the cooldown owns the fill until it finishes
            } else if (tile._ocFilled && this.animateTiles) {
                this._coolTile(tile);
            } else {
                fill.visible = false;
            }
        }
        tile._ocFilled = filled;
        // The bar follows the fill's state, so it is painted after it: a tile
        // that just filled must not leave a working bar over the colour.
        this._paintBar(tile, state);
        if (!tile._ocText || !tile._ocInk || tile._ocCooling) {
            // while a fill retracts, the cooldown owns the text layers
            return;
        }
        if (filled) {
            // The fill covers the tile whole: the dark layer alone is visible.
            // Its bright counterpart is clipped away rather than hidden, so the
            // two copies cannot both draw into the same antialiased pixels, and
            // a hidden layer cannot change the tile's preferred size.
            this._splitText(tile, 0, BAR_CLIP_END, BAR_CLIP_END);
        } else {
            tile._ocTextRow.remove_clip();
            tile._ocTextRow.set_opacity(255);
            tile._ocInkRow.set_opacity(0);
        }
    }

    // Divides the two text layers at the fill's left edge: the dark layer shows
    // from `edge` to the tile's right side, the bright one from its left side to
    // `edge`. A clip costs the layout nothing, so the split moves without ever
    // re-laying the tile out, and each line is drawn on exactly the background
    // its colour belongs to. The width and height are the fill's own, so the
    // boundary is the same x the fill is clipped at.
    //
    // The layer a split puts on the wrong side of the tile (the bright copy of a
    // whole fill, the dark copy of none) is faded out as well as clipped: a
    // zero-width clip already paints nothing, but opacity says so outright.
    _splitText(tile, edge, width, height) {
        let bright = tile._ocTextRow;
        let dark = tile._ocInkRow;
        if (!bright || !dark) {
            return;
        }
        let left = Math.max(0, Math.round(edge));
        // A tile that has not been allocated yet (a fill that appeared on the
        // same frame as its sweep started) gives a zero width; reading it as
        // "the whole tile" keeps the split where the fill was - full - instead
        // of clipping both layers to nothing.
        let span = width > 0 ? width : BAR_CLIP_END;
        let tall = height > 0 ? height : BAR_CLIP_END;
        bright.set_clip(0, 0, Math.max(0, Math.min(left, span)), tall);
        dark.set_clip(left, 0, Math.max(0, span - left), tall);
        bright.set_opacity(left > 0 ? 255 : 0);
        dark.set_opacity(left < span ? 255 : 0);
    }

    // ---- the fill cooldown ---------------------------------------------

    // A fill that has just ended keeps its colour and retracts to the right over
    // six seconds, the way the studio's sidebar sweeps it away. A conversation
    // that goes back to work never gets here: _paintTile clears the fill
    // immediately so its amber bar takes over.
    //
    // The retraction is a sweep instead of a fade: a fading colour passes
    // through muddy mixes on the way out, this one just gets narrower until the
    // tile is its old self again. The fill layer is clipped rather than the
    // tile, and the text's dark/bright boundary travels with its edge (see
    // _splitText), so both sides of the sweep stay readable the whole way.
    _coolTile(tile) {
        let fill = tile._ocFill;
        if (!fill) {
            return;
        }
        this._stopCooling(tile);
        let duration = COOL_MS;
        let started = GLib.get_monotonic_time() / 1000;
        let self = this;
        let id = 0;
        tile._ocCooling = true;
        fill.remove_clip();

        let step = function () {
            let elapsed = GLib.get_monotonic_time() / 1000 - started;
            let p = Easing.progress(elapsed, duration, Easing.LINEAR);
            try {
                // The width is read every frame: the row may be re-fitted while
                // the sweep runs (a title arrives, the panel is resized).
                let width = fill.get_width();
                let height = fill.get_height();
                let left = Math.round(width * p);
                fill.set_clip(left, 0, Math.max(0, width - left), height);
                self._splitText(tile, left, width, height);
            } catch (e) {
                // The actor went away underneath us (applet removed, a rebuild),
                // or a lib module is stale after a reload. Either way the fill
                // must not be left stuck half swept.
                self._forgetCooling(id, tile);
                try {
                    self._clearFill(fill, tile);
                } catch (ignored) {
                    // the actor is gone with the applet
                }
                self._log("fill cooldown stopped: " + e.message +
                    " (a change in lib/ needs a Cinnamon restart to load)");
                // The actor may already be gone: drop the hold without asking for
                // a render that would touch a destroyed tile. The next poll takes
                // the row's stale entry out on its own.
                if (tile._ocId) {
                    delete self._cooling[tile._ocId];
                }
                return GLib.SOURCE_REMOVE;
            }
            if (elapsed >= duration) {
                self._forgetCooling(id, tile);
                try {
                    self._clearFill(fill, tile);
                } catch (e) {
                    // the actor went away underneath us
                }
                self._endCooling(tile);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        };

        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, step);
        tile._ocCoolId = id;
        this._animations.push(id);
    }

    // Puts a tile back to its plain state after a fill ends or a sweep is cut
    // short: no colour, no clip on the bright line, and the dark layer clipped
    // to nothing.
    _clearFill(fill, tile) {
        fill.remove_clip();
        fill.visible = false;
        if (tile._ocTextRow) {
            tile._ocTextRow.remove_clip();
            tile._ocTextRow.set_opacity(255);
        }
        if (tile._ocInkRow) {
            tile._ocInkRow.set_opacity(0);
        }
    }

    // The sweep has finished: the tile is no longer held, so the next render
    // takes it out of the row - an idle tile has nothing left to say. A tile
    // that filled again during the sweep has already dropped its hold.
    _endCooling(tile) {
        if (!tile || !tile._ocId) {
            return;
        }
        delete this._cooling[tile._ocId];
        if (!this._model) {
            return;
        }
        try {
            this._renderTiles(this._model);
        } catch (e) {
            // the applet is going away; the next render would be its last anyway
        }
    }

    // Drops a cooldown's timer without touching the tile's paint, so a tile that
    // is leaving can finish its slide-out with its fill still on.
    _forgetCooling(id, tile) {
        let index = this._animations.indexOf(id);
        if (index >= 0) {
            this._animations.splice(index, 1);
        }
        if (tile) {
            tile._ocCoolId = 0;
            tile._ocCooling = false;
            return;
        }
        for (let key in this._tiles) {
            let known = this._tiles[key];
            if (known && known._ocCoolId === id) {
                known._ocCoolId = 0;
                known._ocCooling = false;
            }
        }
    }

    // Cancels a cooldown in progress. `keepFill` leaves the fill as it is, for a
    // tile that is going away anyway.
    _stopCooling(tile, keepFill) {
        if (!tile) {
            return;
        }
        let id = tile._ocCoolId;
        if (id) {
            this._forgetCooling(id, tile);
            try {
                GLib.source_remove(id);
            } catch (e) {
                // the timer already fired
            }
        }
        tile._ocCoolId = 0;
        tile._ocCooling = false;
        // The row's hold on the tile is not the timer's to drop: a cooldown that
        // is just starting calls this too, and the tile must stay in the row
        // while the sweep runs. _endCooling, _removeTile and _paintTile release
        // the hold at the points where the tile really stops retracting.
        if (!keepFill && tile._ocFill) {
            tile._ocFill.remove_clip();
        }
    }

    // ---- the working bar sweep -----------------------------------------

    // One timer drives the bar of every working tile, the indeterminate progress
    // bar that stands in for the studio's pulsing "working" dot. It runs only
    // while at least one agent works, and only with the animation setting on;
    // otherwise each bar stays lit across the whole tile.
    _syncBar() {
        let working = false;
        for (let id in this._tiles) {
            if (this._states[id] === "working") {
                working = true;
                break;
            }
        }
        if (working && this.animateTiles) {
            if (!this._barTimer) {
                let started = GLib.get_monotonic_time() / 1000;
                this._barTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
                    let elapsed = GLib.get_monotonic_time() / 1000 - started;
                    this._paintBarFrame(elapsed);
                    return GLib.SOURCE_CONTINUE;
                });
                this._paintBarFrame(0);
            }
            return;
        }
        this._stopBar();
    }

    // Stops the sweep and repaints every bar, so a tile whose session is no
    // longer working loses it and an unanimated one keeps a full, steady bar.
    _stopBar() {
        if (this._barTimer) {
            GLib.source_remove(this._barTimer);
            this._barTimer = 0;
        }
        for (let id in this._tiles) {
            this._paintBar(this._tiles[id], this._states[id]);
        }
    }

    // Reveals the stretch of the sweep the bar is at this instant by clipping the
    // bright layer to it - a frame's work is a rectangle, not a reallocation, so
    // the sweep can never disturb the row's layout.
    _paintBarFrame(elapsed) {
        let band = barThickness();
        for (let id in this._tiles) {
            let tile = this._tiles[id];
            let bar = tile ? tile._ocBar : null;
            if (!bar || !bar.visible || this._states[id] !== "working") {
                continue;
            }
            try {
                // The band runs across the tile, so the sweep travels along its
                // width and the clip keeps to its height.
                let part = Easing.barSweep(elapsed, bar.get_width());
                bar.set_clip(Math.round(part.start), 0, Math.round(part.length), band);
            } catch (e) {
                // the actor went away underneath us; the next render tidies up
            }
        }
    }

    // ---- acknowledging a finished agent --------------------------------

    // Only a finished (green) agent can be acknowledged; clicking a working or
    // blocked tile just opens the menu. Marking a live session would otherwise
    // swallow the green fill the moment it finishes.
    _acknowledge(id) {
        if (!id || Tiles.isMarker(id) || this._states[id] !== "done") {
            return;
        }
        let session = this._known[id] || null;
        this._acknowledged[id] = true;
        this._states[id] = "idle";
        delete this._known[id];
        this._view(session);
        this._renderTiles(this._model);
        this._renderMenu(this._model);
    }

    _acknowledgeAll() {
        let finished = [];
        for (let id in this._states) {
            if (this._states[id] === "done") {
                if (this._known[id]) {
                    finished.push(this._known[id]);
                }
                this._acknowledged[id] = true;
                this._states[id] = "idle";
                delete this._known[id];
            }
        }
        for (let i = 0; i < finished.length; i++) {
            this._view(finished[i]);
        }
        this._renderTiles(this._model);
        this._renderMenu(this._model);
    }

    // Tell the server the finish has been looked at, so the studio (and the TUI)
    // drop their own dot for the same conversation. The panel has already
    // cleared it here, so this is best effort.
    _view(session) {
        if (!this._monitor || !session || typeof this._monitor.view !== "function") {
            return;
        }
        try {
            this._monitor.view(session);
        } catch (e) {
            this._error("cannot mark the session viewed", e);
        }
    }

    // ---- animation -----------------------------------------------------

    // Slides a tile in from the left, fading it in.
    _animateIn(actor, id, animate) {
        if (!animate) {
            return;
        }
        let distance = id === Tiles.IDLE ? 0 : this._slideDistance();
        actor.set_opacity(0);
        actor.set_translation(-distance, 0, 0);
        this._slide(actor, {
            translationFrom: -distance,
            translationTo: 0,
            opacityFrom: 0,
            opacityTo: 255,
            duration: IN_ANIMATION_MS,
            curve: Easing.EASE_OUT,
        });
    }

    // Slides a tile out to the left, fading it out, then destroys it. The tiles
    // to its right are pulled left by the same width for the duration, so the
    // row does not jump when the actor finally disappears.
    _removeTile(id, animate) {
        let actor = this._tiles[id];
        delete this._tiles[id];
        delete this._cooling[id];
        if (!actor) {
            return;
        }
        // A tile leaving mid-cooldown keeps its fill: the slide-out is its own
        // animation, and a fill snapping back would flash just before it goes.
        this._stopCooling(actor, true);
        if (!animate) {
            actor.destroy();
            return;
        }
        this._slideOut(actor, id);
    }

    _slideOut(actor, id) {
        let index = this._tileIds.indexOf(id);
        let width = actor.get_width() + this._tileSpacing();
        let following = [];
        if (index >= 0 && width > 0) {
            for (let i = index + 1; i < this._tileIds.length; i++) {
                let sibling = this._tiles[this._tileIds[i]];
                if (!sibling) {
                    continue;
                }
                following.push(sibling);
                this._slide(sibling, {
                    translationFrom: sibling.translation_x,
                    translationTo: sibling.translation_x - width,
                    opacityFrom: sibling.opacity,
                    opacityTo: sibling.opacity,
                    duration: OUT_ANIMATION_MS,
                    curve: Easing.EASE_IN,
                });
            }
        }

        this._slide(actor, {
            translationFrom: actor.translation_x,
            translationTo: -this._slideDistance(),
            opacityFrom: actor.opacity,
            opacityTo: 0,
            duration: OUT_ANIMATION_MS,
            curve: Easing.EASE_IN,
            onComplete: function () {
                actor.destroy();
                // the layout drops the freed slot in the same frame, so the
                // shift can be given back without moving anything on screen
                for (let i = 0; i < following.length; i++) {
                    following[i].set_translation(0, 0, 0);
                }
            },
        });
    }

    // Moves a tile right or left by taking the space back over several frames.
    // Cinnamon skips Clutter easing when desktop animations are off, so the
    // interpolation is done here.
    _slide(actor, options) {
        let duration = Math.max(1, options.duration);
        let started = GLib.get_monotonic_time() / 1000;
        let self = this;
        let id = 0;

        // keeps the timer registry honest, so removing the applet never tries to
        // cancel a timeout that already finished
        let forget = function () {
            let index = self._animations.indexOf(id);
            if (index >= 0) {
                self._animations.splice(index, 1);
            }
        };

        let step = function () {
            let elapsed = GLib.get_monotonic_time() / 1000 - started;
            let p = Easing.progress(elapsed, duration, options.curve);
            try {
                actor.set_translation(Easing.value(options.translationFrom, options.translationTo, p), 0, 0);
                actor.set_opacity(Math.round(Easing.value(options.opacityFrom, options.opacityTo, p)));
            } catch (e) {
                // the actor went away underneath us (applet removed, rebuild)
                forget();
                return GLib.SOURCE_REMOVE;
            }
            if (elapsed >= duration) {
                forget();
                if (options.onComplete) {
                    options.onComplete();
                }
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        };

        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, step);
        this._animations.push(id);
    }

    _slideDistance() {
        return SLIDE_DISTANCE;
    }

    // Announces a newly filled tile: a frame in the state's colour appears
    // around the whole monitor, closes in on the tile, rests there for a moment
    // and fades out. It is drawn in Main.uiGroup, above the panel and every
    // window, because it starts as the screen's own border; being non-reactive,
    // it never takes a click. The tile is measured every frame, so a row that
    // reflows under the frame still leads it to the right rectangle.
    _flashFrame(tile, state) {
        if (!Main.uiGroup) {
            return;
        }
        // A tile that is not on a stage yet (the applet is still being added to
        // the panel) has no screen rectangle to aim at.
        try {
            if (!tile.get_stage()) {
                return;
            }
        } catch (e) {
            return;
        }
        let monitor = this._monitorRectFor(tile);
        if (monitor.width <= 0 || monitor.height <= 0) {
            return;
        }
        let frame = new St.Widget({
            style_class: FRAME_STYLE,
            reactive: false,
        });
        frame.set_style("border-color: " + State.color(state) + ";");
        frame.set_position(monitor.x, monitor.y);
        frame.set_size(monitor.width, monitor.height);
        Main.uiGroup.add_child(frame);
        this._frames.push(frame);

        let started = GLib.get_monotonic_time() / 1000;
        let self = this;
        let id = 0;

        let finish = function () {
            let index = self._animations.indexOf(id);
            if (index >= 0) {
                self._animations.splice(index, 1);
            }
            let at = self._frames.indexOf(frame);
            if (at >= 0) {
                self._frames.splice(at, 1);
            }
            try {
                frame.destroy();
            } catch (e) {
                // the actor is gone with the screen
            }
            return GLib.SOURCE_REMOVE;
        };

        let step = function () {
            let elapsed = GLib.get_monotonic_time() / 1000 - started;
            let target;
            try {
                let [x, y] = tile.get_transformed_position();
                let [width, height] = tile.get_transformed_size();
                target = {
                    x: x - ALERT_GAP,
                    y: y - ALERT_GAP,
                    width: width + ALERT_GAP * 2,
                    height: height + ALERT_GAP * 2,
                };
            } catch (e) {
                // the tile left the row while the frame was travelling
                return finish();
            }

            let p;
            let opacity = 255;
            if (elapsed < ALERT_HOLD_MS) {
                p = 0;
            } else if (elapsed < ALERT_HOLD_MS + ALERT_TRAVEL_MS) {
                p = Easing.progress(elapsed - ALERT_HOLD_MS, ALERT_TRAVEL_MS, Easing.EASE_OUT);
            } else if (elapsed < ALERT_HOLD_MS + ALERT_TRAVEL_MS + ALERT_SETTLE_MS) {
                p = 1;
            } else {
                p = 1;
                opacity = Math.round(255 * (1 - Easing.progress(
                    elapsed - ALERT_HOLD_MS - ALERT_TRAVEL_MS - ALERT_SETTLE_MS,
                    ALERT_FADE_MS, Easing.LINEAR)));
            }

            let rect = Easing.rect(monitor, target, p);
            try {
                frame.set_position(Math.round(rect.x), Math.round(rect.y));
                frame.set_size(Math.max(1, Math.round(rect.width)),
                    Math.max(1, Math.round(rect.height)));
                frame.set_opacity(opacity);
            } catch (e) {
                return finish();
            }
            if (elapsed >= ALERT_TOTAL_MS) {
                return finish();
            }
            return GLib.SOURCE_CONTINUE;
        };

        // A tile that has already left cancels the frame before its timer is
        // even registered.
        if (!step()) {
            return;
        }
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, step);
        this._animations.push(id);
    }

    // The monitor whose rectangle holds the tile's centre, in stage pixels. The
    // alert frame starts from that monitor's border, so on a multi-monitor
    // desktop it does not flash a screen the tile is not on.
    _monitorRectFor(actor) {
        let monitors = (Main.layoutManager && Main.layoutManager.monitors) || [];
        let x = 0;
        let y = 0;
        try {
            let [tx, ty] = actor.get_transformed_position();
            let [tw, th] = actor.get_transformed_size();
            x = tx + tw / 2;
            y = ty + th / 2;
        } catch (e) {
            // the tile is gone; fall through to the primary monitor
        }
        for (let i = 0; i < monitors.length; i++) {
            let monitor = monitors[i];
            if (x >= monitor.x && x < monitor.x + monitor.width &&
                y >= monitor.y && y < monitor.y + monitor.height) {
                return {
                    x: monitor.x,
                    y: monitor.y,
                    width: monitor.width,
                    height: monitor.height,
                };
            }
        }
        if (Main.layoutManager && Main.layoutManager.primaryMonitor) {
            let monitor = Main.layoutManager.primaryMonitor;
            return {
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
            };
        }
        return { x: 0, y: 0, width: 0, height: 0 };
    }

    // Tears down every alert frame still on screen when the applet leaves the
    // panel. Its timers are cancelled by the caller, so no frame is touched
    // after this.
    _destroyFrames() {
        let frames = this._frames;
        this._frames = [];
        for (let i = 0; i < frames.length; i++) {
            try {
                frames[i].destroy();
            } catch (e) {
                // the actor is gone with the screen
            }
        }
    }

    _tileSpacing() {
        try {
            let spacing = this._tilesBox.get_theme_node().get_length("spacing");
            return spacing > 0 ? spacing : 8;
        } catch (e) {
            return 8;
        }
    }

    // ---- menu ----------------------------------------------------------

    _buildMenu() {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, this._orientation);
        this.menuManager.addMenu(this.menu);

        this._infoItem = new PopupMenu.PopupMenuItem("", { reactive: false });
        this.menu.addMenuItem(this._infoItem);

        this._serversSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._serversSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._seenItem = new PopupMenu.PopupIconMenuItem("Mark finished agents as seen", SEEN_ICON, St.IconType.SYMBOLIC);
        this._seenItem.connect("activate", () => this._acknowledgeAll());
        this.menu.addMenuItem(this._seenItem);

        this._refreshItem = new PopupMenu.PopupIconMenuItem("Refresh now", REFRESH_ICON, St.IconType.SYMBOLIC);
        this._refreshItem.connect("activate", () => {
            if (this._monitor) {
                this._monitor.refresh();
            }
        });
        this.menu.addMenuItem(this._refreshItem);

        this._settingsItem = new PopupMenu.PopupIconMenuItem("Applet settings", SETTINGS_ICON, St.IconType.SYMBOLIC);
        this._settingsItem.connect("activate", () => this.configureApplet());
        this.menu.addMenuItem(this._settingsItem);

        this.menu.connect("open-state-changed", (menu, isOpen) => {
            if (isOpen && this._monitor) {
                this._monitor.refresh();
            }
        });
    }

    _infoLabel(model) {
        if (!model) {
            return "OpenCode Agents - scanning for servers\u2026";
        }
        let parts = [model.active + " active"];
        if (model.blocked) {
            parts.push(model.blocked + " blocked");
        }
        if (model.working) {
            parts.push(model.working + " working");
        }
        let done = this._doneCount();
        if (done) {
            parts.push(done + " finished");
        }
        parts.push(Format.serverSummary(model));
        return "OpenCode Agents - " + parts.join(", ");
    }

    // How many agents are finished but not yet acknowledged.
    _doneCount() {
        let done = 0;
        for (let id in this._states) {
            if (this._states[id] === "done") {
                done++;
            }
        }
        return done;
    }

    _renderMenu(model) {
        let done = this._doneCount();
        this._infoItem.setLabel(this._infoLabel(model));
        this._seenItem.setSensitive(done > 0);
        this._serversSection.removeAll();

        if (!model) {
            return;
        }

        for (let i = 0; i < model.servers.length; i++) {
            let server = model.servers[i];
            // The quiet ones (a finish that has been read) are in the model so
            // the states can tell read from unread; they are not worth a row.
            let sessions = model.sessions.filter((session) => session.serverId === server.id && isWorthListing(session));
            if (sessions.length === 0 && !server.error && !this.menuShowIdleServers) {
                continue;
            }
            this._serversSection.addMenuItem(this._serverItem(server, sessions));
        }

        if (model.servers.length === 0) {
            this._serversSection.addMenuItem(new PopupMenu.PopupMenuItem("No opencode server found", { reactive: false }));
        }
    }

    _serverItem(server, sessions) {
        let live = sessions.filter(function (session) { return session.blocked || session.status === "running"; }).length;
        let finished = sessions.length - live;
        let title = server.id;
        let parts = [];
        if (live) {
            parts.push(live + " active");
        }
        if (finished) {
            parts.push(finished + " finished");
        }
        if (parts.length === 0) {
            parts.push(server.error ? "unreachable" : "idle");
        }
        title += "  \u2014  " + parts.join(", ");
        let item = new PopupMenu.PopupSubMenuMenuItem(title);
        if (server.pid) {
            item.menu.addMenuItem(new PopupMenu.PopupMenuItem("pid " + server.pid + " \u00b7 " + server.projectCount + " projects", { reactive: false }));
        }
        if (server.error) {
            item.menu.addMenuItem(new PopupMenu.PopupMenuItem(Format.truncate(server.error, 70), { reactive: false }));
        }
        for (let i = 0; i < sessions.length; i++) {
            item.menu.addMenuItem(this._sessionItem(sessions[i]));
        }
        return item;
    }

    _sessionItem(session) {
        let state = this._states[session.id] || (session.blocked ? "blocked" : "working");
        let glyph = state === "blocked" ? "\u25cf" :
            (state === "done" ? "\u2713" : "\u25b6");
        let label = glyph + "  " + Format.sessionMenuLabel(session, {
            maxTitleLength: this.menuTitleLength,
            showAgent: true,
            showModel: this.menuShowModel,
        });
        let item = new PopupMenu.PopupSubMenuMenuItem(label);

        if (session.project) {
            item.menu.addMenuItem(new PopupMenu.PopupMenuItem("project " + session.project, { reactive: false }));
        }
        item.menu.addMenuItem(new PopupMenu.PopupMenuItem(Format.truncate(session.title, 80), { reactive: false }));
        if (this.menuShowDirectory && session.directory) {
            item.menu.addMenuItem(new PopupMenu.PopupMenuItem(session.directory, { reactive: false }));
        }
        item.menu.addMenuItem(new PopupMenu.PopupMenuItem("session " + session.id, { reactive: false }));
        item.menu.addMenuItem(new PopupMenu.PopupMenuItem(Format.statusDetail(session), { reactive: false }));
        if (session.agent || session.model) {
            let bits = [];
            if (session.agent) {
                bits.push("agent " + session.agent);
            }
            let model = Format.modelLabel(session.model);
            if (model) {
                bits.push("model " + model);
            }
            item.menu.addMenuItem(new PopupMenu.PopupMenuItem(bits.join(" \u00b7 "), { reactive: false }));
        }
        if (session.updated) {
            item.menu.addMenuItem(new PopupMenu.PopupMenuItem("updated " + Format.elapsedSince(session.updated), { reactive: false }));
        }
        if (this.menuShowCost) {
            let bits = [];
            let cost = Format.formatCost(session.cost);
            if (cost) {
                bits.push("cost " + cost);
            }
            let tokens = Format.tokenCount(session);
            if (tokens) {
                bits.push(tokens + " tokens");
            }
            if (bits.length) {
                item.menu.addMenuItem(new PopupMenu.PopupMenuItem(bits.join(" \u00b7 "), { reactive: false }));
            }
        }
        item.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let copyItem = new PopupMenu.PopupIconMenuItem("Copy session ID", "edit-copy-symbolic", St.IconType.SYMBOLIC);
        copyItem.connect("activate", () => this._copyToClipboard(session.id));
        item.menu.addMenuItem(copyItem);

        // The "copy" action is already the row above - only offer a separate
        // command row when a command is configured.
        if (this.clickAction === "command") {
            let actionItem = new PopupMenu.PopupIconMenuItem("Run command for this session", "system-run-symbolic", St.IconType.SYMBOLIC);
            actionItem.connect("activate", () => this._activateSession(session));
            item.menu.addMenuItem(actionItem);
        }

        item.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        let markItem = new PopupMenu.PopupIconMenuItem("Mark as seen", SEEN_ICON, St.IconType.SYMBOLIC);
        markItem.connect("activate", () => this._acknowledge(session.id));
        item.menu.addMenuItem(markItem);

        return item;
    }

    // ---- actions -------------------------------------------------------

    // Deliberately silent: the applet never raises desktop notifications.
    _copyToClipboard(text) {
        try {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        } catch (e) {
            this._error("clipboard write failed", e);
        }
    }

    _activateSession(session) {
        this._acknowledge(session.id);
        if (this.clickAction === "copy") {
            this._copyToClipboard(session.id);
            return;
        }
        if (this.clickAction !== "command") {
            return;
        }
        let command = this._expand(this.clickCommand, session);
        if (!command) {
            return;
        }
        try {
            Util.spawnCommandLine(command);
        } catch (e) {
            this._error("cannot run " + command, e);
        }
    }

    _expand(template, session) {
        if (!template) {
            return "";
        }
        let values = {
            id: session.id,
            title: session.title,
            project: session.project || "",
            dir: session.directory || "",
            agent: session.agent || "",
            model: Format.modelLabel(session.model) || "",
            status: this._states[session.id] || (session.blocked ? "blocked" : "working"),
        };
        return String(template).replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : values[key]));
    }

    // ---- applet entry points -------------------------------------------

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_middle_clicked() {
        if (this._monitor) {
            this._monitor.refresh();
        }
    }

    on_applet_removed_from_panel() {
        if (this._resizeIdle) {
            GLib.source_remove(this._resizeIdle);
            this._resizeIdle = 0;
            this._resizeQueued = false;
        }
        for (let i = 0; i < this._panelSignals.length; i++) {
            let entry = this._panelSignals[i];
            try {
                entry.actor.disconnect(entry.id);
            } catch (e) {
                // the actor is being torn down with us
            }
        }
        this._panelSignals = [];
        for (let i = 0; i < this._animations.length; i++) {
            GLib.source_remove(this._animations[i]);
        }
        this._animations = [];
        this._destroyFrames();
        if (this._barTimer) {
            GLib.source_remove(this._barTimer);
            this._barTimer = 0;
        }
        if (this._monitor) {
            this._monitor.stop();
            this._monitor = null;
        }
        if (this.settings) {
            this.settings.finalize();
        }
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new OpencodeAgentsApplet(metadata, orientation, panelHeight, instanceId);
}
