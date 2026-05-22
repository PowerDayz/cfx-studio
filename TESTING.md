# Testing in Cfx Studio

## TL;DR

```
npm run cfx:test           # one-shot, exits when done
npm run cfx:test:watch     # re-runs on save
```

Pure-logic tests (vitest) live next to the file under test as
`<name>.test.ts`. They run in <1s off the source `.ts` — no
`cfx:dev` / `compile-src` build step required.

## Two test infrastructures coexist

| | `npm run cfx:test` (vitest) | `npm run test-node` (vscode mocha) |
|---|---|---|
| Scope | cfx-contrib pure logic | VSCode core integration |
| Setup | none | requires full `out/` build (~3 min) |
| Speed | <1s | minutes |
| Test API | `describe / it / expect` | `suite / test / assert` |
| File pattern | `src/vs/workbench/contrib/cfx/**/*.test.ts` | `test/unit/node/**/*.test.js` (compiled) |

vitest is the new entrypoint for cfx-contrib unit tests. The upstream
mocha runner is still here for any cfx test that needs the full
workbench surface (today there's one — `src/vs/workbench/contrib/cfx/test/common/diagnostics.test.ts`,
landed alongside PR #9; can stay as-is or be migrated to vitest in a
follow-up).

**Why two systems**: the mocha runner targets `out-build/` and pulls
in the whole workbench, which is the right tool for testing how cfx
contributions integrate with vscode services — but it's overkill for
testing pure functions like the radial menu's `bucketByVerb` or the
secret redactor's `redactSecrets`. Vitest fills that gap without
disturbing the upstream test infra.

## When to write a vitest unit test

Yes:
- Pure functions: parsers, validators, normalizers, scorers.
- Data transforms whose output is determined entirely by input.
- State-machine transition tables (given current state + event → next state).
- Type guards / discriminators.

Skip (use the mocha runner or a manual smoke instead):
- Anything that touches `fileService`, `notificationService`, `webviewService`, `child_process`, real DOM.
- Visual / layout / animation behavior.
- Integration with vscode services beyond passing them in via DI.

For the in-between case ("logic with DI dependencies — e.g. a service
class that uses fileService"), prefer unit tests with hand-rolled
mock objects over the heavyweight mocha runner. Examples:

```ts
const mockFile: Pick<IFileService, 'readFile'> = {
  readFile: async () => ({ value: VSBuffer.fromString('hi'), ...rest }),
};
```

## File layout convention

Co-located, same directory as the file under test:

```
RadialMenu/
  verbs.ts
  verbs.test.ts      ← here
  geometry.ts
  geometry.test.ts   ← here
```

This keeps the test next to the implementation, makes orphaned tests
visible (delete the source → test file is loud about missing imports),
and avoids long `../../../` import paths.

## PR test-plan convention

Every PR that adds non-trivial behaviour should include a `## Testing`
section in its body with two parts:

```markdown
## Testing

### Automated
- `cfx:test` covers: [function 1], [function 2], [scenarios in <file>.test.ts]

### Manual (reviewer to run)
- [ ] Open Cfx Studio on this branch.
- [ ] Open a `.fxgraph` from `resources/gang-test/`.
- [ ] Drag a node, press Ctrl+S → tab dirty dot clears.
- [ ] (etc — one checkbox per UI assertion)
```

The automated section makes the test investment visible. The manual
section is a checklist the reviewer (human or agent) can tick off
in 60 seconds instead of inventing test steps from prose.

When a PR has zero pure logic to test (pure config / registration
changes like PR #8 — the resource-shell strip), the Automated section
should say so explicitly: `_no testable pure logic; covered by
manual smoke below_`.

## Adding tests retroactively

For PRs that have already landed without tests, file a follow-up
issue (or add to an existing one) labeled `tests:wanted` listing the
file(s) and the pure functions worth covering. An agent can pick it
up in batch.

## Gotchas

- **`.js` import suffix**: cfx-contrib source uses `.js` suffix in
  imports for files that are actually `.ts` (vscode-fork convention).
  Vitest is configured to resolve these (see `vitest.config.ts`).
- **Don't import from `vs/platform`, `vs/workbench/services`, etc.**
  in your tests — those drag in vscode core. If your test target
  imports them, mock the dependency rather than importing for real.
- **`_shared/` is dependency-free** by design (it's the same code
  reused by `cfx-mcp`). Tests of `_shared/` modules should stay
  dependency-free too.
