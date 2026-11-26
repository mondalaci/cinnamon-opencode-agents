# OpenCode Agents - Cinnamon applet

Shows, in the Cinnamon panel, which opencode v2 agents are working right now:
one tile per live conversation, side by side, with two lines of text — the
project on top, the conversation subject below — and a thin progress bar along
the tile's top edge that sweeps while its agent works.

```
▔▔▔▔▔▔▔▔▔▔▔▔▔  ▔▔▔▔▔▔▔▔▔▔▔▔▔  ▔▔▔▔▔▔▔▔▔▔▔  +2
uhk.io          uhk.io          agent
Fix the widget… Ask which file… Refactor the …
```

<p align="center">
  <img src="docs/panel.png" alt="the applet in the panel" width="520">
</p>

- **The tile carries the state**, with the vocabulary and the colours of the
  [opencode project
  studio](https://github.com/mondalaci/opencode-projects-studio) it borrows
  them from:

  | State | Meaning | The tile |
  | --- | --- | --- |
  | `blocked` | the agent waits for you: a permission request or a question | fills red |
  | `working` | a turn is running | a thin amber bar sweeps along its top edge |
  | `done` | the turn finished and nobody has looked at it yet | fills green |
  | `idle` | nothing to do | no tile (only the idle icon uses the grey) |

- **A tile that needs a human fills with its colour** - a conversation waiting
  for you (a permission request, or a question offering its choices) is painted
  red across the whole tile, and one whose turn finished and that nobody has
  looked at yet is painted green, so both are visible from across the room. The
  amber working tiles keep the panel background: they say all there is to say
  with their thin sweeping bar.

- **Project and subject** - the top line is the project the conversation lives
  in (its registered name, else the folder name), the bottom line the
  conversation's subject. A tile widens into the free panel space to show them
  in full, and only ellipsizes a line when the row as a whole runs out of room.
- **Acknowledging** - a finished agent keeps its green tile until somebody
  looks at it. Clicking its tile (or *Mark finished agents as seen* in the menu)
  marks it viewed **on the server**, so the opencode project studio drops its own
  green dot for the same conversation and every other client agrees - see *Seen
  is a server fact* below.
- **`+N`** - more agents are working than the tile limit allows.
- **Motion** - a session that starts slides in from the left and fades in; one
  that leaves slides out to the left and fades out, while the tiles to its right
  take the freed space back so the row never jumps. A fill that stops being
  needed - the block was answered, or the finish was read - sweeps away to the
  right over six seconds while its tile stays in place, exactly as the studio's
  sidebar retracts the same fill; only then does the tile leave. While any agent
  works a thin amber bar sweeps along the top of its tile, loop after loop,
  where the studio's working dot pulses. Turn it off with *Animate new and
  finished agents* for instant changes and a steady bar.
- **Idle** - a dimmed robot icon, or nothing at all if you prefer
  (*Hide the panel icon when no agent is working*).
- **Never any desktop notification** - the applet only draws in the panel. The
  tooltip and the menu carry the details.

Clicking the applet opens the menu: every server with its live sessions, each
session with its project, agent, model, status and (optionally) cost, plus
per-session actions (copy the session ID, mark as seen, or run a command).
Hovering shows a tooltip summary.

## Install

```sh
./install.sh                    # symlink into ~/.local/share/cinnamon/applets + add to the panel
./install.sh --copy             # copy the files instead of symlinking
./install.sh --no-enable        # install only, leave the panel alone
./install.sh --panel-right 5    # place it at panel1:right:5
./uninstall.sh                  # remove the panel entry, config and files
```

Upgrading from the older `kilo-agents@laci` applet: this one has a new uuid, so
run the old `uninstall.sh` from the kilo checkout (or let this `install.sh`
drop the stale panel entry for you) before enabling it.

Cinnamon loads the applet immediately. Settings: right-click the applet ->
*Configure*, or `cinnamon-settings applets`.

Requirements: Cinnamon 5.4+ (developed on 6.6.9), `gjs`, and `python3` for the
installer and the test suite. The applet itself needs nothing extra: it talks
HTTP with the libsoup Cinnamon already links against and reads `/proc` with
GLib.

## How a server is found

opencode v2 is a client-server design: one shared background service owns the
sessions, the configuration and the projects, and every interface (the TUI, the
web chat, the studio) connects to it. It registers itself in a service file
when it starts, so one server normally answers for every project.

The applet finds every server it can and merges the answers:

1. **service file** - `~/.local/state/opencode/service.json`, written by
   `opencode serve --service`; carries the url, the pid and the password.
2. **configured servers** - the *Additional servers* setting
   (`host:port` or `host:port:username:password`), for a fixed port or a server
   on another machine.
3. **/proc scan** - processes whose command line contains `serve` and whose
   environment carries `OPENCODE*`, for a server started by hand on its own port
   and never registered. The port comes from `--port`, and for a server started
   with `--port 0` the listening socket is resolved through `/proc/net/tcp`; a
   password is read from `OPENCODE_SERVER_PASSWORD` when present.

Servers are deduplicated by `host:port` (keeping the entry with credentials), so
a service-file server that the `/proc` scan also finds is queried once.

Test doubles started by `tests/bin/opencode` export `OPENCODE_AGENTS_MOCK=1`,
and the `/proc` scan skips processes carrying that marker, so running the test
suite never puts phantom agents into a live panel. The suite opts back in with
`{ includeMocks: true }` where it needs to see them; the mock servers also watch
their parent process and exit if the harness dies, so an interrupted test run
cannot leave them behind.

## What is read from a server

| Request | Purpose |
| --- | --- |
| `GET /api/project?archived=true` | project names and whether a folder is gone |
| `GET /api/session/active` | the sessions a turn is running for right now |
| `GET /api/session?limit=200&parentID=null&order=desc` | the newest conversation of every project - read or not, so a green tile can never be invented for one |
| `GET /api/debug/location` | the project directories the server has materialized |
| `GET /api/permission/request?location[directory]=<dir>` | who waits for approval |
| `GET /api/form?location[directory]=<dir>` | who waits for an answer |
| `GET /api/session/<id>` | title, project, agent, model, cost, tokens, timestamps |
| `POST /api/session/<id>/view` | mark a finish as looked at (`time.viewed`) |

`/api/session/active` is the only authoritative answer to "is it working right
now": a session record's own `outcome` and `time.idle` are sticky and describe
the last turn that *ended*. The full session list is deliberately not swept —
one active read per poll keeps the applet cheap whatever the project count.

A conversation is named by the server a moment after it starts, so a record read
without a title is not trusted for the whole metadata TTL: it is re-read on the
next poll, and the tile stops showing the session id as soon as the title
arrives.

A pending permission or question exists only inside its own `location`, so the
loaded project directories are read for one. A session that stopped to ask a
question is blocked even when its own status is idle, so a session with a
pending request is kept in the row regardless. `/api/debug/location` is the
server's debug endpoint, so a failure is tolerated (the sweep then falls back to
the server's own directory).

Auth is HTTP Basic: the username is always `opencode`, and the password comes
from the service file. A request without credentials to a server that requires
them yields 401 and that server is reported unreachable.

## Seen is a server fact

Whether a finished conversation is *news* is the one thing the two apps have to
agree on, and they do it through the server: `POST /api/session/<id>/view` with
the `idle` stamp the viewer looked at records `time.viewed`, and

```
green  =  the conversation is idle  &&  (nothing viewed it, or viewed < idle)
```

is the whole rule, computed the same way in the panel and in the opencode
project studio. Nothing else can tell a finish somebody has read from one they
have not - the apps' own notes are private to each (the studio keeps its unread
set in its own storage), so an applet-only rule could never match.

