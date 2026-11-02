# codz commands

Generated from `src/core/commands.ts` (codz 0.1.7). Do not edit by hand; run `npm run docs`.

## Start

### `codz create [name] [--type <type>] [--architecture <id>]`

Create a new project and set it up: pick the type, architecture, name and options, then codz runs the platform creator and applies the architecture.

Asks for anything not given as an option. Architectures: Flutter riverpod, getx, bloc, get_it, none; Next.js fetch-helper, plain-fetch, none; React Native fetch-helper, axios-react-query, axios, none (--flavor expo or bare); Android retrofit-hilt, retrofit-koin, retrofit, none (Kotlin, Jetpack Compose, version catalog); React (Vite) fetch-helper, axios, axios-react-query, none; iOS urlsession, none (SwiftUI, Xcode 16 project). The app opens on a demo screen written in the chosen architecture, on sample data. Without the platform creator (flutter, npx) or with --offline, codz writes a minimal project itself; Android, React (Vite) and iOS always use the built-in templates.

| Option | |
| --- | --- |
| `--type <type>` | Project type: flutter, nextjs, react, react-native, android, ios |
| `--architecture <id>` | Flutter: getx, riverpod, bloc, get_it. Next.js: fetch-helper, plain-fetch. React Native and React: fetch-helper, axios, axios-react-query. Android: retrofit-hilt, retrofit-koin, retrofit. iOS: urlsession |
| `--base-url <url>` | The API's base URL (setup), or only HAR requests under it (import/sync) |
| `--org <com.example>` | Organization in reverse-domain form, for app ids (default com.example) |
| `--tailwind` | Next.js: use Tailwind CSS |
| `--flavor <expo\|bare>` | React Native: Expo (default) or the React Native CLI |
| `--primary <#rrggbb>` | The theme's primary color |
| `--offline` | Do not run the platform's creator; write codz's minimal project |
| `--no-install` | Do not install dependencies |
| `--no-git` | Do not run git init |

### `codz init [--root <folder>] [--force]`

Detect the framework, scan, write codz.config.yaml; offers to set up an API layer when there is none.

| Option | |
| --- | --- |
| `--force` | Do it even when codz would normally refuse (see the command) |
| `--architecture <id>` | Flutter: getx, riverpod, bloc, get_it. Next.js: fetch-helper, plain-fetch. React Native and React: fetch-helper, axios, axios-react-query. Android: retrofit-hilt, retrofit-koin, retrofit. iOS: urlsession |
| `--base-url <url>` | The API's base URL (setup), or only HAR requests under it (import/sync) |

### `codz setup [--architecture <id>] [--base-url <url>]`

Create the API layer for a fresh project.

| Option | |
| --- | --- |
| `--architecture <id>` | Flutter: getx, riverpod, bloc, get_it. Next.js: fetch-helper, plain-fetch. React Native and React: fetch-helper, axios, axios-react-query. Android: retrofit-hilt, retrofit-koin, retrofit. iOS: urlsession |
| `--base-url <url>` | The API's base URL (setup), or only HAR requests under it (import/sync) |

Accepts the change options.

### `codz explain [--rescan]`

Show routes, endpoints, models, locales and conventions.

| Option | |
| --- | --- |
| `--rescan` | Scan again instead of using the cached project map |

## Endpoints

### `codz api add [input] [options]`

Add an endpoint: model, function and registration.

Input: --curl, --url, --clipboard, or a cURL command or URL pasted on stdin, optionally followed by "response:" and JSON (and "request:" and JSON). A response sample is strongly recommended.

| Option | |
| --- | --- |
| `--curl '<curl command>'` | A cURL command; secrets in it are removed, never written |
| `--url '<url>'` | A URL (or "POST https://...") |
| `--method <GET\|POST\|...>` | HTTP method (api add), or only these methods (api import) |
| `--clipboard` | Read the cURL command (and response) from the clipboard |
| `--sample <file.json>` | Response sample; repeat for several samples (repeatable) |
| `--request-sample <file.json>` | Request body sample |
| `--name <functionName>` | Override the derived function name |
| `--path </users/{id}>` | Path parameters (api add), route path (screen/route add), or a path filter (import/sync) |
| `--model-name <Name>` | Name the response model yourself |
| `--no-unwrap` | Keep a {"data": ...} envelope instead of returning data |
| `--into <module>` | Call the endpoint from that module's controller (GetX) |
| `--no-load` | Do not call the load method from onInit |
| `--model-dir <folder>` | Write new models into this folder for this command only (e.g. lib/features/orders/models); set modelsFolder in codz.config.yaml to change it for good |

