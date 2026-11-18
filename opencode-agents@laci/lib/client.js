// Minimal async HTTP client for the opencode v2 server API.
//
// Works with whichever libsoup flavour the running Cinnamon loaded: libsoup3
// (Soup.Session.send_and_read_async, what Cinnamon 6.x links against) or
// libsoup2.4 (Soup.SessionAsync.queue_message, Cinnamon 5.x). No version is
// pinned here on purpose - pinning after the shell has already imported Soup
// only produces warnings, and feature detection is exact.
//
// The server is HTTP Basic authenticated: the username is always "opencode"
// and the password comes from the service file the server wrote when it
// started (see lib/discovery.js).

const Soup = imports.gi.Soup;
const GLib = imports.gi.GLib;

var LIBSOUP_MAJOR = Soup.MAJOR_VERSION;
var HAS_SEND_AND_READ = typeof Soup.Session.prototype.send_and_read_async === "function";

var DEFAULT_TIMEOUT_SECONDS = 5;

var _session = null;

function session(timeoutSeconds) {
    let timeout = timeoutSeconds || DEFAULT_TIMEOUT_SECONDS;
    if (!_session) {
        _session = HAS_SEND_AND_READ ? new Soup.Session() : new Soup.SessionAsync();
        _session.user_agent = "cinnamon-opencode-agents/1.0";
    }
    try {
        _session.timeout = timeout;
    } catch (e) {
        // Older libsoup without the property - requests then rely on the
        // server answering, which a local opencode server always does.
    }
    return _session;
}

function basicAuth(username, password) {
    let raw = new TextEncoder().encode(username + ":" + password);
    return "Basic " + GLib.base64_encode(raw);
}

function decode(bytes) {
    if (!bytes) {
        return "";
    }
    try {
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return "";
    }
}

