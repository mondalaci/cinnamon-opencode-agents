// Verifies that the HTTP client also works on libsoup 2.4 (Cinnamon 5.x),
// which the feature-detecting client falls back to. Run in its own gjs
// process so the version pin happens before Soup is imported.

imports.gi.versions.Soup = "2.4";

const GLib = imports.gi.GLib;

const ROOT = GLib.getenv("OPENCODE_TEST_ROOT");
imports.searchPath.unshift(GLib.build_filenamev([ROOT, "opencode-agents@laci"]));

const Client = imports.lib.client;
const OpencodeClient = imports.lib.client.OpencodeClient;

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
    checks++;
    if (condition) {
        print("ok   - " + name);
    } else {
        failures++;
        print("FAIL - " + name + (detail ? "  [" + detail + "]" : ""));
    }
}

function equal(name, actual, expected) {
    check(name, actual === expected, "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

function env(name) {
    return GLib.getenv(name);
}

function readFile(path) {
    try {
        let [ok, contents] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(contents) : null;
    } catch (e) {
        return null;
    }
}

async function run() {
    print("libsoup major version: " + Client.LIBSOUP_MAJOR + ", send_and_read_async: " + Client.HAS_SEND_AND_READ);
    equal("soup2: libsoup 2.x is in use", Client.LIBSOUP_MAJOR, 2);
    equal("soup2: send_and_read_async absent", Client.HAS_SEND_AND_READ, false);

    let fixedPort = parseInt(env("OPENCODE_TEST_FIXED_PORT"), 10);
    let dynamicPort = parseInt(readFile(env("OPENCODE_TEST_DYNAMIC_PORT_FILE")), 10);

    let open = new OpencodeClient({ host: "127.0.0.1", port: fixedPort });
    equal("soup2: /api/info works", (await open.info()).version, "9.9.9-test");

    let projects = await open.projects();
    check("soup2: /api/project works", projects.length >= 2, JSON.stringify(projects.length));

    let active = await open.activeSessions();
    equal("soup2: /api/session/active works", active["ses_busy_a"] && active["ses_busy_a"].type, "running");

    let session = await open.session("ses_busy_a");
    equal("soup2: /api/session/<id> works", session && session.title, "Fix the widget");

    let list = await open.sessions({ limit: 5, directory: env("OPENCODE_TEST_PROJ_A") });
    equal("soup2: /api/session works", list.length >= 1, true);

    let anonymous = new OpencodeClient({ host: "127.0.0.1", port: dynamicPort });
    let unauthorized = null;
    try {
        await anonymous.projects();
    } catch (e) {
        unauthorized = e;
    }
    check("soup2: 401 without credentials", unauthorized !== null && unauthorized.status === 401,
        unauthorized ? String(unauthorized.status) : "no error");

    let authenticated = new OpencodeClient({ host: "127.0.0.1", port: dynamicPort, password: "test-secret-123" });
    equal("soup2: authenticated request works", (await authenticated.projects()).length >= 2, true);

    let permissions = await authenticated.permissions(env("OPENCODE_TEST_PROJ_B"));
    check("soup2: /api/permission/request works", permissions.length === 1, JSON.stringify(permissions));
    equal("soup2: a permission names its session", permissions[0] && permissions[0].sessionID, "ses_blocked_b");

    let forms = await authenticated.forms(env("OPENCODE_TEST_PROJ_B"));
    check("soup2: /api/form works", forms.length === 2, JSON.stringify(forms.length));

    // The one write the applet makes, so the POST body path is exercised on
    // libsoup 2.4 as well.
    equal("soup2: viewSession works", await authenticated.viewSession("ses_question_c", 7000), null);
    let marked = await authenticated.session("ses_question_c");
    equal("soup2: the view is recorded", marked.time.viewed, 7000);

    print("");
    print(checks + " checks, " + failures + " failures");
    return failures === 0;
}

let loop = new GLib.MainLoop(null, false);
let ok = false;
run().then(function (result) {
    ok = result;
}, function (error) {
    print("ERROR: " + error.message);
    print(error.stack ? error.stack : "");
}).then(function () {
    loop.quit();
});
loop.run();

if (!ok) {
    imports.system.exit(1);
}