Accepts the change options.

### `codz api import <file> [filters]`

Add every endpoint from an OpenAPI 3, Swagger 2, Postman or HAR file.

| Option | |
| --- | --- |
| `--tag <tag>` | Only operations with this tag (folder in Postman, host in HAR) (repeatable) |
| `--only <name>` | Only these operations (import), or only these checks (doctor) (repeatable) |
| `--path </users/{id}>` | Path parameters (api add), route path (screen/route add), or a path filter (import/sync) |
| `--method <GET\|POST\|...>` | HTTP method (api add), or only these methods (api import) |
| `--max <n>` | Import at most n operations |
| `--list` | Show what would be imported and stop |
| `--base-url <url>` | The API's base URL (setup), or only HAR requests under it (import/sync) |
| `--include-errors` | HAR: keep failed (non-2xx) responses |
| `--skip-conflicts` | Import what works and report endpoints that cannot be added |
| `--model-dir <folder>` | Write new models into this folder for this command only (e.g. lib/features/orders/models); set modelsFolder in codz.config.yaml to change it for good |

Accepts the change options.

### `codz api sync <file> [--add] [--remove] [--check]`

Bring endpoints in line with an API spec: update changed ones, report breaking changes.

| Option | |
| --- | --- |
| `--add` | Also add operations the project does not have yet |
| `--remove` | Also delete endpoints the spec no longer has |
| `--check` | Report drift without writing; exit 1 when out of sync |
| `--tag <tag>` | Only operations with this tag (folder in Postman, host in HAR) (repeatable) |
| `--path </users/{id}>` | Path parameters (api add), route path (screen/route add), or a path filter (import/sync) |
| `--base-url <url>` | The API's base URL (setup), or only HAR requests under it (import/sync) |
| `--model-dir <folder>` | Write new models into this folder for this command only (e.g. lib/features/orders/models); set modelsFolder in codz.config.yaml to change it for good |

Accepts the change options.

### `codz api diff <old spec> <new spec> [--format md] [--fail-on breaking]`

What changed between two API specs, what breaks, and the lines in this project that use it.

Breaking: an operation removed, a response field removed or retyped, a new path parameter, a new required request field. Warning: a field that can now be null, a removed query parameter, a retyped request field.

Inside a project each change lists the files and lines that use it. Works outside a project too.

CI: codz api diff main.yaml pr.yaml --format md --report api-diff.md (exit 1 on breaking changes); --format sarif for GitHub code scanning.

| Option | |
| --- | --- |
| `--format <text\|md\|json\|sarif>` | Report format (default text; md for a pull request comment, sarif for code scanning) |
| `--report <file>` | Write the report to a file |
| `--fail-on <breaking\|warning\|any\|none>` | Exit 1 at this level (default breaking) |
| `--tag <tag>` | Only operations with this tag (folder in Postman, host in HAR) (repeatable) |
| `--path </users/{id}>` | Path parameters (api add), route path (screen/route add), or a path filter (import/sync) |

### `codz api update <endpoint> --sample <file>`

Rebuild the response model from new samples.

| Option | |
| --- | --- |
| `--sample <file.json>` | Response sample; repeat for several samples (repeatable) |
| `--no-unwrap` | Keep a {"data": ...} envelope instead of returning data |

Accepts the change options.

### `codz api remove <endpoint>`

Remove an endpoint and list callers that break.

Accepts the change options.

### `codz api rename <endpoint> <newName>`

Rename an endpoint and its call sites.

Accepts the change options.

### `codz api wire <endpoint> --into <module>`

Call an endpoint from a module's controller (GetX).

| Option | |
| --- | --- |
| `--into <module>` | Call the endpoint from that module's controller (GetX) |
| `--no-load` | Do not call the load method from onInit |

Accepts the change options.

### `codz api list [filter]`

Every endpoint: method, path, function, response, file.

### `codz api show <endpoint>`

