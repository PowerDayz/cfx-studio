# Cfx Studio — Agent Onboarding

This document is the single source of truth for the project's intent, the
state of the world today, and what NOT to do. Read it cold and you should
be able to make decisions without recovering history from chat logs.

---

## 1. What we're building

A standalone Windows desktop IDE called **Cfx Studio** for FiveM AND
RedM resource development. Cursor-style: own .exe, own brand, own
start-menu entry, own data folder. Internally a fork of Code-OSS
(microsoft/vscode under MIT), heavily stripped of features a Cfx
developer doesn't need (extensions marketplace, sign-in/account, source
control, run/debug, telemetry, chat, notebooks, walkthroughs from
upstream, etc.).

### Dual-game support

FiveM and RedM are equal first-class targets. The runtime difference
between them, from a tooling perspective, is narrow:

- **Natives:** FiveM and RedM each ship their own natives index. Cfx
  Studio loads the right one per workspace.
- **server.cfg:** `gamename rdr3` declares a RedM server. Absent or
  `gamename gta5` is FiveM.
- **fxmanifest.lua:** the `game` field per resource (`gta5`, `rdr3`,
  `common`) controls which natives a single resource compiles against.
  Per-resource setting wins over server-level setting.

Detection is automatic from the workspace; there is no UI toggle.

### Architecture: everything in source

Cfx Studio does **not** ship as an extension. All Cfx-specific logic
lives directly in the workbench source under
`cfx-studio/src/vs/workbench/contrib/cfx/...` — committed straight to
our long-lived fork at `https://github.com/PowerDayz/cfx-studio`. The
shared TypeScript libraries (codegen, natives index, server-cfg parser,
natives data JSON) live alongside at
`cfx-studio/src/vs/workbench/contrib/cfx/_shared/`. Everything builds
through the fork's own gulp tsc — no orchestrator, no patch series, no
runtime rewrites. The IDE is plain-source software. There is no
extension host roundtrip for core features; the Resources tree,
FXServer manager, console router, `.fxgraph` editor, status bar items,
scaffolds, Natives reference, and Lua LSP wiring are all first-party
workbench contributions.

The extension host stays available for any third-party language server
we shell out to (e.g. sumneko/lua-language-server), but our own UI and
business logic is first-party workbench code.

### What sets it apart from stock VSCode

- The activity bar has **only the Cfx icon**. No Explorer, no Search,
  no SCM, no Run/Debug, no Extensions, no Testing, no Account.
- No Welcome / Getting Started page on first launch.
- Built-in Lua language support with auto-typed natives reference for
  autocomplete on every native of the detected game mode (FiveM or RedM).
- The IDE drives FXServer.exe externally. The status bar has Play / Stop /
  Restart. Output streams into a console panel.
- A custom editor for `.fxgraph` files renders a React-Flow visual graph
  that compiles to Lua on save (drag-and-drop scripting for non-coders,
  but the runtime is just a normal Cfx resource).
- Resource list (replacing the file Explorer) shows every folder with an
  `fxmanifest.lua` in the open server-data workspace, with state badges
  (running / stopped / errored), driven by FXServer log parsing.

### What sets it apart from previous attempts in this repo

The deprecated `resources/[local]/script-studio/` was an in-game NUI
editor. That approach is **abandoned** — the visual editor and code
generator code was lifted into `shared/` and the script-studio resource
itself is no longer in `server.cfg`. Don't try to revive it.

---

## 2. Repo layout