- Clicking a red/amber/green tile does not change anything server side; clicking
  a **green** one (or *Mark finished agents as seen*) posts the view, so the
  studio's dot for the same conversation goes out, and stays out across restarts.
- Opening a conversation in the studio posts the view too, so the panel's tile
  clears on its next poll.
- The marker has no history, so on the very first run the panel would open with a
  row of green for finished conversations nobody has ever marked viewed. The
  studio closes that gap: it publishes the view for every row whose dot it is
  *not* lighting up, which backfills the marker and keeps the two in step.

## Settings

| Page | Keys |
| --- | --- |
| General | poll interval (2 s), session details refresh (30 s), projects checked for pending requests (12) |
| Servers | service file on/off + path, `/proc` scan on/off, additional servers |
| Panel | show the project, show the subject, agents shown side by side (5), animate new/finished agents and the bar sweep, hide when idle |
| Menu | session title length, show model, show directory, show cost/tokens, list idle servers |
| Actions | session action: copy the session ID, run a command (`{id} {title} {project} {dir} {agent} {model} {status}`), or nothing |

There is no notification setting: the applet never shows desktop notifications.

## Repository layout

```
opencode-agents@laci/     the applet (installed as one directory)
  applet.js               tile row, tooltip, menu, actions
  lib/procfs.js           /proc helpers (cmdline, environ, listening sockets)
  lib/discovery.js        server discovery: service file, config, /proc scan
  lib/client.js           async HTTP client for the opencode v2 API
  lib/monitor.js          poll loop, active/blocked sweep, per-server merge
  lib/state.js            the tile states, colours and their transitions (pure)
  lib/format.js           tooltip/menu formatting (pure functions)
  lib/tiles.js            the tile row diff and width fit (pure)
  lib/easing.js           slide curves and the working bar sweep (pure)
  lib/agenticon.js        resolves the idle icon path (pure, testable)
  icons/lucide-bot.svg    the idle icon (Lucide bot, ISC), tinted to the panel tone
  settings-schema.json    settings UI definition
docs/panel.png
install.sh uninstall.sh
tests/
  run-tests.sh            starts mock servers, runs both gjs suites
  mock-opencode-server.py server double with the real payload shapes
  bin/opencode            wrapper making the mock look like `opencode serve`
  test-lib.js             unit + integration tests (libsoup 3)
  readme-screenshot.sh    regenerates docs/panel.png from a running applet
  test-client-soup2.js    the same client on libsoup 2.4 (Cinnamon 5.x)
```