One endpoint: signature, models, every place that uses it.

### `codz model <Name> --from-clipboard | --sample <file.json>`

A model (and its nested models) from JSON, without an endpoint.

Reads the JSON from --from-clipboard, --sample, or standard input (pipe or paste, then Ctrl+D). Nested objects become their own models (Order → OrderItem, OrderAddress); a list gives the model of its items; {"data": ...} is unwrapped unless --no-unwrap.

Writes into the models folder, or --model-dir <folder> for this model only. An existing model with the same name is replaced only with --force.

| Option | |
| --- | --- |
| `--from-clipboard` | Read the JSON from the clipboard |
| `--sample <file.json>` | Response sample; repeat for several samples (repeatable) |
| `--model-dir <folder>` | Write new models into this folder for this command only (e.g. lib/features/orders/models); set modelsFolder in codz.config.yaml to change it for good |
| `--no-unwrap` | Keep a {"data": ...} envelope instead of returning data |
| `--force` | Do it even when codz would normally refuse (see the command) |

Accepts the change options.

### `codz field add <Model> <name:type> [...]`

Add a field to a model, in every place the model spells it.

Types: string, int, double, bool, date, any, a model name, or a list (string[], list<Category>). End with ? for an optional field: rating:double?. The name is the JSON key (created_at); codz writes the property name the project uses (createdAt).

TypeScript interfaces, Dart classes (plain, json_serializable, freezed: constructor, fromJson, field and toJson), Kotlin data classes and Swift Codable structs (CodingKeys too). Only the new lines are added; then it lists the files that use the model.

Accepts the change options.

### `codz field remove <Model> <field> [...]`

Remove a field from a model and list the lines that still use it.

Accepts the change options.

### `codz mock serve [--spec <file>] [--port 4010] [--delay 300] [--items 5] [--scenario normal] [--lan]`

A local fake API with sample data, so screens show data before the backend exists.

Answers the project's endpoints, or every operation in --spec (OpenAPI, Swagger, Postman, HAR), with sample data from the response models. A list and its items share in-memory data, so create, edit and delete work and the list shows the change; restarting resets it. Paths match by their last segments, so /v1/products reaches GET /products. Prints how to point the app at it (emulator, simulator, phone).

Scenarios check every screen state: empty (empty lists), error (500), unauthorized (401), slow (3 s), offline (connection drops). Open http://localhost:4010/__codz to switch them, for every endpoint or one, reset the data, and see each request with its body.

| Option | |
| --- | --- |
| `--spec <file>` | OpenAPI, Swagger, Postman or HAR file to take the endpoints from |
| `--port <n>` | Port for the mock API (default 4010) |
| `--delay <ms>` | Wait before each answer, so loading states show (default 300) |
| `--items <n>` | Items in each list to start with (default 5) |
| `--scenario <name>` | How the mock answers at the start; switch live at /__codz |
| `--lan` | Listen on your network too, for a phone on the same Wi-Fi (default: this computer only) |

### `codz mock add <endpoint>... | --all`

Mock responses for building screens before the backend.

Next.js, React Native and Flutter. Not yet on Android.

| Option | |
| --- | --- |
| `--all` | Every endpoint (mock add, test add), or every plan (plans clean) |
| `--sample <file.json>` | Response sample; repeat for several samples (repeatable) |
| `--keep-values` | Write --sample values exactly as given (no secret or personal-data scrubbing) |
| `--force` | Do it even when codz would normally refuse (see the command) |

Accepts the change options.

### `codz test add <endpoint>... | --all`

Unit tests for API functions with the network faked.

Next.js: Vitest or Jest. React Native: Jest. Flutter: flutter_test with a fake Dio adapter. Android: JUnit with MockWebServer (adds the test dependencies).

| Option | |
| --- | --- |
| `--all` | Every endpoint (mock add, test add), or every plan (plans clean) |

Accepts the change options.

## Screens and app

### `codz env add <name> --base-url <url>`

Add an API environment (staging, qa, ...) the app can run against.

Next.js and Expo: .env.<name> plus npm scripts that load it (dotenv-cli). Vite: .env.<name> and --mode <name>. React Native CLI: an API_URLS table in env.ts. Flutter: env/<name>.json for --dart-define-from-file, and a VS Code run configuration. Android: an apiUrls table in the app build file, picked with -PapiEnv=<name> into BuildConfig.BASE_URL. iOS: an AppEnvironment enum, picked with APP_ENV in the scheme.

