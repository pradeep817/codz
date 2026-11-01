# codz — Roadmap & Implementation Plan

**Status:** living document for post-v0.1.0 work.  
**Last updated:** October 2026.

Single reference for product improvements, engineering specs, and release phases. Replaces the separate implementation plan.

---

## Ground rules (apply to every item)

These must not regress:

- **Offline by default.** No network, no telemetry. Anything that touches the network is explicit opt-in.
- **No runtime dependencies.** Node 22.18+ running TypeScript directly; no build step in development.
- **Every command supports `--json`** and prints exactly one JSON object: `{"ok": true, ...}` or `{"ok": false, "error": {"code", "message", "hint"}}`.
- **Exit codes:** 0 success, 1 reported error, 2 unparsable command line.
- **Change pipeline:** Anything that changes files goes through plan → preview → apply → undo. Nothing writes without a diff.
- **Secrets scrubbing** (headers, cookies, `-u`, `-b`, token/key/api_key query params) applies to every new input source.
- **Each new error** gets a `code`, `message`, and one-line `hint`, and is added to the troubleshooting table in the README.
- **Each feature ships with** tests, a README section, and a flag-reference entry.

---

## 1. v0.1.0 baseline (shipped — do not reimplement)

### Architecture

Skills → `EndpointSpec` → adapters → change sets. Offline, diff-first, undo, `--json`.

### Shipped commands

| Area | Commands |
|------|----------|
| **Setup** | `init`, `setup`, `explain` |
| **API** | `api add`, `api import`, `api update`, `api remove`, `api rename`, `api wire` |
| **GetX** | `module add` |
| **Other skills** | `mock add`, `locale add`, `locale key`, `theme set`, `route add`, `screen add` |
| **Safety** | `apply`, `undo [--to <id>]`, `history [show <id>]`, `--plan`, `--dry-run`, `--commit`, `--open` |
| **Health** | `doctor` (project health — see below), `doctor --fix`, `check` (CI gate), `doctor --setup` (environment) |
| **Inspect** | `api list`, `api show`, `config` / `config get` / `config set` / `config check`, `plans list` / `plans show` / `plans clean` |
| **Shell** | `completion bash\|zsh\|fish` |

### Shipped import (`api import`)

- **CLI:** `codz api import <file> [--list] [--tag t] [--only n] [--path glob] [--method M] [--max n] [--base-url url] [--include-errors] [--skip-conflicts]`
- **Formats:** OpenAPI 3.x (JSON + YAML via `parseYamlDocument`), **Swagger 2.0**, Postman v2.x, **HAR** (`src/input/har.ts`)
- **Pipeline:** `readApiFile` → `EndpointSpec` → `planEndpoint` (same as `api add`)
- **Behavior:** Combined change set; existing endpoints skipped; per-endpoint failures collected in `skipped[]`

### Shipped project doctor (`codz doctor`)

Read-only checks over the project map (`src/skills/doctor.ts`):

| Check | Reports |
|-------|---------|
| `locales` | Missing keys (error), extra keys, untranslated texts, unused keys |
| `api` | Calls with no error handling; endpoints without typed response |
| `urls` | Hardcoded `http(s)://` outside config |
| `models` | Models nothing uses |

Flags: `--only locales,api,urls,models`, `--strict` (warnings also fail), `--json`.  
Exit 1 on errors; with `--strict`, warnings also exit 1.

### Partial / interactive today

- `api add` with TTY and no input → paste prompt (`readPasteInteractive`)
- Colored diffs when stdout is a TTY

### Known gaps

| Area | Gap |
|------|-----|
| **Distribution** | No npm compile step; requires Node 22.18+ (MIT licensed) |
| **Import** | No interactive `--select` checklist yet |
| **MCP** | Not built |
| **Parsing** | Text-based scanning, not AST |
| **Frameworks** | No axios, React Query, Pages Router, Retrofit, freezed, etc. |

