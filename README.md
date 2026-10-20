# iTest

**Hand regression testing to an agent you can control.**

AI-first test management platform: manage cases, environments, and plans in one sentence. The space assistant, built on the [pi](https://github.com/badlogic/pi-mono) agent framework, turns "requirement → cases → live verification → solidification → plan execution → attribution" into a conversational workflow — while traditional pages (cases / plans / reports) remain for hands-on refinement.

> 中文文档见 [README.zh-CN.md](README.zh-CN.md) · [Chinese documentation](README.zh-CN.md)

## Read the story first

Recorded scripts break on every change, intent-driven testing is slow and drifts, and with AI coding raising commit frequency, regression ends up being run blind. The article below walks through the design: dual engines for intent-driven and mechanical instructions, cases that self-heal across versions, and automatic case selection based on the blast radius of a change.

**[开源自动化回归测试，交给一个可靠的 Agent](https://mp.weixin.qq.com/s/kgM6LAq_zphtbBPu956v_w)** (WeChat, 中文) — 2026-10-20

## Screenshots

**AI assistant** — describe what you need; the assistant inspects the environment, stages objects for you to confirm, and explains what it can do.

![AI assistant](docs/screenshots/assistant.png)

**Case editing** — every step carries its kind (`AGENT` / mechanical), and unsolidified steps are flagged in place, so you always know what still needs a real browser run.

![Case editing](docs/screenshots/case-edit.png)

**Plan run, live** — the browser runs in real time with a live view, and the timeline records each case with its verdict and attribution.

![Plan run, live](docs/screenshots/plan-run-live.png)

## Why iTest

Regression automation usually gets stuck at three barriers. iTest has an engineering answer for each:

| Industry pain point | iTest's answer |
|---|---|
| Recorded scripts break on every change — scripts bind to page structure and locators, so one version bump invalidates a whole batch of cases | Cases are first run to green by AI in a real browser, then `solidify_case` turns them into mechanical DSL steps; when the page structure changes, cases self-heal and recompile against the new version instead of being hand-patched one by one |
| Intent-driven testing is slow and unpredictable — every step requires model inference, so speed and token cost both suffer, and behavior changes with context | Dual-mode replay: AI handles exploration and verification, while mechanical steps are solidified and executed by playwright-core at high speed and precision; only when a mechanical step fails does a classifier downgrade to on-the-fly AI execution |
| AI coding accelerates delivery but coverage lags behind — commit frequency grows, yet test assets still rely on manual upkeep | The requirement → case design methodology is built into the assistant's system prompt (`reqDesign.ts`: every case states its stance on normal flow, boundaries, illegal input, state transitions, permissions, etc.), and repo sandbox tools (`repo_read` / `repo_grep` / `static_locator`) anchor cases to real source code, so change impact is no longer assessed by hand |

## Features

- **Dual-mode replay**: two engines — AI-driven (`aiTask`) and mechanical scripts (compiled DSL) — balancing coverage with runtime efficiency
- **AI-native workbench**: the AI assistant spans the whole flow of case generation, debugging, execution, and attribution; natural language leads straight to execution
- **Data-driven testing**: datasets (`/p/:projectId/datasets`) bind to case parameters, one row of data per scenario
- **Self-healing cases**: `verify_case` measures step by step in a real browser, `solidify_case` recompiles and solidifies; the mechanical DSL updates itself as page structure changes
- **Coverage design built in**: incoming requirements go through a coverage design first (functionality / exception / boundary / security / UIUX — every dimension takes a stance, per `reqDesign.ts` + `packages/shared/coverage.ts`), so expected values are never invented
- **PC and mobile coverage**: Web runs on playwright-core, iOS/Android on the agent-device SDK, all managed from one platform

## Architecture

Turborepo monorepo:

- `apps/api`: Node 22 + Express 5 + Drizzle + PostgreSQL + Redis (execution queue worker + plan scheduler)
- `apps/web`: React 19 + Vite + Tailwind v4 + assistant-ui (port 5173)
- `apps/recorder`: Chrome Manifest V3 extension (recording Web cases)
- `apps/api/src/pi`: space assistant backend — pi AgentSession, space tool set (staging / verification / solidification / skills / MCP), SSE event stream
- `apps/api/src/execute`: execution engine — playwright-core (Web) / agent-device SDK (mobile), AI fallback downgrade, failure attribution
- `packages/shared`: step DSL + Zod schema + replay utilities
- `packages/ui`: design tokens (`tokens.css`) + utility classes

## Ports

| Service | Port |
|---|---|
| Web | 127.0.0.1:5173 |
| API | 127.0.0.1:54321 |
| PostgreSQL | 127.0.0.1:5432 (container `itest-pg`) |
| Redis | 127.0.0.1:6379 (container `itest-redis`) |

## Getting started

```bash
cp .env.example .env   # at least change AUTH_JWT_SECRET / RECORDER_TOKEN_SECRET
pnpm install
pnpm dev   # docker compose brings up PG/Redis → drizzle migrate → turbo starts web + api in parallel
```

Visit http://localhost:5173. Seed account `admin/admin123` (password change forced on first login).

Prerequisites: Docker (for PG/Redis) plus Node 22 and pnpm 9 installed locally.

## Core flow

Four steps to run a regression: **ingest requirement → generate cases → execute and verify → review report**. Requirements come in, reports go out, everything in between is handled by iTest.

1. `/settings` — configure the LLM provider (mock / openai / anthropic / google; leave model blank to use the provider default)
2. `/` — project → version space (`/p/:projectId/v/:versionId/…`): AI assistant / cases / execution plans / execution history / workbench
3. **AI assistant**: one sentence creates a case → the AI stages objects (StagePanel) → a human selects and saves; `verify_case` measures step by step in a real browser (with a live view), `solidify_case` solidifies mechanically replayable steps into compiled steps; when intent is unclear, a confirmation card (confirm_request) is shown first
4. Traditional path: case detail → "Record supplement" (Chrome extension), "AI supplement steps", "Execute"; steps can be edited, copy-pasted, undone, and recompiled on failure
5. `/p/.../plans` — plan orchestration (link cases + environment + scheduled runs) → execution history includes per-step screenshots and failure attribution

## Space assistant (pi)

- **Scope**: threads are isolated per version space (`workspacePath ≡ versionId`); the left rail ThreadList supports switch / rename / delete / collapse.
- **Tool set** (`apps/api/src/pi/space/tools/`): inspect_page / announce_plan / manage_cases / manage_scenarios / manage_environments / manage_plans / verify_case / solidify_case / manage_skill / manage_mcp / query_history, etc.; plus repo sandbox tools `repo_ls` / `repo_read` / `repo_grep` / `static_locator` / `repo_run` (`apps/api/src/repo.ts`).
- **Skills**: content lives in an on-disk directory tree (container `skills/` volume; the DB keeps metadata only), with import / edit / script execution; `export-skills-to-disk.mjs` exports before publishing.
- **Suggested follow-ups**: after each answer settles, 3 follow-up suggestions are generated by transcribing the thread.
- **Image attachments**: composer screenshots go straight into the conversation (the model's `input` must declare `image`; a gateway alias model that omits the declaration silently strips images).
- **Session persistence**: AgentSession is in-process memory state (`SessionManager.inMemory()`) — an empty thread list after restarting the api is expected; the DB only stores thread metadata and staged objects.

## Case execution (real browser)

Execution drives local chromium through playwright-core (headless), with per-step screenshots written to `apps/api/screenshots/<reportId>/`.
The chromium binary is **not** downloaded by `pnpm install` — it must already exist locally:

- `npx playwright install chromium` (cached in `~/Library/Caches/ms-playwright` / `~/.cache/ms-playwright`); or
- set `CHROMIUM_PATH` to point at a system chromium.

When a mechanical step fails, a classifier decides whether to downgrade to on-the-fly AI execution (`aiTask`), and the downgrade result is written back into the report; with no browser available it falls back to the mock path and the report says so.

## Loading the Chrome extension

First compile `modules/` with `pnpm --filter @itest/recorder build`, then load the extension:

1. Open `chrome://extensions/`
2. Turn on "Developer mode"
3. "Load unpacked" → select the `apps/recorder/` directory

Across machines, point `RECORDER_PUBLIC_WS_URL` at the API port (`ws://<host>:54321/recorder`); plaintext ws + a token in the query string — never expose it to the public internet.

## Mobile testing

Supports **iOS Simulator** and **Android Emulator**, based on the [agent-device](https://github.com/callstack/agent-device) SDK (`apps/api/src/execute/mobileEngine.ts`).

- Device targets live under the project at `/p/:projectId/device-targets`, split by mobileOs, with deviceRef and appBundleId as fallbacks.
- A case with `platform='mobile'` automatically routes to the MobileEngine on execution; the report header shows a device pill.
- Manual check: `node apps/api/probe-mobile.mjs` (`DRY_RUN=1` only prints the request sequence).
- Boundaries: no real devices / cloud devices / screen recording.

## Testing and quality

```bash
pnpm verify  # lint + typecheck + test (web + api)
```

Backend tests require Docker (testcontainers spins up a temporary PG); `apps/api` has `TESTCONTAINERS_RYUK_DISABLED=true` pinned.

## Deployment

`infra/docker/`: `api.Dockerfile` / `web.Dockerfile` (nginx reverse proxy + direct WS passthrough) / `release.sh` + `deploy.sh` (build image → load on remote → roll containers → smoke). In production, migrations are applied automatically by `drizzle-kit push` as the api container starts — there is no separate migrate step. The skills volume is tar-backed up before every deploy.

## Known boundaries

- Assistant thread sessions are in-memory: after an api restart, old threads keep only their metadata (the list is filtered by `messageCount>0` and comes up empty)
- Background threads do not stream: the rail's running indicator is only real for the currently open thread
- Uploads: a single file ≤ 50MB, reused across cases by sha256; multiple files and drag-and-drop are not supported
- Password encryption: AES-256-GCM, key from `ENCRYPTION_KEY` (base64, 32 bytes) — losing it means losing the data for good
- Component recognition covers AntD / Element / iView only; multi-tab recording only takes over derived tabs
- Production must change `AUTH_JWT_SECRET` / `RECORDER_TOKEN_SECRET`, and `ENCRYPTION_KEY` must be configured

## Contributing

Contributions via PR are welcome. The `main` branch is protected: merging requires **at least 1 approving review**, and all conversations must be resolved. Please open an issue to discuss larger changes first, so nobody wastes effort.

- Run `pnpm verify` before committing (lint + typecheck + test) — backend tests require Docker (testcontainers spins up a temporary PG)
- Do not commit any secrets or credentials: local configuration goes in `.env` (see `.env.example`); `infra/docker/deploy.d/` and `infra/docker/.env.production` are gitignored

## License

This project is licensed under the [Apache License 2.0](LICENSE).

`apps/api/scripts/skill-creator-content/` is a verbatim copy of Anthropic's official `skill-creator` skill, covered by its own Apache-2.0 `LICENSE.txt` (that file is retained unmodified). See [NOTICE](NOTICE) for details.