The base URL you have now becomes the default environment. Never writes .env.local.

| Option | |
| --- | --- |
| `--base-url <url>` | The API's base URL (setup), or only HAR requests under it (import/sync) |
| `--force` | Do it even when codz would normally refuse (see the command) |

Accepts the change options.

### `codz env list`

The API environments and their base URLs.

### `codz env use <name>`

Switch the app to an environment (React Native CLI, Android, iOS).

Accepts the change options.

### `codz screen add <name> --api <endpoint> [--path /x/:id] [--paginate] [--search] [--form]`

A working screen (route, page, the call, loading, error, data), or a form with --form.

Android: a Compose screen plus a ViewModel (Hilt, Koin or the service locator) with a UiState StateFlow, registered in the NavHost.

| Option | |
| --- | --- |
| `--api <endpoint>` | Endpoint to load (repeat for several in module add) (repeatable) |
| `--path </users/{id}>` | Path parameters (api add), route path (screen/route add), or a path filter (import/sync) |
| `--initial` | Make it the first screen |
| `--form` | A form that sends the endpoint's request body (POST, PUT, PATCH) |
| `--paginate` | List screens: load page after page as you scroll (the endpoint needs a page or offset parameter) |
| `--search` | List screens: a search box (on the server with a q/search parameter, otherwise over the loaded items) |

Accepts the change options.

### `codz route add <name> [--path /x/:id]`

Add a screen and its route (GetX module, GoRoute, Next.js page, React Navigation or Expo Router screen, Compose NavHost entry).

| Option | |
| --- | --- |
| `--path </users/{id}>` | Path parameters (api add), route path (screen/route add), or a path filter (import/sync) |
| `--initial` | Make it the first screen |

Accepts the change options.

### `codz feature add <name> --spec <file> | --api <endpoint>...`

A whole feature in one change: endpoints, list, detail, create and edit screens, routes and tests.

A project with no API layer yet is set up first, in the same change: the recommended architecture (or --architecture), with the base URL from --base-url or the spec.

Without --tag or --path, the endpoints are those whose path or tag names the feature (orders: /orders, /orders/{id}, /users/{id}/orders).

Screens: a list for a GET that returns a list, a detail for a GET with an id, a create form for a POST with a body, an edit form for a PUT or PATCH with a body. Other endpoints are added and listed.

Everything is planned in a private copy of the project and shown as one diff: one apply, one undo.

| Option | |
| --- | --- |
| `--spec <file>` | OpenAPI, Swagger, Postman or HAR file to take the endpoints from |
| `--tag <tag>` | Only operations with this tag (folder in Postman, host in HAR) (repeatable) |
| `--path </users/{id}>` | Path parameters (api add), route path (screen/route add), or a path filter (import/sync) |
| `--api <endpoint>` | Endpoint to load (repeat for several in module add) (repeatable) |
| `--base-url <url>` | The API's base URL (setup), or only HAR requests under it (import/sync) |
| `--architecture <id>` | Flutter: getx, riverpod, bloc, get_it. Next.js: fetch-helper, plain-fetch. React Native and React: fetch-helper, axios, axios-react-query. Android: retrofit-hilt, retrofit-koin, retrofit. iOS: urlsession |
| `--initial` | Make it the first screen |
| `--no-forms` | No create or edit form screens |
| `--no-tests` | Do not generate tests |
| `--skip-conflicts` | Import what works and report endpoints that cannot be added |
| `--no-install` | Do not install dependencies |
| `--model-dir <folder>` | Write new models into this folder for this command only (e.g. lib/features/orders/models); set modelsFolder in codz.config.yaml to change it for good |

Accepts the change options.

### `codz auth add [--login-path /auth/login] [--me-path /auth/me]`

Sign-in for this project: secure token storage, the token on every request, sign out on 401, a login screen and a guard.

Next.js: server actions, an HttpOnly session cookie, middleware that sends signed-out visitors to /login, withAuth() for server calls.

React Native: expo-secure-store (or react-native-keychain), the fetch helper or axios sends the token, AuthProvider and useAuth().