// Resolves with { status: <http status int>, body: <string> }.
function httpSend(method, url, body, options) {
    let opts = options || {};
    let message = Soup.Message.new(method, url);
    if (!message) {
        return Promise.reject(new Error("invalid URL: " + url));
    }
    if (opts.username && opts.password) {
        message.request_headers.append("Authorization", basicAuth(opts.username, opts.password));
    }
    if (body !== null && body !== undefined) {
        // libsoup 3 wants a GLib.Bytes; libsoup 2.4 takes the payload straight
        // through set_request. Feature detection, so neither has to be pinned.
        let encoded = new TextEncoder().encode(body);
        if (typeof message.set_request_body_from_bytes === "function") {
            message.set_request_body_from_bytes("application/json", new GLib.Bytes(encoded));
        } else if (typeof message.set_request === "function") {
            message.set_request("application/json", Soup.MemoryUse.COPY, encoded);
        }
    }

    if (HAS_SEND_AND_READ) {
        return new Promise(function (resolve, reject) {
            session(opts.timeoutSeconds).send_and_read_async(message, GLib.PRIORITY_DEFAULT, null,
                function (sess, result) {
                    try {
                        let bytes = sess.send_and_read_finish(result);
                        resolve({ status: message.get_status(), body: decode(bytes ? bytes.get_data() : null) });
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    return new Promise(function (resolve, reject) {
        session(opts.timeoutSeconds).queue_message(message, function (sess, msg) {
            try {
                let body = (msg.response_body && msg.response_body.data) ? msg.response_body.data : "";
                resolve({ status: msg.status_code, body: body });
            } catch (e) {
                reject(e);
            }
        });
    });
}

function httpGet(url, options) {
    return httpSend("GET", url, null, options);
}

function withQuery(path, params) {
    let pairs = [];
    for (let key in params) {
        if (params[key] === null || params[key] === undefined) {
            continue;
        }
        pairs.push(encodeURIComponent(key) + "=" + encodeURIComponent(params[key]));
    }
    return pairs.length ? path + "?" + pairs.join("&") : path;
}

// A single opencode v2 server endpoint.
//
// The v2 API wraps the interesting payloads in envelopes: lists come back as
// { data, cursor } and single reads as { data }. The instance-scoped endpoints
// (permissions, forms) pick their project with the `location[directory]` deep
// object, while /api/session takes a flat `directory` parameter.
var OpencodeClient = class OpencodeClient {
    constructor(options) {
        let opts = options || {};
        this.host = opts.host || "127.0.0.1";
        this.port = opts.port;
        this.username = opts.username || "opencode";
        this.password = opts.password || null;
        this.timeoutSeconds = opts.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS;
    }

    get id() {
        return this.host + ":" + this.port;
    }

    url(path) {
        return "http://" + this.host + ":" + this.port + path;
    }

    async getRaw(path, params) {
        return httpGet(this.url(withQuery(path, params || {})), {
            username: this.username,
            password: this.password,
            timeoutSeconds: this.timeoutSeconds,
        });
    }

    async getJson(path, params) {
        let response = await this.getRaw(path, params);
        if (response.status < 200 || response.status >= 300) {
            let error = new Error("HTTP " + response.status + " " + path + " (" + this.id + ")");
            error.status = response.status;
            throw error;
        }
        if (!response.body) {
            return null;
        }
        try {
            return JSON.parse(response.body);
        } catch (e) {
            throw new Error("invalid JSON from " + this.id + path + ": " + e.message);
        }
    }

    // The envelope helper: { data: ... } -> the value, anything else as is.
    async getData(path, params) {
        let payload = await this.getJson(path, params);
        if (payload && !Array.isArray(payload) && payload.data !== undefined) {
            return payload.data;
        }
        return payload;
    }

    // A JSON POST. The server answers 204 to the writes it has nothing to say
    // about, which reads as null.
    async postJson(path, payload) {
        let response = await httpSend("POST", this.url(path), JSON.stringify(payload || {}), {
            username: this.username,
            password: this.password,
            timeoutSeconds: this.timeoutSeconds,
        });
        if (response.status < 200 || response.status >= 300) {
            let error = new Error("HTTP " + response.status + " POST " + path + " (" + this.id + ")");
            error.status = response.status;
            throw error;
        }
        if (!response.body) {
            return null;
        }
        try {
            return JSON.parse(response.body);
        } catch (e) {
            return null;
        }
    }

    // { version, pid, urls, ... } - doubles as the reachability/auth probe.
    async info() {
        return await this.getJson("/api/info");
    }

    // [{ id, canonical, name?, vcs?, time: { created, updated, active, archived? } }]
    // Archived projects (their folder is gone) are asked for as well, so the
    // applet can tell an archived project from a live one.
    async projects() {
        let list = await this.getJson("/api/project", { archived: "true" });
        return Array.isArray(list) ? list : [];
    }

    // { "<sessionID>": { type: "running" } } - the authoritative "is a turn
    // running right now". A session record's own outcome/time.idle describe the
    // last turn that ended, so they cannot answer this.
    async activeSessions() {
        let data = await this.getData("/api/session/active");
        if (!data || typeof data !== "object") {
            return {};
        }
        return data;
    }

    // ["/home/user/project", ...] - the directories the server has currently
    // materialized. A pending permission or question exists only in its own
    // location, so this is the set that has to be swept for one. It is the
    // server's debug endpoint, so callers have to tolerate a failure.
    async locations() {
        let list = await this.getData("/api/debug/location");
        if (!Array.isArray(list)) {
            return [];
        }
        let directories = [];
        for (let i = 0; i < list.length; i++) {
            let directory = list[i] && list[i].directory;
            if (directory && directories.indexOf(directory) < 0) {
                directories.push(directory);
            }
        }
        return directories;
    }

    // The newest sessions first. `parentID: "null"` asks for root
    // conversations only, i.e. the ones the panel shows as tiles.
    async sessions(options) {
        let opts = options || {};
        let payload = await this.getJson("/api/session", {
            limit: opts.limit || 50,
            order: opts.order || "desc",
            parentID: opts.rootsOnly === false ? null : "null",
            directory: opts.directory || null,
        });
        if (!payload || !Array.isArray(payload.data)) {
            return [];
        }
        return payload.data;
    }

    // One session's info (title, agent, model, location, cost, tokens, time). A
    // session that has just been deleted answers 404, which reads as "no info".
    async session(sessionID) {
        try {
            let data = await this.getData("/api/session/" + encodeURIComponent(sessionID));
            return data || null;
        } catch (e) {
            if (e.status === 404) {
                return null;
            }
            throw e;
        }
    }

    // [{ id, sessionID, action, resources, message? }] - permission requests
    // waiting for the user, scoped to one project directory.
    async permissions(directory) {
        let data = await this.getData("/api/permission/request", locationParam(directory));
        return Array.isArray(data) ? data : [];
    }

    // [{ id, sessionID, title, fields }] - agent questions waiting for the user.
    async forms(directory) {
        let data = await this.getData("/api/form", locationParam(directory));
        return Array.isArray(data) ? data : [];
    }

    // Mark the idle transition a viewer has seen. The server keeps it as
    // `time.viewed`, so every client can tell a finish that has been looked at
    // from one that has not - what the studio's green dot means.
    async viewSession(sessionID, idle) {
        return this.postJson("/api/session/" + encodeURIComponent(sessionID) + "/view", { idle: idle });
    }
};

// The instance-scoped endpoints select their project with a deep object,
// `location[directory]=/path`; a flat `directory=` is ignored by them and
// silently falls back to the server's own directory.
function locationParam(directory) {
    if (!directory) {
        return {};
    }
    return { "location[directory]": directory };
}