## Tests

```sh
tests/run-tests.sh
```

The suite starts three mock servers (one password-less, one that requires auth
on an OS-assigned `--port 0` port, one announced by a service file) and covers:

- panel/menu formatting helpers (titles, projects, durations, cost, tooltips)
- the tile states: the colours, the `blocked > working > done > idle`
  precedence, the "a session that just stopped is done" transition, a finish the
  monitor reports on the first poll, and acknowledgement
- the tile row diff: slides in and out, reordering, the overflow tile, the idle
  tile, and the width fit that hands a short tile's slack to a longer one
- the easing curves and the working bar sweep
- the idle icon: that the file exists, is an SVG, carries its licence note and
  is tinted, that its paths cannot escape the applet directory, that the old
  inverted twin is gone, and that the settings offer no icon chooser
- every setting the applet binds exists in the schema (a silent load failure
  otherwise)
- server-spec and service-file parsing, including broken input
- `/proc` discovery: fixed port, `--port 0` resolved via `/proc/net/tcp`,
  password read from `environ`, own process excluded, a shell that merely
  mentions a server excluded, deduplication
- that the applet's discovery skips the test doubles while they are running and
  answering, and that the suite can still see them on request
- the HTTP client: payload shapes, per-location permission/form scoping, 401
  without credentials, 404, refused connections — on libsoup 3 and on libsoup
  2.4
- the monitor: project names, the active/blocked sweep, permission and question
  reasons, the metadata join, a question surfacing a session whose status is
  idle, the recently finished conversations and the `viewed` marker that clears
  them, per-server attribution, unreachable servers isolated, duplicate sessions
  merged with the blocked report winning, live reaction to sessions starting and
  finishing, `stop()`
- the view marker itself: that `POST /api/session/<id>/view` records
  `time.viewed` and that a view without an idle stamp is rejected - on libsoup 3
  and on libsoup 2.4

## Development notes

- Editing `applet.js` and reloading the applet is enough to pick up the change.
  The type argument is `APPLET`, not `applet` — a wrong name destroys the applet
  and does **not** recreate it, leaving the panel entry dead until Cinnamon is
  restarted:
  `dbus-send --session --dest=org.Cinnamon /org/Cinnamon org.Cinnamon.ReloadXlet string:opencode-agents@laci string:APPLET`.
  Edited `lib/*.js` modules stay cached in the Cinnamon process, so those need a
  Cinnamon restart (`org.Cinnamon.RestartCinnamon true`) — a fresh start always
  works.
- `stylesheet.css` is cached the same way, and worse: a reload leaves the parsed
  CSS the applet was loaded with, so a size change simply does not appear. What
  worked here is `cinnamon --replace` in the background — `RestartCinnamon`
  returned without the change showing, and a probe rule (a 20px tile padding) was
  still inert after it, which is what proved the stylesheet, not the applet, was
  stale.
