# Cfx Studio

A desktop IDE for **FiveM and RedM** resource development. Cfx Studio is a
fork of [Visual Studio Code](https://github.com/microsoft/vscode)
(`Code - OSS`, MIT) with the editing core kept intact and a first-party
Cfx development environment built directly into the workbench.

FiveM and RedM are equal first-class targets. The game mode is detected
per workspace from `server.cfg` (`gamename`), with a per-resource
override from each `fxmanifest.lua` (`game`). There is no UI toggle.

> Status: in active development. Cfx Studio is not yet packaged as a
> signed installer — it currently runs from source via the dev build.

## What it does

- **Resources view** — replaces the file Explorer with a tree of every
  folder containing an `fxmanifest.lua`, with running / stopped /
  errored state badges driven by FXServer log parsing.
- **FXServer manager** — Play / Stop / Restart from the editor toolbar
  and status bar. FXServer is downloaded on demand (FiveM or RedM build)
  and driven as an external process; output streams into a console panel.
- **`.fxgraph` visual editor** — a React-Flow graph editor that compiles
  to real Lua on save. The output runs as a normal Cfx resource; there
  is no runtime interpreter.
- **Natives reference** — a searchable tree of the FiveM (`gta5`) and
  RedM (`rdr3`) natives catalogues.
- **Lua language support** — wires up [sumneko/lua-language-server](https://github.com/LuaLS/lua-language-server)
  with auto-generated typings for every native of the detected game mode.
- **Scaffolds** — New Resource templates (Lua / TypeScript / visual) for
  both FiveM and RedM.
- **MCP server** — `cfx-mcp/` is a standalone Model Context Protocol
  server that exposes the running IDE to AI clients (Claude, Codex,
  Cursor, …): list/restart resources, read FXServer logs, search
  natives. See [`cfx-mcp/README.md`](cfx-mcp/README.md).

## Architecture

Cfx Studio does **not** ship as an extension. All Cfx-specific logic is
a first-party workbench contribution:

```
src/vs/workbench/contrib/cfx/
├── common/            # game-agnostic types + service interfaces
├── browser/           # views, editors, status bar, commands, graph webview
├── electron-sandbox/  # renderer-side service clients
├── node/              # process spawn, fs ops, MCP bridge server
└── _shared/           # pure TS libs: visual codegen, natives index,
                       # server.cfg parser, natives data JSON
```

The extension host is retained only for third-party language servers
Cfx Studio shells out to (e.g. the Lua language server). There is no
extensions marketplace and no bundled extensions.

Cfx-specific build helpers live in `cfx-scripts/`. The standalone MCP
server lives in `cfx-mcp/`.

## Building from source

Prerequisites match upstream VS Code (Node.js, Python, and a C++
toolchain — see [the VS Code contributor guide](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites)).
A portable Node.js toolchain is fetched automatically by the dev script.

```sh
npm install
npm run cfx:dev          # build + launch
```

Other dev entry points:

- `npm run cfx:dev:watch` — incremental rebuilds; reload the window with `Ctrl+R`.
- `npm run cfx:dev:relaunch` — relaunch without rebuilding.

## Relationship to VS Code

Cfx Studio tracks `microsoft/vscode` as an upstream and merges new
releases periodically. The unmodified editor, terminal, settings, and
language tooling are upstream VS Code; the Cfx contribution under
`src/vs/workbench/contrib/cfx/` and the `cfx-mcp/` / `cfx-scripts/`
directories are this project's work.

## License

Cfx Studio is licensed under the [MIT License](LICENSE.txt).

It includes Visual Studio Code (`Code - OSS`),
Copyright (c) Microsoft Corporation, also under the MIT License.
Third-party component licenses are listed in
[`ThirdPartyNotices.txt`](ThirdPartyNotices.txt).

Cfx Studio is an independent project and is not affiliated with,
endorsed by, or sponsored by Microsoft or Cfx.re. FiveM and RedM are
products of Cfx.re. FXServer is not bundled — it is downloaded on demand
from the official Cfx.re artifacts host.
