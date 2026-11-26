// Polls every discovered opencode v2 server and merges the answers into one
// model.
//
// Per server the sweep is:
//   GET /api/project?archived=true         -> project names (cached with a TTL)
//   GET /api/session/active                -> the sessions a turn runs for now
//   GET /api/debug/location                -> the materialized project directories
//   GET /api/permission/request?location[directory]=<dir>  -> who waits for a human
//   GET /api/form?location[directory]=<dir>                -> ... and who asks a question
//   GET /api/session/<id>                  -> title/agent/model/cost for those ids
//
// The session list is deliberately *not* swept: `/api/session/active` is the
// only authoritative answer to "is it working right now", and a pending
// request is per-location, so the loaded locations are what has to be read for
// one. That keeps a poll to a handful of requests whatever the project count.
//
// The monitor reports the live world only (blocked or working). Whether a
// session that has just finished shows as "done" is the panel's business - see
// lib/state.js.

const GLib = imports.gi.GLib;

const OpencodeClient = imports.lib.client.OpencodeClient;
const Discovery = imports.lib.discovery;

function now() {
    return Date.now();
}

function emptyModel() {
    return { at: 0, servers: [], sessions: [], active: 0, blocked: 0, working: 0, done: 0, errors: [] };
}

// Run `worker` over `items` with at most `limit` in flight, preserving order.
async function mapLimit(items, limit, worker) {
    let results = new Array(items.length);
    let next = 0;
    let workers = [];
    let count = Math.max(1, Math.min(limit, items.length));
    for (let i = 0; i < count; i++) {
        workers.push((async function () {
            while (true) {
                let index = next++;
                if (index >= items.length) {
                    return;
                }
                results[index] = await worker(items[index], index);
            }
        })());
    }
    await Promise.all(workers);
    return results;
}

// "permission: bash" - the short reason a session is blocked, for the tile's
// tooltip and the menu. A question is just a question.
function blockedReason(entry) {
    if (entry.kind === "question") {
        return "question";
    }
    return "permission: " + (entry.action || "approval");
}

function blockedDetail(entry) {
    if (entry.kind === "question") {
        return entry.title || null;
    }
    if (entry.message) {
        return entry.message;
    }
    if (entry.resources && entry.resources.length) {
        return entry.resources.join(", ");
    }
    return entry.action || null;
}