```
D:/txData/FivemRetard/                    # also a working FiveM/RedM server-data folder
├── README.md                             # high-level intro, points here
├── ONBOARDING.md                         # this file
├── server.cfg                            # for testing the IDE against a real server
├── resources/                            # FiveM resources (vanilla + script-studio deprecated)
│
├── shared/                               # pure TS libs, no VSCode + no FXServer runtime deps
│   ├── tsconfig.base.json                # CommonJS module + Node module resolution
│   ├── visual/                           # GraphDoc types + Lua codegen
│   │   ├── package.json                  # @cfx-studio/visual
│   │   └── src/                          # codegen.ts, doc.ts, runtime-helpers.ts, sig-to-node.ts, …
│   ├── natives/                          # natives index + search (game-agnostic; consumes both indices)
│   ├── language/                         # placeholder, kept for future DSL
│   ├── server-cfg/                       # format-preserving server.cfg parser/writer
│   └── natives-data/
│       ├── natives-fivem.json            # ~6.3k FiveM (gta5) natives
│       └── natives-redm.json             # ~5k  RedM  (rdr3) natives
│
├── _deprecated-extensions/              # READ-ONLY historical port reference
│   ├── DEPRECATED.md                     # explains why this exists
│   ├── fivem-studio/                     # legacy bundled extension
│   └── fivem-lua/                        # legacy LuaLS wrapper
│
└── cfx-studio/                          # the fork itself, lives at PowerDayz/cfx-studio
    ├── src/vs/workbench/contrib/cfx/    # all Cfx-specific source (see shape below)
    │   └── _shared/                     # in-tree shared TS libs (codegen, natives, server-cfg)
    └── cfx-scripts/                     # build helpers (cfx-dev, ensure-node, fetch-natives, …)
```

`cfx-studio/` is a normal git clone of `https://github.com/PowerDayz/cfx-studio`.
`origin` points at our fork; `upstream` points at `microsoft/vscode`. New
work is normal commits on `main`. Periodic upstream sync via
`git fetch upstream && git merge upstream/release/<version>`.

There is no `extensions/` directory inside the cfx contribution. The
previous bundled `fivem-studio` and `fivem-lua` extensions sit in
`_deprecated-extensions/` only as historical port reference — not
built, not imported at runtime, deletable once nothing references them.

The shape of `cfx-studio/src/vs/workbench/contrib/cfx/` is:

```
cfx-studio/src/vs/workbench/contrib/cfx/
├── common/                               # game-agnostic types + service interfaces
├── browser/
│   ├── cfx.contribution.ts               # registers everything below
│   ├── gameMode/                         # detects FiveM vs RedM from server.cfg + fxmanifest
│   ├── resources/                        # Resources tree (replaces Explorer)
│   ├── server/                           # FXServer process manager + state machine
│   ├── artifacts/                        # FXServer download + .7z extract (FiveM and RedM builds)
│   ├── console/                          # OutputChannel router + xterm panel + ring buffer view
│   ├── status/                           # Play/Stop/Restart status bar items
│   ├── graph/                            # .fxgraph custom editor + React-Flow webview
│   ├── scaffolds/                        # New Resource scaffolds (lua/ts/visual; FiveM and RedM variants)
│   ├── natives/                          # natives reference tree
│   ├── lua/                              # writes .luarc.json + cfx-natives.lua per workspace,
│   │                                     # picks fivem or redm natives based on detected mode;
│   │                                     # owns LuaLS lifecycle directly (no extension wrapper)
│   └── commands/                         # registers every Cfx command
└── electron-sandbox/                     # Node-side bits (process spawn, fs ops on artifacts/)
```

---

## 3. State of the world (what works, what doesn't)

### Target architecture vs current code

The target is "everything in source" (above). The current code on disk
still reflects the previous bundled-extension model. Migrating that
logic into `vscode/src/vs/workbench/contrib/cfx/` is the open work.

### What works today (legacy, to be replaced)
- `npm install` in `ide/` succeeds and pulls all deps.
- `shared/visual/` codegen produces real Lua from a GraphDoc.
- `node ide/build/dev-run.mjs` produces a launchable dev build of Cfx
  Studio in ~3 minutes on a warm cache.
- The launched app:
  - Branded "Cfx Studio Dev" in the title bar.
  - The Manage gear icon stays at the bottom-left (Settings, etc.).
  - Account/profile icon at the bottom-left is **gone**.
  - Welcome page is suppressed via configurationDefaults.

### What does NOT work
- The Explorer activity bar item still appears alongside the Cfx item.
  Removal is blocked behind the patch-series migration. See §6.
