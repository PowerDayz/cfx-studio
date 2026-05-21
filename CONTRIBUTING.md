# Contributing to Cfx Studio

Thanks for your interest in contributing to Cfx Studio — an IDE for
FiveM and RedM resource development, built as a fork of
[Visual Studio Code](https://github.com/microsoft/vscode).

## Reporting issues

Use the [issue tracker](https://github.com/PowerDayz/cfx-studio/issues).
Search first to avoid duplicates, then open a bug report or feature
request with the provided templates. For security issues, see
[SECURITY.md](SECURITY.md) — do **not** open a public issue.

## Building from source

```sh
npm install
npm run cfx:dev          # build + launch
```

`npm run cfx:dev:watch` gives incremental rebuilds (reload the window
with `Ctrl+R`); `npm run cfx:dev:relaunch` relaunches without
rebuilding. Prerequisites match upstream VS Code (Node.js, Python, and a
C++ toolchain).

## Working in the codebase

- The Cfx-specific code is a first-party workbench contribution under
  `src/vs/workbench/contrib/cfx/`. Everything else is upstream VS Code.
- `CLAUDE.md` is the project's working agreement — read it before making
  changes. It applies to human and AI contributors alike: understand the
  context, plan the change, then write code.
- Match the surrounding style. Keep changes focused and production-ready
  — no stubs, no TODOs pointing at unimplemented paths.

## Pull requests

1. Branch from `main`.
2. Keep the PR scoped to one change; describe what it does and why.
3. Say how you verified it (`npm run cfx:dev`, exercised against a
   FiveM/RedM workspace, etc.).
4. The pre-commit hook runs a hygiene check; both Microsoft and Cfx
   Studio copyright headers pass.

## Upstream

Cfx Studio tracks `microsoft/vscode` and merges new releases
periodically. When touching upstream files, keep changes minimal so
future merges stay cheap.

## License

By contributing, you agree that your contributions are licensed under
the [MIT License](LICENSE.txt).