---

## 2. Priority overview

| Phase | Focus | Effort |
|-------|-------|--------|
| **1** | Quick wins: discoverability, config, completions, CI, setup doctor | S–M |
| **2** | Daily driver: doctor `--fix`, import gaps (HAR, filters), screen scaffold | M |
| **3** | Advanced & agents: MCP, `api sync`, React Query, npm publish | M–L |
| **4** | Scale: AST, more stacks, plugins, editor integration | L |

### Top 10 implementation order

1. ✅ `api list` + `api show` — discoverability from project map
2. ✅ `codz config` view/set/check — fewer misconfigurations
3. ✅ Shell completions — daily QoL
4. ✅ **Setup doctor** (`doctor --setup`) — environment checks (§3)
5. ✅ `doctor --fix` — actionable project health (§4)
6. ✅ `plans list` / `plans show` — complete plan workflow
7. ✅ `screen add` — end-to-end scaffold
8. ✅ GitHub Actions + license — production credibility
9. `api sync` + HAR import — teams and browser capture (✅ HAR import shipped; `api sync` is phase 3)
10. MCP server — agent/IDE story (§5)

---

## 3. Setup doctor (`doctor --setup`) — ✅ shipped

### Goal

Tell users whether codz *can run* in this environment, separate from project-health `doctor`.

### CLI

```
codz doctor --setup [--cwd <folder>] [--json] [--no-color]
```

Read-only. Never writes files. Coexists with default `codz doctor` (project checks).

### Checks

Each returns `pass`, `warn`, or `fail`, with `id`, `message`, `hint`.

| id | Checks | Result |
|----|--------|--------|
| `node_version` | Node >= 22.18 | fail if older |
| `git_present` | git installed and project is a repo | warn if not |
| `git_clean` | working tree clean (ignoring `codz.config.yaml`) | warn if dirty |
| `config_found` | `codz.config.yaml` found walking up from cwd | fail if missing → `codz init` |
| `config_valid` | parses, no tabs, known keys, valid values | fail on errors, warn on unknown keys |
| `config_paths` | folders in config exist and inside project root | warn if missing, fail if outside root |
| `gitignore` | `.codz/` is ignored | warn if not |
| `framework_supported` | Next.js or Flutter for `api add` | warn on generic adapter |
| `unsupported_libs` | axios, http package, freezed, Pages Router detected | warn, name the library |
| `formatter` | Prettier (Next.js) or Dart SDK (Flutter) | warn if missing |
| `analyzer` | `typescript` in node_modules, or Dart SDK + `flutter pub get` | warn if missing |
| `scan_cache` | cache present and not stale | warn → `codz explain --rescan` |
| `history_state` | `.codz/` readable, no half-applied change | fail if inconsistent |

### Output (human)

```
codz doctor --setup  (flutter@0.1.0)
  pass  node_version        v22.19.0
  pass  config_valid
  warn  formatter           Dart SDK not found. Code will be written but not formatted.
  fail  config_paths        modelsFolder lib/data/models does not exist
Summary: 9 pass, 2 warn, 1 fail
```

### Output (JSON)

```json
{"ok": true, "checks": [{"id": "node_version", "status": "pass", "message": "v22.19.0"}], "summary": {"pass": 9, "warn": 2, "fail": 1}}
```

`ok` is true when the command ran. Exit **1** if any check is `fail`; **0** if only pass/warn.

### Implementation

- Shipped as `src/skills/setupDoctor.ts` (a `CHECKS` list of `{id, run(ctx)}`) and `src/core/validateConfig.ts`
- `scan_cache` only checks that the cache is readable: it rebuilds itself when project files or codz change, so it cannot go stale
- `validateConfig(config)` in `src/core/config.ts` — reused by `codz config check` (G3)
- Reuse existing config loader and detector; do not duplicate scan logic
- Setup doctor `--fix` is out of scope for v1; hints only

### Tests

