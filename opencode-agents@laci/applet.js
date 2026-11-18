// Cinnamon panel applet showing the opencode v2 agents that are working right
// now.
//
// The panel lists one tile per live conversation, side by side. A tile is two
// lines of text with a status dot to their left:
//
//     ●  uhk.io
//        Fix the widget tests
//
// The top line is the project, the bottom line the conversation's subject. The
// dot carries the state, with the vocabulary and colours of the opencode
// project studio: red blocked (an agent waits for you), amber working, green
// finished but not yet acknowledged, grey nothing to do. A working dot pulses;
// clicking a finished tile acknowledges it and the tile slides away.
//
// The menu has the details (project, agent, model, status, cost) and the
// per-session actions. See lib/state.js for the dots and lib/monitor.js for the
// polling.

const Applet = imports.ui.applet;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
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
const DOT_STYLE = "opencode-agents-dot";
const IN_ANIMATION_MS = 250;
const OUT_ANIMATION_MS = 200;
const FRAME_MS = 16;
const PULSE_FRAME_MS = 40;
const IDLE_ICON_SIZE = 20;

// What the panel is about: a session waiting for a human, one that is running,
// or a finish nobody has read yet. The monitor also reports the conversations
// that *have* been read, but only so a dot can never be invented for them.
function isWorthListing(session) {
    return !!(session && (session.blocked || session.done || session.status === "running"));
}

