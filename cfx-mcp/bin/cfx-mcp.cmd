@echo off
rem -----------------------------------------------------------------------------
rem  Cfx Studio MCP server — Windows shim.
rem  Spawns the standalone Node binary that AI clients (Claude Desktop,
rem  Claude Code, Codex, Cursor, Cline, …) connect to over stdio JSON-RPC.
rem -----------------------------------------------------------------------------
node "%~dp0..\dist\index.js" %*
