// Finding the opencode v2 servers that are running on this machine.
//
// A v2 server is a single shared background service that multiplexes every
// project, so unlike v1 (and unlike kilo) one server is normally enough. It
// registers itself when it starts, and the applet reads that registration:
//
//   1. the service file - ~/.local/state/opencode/service.json, written by
//      `opencode serve --service` with the url, pid and password
//   2. servers the user listed in the applet settings
//   3. a /proc scan - every `opencode ... serve` process of this user, for a
//      server started by hand on its own port and never registered

const GLib = imports.gi.GLib;

const Procfs = imports.lib.procfs;

var DEFAULT_HOST = "127.0.0.1";
var DEFAULT_USERNAME = "opencode";

// argv[0] of a shell is never an opencode server, even when its command line
// mentions `serve --port N` (a terminal running that command looks otherwise
// identical).
var SHELLS = ["sh", "bash", "dash", "zsh", "ksh", "fish", "csh", "tcsh", "busybox"];

function isShell(argv) {
    if (!argv || argv.length === 0) {
        return false;
    }
    let program = argv[0].split("/").pop().toLowerCase();
    return SHELLS.indexOf(program) >= 0;
}

// $XDG_STATE_HOME/opencode/service.json, defaulting to ~/.local/state.
function defaultServiceFile() {
    let base = null;
    try {
        base = GLib.get_user_state_dir();
    } catch (e) {
        base = null;
    }
    if (!base) {
        base = GLib.build_filenamev([GLib.get_home_dir(), ".local", "state"]);
    }
    return GLib.build_filenamev([base, "opencode", "service.json"]);
}

function makeServer(fields) {
    let server = {
        host: fields.host || DEFAULT_HOST,
        port: parseInt(fields.port, 10),
        username: fields.username || DEFAULT_USERNAME,
        password: fields.password || null,
        source: fields.source || "unknown",
        pid: fields.pid || null,
        cmdline: fields.cmdline || null,
        cwd: fields.cwd || null,
    };
    if (!server.port || isNaN(server.port)) {
        return null;
    }
    server.id = server.host + ":" + server.port;
    return server;
}

function label(server) {
    let text = server.id;
    if (server.pid) {
        text += " (pid " + server.pid + ")";
    }
    return text;
}

function parseUrl(text) {
    let match = /^(?:https?:\/\/)?([^\/:]+)(?::(\d+))?/.exec(String(text).trim());
    if (!match) {
        return null;
    }
    return { host: match[1], port: match[2] ? parseInt(match[2], 10) : null };
}

// "host:port", "host:port:username:password" or "http://host:port".
function parseServerSpec(text) {
    let spec = text.trim();
    if (!spec || spec.startsWith("#")) {
        return null;
    }
    let parsed = parseUrl(spec);
    if (!parsed || !parsed.port) {
        return null;
    }
    let rest = spec.replace(/^(?:https?:\/\/)?[^\/:]+:\d+/, "");
    let credentials = rest.replace(/^[:\s]+/, "").split(":");
    return makeServer({
        host: parsed.host,
        port: parsed.port,
        username: credentials.length > 0 && credentials[0] ? credentials[0] : DEFAULT_USERNAME,
        password: credentials.length > 1 && credentials[1] ? credentials[1] : null,
        source: "config",
    });
}

function parseExtraServers(text) {
    if (!text) {
        return [];
    }
    let servers = [];
    let lines = text.split(/[\n,]/);
    for (let i = 0; i < lines.length; i++) {
        let server = parseServerSpec(lines[i]);
        if (server) {
            servers.push(server);
        }
    }
    return servers;
}

// The service file written by `opencode serve --service`:
//   { id, version, url: "http://127.0.0.1:4097", pid, password }
function fromServiceFile(path, options) {
    let file = path || defaultServiceFile();
    let text = Procfs.readText(file);
    if (!text) {
        return [];
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        if (options && options.log) {
            options.log("opencode-agents: ignoring unreadable service file " + file + ": " + e.message);
        }
        return [];
    }
    let host = DEFAULT_HOST;
    let port = data.port;
    let parsed = parseUrl(data.url || data.urls && data.urls.local || "");
    if (parsed) {
        host = parsed.host || host;
        port = port || parsed.port;
    }
    if (data.hostname === "localhost") {
        host = DEFAULT_HOST;
    } else if (data.hostname) {
        host = data.hostname;
    }
    let server = makeServer({
        host: host,
        port: port,
        username: data.username,
        password: data.password,
        pid: data.pid,
        source: "service",
    });
    return server ? [server] : [];
}

function flagValue(argv, flag) {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === flag && i + 1 < argv.length) {
            return argv[i + 1];
        }
        if (argv[i].startsWith(flag + "=")) {
            return argv[i].slice(flag.length + 1);
        }
    }
    return null;
}