- Fixture per check state; JSON shape snapshot; exit code tests

### Done when

All checks ship, README gets "Check your setup" after Install, troubleshooting points here first.

---

## 4. Project doctor extensions (`doctor --fix`) — ✅ B1–B5 shipped

Extends the **existing** project doctor (not setup doctor).

| ID | Item | Example |
|----|------|---------|
| B1 | **`doctor --fix`** | Auto-fix with diff preview |
| B2 | Fix missing locale keys | `locale key` / `locale add` |
| B3 | Fix hardcoded URLs | Rewrite to env/base URL |
| B4 | Fix unused models | Delete or link to `api remove` |
| B5 | Fix untyped responses | Suggest `api update --sample` |
| B6 | SARIF output | `doctor --format sarif` for CI/IDE |
| B7 | Pre-commit hook | `codz hook install` → `codz check` |

`codz check` — CI alias: `doctor --strict` + fresh map rescan.

---

## 5. Import extensions (`api import`) — ✅ shipped except `--select`

### Goal

Extend existing `api import`; do **not** rebuild OpenAPI/Postman/Swagger support.

### Gaps to add

| Gap | Spec |
|-----|------|
| **HAR** | JSON responses from XHR/fetch; group by method+normalized path; scrub secrets; warn on size/PII |
| **`--list`** | List found endpoints and exit (no plan); works with `--json` |
| **`--select`** | Interactive checklist (TTY only) |
| **`--path <glob>`** | e.g. `"/users/**"` |
| **`--method <M>`** | Repeatable |
| **`--base-url <url>`** | Override host matching |
| **`--max <n>`** | Cap; warn above 50 without `--yes` |
| **`--skip-conflicts`** | Apply non-conflicting endpoints when some fail |

### HAR rules

- Keep JSON `mimeType`; skip images, scripts, HTML, analytics hosts
- Normalize path params (numbers, UUIDs, 24-char IDs)
- Exclude non-2xx by default (`--include-errors` later)
- Scrub headers, cookies, query tokens, postData credentials
- **Retention:** response bodies used only for inference; never stored in cache or history (document in README)

### Conflict behavior (decided)

**Shipped:** without `--skip-conflicts`, codz lists every endpoint that cannot be added and stops before planning; with it, the rest are imported and the conflicts are reported.

### Architecture note

`EndpointSpec` + `buildEndpoint()` already unify cURL and import. HAR becomes another producer — no large refactor required.

### New error codes

| Code | When |
|------|------|
| `bad_har` | Invalid HAR JSON |
| `no_endpoints` | No importable endpoints after filters |
| `too_many_endpoints` | Above cap without `--max` / `--yes` |

### Tests

- HAR fixture with secret header; golden diffs; determinism; secrets never in plan/cache/history

---

## 6. MCP server (`codz mcp`) — ✅ shipped (stage F)

### Goal

AI agents use codz with the same safety as the CLI.

### CLI

```
codz mcp [--cwd <folder>] [--read-only]
```

Stdio JSON-RPC 2.0; logs on stderr only; no runtime dependencies.

### Tools (wrap `--json` — no behavior drift)

| Tool | Wraps | Notes |
|------|-------|-------|
| `codz_explain` | `explain --json` | `rescan?` |
| `codz_doctor` | `doctor --json` | project health |
| `codz_doctor_setup` | `doctor --setup --json` | environment |
| `codz_api_plan` | `api add ... --plan --json` | never applies |
| `codz_import_plan` | `api import ... --plan --json` | filters |
| `codz_apply` | `apply <id> --json` | disabled in `--read-only` |
| `codz_undo` | `undo --json` | disabled in `--read-only` |
| `codz_history` | `history --json` | read-only |

Future: `api_list`, `api_show`, `module_plan`, etc.

### Safety

