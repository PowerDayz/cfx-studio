# cfx-mcp

A standalone Model Context Protocol (MCP) server that exposes Cfx Studio
to AI clients. Lets an AI assistant list resources, restart them, read
recent FXServer logs (server- *and* client-side errors when the
[bridge resource](#client-side-errors) is installed), and search the
FiveM / RedM natives catalogue with full descriptions.

It speaks MCP JSON-RPC over **stdio**, so it works with every
spec-compliant client. Verified configs below.

## What's exposed

### Tools

| Tool | When live (IDE running) | Offline |
|---|---|---|
| `cfx_server_state` | ✓ | ✗ |
| `cfx_list_resources` | ✓ | ✗ |
| `cfx_restart_resource` | ✓ | ✗ |
| `cfx_recent_logs` | ✓ | ✗ |
| `cfx_resource_errors` | ✓ | ✗ |
| `cfx_search_natives` | ✓ | ✓ |
| `cfx_get_native` | ✓ | ✓ |

### Resources

- `cfx://natives/fivem` — full GTA5+CFX natives JSON
- `cfx://natives/redm` — full RDR3+CFX natives JSON

## Install

```sh
cd cfx-studio/cfx-mcp
npm install
npm run build
```

This produces `dist/index.js` and copies the latest natives JSON from
the IDE fork into `data/`. The Windows shim is at `bin/cfx-mcp.cmd`.

When you run the IDE via `npm run cfx:dev` from the cfx-studio root,
the cfx-mcp binary is rebuilt automatically so it stays in sync.

## Wire it into your AI client

All clients use the same `mcpServers` block. Replace
`<cfx-studio>` with the absolute path to your cfx-studio checkout.

### Claude Desktop

Edit `%APPDATA%/Claude/claude_desktop_config.json`:

```json
{
	"mcpServers": {
		"cfx-studio": {
			"command": "<cfx-studio>/cfx-mcp/bin/cfx-mcp.cmd"
		}
	}
}
```

### Claude Code

Per-project: create `.mcp.json` at the workspace root:

```json
{
	"mcpServers": {
		"cfx-studio": {
			"command": "<cfx-studio>/cfx-mcp/bin/cfx-mcp.cmd"
		}
	}
}
```

User-wide: same block under `mcpServers` in `~/.claude.json`.

### OpenAI Codex CLI

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.cfx-studio]
command = "<cfx-studio>/cfx-mcp/bin/cfx-mcp.cmd"
```

### Cursor

Settings → MCP → "Add new MCP Server" and pick the binary, or edit
`~/.cursor/mcp.json`:

```json
{
	"mcpServers": {
		"cfx-studio": {
			"command": "<cfx-studio>/cfx-mcp/bin/cfx-mcp.cmd"
		}
	}
}
```

### Cline / Continue / Zed

Same JSON shape under their respective MCP config files. All major
clients share the format.

## Authentication

On every IDE start, Cfx Studio writes a 32-byte random token to
`~/.cfx-studio/mcp/auth.token` (file mode 0600 on Unix; user-only ACL
on Windows by default). The standalone binary reads it and presents it
on the first message of each pipe connection. Without it, the IDE
closes the connection. The token rotates on every IDE restart.

## Client-side errors

`cfx_resource_errors` and `cfx_recent_logs` see *server-side* lines for
free. To also see *client-side* Lua errors, install the optional
in-game `cfx-studio-bridge` resource — Cfx Studio prompts you on first
workspace open, or run `Cfx: Install Client Error Bridge` from the
command palette. The bridge is ~50 lines of Lua and forwards
`onResourceError` events to the server, prefixed with
`[client:<resource>]` so the IDE log parser flags them as errors.

## Behaviour when the IDE isn't running

Static tools (`cfx_search_natives`, `cfx_get_native`) and the natives
resources keep working from the bundled JSON. Live tools return a
friendly *"Cfx Studio is not running, so this tool is unavailable."*
message so the AI client can fall back gracefully.