- Production installer (`build-win.mjs`) has not produced a `.exe`
  end-to-end. It dies in the webpack bundle of language-feature
  extensions due to type-check mismatches in vscode-dts vs. impl
  (proposed-API drift). See §6.
- RedM mode detection and natives loading — `natives-redm.json` doesn't
  exist yet (`fetch-natives.mjs` only pulls FiveM today; it needs a
  `--game {fivem|redm}` flag).
- `vscode/src/vs/workbench/contrib/cfx/` doesn't exist yet — no logic
  has been ported into it. The contrib patches are still to be written.

### What hasn't been tried yet
- Running FXServer end-to-end from the IDE (Play button → download →
  spawn → console output). Code is written for the FiveM case but never
  exercised because the build hasn't been stable enough.
- The `.fxgraph` custom editor with a real graph (the React-Flow webview
  loads but no end-to-end test of save → emit Lua → run in FXServer).
- Anything against a RedM server-data folder.

---

## 4. Build prerequisites (Windows, already installed on this machine)

- Node 20.x or 22.x **system-installed** (used only to bootstrap; the dev
  build uses portable Node 20.18 from `ide/.toolchain/` for everything else).
- VS 2022 Community with C++ workload **AND** "MSVC v143 — C++ x64/x86
  Spectre-mitigated libs (Latest)" individual component. Lives at
  `D:\Program Files\Microsoft Visual Studio\2022\Community`.
- Python 3.x.
- The build script auto-detects VS via `vswhere.exe`.

---

## 5. Decisions already made (don't re-litigate)

- **Fork microsoft/vscode directly**, not VSCodium. Track `release/1.96`.
- **Fork strategy: stripping**, not Theia/Monaco-from-scratch. We start
  from full VSCode and remove what we don't want.
- **Everything in source.** Cfx-specific features ship as workbench
  contributions under `vscode/src/vs/workbench/contrib/cfx/`, not as
  extensions. There is no `ide/extensions/` directory.
- **Dual-game support.** FiveM and RedM in one IDE, detected from
  workspace (`server.cfg` `gamename`, with `fxmanifest.lua` `game` as a
  per-resource override). No UI toggle.
- **No Marketplace.** No third-party extension installation.
- **No bundling FXServer.exe** — Cfx.re ToS forbids; download from
  `https://runtime.fivem.net/artifacts/...` on first user request.
  Same artifacts host serves both FiveM and RedM builds.
- **`.7z` extraction via bundled `7zip-bin`** — Windows' Expand-Archive
  doesn't support LZMA.
- **Visual graph compiles to Lua**, not interpreted. `.fxgraph` save →
  generates sibling `<base>.lua`, FXServer runs that as a normal
  resource. Same codegen for FiveM and RedM resources; only the natives
  index used to validate calls differs.
- **No HMR for NUI/webview**; `restart <name>`-style reloads only.
- **Lua LSP via sumneko/lua-language-server**; auto-downloaded on first
  workspace open. Native typings generated from
  `shared/natives-data/natives-fivem.json` or `natives-redm.json`
  according to detected mode.
- **Auto-restart on save**: edit a `.lua` in a running resource →
  debounced `restart <name>` to FXServer stdin. Setting toggles it off.
- **Default UI = stock VSCode look** (Dark+ theme, no custom chrome
  beyond name and icon).

---

## 6. How changes to the IDE land (the fork workflow)

Cfx Studio is a long-lived fork of microsoft/vscode at
`https://github.com/PowerDayz/cfx-studio`, cloned to
`D:/txData/FivemRetard/cfx-studio/`. The fork has two remotes:

- `origin` → `https://github.com/PowerDayz/cfx-studio.git` (our fork)
- `upstream` → `https://github.com/microsoft/vscode.git` (Microsoft)

All changes to the IDE — Cfx-specific contributions under
`src/vs/workbench/contrib/cfx/`, the shared libs under `_shared/`, the
build scripts under `cfx-scripts/`, and any tweaks to upstream files —
are normal git commits on the fork's `main` branch. There is no patch
series, no orchestrator, no runtime rewrites. Microsoft contributions
Cfx Studio doesn't ship are deleted from the fork's history; the
source on disk is the source we run.