var Monitor = class Monitor {
    // options: { intervalSeconds, metadataTtlSeconds, maxLocations,
    //            discoverOptions, onUpdate, onError, log }
    constructor(options) {
        let opts = options || {};
        this.intervalMs = Math.max(500, (opts.intervalSeconds || 2) * 1000);
        this.metadataTtlMs = (opts.metadataTtlSeconds === undefined ? 30 : opts.metadataTtlSeconds) * 1000;
        this.maxLocations = opts.maxLocations || 12;
        this.discoverOptions = opts.discoverOptions || {};
        this.onUpdate = opts.onUpdate || function () {};
        this.onError = opts.onError || function () {};
        this.log = opts.log || function () {};

        this._timer = 0;
        this._busy = false;
        this._stopped = true;
        this._servers = [];
        this._projectCache = {};
        this._sessionCache = {};
        // A session's title is filled in by the server shortly after it starts,
        // so a record that arrived without one is re-read on the next poll
        // rather than trusted for the whole metadata TTL.
        this._titlelessTtlMs = Math.max(1000, this.intervalMs);
        this._model = emptyModel();
    }

    get running() {
        return !this._stopped;
    }

    get model() {
        return this._model;
    }

    start() {
        if (!this._stopped) {
            return;
        }
        this._stopped = false;
        this.refresh();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.intervalMs, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        this._stopped = true;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
    }

    // Force a sweep, ignoring the interval. Resolves with the model.
    async refresh() {
        if (this._stopped || this._busy) {
            return this._model;
        }
        this._busy = true;
        try {
            let servers = Discovery.discover(this.discoverOptions);
            this._servers = servers;
            let results = await mapLimit(servers, 4, (server) => this._scanServer(server));
            this._pruneCaches();
            this._model = this._buildModel(servers, results);
            this.onUpdate(this._model);
            return this._model;
        } catch (e) {
            this.onError(e);
            return this._model;
        } finally {
            this._busy = false;
        }
    }

    // Drop the per-session info that has not been asked for in a long while, so
    // a panel left running for days does not grow a cache without bound.
    _pruneCaches() {        let cutoff = now() - Math.max(this.metadataTtlMs * 10, 60000);
        for (let key in this._sessionCache) {
            if (this._sessionCache[key].at < cutoff) {
                delete this._sessionCache[key];
            }
        }
    }

    // Tell the server this conversation's finish has been looked at, so every
    // other client (the studio, the TUI) drops its own green dot for it too.
    // Best effort: the panel has already acknowledged it locally.
    async view(session) {
        if (!session || !session.id || !session.idle) {
            return false;
        }
        let server = null;
        for (let i = 0; i < this._servers.length; i++) {
            if (this._servers[i].id === session.serverId) {
                server = this._servers[i];
                break;
            }
        }
        if (!server) {
            return false;
        }
        try {
            await new OpencodeClient(server).viewSession(session.id, session.idle);
            // The cached copy still says "unviewed"; forget it so the next poll
            // asks the server again rather than trusting the stale record.
            delete this._sessionCache[server.id + "|" + session.id];
            return true;
        } catch (e) {
            this.log("opencode-agents: " + server.id + " could not mark " + session.id + " viewed: " + e.message);
            return false;
        }
    }

    // The known projects of a server, cached for a while: the list is
    // machine-wide and changes rarely, while the status poll runs every tick.
    async _projects(client, server) {
        let cached = this._projectCache[server.id];
        if (cached && now() - cached.at < this.metadataTtlMs) {
            return cached;
        }
        let list = await client.projects();
        let names = {};
        let count = 0;
        for (let i = 0; i < list.length; i++) {
            let project = list[i];
            if (!project || !project.canonical || project.time && project.time.archived) {
                continue;
            }
            count++;
            if (project.name) {
                names[project.canonical] = project.name;
            }
        }
        let entry = { at: now(), names: names, count: count };
        this._projectCache[server.id] = entry;
        return entry;
    }

    // Session info for an id, refreshed when it is stale. One id at a time:
    // the panel only ever asks about the handful of sessions that are live.
    // A record without a title is already stale: the server names a
    // conversation a moment after it starts, so the title would otherwise be
    // pinned to the session id for the whole metadata TTL.
    async _session(client, server, id) {
        let key = server.id + "|" + id;
        let cached = this._sessionCache[key];
        if (cached) {
            let ttl = cached.info && cached.info.title ? this.metadataTtlMs : this._titlelessTtlMs;
            if (now() - cached.at < ttl) {
                return cached.info;
            }
        }
        let info = null;
        try {
            info = await client.session(id);
        } catch (e) {
            this.log("opencode-agents: " + server.id + " session " + id + " failed: " + e.message);
        }
        this._sessionCache[key] = { at: now(), info: info };
        return info;
    }

    // The pending permissions and questions of one project directory.
    async _blocked(client, server, directory) {
        let blocked = {};
        let results = await mapLimit(["permissions", "forms"], 2, async (kind) => {
            try {
                return { kind: kind, list: kind === "permissions" ? await client.permissions(directory) : await client.forms(directory) };
            } catch (e) {
                this.log("opencode-agents: " + server.id + " " + kind + " for " + directory + " failed: " + e.message);
                return { kind: kind, list: [], failed: true };
            }
        });
        for (let i = 0; i < results.length; i++) {
            let kind = results[i].kind;
            let list = results[i].list;
            for (let j = 0; j < list.length; j++) {
                let request = list[j];
                if (!request || !request.sessionID) {
                    continue;
                }
                let entry = kind === "permissions"
                    ? { kind: "permission", action: request.action, resources: request.resources, message: request.message, id: request.id }
                    : { kind: "question", title: request.title, id: request.id };
                entry.directory = directory;
                // A permission beats a question for the same session: it is the
                // one that stopped the tool call.
                if (!blocked[request.sessionID] || kind === "permissions") {
                    blocked[request.sessionID] = entry;
                }
            }
        }
        return blocked;
    }

    async _scanServer(server) {
        let client = new OpencodeClient(server);
        let result = {
            server: server,
            ok: false,
            error: null,
            sessions: [],
            projectCount: 0,
        };

        let projects = { names: {}, count: 0 };
        try {
            projects = await this._projects(client, server);
        } catch (e) {
            this.log("opencode-agents: " + server.id + " /api/project failed: " + e.message);
        }
        result.projectCount = projects.count;

        // The active read is the reachability probe as well as the status: a v2
        // server always answers it, so a failure means the server is down or
        // refuses the credentials.
        let active = {};
        try {
            active = await client.activeSessions();
        } catch (e) {
            result.error = e.message;
            return result;
        }

        let locations = [];
        try {
            locations = (await client.locations()).slice(0, this.maxLocations);
        } catch (e) {
            // A server too old for the debug endpoint still reports its own
            // directory.
            this.log("opencode-agents: " + server.id + " /api/debug/location failed: " + e.message);
        }
        if (locations.length === 0 && server.cwd) {
            locations = [server.cwd];
        }

        let blockedBySession = {};
        let blockedCount = 0;
        let locationResults = await mapLimit(locations, 4, (directory) => this._blocked(client, server, directory));
        for (let i = 0; i < locationResults.length; i++) {
            let blocked = locationResults[i];
            for (let id in blocked) {
                blockedCount++;
                if (!blockedBySession[id] || blocked[id].kind === "permission") {
                    blockedBySession[id] = blocked[id];
                }
            }
        }

        let ids = {};
        let order = [];
        for (let id in active) {
            if (!ids[id]) {
                ids[id] = true;
                order.push(id);
            }
        }
        for (let id in blockedBySession) {
            if (!ids[id]) {
                ids[id] = true;
                order.push(id);
            }
        }

        // The newest root conversation of every project - the row the studio's
        // dot belongs to - whether or not anybody has read it. A finish nobody
        // has read is a green tile; one that has been read is reported as plain
        // idle, which is what stops the panel inventing a green tile for a
        // conversation the studio already shows grey. The list is ordered by
        // activity, so the first entry seen for a directory is that project's
        // newest conversation.
        let doneIds = {};
        let seenIds = {};
        let known = {};
        try {
            let roots = await client.sessions({ limit: 200, order: "desc", rootsOnly: true });
            for (let i = 0; i < roots.length; i++) {
                let info = roots[i];
                if (!info || !info.id || ids[info.id]) {
                    continue;
                }
                let directory = info.location && info.location.directory;
                if (directory) {
                    if (known[directory]) {
                        continue;
                    }
                    known[directory] = true;
                }
                let time = info.time || {};
                if (!time.idle) {
                    continue;
                }
                // "Seen" is the server's own marker: a viewer posts the idle
                // transition it looked at, and time.viewed records it. Nothing
                // else can tell a finish somebody has read from one they have
                // not - it is what the studio's dot means too.
                if (time.viewed && time.viewed >= time.idle) {
                    seenIds[info.id] = info;
                } else {
                    doneIds[info.id] = info;
                }
                ids[info.id] = true;
                order.push(info.id);
            }
        } catch (e) {
            this.log("opencode-agents: " + server.id + " recent session list failed: " + e.message);
        }

        let infos = await mapLimit(order, 6, (id) => doneIds[id] || this._session(client, server, id));
        for (let i = 0; i < order.length; i++) {
            let id = order[i];
            let info = infos[i];
            let blocked = blockedBySession[id] || null;
            result.sessions.push(this._buildSession(id, {
                active: !!active[id],
                blocked: blocked,
                done: !!doneIds[id],
                seen: !!seenIds[id],
                info: info,
                server: server,
                projects: projects.names,
            }));
        }

        result.blockedCount = blockedCount;
        result.ok = true;
        return result;
    }

    _buildSession(id, ctx) {
        let info = ctx.info;
        let blocked = ctx.blocked;
        let directory = (info && info.location && info.location.directory) || (blocked && blocked.directory) || ctx.server.cwd || null;
        let project = null;
        if (directory) {
            project = ctx.projects[directory] || null;
            if (!project) {
                project = directory.split("/").filter(function (part) { return part.length > 0; }).pop() || directory;
            }
        }
        let model = info && info.model ? (info.model.id || info.model.modelID || null) : null;
        return {
            id: id,
            title: info && info.title ? info.title : id,
            project: project,
            directory: directory,
            agent: info && info.agent ? info.agent : null,
            model: model,
            status: ctx.active ? "running" : "idle",
            blocked: !!blocked,
            done: !!ctx.done,
            // Finished and already read: reported so the panel knows the
            // conversation is not news, never shown as a green tile of its own.
            seen: !!ctx.seen,
            blockedReason: blocked ? blockedReason(blocked) : null,
            blockedDetail: blocked ? blockedDetail(blocked) : null,
            parentID: info && info.parentID ? info.parentID : null,
            cost: info && typeof info.cost === "number" ? info.cost : null,
            tokens: info && info.tokens ? info.tokens : null,
            created: info && info.time ? info.time.created : null,
            updated: info && info.time ? info.time.updated : null,
            // The idle transition this conversation is sitting on, and whether
            // somebody has already looked at it.
            idle: info && info.time ? info.time.idle : null,
            viewed: info && info.time ? info.time.viewed : null,
            serverId: ctx.server.id,
            serverLabel: Discovery.label(ctx.server),
            serverSource: ctx.server.source,
        };
    }

    _buildModel(servers, results) {
        // One row per session id: two servers can both know about a session
        // (a restarted service, a hand-started twin), and the panel should not
        // list it twice. A blocked report beats a running one.
        let byId = {};
        let order = [];
        let serverModels = [];
        let errors = [];

        for (let i = 0; i < results.length; i++) {
            let result = results[i];
            let server = result.server;
            serverModels.push({
                id: server.id,
                host: server.host,
                port: server.port,
                source: server.source,
                pid: server.pid,
                ok: result.ok,
                error: result.error,
                projectCount: result.projectCount,
                activeCount: result.sessions.length,
                blockedCount: result.blockedCount || 0,
            });
            if (result.error) {
                errors.push(server.id + ": " + result.error);
            }
            for (let s = 0; s < result.sessions.length; s++) {
                let session = result.sessions[s];
                let existing = byId[session.id];
                if (!existing) {
                    byId[session.id] = session;
                    order.push(session.id);
                    continue;
                }
                // A blocked report wins over a running one.
                let preferred = session.blocked && !existing.blocked ? session : existing;
                let other = preferred === session ? existing : session;
                preferred.reportedBy = (preferred.reportedBy || [preferred.serverId]).concat(other.reportedBy || [other.serverId]);
                byId[session.id] = preferred;
            }
        }

        let sessions = [];
        let blocked = 0;
        let working = 0;
        let done = 0;
        for (let i = 0; i < order.length; i++) {
            let session = byId[order[i]];
            if (session.blocked) {
                blocked++;
            } else if (session.done) {
                done++;
            } else if (session.status === "running") {
                working++;
            }
            sessions.push(session);
        }

        // Most interesting first: a session waiting for a human, then working,
        // then a finish nobody has read, then the quiet ones, then newest.
        let rank = function (session) {
            if (session.blocked) {
                return 0;
            }
            if (session.status === "running") {
                return 1;
            }
            return session.done ? 2 : 3;
        };
        sessions.sort(function (a, b) {
            let ra = rank(a);
            let rb = rank(b);
            if (ra !== rb) {
                return ra - rb;
            }
            return (b.updated || 0) - (a.updated || 0);
        });

        // Keep every server's own tally in step with what the menu shows. Only
        // the live sessions count as active; a finished one is its own thing.
        for (let i = 0; i < serverModels.length; i++) {
            serverModels[i].activeCount = sessions.filter(function (session) {
                return session.serverId === serverModels[i].id && (session.blocked || session.status === "running");
            }).length;
        }

        return {
            at: now(),
            servers: serverModels,
            sessions: sessions,
            active: blocked + working,
            blocked: blocked,
            working: working,
            done: done,
            errors: errors,
        };
    }
};