- Plan-then-apply enforced; no combined create+apply tool
- `--yes` and `--allow-dirty` **not** exposed to MCP (CLI-only)
- Full `changeSet` diffs in tool results
- Mark `codz_apply` / `codz_undo` as destructive for client prompts
- Paths validated inside project root

### Resources (phase 2)

- `codz://config`, `codz://map`, `codz://plans/<id>`

### Client setup

```json
{
  "mcpServers": {
    "codz": {
      "command": "codz",
      "args": ["mcp", "--cwd", "/path/to/project"]
    }
  }
}
```

### Tests

- Protocol: initialize, list tools, call each; read-only mode; stdout is JSON-RPC only

### Done when

Agent can explain → plan endpoint → show diff → apply → undo via MCP only. README "No MCP server yet" removed.

---

## 7. Improvement backlog (by category)

### A. User experience & discoverability

| ID | Item | Example | Size |
|----|------|---------|------|
| A1 | `api list` | `codz api list [--json]` | S |
| A2 | `api show <name>` | method, path, model, callers | S |
| A3 | `config` view/set | `codz config set modelsFolder src/types` | S |
| A4 | Shell completions | `codz completion zsh` | S |
| A5 | Plan management | `plans list`, `plans show <id>` | S |
| A6 | Richer history | `history show <id>`, `undo --to <id>` | M |
| A7 | Progress indicators | Import progress bar | S |
| A8 | Interactive TUI-lite | Menus for init, import, paste preview | M |
| A9 | `codz check` | CI alias for doctor + rescan | S |
| A10 | Context-aware help | Framework-specific `--help` examples | S |
| A11 | Onboarding wizard | init → setup → first `api add` | M |
| A12 | Side-by-side diff | `--diff side` | S |
| U1 | Full interactive `api add` | Prompts for name, model, confirm | M | *partial: paste exists* |
| U2 | Auto-commit | `--commit [message]` after apply | S |
| U4 | Better preview | Summary line, `--open` in `$EDITOR` | S |
| U5 | Clipboard input | `--clipboard` (pbpaste, xclip, …) | S |
| U6 | Per-file accept | Like `git add -p` | M |

### B. Doctor (see §3, §4)

### C. API layer (advanced)

| ID | Item | Example | Size |
|----|------|---------|------|
| C1 | `api sync` | Diff vs OpenAPI; `--apply` | L |
| C2 | Breaking change report | Fields changed + call sites | M |
| C3 | HAR import | §5 | M |
| C4 | HAR picker | `api add --har file.har --pick` | S |
| C5 | Multi-env base URLs | `config set baseUrl.staging …` | M |
| C6 | Auth wiring | `auth set bearer --env API_TOKEN` | M |
| C7 | Request validation | Zod from models | L |
| C8 | `api test` | Live call vs model | M |
| C9 | Pagination helpers | Cursor/offset wrappers | M |
| C10 | Import filters | `--path`, `--method`, `--list` | S |

### D. End-to-end scaffolding

| ID | Item | Example | Size |
|----|------|---------|------|
| D1 | `screen add` | module + route + wire + UI | L |
| D2 | Next.js page skeleton | Server/client from conventions | M |
| D3 | GetX full module | One diff | M |
| D4 | Riverpod AsyncValue screen | Provider + loading/error | M |
| D5 | `feature remove` | Inverse of screen add | M |

### E. Framework expansion

| ID | Item | Priority |
|----|------|----------|
| E1 | React Query hooks | High |
| E2 | axios | Medium |
| E3 | Pages Router | Medium |
| E4 | SWR | Low |
| E5 | Flutter `http` | Medium |
| E6 | Retrofit / Chopper | Low |
| E7 | freezed models | Medium |
| E8 | json_serializable integration | Medium |
| E9 | React Native adapter | ✅ shipped (stage G) |
| E10 | Vue / Nuxt | Future |
| E11 | Android (Kotlin) adapter | ✅ shipped (stage G) |
| E12 | Android: Ktor client, `mock add` (OkHttp interceptor), XML Views screens | Next |
| E13 | Native iOS (Swift, URLSession/Alamofire, SwiftUI) | Future |

