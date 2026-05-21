# Cfx Studio MCP — setup + smoke test

The standalone `cfx-mcp` binary lets MCP-compatible AI clients (Claude
Desktop, **Claude Code**, OpenAI Codex, Cursor, Cline, …) drive
Cfx Studio: list resources, restart them, read FXServer logs (server-
*and* client-side errors when the bridge resource is installed), and
search the FiveM / RedM natives catalogue.

---

## 1. One-time setup

Paths below use two placeholders: `<cfx-studio>` is the absolute path to
your cfx-studio checkout, and `<workspace>` is the FiveM/RedM
server-data folder you open in the IDE. Substitute your own.

### 1a. Build the binary

```sh
cd <cfx-studio>/cfx-mcp
npm install      # only the first time
npm run build    # produces dist/index.js + copies natives JSON
```

`npm run cfx:dev` from the cfx-studio fork rebuilds it automatically
on every IDE dev run, so you only need this step manually if you
haven't run dev recently or you're prepping a fresh machine.

Verify:

```sh
ls <cfx-studio>/cfx-mcp/dist/index.js
ls <cfx-studio>/cfx-mcp/data/natives-fivem.json
```

Both should exist.

### 1b. Install the in-game error bridge (optional but recommended)

When you first open the workspace in Cfx Studio you'll get an "install
the bridge resource?" prompt. Click **Install** (you can re-trigger
later via the command palette: `Cfx: Install Client Error Bridge`).

This drops a tiny `cfx-studio-bridge` resource into
`<workspace>/resources/` and adds `ensure cfx-studio-bridge` to
`server.cfg`. Without it the MCP can still see *server-side* errors,
but client-side Lua errors (the F8-console kind) won't reach the IDE.

### 1c. Wire `cfx-mcp` into Claude Code

Project-scoped (recommended — config travels with the workspace):
create `.mcp.json` at `<workspace>/.mcp.json`:

```json
{
	"mcpServers": {
		"cfx-studio": {
			"command": "<cfx-studio>/cfx-mcp/bin/cfx-mcp.cmd"
		}
	}
}
```

Or user-wide: add the same `mcpServers` block under `~/.claude.json`
(Windows: `%USERPROFILE%/.claude.json`).

For other clients see `cfx-mcp/README.md` — same JSON shape.

---

## 2. Daily flow

1. Start Cfx Studio: from `<cfx-studio>/` run
   `npm run cfx:dev:relaunch` (or `cfx:dev` for a full rebuild).
   Make sure it's running while you want the AI to use the live tools.
2. Start FXServer from inside the IDE (the title-bar Start button).
3. Open Claude Code in `<workspace>/`.
4. In the chat, run `/mcp` — `cfx-studio` should appear with seven
   tools.

Auth is handled automatically: every IDE start writes a fresh 32-byte
token to `%USERPROFILE%/.cfx-studio/mcp/auth.token` (mode 0600), and
the standalone binary reads it on first connection. You don't have to
touch the file. Token rotates on every IDE restart so a leaked token
becomes invalid as soon as you reload.

---

## 3. Smoke test prompts

Drop these into Claude Code one at a time. Each exercises a different
tool. Confirm the agent's reply matches reality in the IDE.

### Resources

> **List my Cfx resources and their state.**

→ Calls `cfx_list_resources`. Should return rows for every resource
folder in the workspace, e.g. `gang-test`, `cfx-studio-bridge`. Each
row carries `runtimeState` (`idle` / `running` / `errored` / …) and
`ensured` (whether `server.cfg` has an `ensure` line for it).

> **What's the FXServer state right now?**

→ `cfx_server_state`. One of `idle / starting / running / stopping / errored`.

> **Restart gang-test for me.**

→ `cfx_restart_resource name=gang-test`. Watch the **Cfx Console**
panel in the IDE: you'll see `Stopping resource gang-test` then
`Started resource gang-test`.

### Logs + errors

> **Show me the last 30 lines of FXServer output.**

→ `cfx_recent_logs limit=30`. Returns parsed records `{scope, level, line}`.

> **Show me only the error lines from gang-test.**

→ `cfx_resource_errors name=gang-test`. Returns parsed lines tagged
`errored`. Includes both server-side errors and client-side errors
forwarded by the bridge resource.

To trigger a synthetic client error for the test, edit
`resources/gang-test/client.lua` and add:

```lua
Citizen.CreateThread(function()
	error('synthetic client error for MCP smoke test')
end)
```

Save, restart the resource, spawn into the world; the bridge will
forward the error and `cfx_resource_errors` will surface it tagged
with `[client:gang-test]`.

### Natives

> **Find the FiveM native that freezes a ped.**

→ `cfx_search_natives query="freeze ped"`. Top hit should be
`FREEZE_ENTITY_POSITION`.

> **Show me the full docs for FREEZE_ENTITY_POSITION.**

→ `cfx_get_native name=FREEZE_ENTITY_POSITION`. Returns the full
record including the description.

> **What CFX-namespace natives are there for triggering server events?**

→ `cfx_search_natives query="trigger server event"` or
`cfx_search_natives query="trigger" mode=fivem`. Look for results in
the `CFX` namespace.

### Offline (IDE not running)

Stop Cfx Studio. Re-ask the natives questions — they still work
because the binary bundles its own copy of the natives JSON. The
live tools (`cfx_server_state`, `cfx_list_resources`,
`cfx_restart_resource`, `cfx_recent_logs`, `cfx_resource_errors`)
return:

> Cfx Studio is not running, so this tool is unavailable. Open the IDE
> and try again. Native search/lookup work offline.

That message is intentional so the agent can fall back gracefully.

---

## 4. End-to-end "build me a resource" flow

A real exercise to confirm the agent can drive a full loop. Try:

> **Create a new FiveM client-side resource called `mcp-test` that
> prints "hello from MCP" once when the player spawns. Restart it.
> Then check the console for the message.**

Expected behaviour:

1. Claude Code uses its **built-in file tools** (not MCP) to create
   `resources/mcp-test/fxmanifest.lua` + `client.lua`.
2. It edits `server.cfg` to add `ensure mcp-test` (also via built-in
   file edit, or via the tools the IDE exposes through commands).
3. It calls **`cfx_restart_resource name=mcp-test`** through MCP.
4. It calls **`cfx_recent_logs scope=mcp-test`** to confirm the
   "hello from MCP" line appeared.
5. If errors, **`cfx_resource_errors name=mcp-test`** gets the
   stack and the agent self-corrects.

If any step misbehaves, copy the agent's tool call + the IDE's
response and paste both back to me — the round-trip is the most
useful debug signal.