function hasToken(argv, token) {
    return argv.indexOf(token) >= 0;
}

// Test doubles started by tests/bin/opencode carry this marker so that running
// the test suite cannot pollute a live panel.
var MOCK_MARKER = "OPENCODE_AGENTS_MOCK";

function isMock(env) {
    return !!(env && env[MOCK_MARKER]);
}

// An opencode process announces itself in its environment. `OPENCODE` alone is
// not enough (every agent-spawned child carries it), so the caller also asks
// for the `serve` subcommand on the command line.
function looksLikeOpencodeEnv(env) {
    if (!env) {
        return false;
    }
    if (env.OPENCODE || env.OPENCODE_TERMINAL || env.AI_AGENT === "opencode") {
        return true;
    }
    for (let key in env) {
        if (key.startsWith("OPENCODE_")) {
            return true;
        }
    }
    return false;
}

// Every `opencode ... serve` process owned by the current user.
// options: { includeMocks } - the applet leaves that false, the test suite sets it.
function fromProc(options) {
    let opts = options || {};
    let self = Procfs.selfPid();
    let servers = [];
    let pids = Procfs.pidList();
    let listeners = Procfs.listenInodes();
    for (let i = 0; i < pids.length; i++) {
        let pid = pids[i];
        if (pid === self) {
            continue;
        }
        let argv = Procfs.cmdline(pid);
        if (!argv || !hasToken(argv, "serve") || isShell(argv)) {
            continue;
        }
        let env = Procfs.environ(pid);
        if (!looksLikeOpencodeEnv(env)) {
            continue;
        }
        if (!opts.includeMocks && isMock(env)) {
            continue;
        }

        let hosts = [];
        let hostname = flagValue(argv, "--hostname") || flagValue(argv, "--host");
        if (hostname) {
            hosts.push(hostname === "0.0.0.0" ? DEFAULT_HOST : hostname);
        }
        // What the process actually listens on: `--port 0` means "pick one", and
        // a claimed port must be backed by a real listening socket, otherwise the
        // process is only talking about a server rather than being one.
        let listening = Procfs.pidListeningPorts(pid, listeners);
        let port = parseInt(flagValue(argv, "--port") || "", 10);
        if (isNaN(port) || port <= 0) {
            if (opts.log && listening.length === 0) {
                opts.log("opencode-agents: pid " + pid + " speaks serve but listens on nothing (yet)");
            }
            for (let p = 0; p < listening.length; p++) {
                let server = makeServer({
                    host: hosts.length ? hosts[0] : DEFAULT_HOST,
                    port: listening[p],
                    username: env.OPENCODE_SERVER_USERNAME,
                    password: env.OPENCODE_SERVER_PASSWORD,
                    pid: pid,
                    cmdline: argv.join(" "),
                    cwd: Procfs.cwd(pid),
                    source: "proc",
                });
                if (server) {
                    servers.push(server);
                }
            }
            continue;
        }

        if (listening.indexOf(port) < 0) {
            if (opts.log) {
                opts.log("opencode-agents: pid " + pid + " claims --port " + port + " but does not listen on it");
            }
            continue;
        }

        let server = makeServer({
            host: hosts.length ? hosts[0] : DEFAULT_HOST,
            port: port,
            username: env.OPENCODE_SERVER_USERNAME,
            password: env.OPENCODE_SERVER_PASSWORD,
            pid: pid,
            cmdline: argv.join(" "),
            cwd: Procfs.cwd(pid),
            source: "proc",
        });
        if (server) {
            servers.push(server);
        }
    }
    return servers;
}

// Merge by host:port, preferring the entry that carries credentials.
function merge(servers) {
    let byId = {};
    let order = [];
    for (let i = 0; i < servers.length; i++) {
        let server = servers[i];
        let existing = byId[server.id];
        if (!existing) {
            byId[server.id] = server;
            order.push(server.id);
            continue;
        }
        if (!existing.password && server.password) {
            existing.password = server.password;
            existing.username = server.username;
            existing.source = existing.source + "+" + server.source;
        }
        if (!existing.pid && server.pid) {
            existing.pid = server.pid;
        }
    }
    return order.map(function (id) { return byId[id]; });
}

// options: { serviceFile, useService, useProc, extraServers, includeMocks, log }
function discover(options) {
    let opts = options || {};
    let found = [];

    if (opts.useService !== false) {
        found = found.concat(fromServiceFile(opts.serviceFile, opts));
    }
    found = found.concat(parseExtraServers(opts.extraServers));
    if (opts.useProc !== false) {
        found = found.concat(fromProc(opts));
    }

    let servers = merge(found);
    servers.sort(function (a, b) { return a.port - b.port; });
    return servers;
}