### F. Agent & IDE

| ID | Item | Size |
|----|------|------|
| F1 | MCP server | §6 | M |
| F2 | Structured MCP schemas | S |
| F3 | Plan-first agent docs | S |
| F4 | VS Code extension | L |
| F5 | Cursor rules generator | `codz rules` | M |

### G. Configuration

| ID | Item | Size |
|----|------|------|
| G1–G2 | `config` view/set | S |
| G3 | `config check` | Reuses `validateConfig` | S |
| G4 | Config presets | `init --preset team-nextjs` | M |
| G5 | Monorepo root pick | `init --root apps/web` | S |
| G6 | Convention diff on rescan | M |

### H. Mocks

| ID | Item |
|----|------|
| H1 | `mock serve --port 3001` |
| H2 | `mock record getUser` |
| H3 | Mock scenarios (error, empty, slow) |
| H4 | MSW integration (Next.js) |

### I. Locales

| ID | Item |
|----|------|
| I1 | `locale sync` export for translators |
| I2 | `locale remove <lang>` |
| I3 | Optional translation hook (opt-in network) |
| I4 | Plural / ICU in ARB |

### J. Theme

| ID | Item |
|----|------|
| J1 | `theme show` |
| J2 | `theme reset` |
| J3 | Import Figma tokens |
| J4 | Dark/light consistency check |

### K. Engineering

| ID | Item | Priority |
|----|------|----------|
| K1 | Incremental AST editing | High (long-term) |
| K2 | Split large adapters | Medium |
| K3 | Structured analyzer JSON parsing | Medium |
| K4 | CLI integration tests | High |
| K5 | GitHub Actions CI | High |
| K6 | npm publish build (Node 18+) | High |
| K7 | Open-source license | High |
| K8 | Windows CI | Medium |
| K9 | Plugin / adapter API | Future |
| K10 | Parallel scan | Low |

### L. Distribution & docs

| ID | Item |
|----|------|
| L1 | `npm install -g codz-cli` |
| L2 | Homebrew formula |
| L3 | Docs site |
| L4 | `CHANGELOG.md` + semver |
| L5 | `codz upgrade` hint |
| L6 | Example template repos |

### Capability (from implementation plan)

| ID | Item | Size | Notes |
|----|------|------|-------|
| C1b | Live sample fetch | M | `--fetch` opt-in; breaks offline guarantee |
| C3b | Custom templates | L | Config-referenced overrides |
| C4b | Test generation per endpoint | M | Vitest/Jest, then Flutter |
| C6b | Natural-language input | L | Rule-based first; LLM opt-in only |
| ~~C7~~ | route/locale/theme skills | — | **Done in v0.1.0** |

---

## 8. Phased delivery

### Phase 1 — Quick wins ✅ shipped (October 2026)

| IDs | Item |
|-----|------|
| A1, A2 | `api list` / `api show` |
| A3, G3 | `config` + `config check` |
| A4 | Shell completions |
| A5 | `plans list` / `show` |
| §3 | Setup doctor (`doctor --setup`) |
| K5, K7 | CI + license |

### Phase 2 — Daily driver ✅ shipped (October 2026; `--select` and SARIF output are not built)

| IDs | Item |
|-----|------|
| B1–B5 | `doctor --fix` |
| A9 | `codz check` |
| §5 | HAR + import filters (`--list`, `--path`, `--max`) |
| D1 | `screen add` |
| A6, A7 | History + import progress |
| U2, U4, U5 | Auto-commit, preview, clipboard |
| K4 | CLI integration tests |

### Phase 3 — Advanced & agents (1–2 months)

| IDs | Item |
|-----|------|
| §6 | MCP server |
| C1, C2 | `api sync` + breaking changes |
| C6 | Auth wiring |
| E1 | React Query hooks |
| F1 | MCP resources |
| K6 | npm publish build |

