// Pure formatting helpers - no Cinnamon, no I/O, so they are trivially
// testable and safe to call from the applet's UI callbacks.

var STATUS_LABELS = {
    blocked: "blocked",
    working: "working",
    done: "done",
    idle: "idle",
};

function truncate(text, max) {
    let value = text === null || text === undefined ? "" : String(text);
    if (!max || value.length <= max) {
        return value;
    }
    if (max <= 1) {
        return value.slice(0, max);
    }
    return value.slice(0, max - 1).trimEnd() + "\u2026";
}

// "…/projects/chats" - enough to recognise a project without the noise.
function shortDirectory(path, segments) {
    if (!path) {
        return "";
    }
    let count = segments || 2;
    let parts = String(path).split("/").filter(function (part) { return part.length > 0; });
    if (parts.length <= count) {
        return path;
    }
    return "\u2026/" + parts.slice(parts.length - count).join("/");
}

// The display name of a project directory: its last segment.
function projectLabel(directory) {
    if (!directory) {
        return "";
    }
    if (directory === "/") {
        return "root";
    }
    let parts = String(directory).split("/").filter(function (part) { return part.length > 0; });
    return parts.length ? parts[parts.length - 1] : directory;
}

function modelLabel(model) {
    if (!model) {
        return null;
    }
    let id = typeof model === "string" ? model : (model.id || model.modelID);
    if (!id) {
        return null;
    }
    let slash = id.lastIndexOf("/");
    return slash >= 0 ? id.slice(slash + 1) : id;
}

function statusText(state) {
    return STATUS_LABELS[state] || state || "unknown";
}

// The one-line reason a session shows: what it waits for, or what it is doing.
function statusDetail(session) {
    if (!session) {
        return "";
    }
    if (session.blocked) {
        if (session.blockedReason && session.blockedReason !== "question") {
            let detail = session.blockedDetail ? ": " + truncate(session.blockedDetail, 60) : "";
            return "waiting for approval" + detail;
        }
        let question = session.blockedDetail ? ": " + truncate(session.blockedDetail, 60) : "";
        return "waiting for an answer" + question;
    }
    if (session.status === "running" || session.status === "busy") {
        return "working";
    }
    if (session.status === "retry") {
        return "retrying";
    }
    if (session.done) {
        return "done";
    }
    return statusText(session.status);
}

function elapsed(ms) {
    if (ms === null || ms === undefined || isNaN(ms)) {
        return "";
    }
    let seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) {
        return seconds + "s";
    }
    let minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return minutes + "m";
    }
    let hours = Math.floor(minutes / 60);
    let restMinutes = minutes % 60;
    if (hours < 24) {
        return restMinutes ? hours + "h" + restMinutes + "m" : hours + "h";
    }
    return Math.floor(hours / 24) + "d";
}

function elapsedSince(timestamp, reference) {
    if (!timestamp) {
        return "";
    }
    return elapsed((reference || Date.now()) - timestamp) + " ago";
}

function formatCost(cost) {
    if (cost === null || cost === undefined || isNaN(cost)) {
        return null;
    }
    if (cost === 0) {
        return "$0";
    }
    if (cost < 0.01) {
        return "$" + cost.toFixed(4);
    }
    return "$" + cost.toFixed(2);
}

function tokenCount(session) {
    if (!session || !session.tokens) {
        return null;
    }
    let tokens = session.tokens;
    let total = (tokens.input || 0) + (tokens.output || 0);
    return total || null;
}

function serverSummary(model) {
    if (!model || model.servers.length === 0) {
        return "no opencode server found";
    }
    let reachable = model.servers.filter(function (server) { return server.ok; }).length;
    let text = model.servers.length + (model.servers.length === 1 ? " server" : " servers");
    if (reachable !== model.servers.length) {
        text += " (" + reachable + " reachable)";
    }
    return text;
}

function sessionMenuLabel(session, options) {
    let opts = options || {};
    let title = truncate(session.title || session.id, opts.maxTitleLength || 48);
    let bits = [];
    if (opts.showAgent !== false && session.agent) {
        bits.push(session.agent);
    }
    if (opts.showModel !== false) {
        let model = modelLabel(session.model);
        if (model) {
            bits.push(model);
        }
    }
    if (bits.length === 0) {
        return title;
    }
    return title + "  (" + bits.join(" \u00b7 ") + ")";
}

// Multi-line summary shown as the panel tooltip.
function tooltipText(model, options) {
    let opts = options || {};
    let lines = [];
    if (!model || model.active === 0) {
        lines.push("OpenCode Agents - no agent is working");
    } else {
        let counts = [];
        if (model.blocked) {
            counts.push(model.blocked + " blocked");
        }
        if (model.working) {
            counts.push(model.working + " working");
        }
        if (model.done) {
            counts.push(model.done + " finished");
        }
        lines.push("OpenCode Agents - " + model.active + " active (" + counts.join(", ") + ")");
    }
    lines.push(serverSummary(model));

    if (model) {
        let limit = opts.maxLines || 6;
        let rows = model.sessions.filter(function (session) {
            return session.blocked || session.done || session.status === "running";
        });
        for (let i = 0; i < rows.length && i < limit; i++) {
            let session = rows[i];
            let parts = [];
            if (session.project) {
                parts.push(session.project);
            }
            parts.push(truncate(session.title, 40));
            parts.push(statusDetail(session));
            lines.push("\u2022 " + parts.join(" - "));
        }
        if (rows.length > limit) {
            lines.push("\u2026 " + (rows.length - limit) + " more");
        }
        if (model.errors.length) {
            lines.push("errors: " + model.errors.join("; "));
        }
    }
    return lines.join("\n");
}
