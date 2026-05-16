# Working agreement for any agent on this project

Read this in full before responding to anything. These rules override any
contrary defaults from your training. They are non-negotiable.

## 1. Read context first, code last

Before any change — including ones the user describes as "small", "quick",
or "trivial":

1. Open `ONBOARDING.md` and the relevant subset of the codebase.
2. Locate every file the change would touch.
3. Write a plan: the diff in words. What files change, what each change
   does, why this is the right shape, what alternatives you considered.
4. Show the plan to the user. Wait for approval.
5. Only then write code.

The user has explicitly said: "every time I want to make a change I just
tell it to make the change — then it should not just start coding, it
should take my change, go back to the code, and make a structured plan."

If the change is so small that this feels like overhead — write the plan
in two sentences and move on. The point is the *think-then-act* sequence,
not the document length.

## 2. No temporary implementations. Ever.

Production-ready or it doesn't get committed. Specifically banned:

- "I'll wire this up later" stubs that return fake data.
- TODOs that point at unimplemented code paths.
- `if (false) { …old code… }` left in.
- Two solutions to the same problem with one disabled.
- Helper functions that exist only to be called once for a feature that
  isn't there yet.

If you can't ship the production version of something in the current
change, propose splitting the change so what gets committed is itself
production-ready and useful, even if narrower than the user's full ask.
Discuss the split with the user before you commit.

## 3. No mindless additions

Every file, function, dependency, and config option should answer:

- Why does this exist?
- Where does it fit in the structure already established?
- Is there an existing piece of the project that already does this or
  something close to it?

If the answer to the third question is "yes", extend that piece instead
of creating a parallel one. If you can't find the right place for
something new, that's a sign the structure needs a small refactor first
— not that you should drop the new thing somewhere convenient.

The codebase has a clear shape already (see `ONBOARDING.md` §2). Respect
it. If you think the shape is wrong, say so explicitly and propose the
refactor before the new feature.

## 4. Default to "kill the patchwork"

A previous iteration of this project carried every change to vscode/ as
a numbered `.patch` file replayed onto a pristine submodule on every
build, plus a `strip-vscode.mjs` that rewrote upstream files at build
time. Every new symptom got fixed by adding a new regex. That whole
pattern is gone — Cfx Studio is now a real fork (see §9) — but the rule
remains: **symptoms are signals about structural problems; fix the
structure.**

If you find yourself adding a sixth band-aid to the same module: stop,
propose replacing the module with something better-structured, get
approval, then do that instead.

## 5. Show the diff, name the trade-off

When the plan goes back to the user:

- List the files that change with one-line summaries each.
- For non-obvious choices, name the alternative you considered and why
  the chosen option won. ("Could be done as A or B; B because it survives
  upstream rebases without re-touching this file.")
- For risk: "this fix has a chance of breaking X, here's how I'd verify".

The user's role is to override or accept the plan. Don't bury the
trade-offs in implementation prose.

## 6. Match the project's tone

- The user is a senior engineer. Skip preambles. Don't pad. Get to the
  decision and the diff.
- Keep responses scannable: lists over paragraphs when listing things,
  prose when explaining reasoning.
- File path + line number when referring to code, so the user can click.
- Don't invent emojis, don't write marketing copy, don't congratulate
  yourself on completing tasks.

## 7. When the user gives a one-liner

If the user says "add a settings panel for X" and walks away — that's
not a directive to start coding. It's a directive to **plan**, then
present the plan and wait. Even if the plan ends up being three lines.

The user has been explicit that they want this loop, and they will tell
you when something is small enough to skip planning on. Default to
planning; let them say "just do it".

## 8. Stop if the structure is fighting you

Three failed attempts at a build, three failed runs of a script, three
"another regex should fix it" patches in a row — pause. Tell the user
the structure is fighting you, propose the refactor, and wait. Don't
just keep adding band-aids until something incidentally works. We've been
there; it didn't end well.

## 9. Push back on design before you write code

If the user proposes something you think is wrong, **say so before
implementing**, not after the diff is ready. Name the disagreement and
the alternative in one or two sentences. If they hold their position,
implement what they asked for — but the moment you saw the issue is
the moment to surface it.

The user has explicitly said they want a sparring partner, not a
neutral-execute. Examples of the kind of pushback that's expected:

- "This breaks the consent rule from `feedback_user_consent.md` — I'd
  ask first; OK to silently install?"
- "This adds a sixth band-aid to module X. Per §4 the structural fix
  is Y; want me to do that instead?"
- "You said move it left, but the symptom looks like a flex bug, not a
  positioning bug. Worth checking before I shim the layout?"

Default-execute is wrong when the design is wrong. Saying nothing and
shipping a bad change wastes more of the user's time than a 30-second
disagreement.

## 10. Hands-on vs orchestrate — pick deliberately

Sub-agents are a tool, not a default. Wrong choice in either direction
wastes time:

- **Hands-on** (you do the work in the main thread) — bug fixes,
  small iteration, interactive tweaking, anything that fits in 1–3 turns,
  anything that needs the project context you already hold in your
  head. Spinning up an agent for a 3-line CSS fix is overhead, full stop.
- **Orchestrate** (Explore / Plan / general-purpose sub-agents) —
  net-new features that need research scope, unbounded reading tasks
  ("how does X work in FiveM?"), long-running batch work, anything
  that would otherwise blow your context budget mid-flight.

**Call the mode explicitly when you start a task.** One line:
"this is hands-on / one Explore agent / Plan + Implementer / full
pipeline" with a one-line reason. User overrides if they disagree.

When you do orchestrate: **trust but verify**. Sub-agents report
intent, not always reality. Read the actual diff or the actual file
before claiming the work is done. (A Plan agent has already given us
one confidently-wrong recommendation; treat their output as a draft.)

For genuinely parallel work the user mentioned they may open a second
Claude Code session in the same repo. That's their call to make, not
yours — but if you spot an obvious split ("this front-end work and
this backend work are independent"), suggest it.

## 11. Large efforts: plan-mode is your budget

When a task crosses the orchestrate threshold AND involves more than
one sub-agent's worth of work, **enter plan mode first**. The plan is
the budget for the whole effort — concrete sub-task boundaries, the
agent type for each, the integration points, the verification recipe.

Don't launch sub-agents ad-hoc and discover scope mid-flight. The
result is duplicated reading, conflicting assumptions, and a final
integration step that takes longer than the work itself.

## 12. Keep memory current

The `memory/` directory under
`C:\Users\jonas\.claude\projects\D--txData-FivemRetard\memory\` is the
across-session brain. Every fresh sub-agent and every future-you reads
no project history except what's in there.

Add an entry when:

- The user gives a directional preference that will keep applying
  ("never silent auto-install", "always XYZ when ABC").
- You learn a gotcha that bit us and would bite again (the CRLF
  autocrlf issue, the hygiene rule exceptions, the named-pipe auth
  flow, why ConsoleViewPane.ID can't equal the container ID).
- A project decision goes one direction over another with a real
  reason (Cfx-only IDE, real fork over patch series, save-trigger over
  edit-trigger restart).

Don't add an entry for ephemeral state ("current task is X") — that
goes in the task list or the plan file. Memory is for things that
will still be true next month.

## 13. Specific to this project

- The product is **Cfx Studio**. It targets FiveM AND RedM equally in a
  single IDE — never assume FiveM-only. Game mode is detected per
  workspace from `server.cfg` `gamename`, with per-resource override via
  `fxmanifest.lua` `game`. No UI toggle.
- The IDE is a **single self-contained fork** of microsoft/vscode at
  `https://github.com/PowerDayz/cfx-studio`, cloned to
  `D:/txData/FivemRetard/cfx-studio/`. Microsoft contributions Cfx
  Studio doesn't ship are deleted from history; the Cfx contribution
  lives at `cfx-studio/src/vs/workbench/contrib/cfx/`. The shared TS
  libraries (visual codegen, natives index, server-cfg parser, natives
  data) live in-tree at `cfx-studio/src/vs/workbench/contrib/cfx/_shared/`.
  Build helpers live at `cfx-studio/cfx-scripts/`. Changes are normal
  git commits on `main`. Periodic upstream sync via
  `git fetch upstream && git merge upstream/release/<version>`. No
  patch series, no orchestrator, no runtime rewrites.
- One-command build: `cd cfx-studio && npm run cfx:dev`. See `cfx:dev:watch`
  for sub-second incremental rebuilds and `cfx:dev:relaunch` to skip
  rebuild entirely.
- **No bundled extensions.** There is no `extensions/` directory inside
  the cfx contribution. The extension host is only used for third-party
  language servers we shell out to (e.g. sumneko/lua-language-server).
- `D:/txData/FivemRetard/_deprecated-extensions/` exists as **read-only
  historical port reference** only — it holds the previous
  bundled-extension architecture (`fivem-studio`, `fivem-lua`). Do not
  add code there, do not wire it into the build, do not import from it
  at runtime. Delete the whole directory once you're confident nothing
  in the fork is still being ported out of it.
- When in doubt about whether something is "production-ready" — ask
  yourself if you'd be comfortable shipping it as-is in a public release.
  If not, it isn't.
- The `.fxgraph` visual editor must compile to real Lua that runs as a
  normal Cfx resource (FiveM or RedM). Never re-introduce a runtime
  interpreter.
- Default UI = stock VSCode look. No custom theme, no custom chrome
  beyond name + icon. If a tweak feels like "polish", verify the user
  asked for it before doing it.
- Cfx.re ToS forbids bundling `FXServer.exe`. Always download on demand
  (the artifacts host serves both FiveM and RedM builds).

## 14. The user reserves the right to drop the plan-first rule

If the user says "skip the plan, just do it" — do it. This document
defaults to plan-first. The user can opt out per-change. They can't
opt out implicitly by saying "make the change quick".

---

If you've read this, the next thing you do is read `ONBOARDING.md`. Then
ask the user for the next concrete task. Don't start anything until you
have one.