### Phase 4 — Scale (ongoing)

| IDs | Item |
|-----|------|
| K1 | AST editing |
| E2–E8 | More stacks |
| K2, K3 | Adapter split + verify |
| F4, C3b, K9 | Extension, templates, plugins |
| E9, E10, E11 | React Native ✅, Android ✅, Vue |

---

### Improvement plan (October 2026), in priority order

| Stage | Items | Status |
|-------|-------|--------|
| A. Weak behaviours | `api update` keeps hand-written model members and doc comments; `mock add` keeps edited mocks (`--force` to replace); `doctor` traces namespaced translation keys; `/config.json` names `getConfig` | ✅ shipped |
| B. Trust on real projects | Rename/remove through the project's TypeScript compiler (K1, TS part); corpus run against public repos (weekly CI); `check-generated.sh` compiles `.tsx` pages and a `flutter create` project | ✅ shipped |
| C. More stacks | axios and TanStack Query hooks (Next.js); freezed models, Retrofit clients and Cubit screens (Flutter); mocks for axios instances and for Dio created inside a get_it registration | ✅ shipped |
| D. Bigger features | `api sync` (with `--add`, `--remove`, `--check` and breaking-change report), `screen add --form` (Next.js, Flutter), `test add` (Vitest/Jest, flutter_test with a fake Dio adapter), custom templates (`templates init`, `{{default}}` wrapping, file headers) | ✅ shipped |
| E. Engineering health | One command table driving help, per-command help, completion, the option parser, unknown-option errors and docs/COMMANDS.md; adapters split into scan / generate files; seeded parser fuzz tests (found and fixed 3 crashes); Windows in CI with LF line endings pinned | ✅ shipped |
| F. Reach | `codz mcp` (every command a tool from the command table, edits as plans, `apply` tool, project and commands resources); npm build (`dist/`, Node 20+, `prepublishOnly`); VS Code extension (palette commands, diff preview before apply, doctor in Problems) | ✅ shipped |
| G. New projects and mobile | `codz create` wizard (type → architecture → name → org → base URL → options; platform creator or an offline skeleton; setup, config, theme, install, git); React Native adapter (Expo and bare, React Navigation and Expo Router, fetch helper / axios / TanStack Query, screens, forms, mocks, Jest tests, theme); Android adapter (Kotlin, Retrofit + kotlinx/Moshi/Gson, Hilt / Koin / service locator, Compose screens with ViewModels and `UiState`, forms, routes, MockWebServer tests, theme, `api update/rename/remove`); Flutter `bloc` setup; CI job that builds created Android projects with Gradle | ✅ shipped |
| H. Starter templates (client) | `codz new` from a template folder or the catalog; `starters list/show/cache`; `login/logout/whoami` (device code, `0600` token file, `CODZ_TOKEN`); strict manifest and JSON parsing; strict tar reader with limits; Ed25519-signed index with rollback and expiry checks; revocation list; per-file hashes; atomic create; undo; plans; MCP plan-only; publishing script (check, pack, sign, index); two internal starters; fake-registry tests. Two-key freshness (offline-signed index, online-signed `timestamp.json`, `scripts/starters.ts index --timestamp-key` and `timestamp`). The catalog, accounts, checkout (Razorpay), email and invoices live in the separate codz store project. Still to do: the CI matrix for published starters | ✅ client shipped |

Found by the first corpus run and fixed in stage B: a comment line inside `dependencies:` hid the rest of the list (`http` projects were treated as Dio); `GetIt.I.register…` was not recognised as a registration point, and an import was added even when no registration was; a missing `dio` dependency was not reported; feature-first projects sent new models into one feature's folder.

Found by the fuzz tests in stage E and fixed: a Swagger `host` that is not a valid URL crashed `api import`; a YAML alias (`*`) with no name crashed the spec reader; config YAML errors were plain errors instead of codz errors.