// St.Icon multiplies icon_size by the stage scale factor, while the sizes in the
// applet's settings are plain pixels, so undo that here.
function iconSizeFor(pixels) {
    let scale = 1;
    try {
        scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    } catch (e) {
        scale = 1;
    }
    return Math.max(1, Math.round(pixels / scale));
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
        this._states = {};        // session id -> dot state (blocked/working/done/idle)
        this._known = {};         // session id -> last known session info
        this._acknowledged = {};  // session id -> true, once the user has seen it
        this._pulseTimer = 0;

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
        this.settings.bind("tile-project-length", "tileProjectLength", this._onAppearanceChanged);
        this.settings.bind("tile-subject-length", "tileSubjectLength", this._onAppearanceChanged);
        this.settings.bind("tile-show-project", "tileShowProject", this._onAppearanceChanged);
        this.settings.bind("tile-show-subject", "tileShowSubject", this._onAppearanceChanged);
        this.settings.bind("dot-size", "dotSize", this._onAppearanceChanged);
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

    // Folds the live sessions into the dots, keeping a finished agent visible
    // until the user acknowledges it. See lib/state.js.
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
        return State.display(this._states, sessions);
    }

    // The tile row is diffed against the previous poll and animated: a session
    // that starts slides in, one that leaves slides out, and tiles that stay
    // are only moved and refreshed.
    _renderTiles(model) {
        let entries = this._entries();
        let appearance = [this.tilesMax, this.tileProjectLength, this.tileSubjectLength, this.tileShowProject,
                          this.tileShowSubject, this.dotSize, this.hideWhenIdle].join("|");

        if (appearance !== this._tilesAppearance) {
            // A visual setting changed: rebuild instantly, nothing to animate.
            this._tilesAppearance = appearance;
            this._dropTiles();
        }

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
        this._tilesRendered = true;
        this._tilesBox.visible = !(entries.length === 0 && this.hideWhenIdle);
        this._syncPulse();
    }

    _dropTiles() {
        this._stopPulse();
        for (let id in this._tiles) {
            this._tiles[id].destroy();
        }
        this._tiles = {};
        this._tileIds = [];
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

    // One agent: a status dot, and the project over the conversation subject.
    _sessionTile(id, entry) {
        let tile = new St.BoxLayout({
            style_class: "opencode-agents-tile",
            reactive: true,
        });
        tile.set_y_align(Clutter.ActorAlign.CENTER);
        tile.set_x_align(Clutter.ActorAlign.CENTER);

        let dot = new St.Widget({ style_class: DOT_STYLE });
        dot.set_size(this.dotSize, this.dotSize);
        dot.set_x_align(Clutter.ActorAlign.CENTER);
        dot.set_y_align(Clutter.ActorAlign.CENTER);
        tile.add_child(dot);
        tile._ocDot = dot;

        let text = new St.BoxLayout({
            style_class: "opencode-agents-tile-text",
            vertical: true,
            reactive: false,
        });
        text.set_y_align(Clutter.ActorAlign.CENTER);
        text.set_x_align(Clutter.ActorAlign.START);
        tile.add_child(text);
        tile._ocText = text;
        tile._ocProject = null;
        tile._ocSubject = null;
        tile._ocId = id;

        // Clicking a tile acknowledges its finished agent (the green dot) and
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
        let session = this._known[id] || null;
        let state = entry.state;

        this._paintDot(actor._ocDot, state);

        let text = actor._ocText;
        if (!text) {
            return;
        }
        let wantsProject = this.tileShowProject && session && session.project;
        let wantsSubject = this.tileShowSubject && session && session.title;
        this._syncLabel(actor, "_ocProject", text, wantsProject ? Format.truncate(session.project, this.tileProjectLength) : null,
            "opencode-agents-tile-project", 0);
        this._syncLabel(actor, "_ocSubject", text, wantsSubject ? Format.truncate(session.title, this.tileSubjectLength) : null,
            "opencode-agents-tile-subject", 1);
        text.visible = !!(wantsProject || wantsSubject);
    }

    // Adds, updates or drops one of a tile's two lines, so a setting change or
    // a missing value does not leave a stale label behind.
    _syncLabel(tile, slot, text, wanted, styleClass, index) {
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
            tile[slot] = label;
            text.insert_child_at_index(label, Math.min(index, text.get_children().length));
        } else if (label.get_text() !== wanted) {
            label.set_text(wanted);
        }
    }

    // The status dot: the studio's colour, plus the pulse for a working agent.
    _paintDot(dot, state) {
        if (!dot) {
            return;
        }
        dot.set_style("background-color: " + State.color(state) + "; border-radius: " + (this.dotSize / 2) + "px;");
        dot.opacity = 255;
    }

    // ---- the working pulse ---------------------------------------------

    // One timer drives every working dot, matching the studio's pulsing
    // "working" dot. It runs only while at least one agent works, and only
    // with the animation setting on; otherwise the dots stay solid.
    _syncPulse() {
        let working = false;
        for (let id in this._tiles) {
            if (this._states[id] === "working") {
                working = true;
                break;
            }
        }
        if (working && this.animateTiles) {
            if (!this._pulseTimer) {
                let started = GLib.get_monotonic_time() / 1000;
                this._pulseTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PULSE_FRAME_MS, () => {
                    let elapsed = GLib.get_monotonic_time() / 1000 - started;
                    this._paintPulse(elapsed);
                    return GLib.SOURCE_CONTINUE;
                });
                this._paintPulse(0);
            }
            return;
        }
        this._stopPulse();
    }

    _stopPulse() {
        if (this._pulseTimer) {
            GLib.source_remove(this._pulseTimer);
            this._pulseTimer = 0;
        }
        this._paintPulse(0);
    }

    _paintPulse(elapsed) {
        let opacity = Easing.pulseOpacity(elapsed);
        for (let id in this._tiles) {
            let tile = this._tiles[id];
            if (tile && tile._ocDot && this._states[id] === "working") {
                tile._ocDot.opacity = opacity;
            }
        }
    }

    // ---- acknowledging a finished agent --------------------------------

    // Only a finished (green) agent can be acknowledged; clicking a working or
    // blocked tile just opens the menu. Marking a live session would otherwise
    // swallow the green dot the moment it finishes.
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
        if (!actor) {
            return;
        }
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
        return Math.max(24, this.dotSize + 12);
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
            // the dots can tell read from unread; they are not worth a row.
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
        for (let i = 0; i < this._animations.length; i++) {
            GLib.source_remove(this._animations[i]);
        }
        this._animations = [];
        if (this._pulseTimer) {
            GLib.source_remove(this._pulseTimer);
            this._pulseTimer = 0;
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