Flutter: flutter_secure_storage, a Dio interceptor (refresh or sign out on 401), AuthService, a go_router redirect.

Android (Hilt): EncryptedSharedPreferences, an OkHttp interceptor, AuthApi, AuthRepository, a login screen with a ViewModel.

| Option | |
| --- | --- |
| `--login-path </auth/login>` | Sign-in endpoint: POST { email, password }, answers with the token (default /auth/login) |
| `--me-path </auth/me>` | Endpoint that returns the signed-in user (default /auth/me) |
| `--logout-path </auth/logout>` | Sign-out endpoint, called on sign out (default /auth/logout) |
| `--refresh-path </auth/refresh>` | Refresh endpoint: POST { refreshToken }; with it a 401 tries one refresh first (Flutter, React Native) |
| `--token-field <name>` | Field of the login answer with the token (default token) |
| `--refresh-field <name>` | Field with the refresh token (default refreshToken) |
| `--public </about>` | Next.js: a page that stays public (besides /login) (repeatable) |

Accepts the change options.

### `codz module add <name> [--api <endpoint>]`

Create a GetX module: binding, controller, view, route.

| Option | |
| --- | --- |
| `--api <endpoint>` | Endpoint to load (repeat for several in module add) (repeatable) |
| `--initial` | Make it the first screen |
| `--no-load` | Do not call the load method from onInit |

Accepts the change options.

### `codz locale add <lang> [--from en]`

Add a language: copies every key from the default one.

| Option | |
| --- | --- |
| `--from <lang>` | Language to copy keys from (default: the default language) |

Accepts the change options.

### `codz locale key <key> "<text>" [--value hi="..."]`

Add a text key to every language file.

| Option | |
| --- | --- |
| `--value lang="text"` | Text for one more language; repeat for several (repeatable) |
| `--force` | Do it even when codz would normally refuse (see the command) |

Accepts the change options.

### `codz theme set <name> <value> [...]`