Still open after stage C (seen in bulletproof-react): object-style clients (`export const api = { get<T>(url) {...} }` around fetch) are not recognised as a request helper, and `export const fn = (...) =>` endpoint functions with an object parameter are not scanned. Hooks in feature-first projects go to `src/hooks` rather than next to each feature's API file.

---

## 9. Architecture notes

### Write commands

```
Input → Skill (planXxx) → PlannedEdits → buildChangeSet → diff / --plan / apply → adapter.plan*
```

### Read-only commands

Read `ProjectMap` + config directly: `api list`, `api show`, `config`, `plans list`, `doctor`, `doctor --setup`.

### Suggested new files

| File | Purpose |
|------|---------|
| `src/doctor/checks/*.ts` | Setup doctor checks |
| `src/core/validateConfig.ts` | Config validation |
| `src/skills/apiList.ts` | List/show endpoints |
| `src/skills/config.ts` | Config view/set |
| `src/skills/plans.ts` | Plan management |
| `src/skills/doctorFix.ts` | Project doctor fixes |
| `src/skills/apiSync.ts` | OpenAPI drift |
| `src/skills/screen.ts` | Composite scaffold |
| `src/input/har.ts` | HAR parser |
| `src/mcp/` | MCP server entry |

---

## 10. What to avoid

| Avoid | Reason |
|-------|--------|
| Rebuilding `api import` / Swagger / OpenAPI | Already shipped |
| Replacing project `doctor` with setup checks only | Two modes: `--setup` vs default |
| Auto-apply without diff | Core safety brand |
| Cloud sync / telemetry | Offline positioning |
| Full AST rewrite upfront | Incremental only |
| Many frameworks at once | Deepen Next.js + Flutter first |
| Storing secrets in config | Env-based auth only |
| GUI-first product | CLI + optional extension |

---

## 11. Success metrics

| Metric | Target |
|--------|--------|
| Time to first endpoint | < 2 min after `init` |
| Commands to add a screen | 1 (`screen add`) vs 3+ today |
| Doctor fix rate | > 50% of findings auto-fixable |
| Agent success | Plan → apply without manual edits |
| CI | Every PR; `check-generated.sh` on release |
| npm install | Works without Node 22 |

---

## 12. Guide & docs checklist

Track alongside code:

- [x] "Check your setup" (`doctor --setup`) after Install in README
- [x] "Import many endpoints" — document HAR and new filters when shipped
- [ ] "Use with AI agents (MCP)" when MCP ships
- [ ] Flag reference + troubleshooting for every new flag and error code
- [ ] Remove "No MCP server yet" when MCP ships
- [ ] Run `check-generated.sh` in CI; update Flutter experimental note when green
- [ ] Dirty-tree and `init --force` warnings in README

---

## 13. Open decisions

| # | Question | Current leaning |
|---|----------|-----------------|
| 1 | YAML for OpenAPI | **Decided:** minimal parser in `yamlDoc.ts`; document subset limits |
| 2 | Import conflicts on apply | **Decided:** per-endpoint skip while planning; `--skip-conflicts` for partial apply |
| 3 | MCP `--allow-dirty` | **Leaning:** CLI-only; agents use plan+apply on clean tree |
| 4 | HAR / PII retention | **Leaning:** never persist response bodies in cache/history; warn in CLI |

---

## 14. Summary

| Theme | Key work |
|-------|----------|
| **Discoverability** | `api list`, `api show`, `config`, completions |
| **Two doctors** | Setup (`--setup`) + project health (`--fix`) |
| **Import** | Extend with HAR, filters, `--list` — don't rebuild |
| **Workflow** | Plans UI, history, `check`, progress, auto-commit |
| **Scaffolding** | `screen add` |
| **Agents** | MCP server, plan-first |
| **Production** | CI, license, npm build, CLI tests |
| **Reliability** | AST incremental, structured verify, adapter split |