- The tile animations and the working bar sweep are driven by the applet's own
  frame loop (`lib/easing.js` + a `GLib.timeout_add`) rather than by Clutter
  easing. Cinnamon applies an actor's final value immediately when desktop
  animations are switched off (`St.Settings.animations_enabled`, false on plenty
  of installs), which would silently turn every `ease()` into a jump; driving the
  sweep here keeps it visible for anyone who asked for it, and the
  `animate-tiles` setting is the switch that matters.
- The working bar is a thin band along the tile's top edge and takes no layout
  room at all: both of its layers span the whole tile and are **clipped** to the
  band, so the band overlays the content's first pixel instead of adding a row
  of its own (two text lines already fill a 30px panel, and a row of its own is
  what used to push the fill over the panel's edge). It cannot be a layer pinned
  to an edge either - Cinnamon's bin layout centres a bin child whatever its
  `x-align` or `y-align` says - so the bar is the top few pixels of a full-tile
  layer and the sweep is a horizontal clip within it. Both colours come from
  `lib/state.js`: the track is the working amber at 36% and the travelling
  stretch at 55%, close enough that the motion is what catches the eye.
  `barSweep` computes the stretch that is on the bar, and the applet applies it
  as a clip, never as a size or a position, so a frame of the sweep cannot
  re-lay the row out. The thickness is a logical-pixel constant scaled by the
  stage factor, because actor coordinates are device pixels. With
  `animate-tiles` off the bar stays lit across the whole tile.
- The tile row claims the panel space the other applets leave, because Cinnamon
  gives an applet only the width its contents ask for. `_availableRowWidth`
  reads the panel's own width and subtracts the two other boxes and the rest of
  our box; `lib/tiles.js`'s `fitWidths` spreads that over the tiles, letting a
  short tile's slack go to a longer one. Each line is given that width and
  ellipsizes when its text is longer, so a tile that still comes up short cuts
  its text rather than pushing the row wider. The lines are measured at their
  natural width (any width forced on them is dropped first), and the panel's
  `notify::width` re-measures when the room changes. The lines carry
  `text-align: left` because the panel theme centres text, which would otherwise
  centre a shorter project name over a longer subject.
- `St.Icon` multiplies `icon_size` by the stage scale factor while the applet's
  pixel values are plain pixels; `iconSizeFor` divides it back out.
- `docs/panel.png` is generated by `tests/readme-screenshot.sh`: it starts a
  marked mock (invisible to `/proc` discovery), plugs it in through the applet's
  own *Additional servers* setting with the service file and `/proc` discovery
  switched off for the shot, waits for the row to settle, and refuses to write
  the image unless it is actually bright enough. It restores the settings on the
  way out, so an interrupted run cannot leave the applet pointed at a dead mock.
  Never inject a model into a live applet: the panel keeps showing it until the
  applet is reloaded.
- The two lines spend the panel's whole height: at `0.95em` they are 58 of a
  30px panel's 60 device pixels, which is as large as they go before they stop
  fitting. The content therefore carries no vertical padding - the 1px it used
  to have is what the last step of type bought - so the tile is the panel's
  height and the fill's edge is the panel's own edge; a rim would have to come
  out of the text. Raising the panel's height setting is the only way to go
  bigger, at the price of a taller panel for every applet.
- Theme-node lengths (`spacing`, `padding`) come back in **device** pixels -
  multiplied by the stage scale factor, which is 2 on a HiDPI panel - while the
  applet's own settings are logical pixels. So a `spacing: 10px` rule in the
  stylesheet measures as 20, and the bar's thickness is multiplied by the same
  factor before it is used as a clip, so the band stays thin on a HiDPI panel.
- `node --check <file>` validates the syntax of every JS file.

## Limitations

- The view marker starts empty, so the first time the applet runs it lists every
  past finish that nobody has ever marked viewed - the panel can therefore open
  with a row of them. One *Mark finished agents as seen* publishes the view for
  all of them at once, and from then on the panel and the studio stay in step.
- A conversation the studio has marked unread while it was running shows its
  green tile in the panel too, but only once the studio has published it: the
  panel polls, so it lags the studio by up to one interval (2 s).
- The tiles are per conversation, not per subagent: a subagent session is not a
  tile of its own.
- Only a permission request or a question counts as blocked; a session whose
  provider is being retried reads as working.
- Status is per server, so an opencode instance on another machine shows up only
  if it is listed in *Additional servers* and its API is reachable from here.
- The `/proc` scan needs the servers to run as the same user; otherwise their
  environment is unreadable and they are skipped.