Set a color (#hex), size (number) or font in the app theme.

Example: codz theme set primary "#6750A4" radius 12 font Inter

Accepts the change options.

### `codz templates list`

Which templates the project customizes.

### `codz templates init [id...]`

Start custom templates from files that reproduce codz's output.

Accepts the change options.

## Health

### `codz report [--json]`

Usage summary for beta feedback: commands run, changes applied and undone, errors; no code, file names or URLs.

Built from .codz/history.json and .codz/events.jsonl, which stay on this machine. CODZ_NO_EVENTS=1 stops recording commands.

### `codz doctor [--only locales,api,urls,models] [--strict] [--fix] [--setup]`

Check locales, unhandled API errors, untyped responses, hardcoded URLs and unused models.

Exit 1 on errors (--strict: on warnings too). --fix repairs what is safe (missing locale keys, base-URL literals, unused models) as one previewed change. --setup checks Node, git, the config, the formatter and the analyzer instead.

| Option | |
| --- | --- |
| `--only <name>` | Only these operations (import), or only these checks (doctor) (repeatable) |
| `--strict` | Exit 1 on warnings too |
| `--fix` | Repair what is safe as one previewed change; list the rest |
| `--setup` | Check that codz can run here: Node, git, config, formatter, analyzer |
| `--force` | Do it even when codz would normally refuse (see the command) |

Accepts the change options.

### `codz check`

CI gate: config check + doctor; exit 1 on any error or warning.

## Setup

### `codz config show`

The conventions codz uses, and where each came from.

### `codz config get <key>`

One convention.

### `codz config set <key> <value>`

Change one convention in codz.config.yaml ('' = detect).

| Option | |
| --- | --- |
| `--force` | Do it even when codz would normally refuse (see the command) |

Accepts the change options.

### `codz config check`

Find problems in codz.config.yaml (exit 1 on errors).

### `codz completion bash|zsh|fish`

Print the shell completion script.

## Starters (online)

### `codz new [name] --template <id[@version]|folder>`

Create a project from a ready-made starter: from the catalog (free or bought) or a template folder.

Shows every file and step first, then creates the folder in one step; codz undo inside the new project removes it again while it is unchanged. Catalog starters are checked against the signed catalog, and template scripts never run. Next: cd <name> && codz init.

This and the other starter commands are the only ones that use the network, and only to reach the starter catalog.

| Option | |
| --- | --- |
| `--template <id[@version]\|folder>` | The starter: a catalog id (pin a version with @x.y.z) or a template folder |
| `--org <com.example>` | Organization in reverse-domain form, for app ids (default com.example) |
| `--dir <folder>` | Parent folder for the new project (default: the current folder) |
| `--set <key=value>` | Answer one of the starter's questions; repeat for more (repeatable) |
| `--framework <name>` | Only starters for this framework |
| `--state <name>` | Only starters with this state management (riverpod, get_it, ...) |
| `--router <name>` | Only starters with this router (go_router, ...) |
| `--http <name>` | Only starters with this HTTP client (dio, fetch, ...) |
| `--cached` | Use only starters and the catalog already downloaded on this machine (no network) |
| `--no-steps` | Skip the setup steps after creating (flutter pub get, dart format, npm install) |

### `codz starters list [--framework flutter] [--free] [--owned]`

Starters in the catalog: id, latest version, framework, price, api add support.

| Option | |
| --- | --- |
| `--framework <name>` | Only starters for this framework |
| `--state <name>` | Only starters with this state management (riverpod, get_it, ...) |
| `--router <name>` | Only starters with this router (go_router, ...) |
| `--http <name>` | Only starters with this HTTP client (dio, fetch, ...) |
| `--owned` | Only starters your account owns (and free ones) |
| `--free` | Only free starters |
| `--refresh` | Download the catalog again even if it has not changed |
| `--cached` | Use only starters and the catalog already downloaded on this machine (no network) |

### `codz starters show <id>[@version]`

One starter: what it includes beyond codz create, tested SDKs, license, versions.

| Option | |
| --- | --- |
| `--refresh` | Download the catalog again even if it has not changed |
| `--cached` | Use only starters and the catalog already downloaded on this machine (no network) |

### `codz starters cache [--clear]`

Starters downloaded on this machine (--clear deletes them).

| Option | |
| --- | --- |
| `--clear` | Delete every downloaded starter |

### `codz login [--no-browser]`

Log in to the starter catalog (prints a code to approve in the browser); needed only for paid starters.

The token is kept in ~/.codz/auth.json, readable only by you. In CI, set CODZ_TOKEN instead.

| Option | |
| --- | --- |
| `--no-browser` | Do not open the login page; print it only |

### `codz logout`

Log out: delete the token here and revoke it on the server.

### `codz whoami`

The logged-in account and the starters it owns.

## Changes

### `codz plans list`

Plans saved with --plan: ready, applied or stale.

### `codz plans show <id>`

One plan's summary and diff.

### `codz plans clean [--all]`

Delete applied and stale plans (--all: every plan).

| Option | |
| --- | --- |
| `--all` | Every endpoint (mock add, test add), or every plan (plans clean) |

### `codz apply <plan-id>`

Apply a plan saved with --plan, exactly as previewed.

### `codz undo [--to <id>] [--force]`

Revert the last applied change (or every change back to <id>).

| Option | |
| --- | --- |
| `--to <id>` | Undo every change back to and including <id> |
| `--force` | Do it even when codz would normally refuse (see the command) |

### `codz history [show <id>]`

List applied changes, or show one change's files and diff.

## Change options

| Option | |
| --- | --- |
| `--dry-run` | Show the diff only |
| `--plan` | Save the diff as a plan and print its id (apply later with codz apply) |
| `--yes` | Apply without asking |
| `--y` | Same as --yes |
| `--allow-dirty` | Apply even if git has uncommitted changes |
| `--no-format` | Do not run the project's formatter |
| `--no-verify` | Do not run the project's analyzer after applying |
| `--commit` | Commit the applied files |
| `--commit-message <text>` | Message for --commit (default: one from the summary) |
| `--open` | Open the diff in $EDITOR before asking |

## Global options

| Option | |
| --- | --- |
| `--json` | Machine-readable output on stdout (for scripts and AI agents) |
| `--cwd <folder>` | Run as if started in <folder> |
| `--root <folder>` | Project root (monorepos: which project) |
| `--no-color` | Plain output |
| `--help` | Show help (for one command: codz <command> --help) |
| `--h` | Same as --help |
| `--version` | Print the version |
| `--v` | Same as --version |