### Inner loop

1. Edit files under `cfx-studio/src/vs/workbench/contrib/cfx/...` (or
   anywhere else in the fork).
2. From `D:/txData/FivemRetard/cfx-studio/`, run `npm run cfx:dev` to
   recompile and launch (~3 min on a warm cache, ~15 min first run).
3. When happy, `git add … && git commit -m "…"`. The pre-commit hook
   (husky → `npm run precommit`) runs the fork's relaxed hygiene check;
   both Microsoft and Cfx Studio copyright headers pass.
4. `git push origin main`.

### Periodic upstream sync

When microsoft/vscode tags a new release we want to track:

1. `cd cfx-studio && git fetch upstream`
2. `git merge upstream/release/<version>` — resolve conflicts as
   normal (most live in `workbench.{common,desktop}.main.ts` where
   we've removed import sites).
3. Smoke-test, push.

### Build artifacts

The Vite-built `.fxgraph` webview bundle, the per-build `_shared/`
copies, and the webview's transient `node_modules` are all gitignored
in the fork — they are regenerated by `npm run dev` from sources of
truth in the sibling `shared/` workspaces and the webview's `src/`.

---

## 7. The fast iteration loop (verified working)

```sh
cd D:/txData/FivemRetard/cfx-studio
npm run cfx:dev                       # first run: ~3-15 min, subsequent: ~1-3 min
# → Electron window opens as "Cfx Studio Dev"
# → edit any source under src/vs/workbench/contrib/cfx/ (or anywhere else)
# → close window, re-run cfx:dev (incremental compile is fast)
```

For sub-second incremental rebuilds use `npm run cfx:dev:watch` instead;
this leaves gulp watch in the foreground and you reload the window with
Ctrl+R after saving.

For just relaunching without rebuilding (e.g. iterating on settings in
the running window): `npm run cfx:dev:relaunch`.

Killing a running instance:
```pwsh
Get-Process -Name "Cfx Studio" -ErrorAction SilentlyContinue | Stop-Process -Force
```

Wiping persisted dev user state (forces fresh first-launch experience):
```pwsh
Remove-Item -Recurse -Force "$env:USERPROFILE\.cfx-studio-dev" -ErrorAction SilentlyContinue
```

The state lives in `~/.cfx-studio-dev/` because vscode in `VSCODE_DEV=1`
mode appends `-dev` to the configured `dataFolderName`.

---

## 8. The first thing a fresh agent should do

1. Read `D:/txData/FivemRetard/README.md` and this file in full.
2. Confirm `D:/txData/FivemRetard/cfx-studio/` exists and is on `main`
   tracking `origin` = `https://github.com/PowerDayz/cfx-studio.git`.
   If missing, clone it there.
3. From `D:/txData/FivemRetard/cfx-studio/`, run `npm install` if needed,
   then `npm run cfx:dev` to confirm the build works end-to-end.
4. For any change ask the user the planning question described in
   `CLAUDE.md` §1, then make the change as a normal git commit on
   `cfx-studio/main`.

---

## 9. Hard rules that survived from earlier conversation

- Production-ready code only; no placeholders, no half-implementations
  left behind.
- Default VSCode UI styling — match the stock look exactly (no custom
  theme, no rebranded chrome beyond name + icon).
- Cannot bundle FXServer.exe (Cfx.re ToS).
- All Cfx features live in `cfx-studio/src/vs/workbench/contrib/cfx/` —
  never as extensions.
- FiveM and RedM are equal first-class targets; no FiveM-only code paths
  unless they're explicitly gated by detected game mode.
- Don't revive `resources/[local]/script-studio/` — it's deprecated.
  Lift code from it if useful, then delete the folder when nothing else
  references it.
- Treat the user as a senior software engineer; show diffs, explain
  trade-offs, ask before making destructive choices.

---

End of onboarding. The next step is for the new agent to read this and
the README, then propose a written plan before writing or running anything.
