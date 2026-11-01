# codz

A project-aware CLI that learns how your project is built, then makes the same structural change the same way every time. It runs offline, never uploads code, shows a diff before writing anything, and can undo every change.

Adapters for **Next.js**, **Flutter**, **React Native** and **Android (Kotlin)**: new projects (`codz create`), API endpoints (add, import, update, rename, remove), screens and forms, routes, mocks, tests, locales, theme values and project health checks, all with a diff first, `--plan`/`apply`, `undo` and `--json`. MIT licensed.

## Requirements

- Node.js **20 or newer** for the built package (`npm run build`), or **22.18 or newer** to run the TypeScript source directly from a checkout. There are no runtime dependencies.
- Git (optional, but recommended: codz refuses to apply changes over uncommitted work unless you pass `--allow-dirty`).

## Install

```bash
npm install -g codz-cli   # the command is `codz`
codz --help
```

From a checkout instead:

```bash
cd codz
npm link          # puts `codz` on your PATH
codz --help
```

On Node 22.18+ this runs the TypeScript in `src/` directly. On Node 20 or 21, run `npm run build` first; `bin/codz.js` then uses the compiled `dist/` (set `CODZ_DIST=1` to force it).

**Publishing:** the package is `codz-cli` on npm (npm refused the plain name `codz` as too similar to existing packages); the command it installs is still `codz`. `npm publish` builds `dist/` and runs the tests first (`prepublishOnly`); the package ships `bin/`, `dist/`, the README, the license, docs/COMMANDS.md, the examples and assets, not the TypeScript source. Publishing needs two-factor authentication on the npm account. Raise the version first (`npm version patch`): a published version cannot be replaced.

### Check your setup

```bash
cd my-app
codz doctor --setup
```

It checks Node, git (installed, a repository, a clean tree), the config file (found, valid, paths that exist), whether `.codz/` is git-ignored, the framework and any libraries codz does not write for yet, the formatter and analyzer, the scan cache and the change history. Each line is `pass`, `warn` or `fail` with a hint; the exit code is 1 when anything fails. It only reads.

### Shell completion

```bash
eval "$(codz completion bash)"                                   # in ~/.bashrc
source <(codz completion zsh)                                     # in ~/.zshrc, after compinit
codz completion fish > ~/.config/fish/completions/codz.fish    # fish
```

Completes commands, flags, endpoint names (`codz api show <TAB>`), plan ids, config keys and their allowed values.

## Quick start

```bash
cd my-app
codz init                 # detect the framework, scan, write codz.config.yaml
                             # (a fresh project is offered an architecture to set up)
codz explain              # routes, endpoints, models, locales, conventions

# Paste a cURL command and (optionally) the response, then press Ctrl-D:
codz api add

# Or pass everything as flags:
codz api add --curl "curl https://api.example.com/users/42/orders" --sample orders.json
codz api add --url "POST https://api.example.com/users" --request-sample new-user.json --sample user.json

codz undo                 # revert the last change
```

Every change shows a diff and asks before writing. Use `--dry-run` to preview only, `--yes` to apply without asking, or `--plan` to save the diff and apply exactly that later with `codz apply <id>`.

### New projects: create

```bash
codz create                     # asks: type, architecture, name, org, base URL, options
codz create shop-app --type android --architecture retrofit-hilt --org com.acme --base-url https://api.shop.dev
codz create shop-app --type react-native --flavor expo --architecture axios-react-query
codz create shop_app --type flutter --architecture riverpod --primary "#0F766E"
codz create shop-app --type nextjs --architecture fetch-helper --tailwind --dry-run
```

`create` asks for the project type (Flutter, Next.js, React Native, Android), then the architecture for that type, the project name, the organization id (for app ids and packages), the API base URL and the type's own options (Tailwind for Next.js, Expo or the React Native CLI). It runs the platform's own creator (`flutter create`, `create-next-app`, `create-expo-app`, the React Native CLI), applies the architecture with the same `setup` as below, writes `codz.config.yaml`, sets the theme color, installs dependencies and makes the first git commit. Without the platform tool, or with `--offline`, codz writes a minimal project of its own instead. Android has no command-line creator, so codz always writes Android Studio's Empty Activity project itself (Kotlin, Jetpack Compose, a version catalog, Navigation Compose with a Home screen) and adds the Gradle wrapper when Gradle is installed. `--dry-run` lists the steps; `--no-install` and `--no-git` skip those steps.

| Type | Architectures |
| --- | --- |
| Flutter | `riverpod`, `getx`, `bloc`, `get_it`, `none` |
| Next.js | `fetch-helper`, `plain-fetch`, `none` |
| React Native | `fetch-helper`, `axios-react-query`, `axios`, `none` (each with `--flavor expo` or `bare`) |
| Android | `retrofit-hilt`, `retrofit-koin`, `retrofit`, `none` |

### Ready-made starters: codz new (online)

```bash
codz new shop_app --template ./starters/flutter-riverpod-dio --org com.acme   # a template folder: no network, no account
codz starters list --framework flutter       # the catalog (when it is online)
codz starters show flutter-riverpod-dio      # what it adds beyond codz create, tested SDKs, license
codz login                                   # only for paid starters: approve a code in the browser
codz new shop_app --template flutter-riverpod-dio@1.2.0
cd shop_app && codz init                     # then api add, screen add, ... as usual
```

`create` is free and offline and builds an architecture. `new` installs a finished starter (screens, theming, tests, error handling) from the starter catalog or a template folder. `new`, `starters`, `login`, `logout` and `whoami` are the only commands with network code, and they load it only when they run. They contact only the starter catalog and send nothing about your projects.

- **Checked before use.** The catalog index is signed with Ed25519 and checked against keys built into codz. An index older than one this machine has seen is refused, and so is an expired one, so a mirror cannot hide a withdrawn version. A catalog can also name online keys that sign a short-lived `timestamp.json` confirming the index is still current; codz then checks that signature, that it points at this exact index, and that it has not expired or gone backwards, so the long-lived index can stay signed offline. Every archive must match the hash in the signed index, and every file must match the hash in its manifest. A withdrawn version is refused even from the cache.
- **Data only.** A starter is files plus a manifest. It never runs its own scripts; codz runs only `flutter create`, `flutter pub get`, `dart format` and `npm install --ignore-scripts`, with arguments it builds itself from typed answers.
- **Strict reading.** The archive reader accepts regular files and folders only. Links, devices, `..`, absolute paths, Windows reserved names, case or Unicode clashes, and oversized or bomb archives stop it before anything is written.
- **One step, and undoable.** The preview lists every file and step. The project is built in a temporary folder and moved into place in one rename. `codz undo` inside the new project removes it again while you have not changed it; files from `pub get`, `npm install` and `codz init` do not count as changes.
- **Plans and agents.** `--plan` (or `--json` without `--yes`) saves a plan, and `codz apply <id>` creates exactly that. From MCP, `new` only plans, `login` is not a tool, and a paid starter has to be downloaded once by a person first.
- **Offline.** `--cached` uses only what is already downloaded. In CI, set `CODZ_TOKEN` instead of logging in.

The catalog is served by the separate codz store project (accounts, purchases, `codz login`); until a release points at it, `new` works with template folders or `CODZ_REGISTRY`. Starter sources live in `starters/`, and `scripts/starters.ts` checks, packs and signs them (see starters/README.md).

### Fresh projects: setup

When a project has no API layer yet, `codz init` asks which architecture to create and for the API base URL, then shows one diff with everything:

| Framework | Architecture | What it creates |
| --- | --- | --- |
| Flutter | `getx` | `createDio()` with your base URL, an `InitialBinding` that registers Dio, `GetMaterialApp(initialBinding: ...)` in `main.dart`, `dio` and `get` in `pubspec.yaml` |
| Flutter | `riverpod` | `createDio()` and `dioProvider`, `ProviderScope` around the app, `dio` and `flutter_riverpod` |
| Flutter | `get_it` | `createDio()`, `setupDependencies()` called from `main()`, `dio` and `get_it` |
| Flutter | `bloc` | `createDio()` and get_it registrations, `flutter_bloc` for Cubit screens |
| Next.js | `fetch-helper` | `lib/api/client.ts` with `apiFetch<T>()` and `ApiError`, `lib/api/index.ts`, `NEXT_PUBLIC_API_URL` in `.env.example` and `.env.local` |
| Next.js | `plain-fetch` | Only `NEXT_PUBLIC_API_URL`; each function calls `fetch` itself |
| React Native | `fetch-helper` | `src/config/env.ts` (`API_URL`, `USE_MOCKS`; `EXPO_PUBLIC_*` on Expo), `src/api/client.ts` with `apiFetch<T>()`, React Navigation (`RootNavigator`, a Home screen) and `App.tsx` |
| React Native | `axios` / `axios-react-query` | The same with an axios instance; `axios-react-query` adds a `QueryClientProvider` and a query hook per endpoint |
| Android | `retrofit-hilt` | `ApiConfig.BASE_URL`, a Hilt `NetworkModule` (Json, OkHttpClient with logging, Retrofit), `@HiltAndroidApp` application, `@AndroidEntryPoint` on `MainActivity`, INTERNET permission, plugins and libraries in `libs.versions.toml` (KSP, Hilt, kotlinx.serialization) |
| Android | `retrofit-koin` | The same with a Koin `networkModule` started from the application class |
| Android | `retrofit` | The same with a `ServiceLocator` object and no DI library |

Android dependencies go into `gradle/libs.versions.toml` and the module's `build.gradle.kts` when the project has a version catalog, otherwise straight into `build.gradle.kts` (Groovy build files get a list of what to add).

It also saves the folder conventions, so every later `api add` puts models and repositories in the right place and registers new repositories (`Get.lazyPut`, a Riverpod provider, or a get_it registration) with no manual step. After setup, codz runs `flutter pub get` when Flutter is installed.

Without a terminal (scripts, CI, agents), pass the choice as flags:

```bash
codz setup --architecture getx --base-url https://api.example.com --yes
codz init  --architecture riverpod --base-url https://api.example.com --yes
```

### GetX modules and wiring

For GetX projects (set up by codz or created with the GetX CLI), codz writes features in the GetX CLI layout:

```bash
codz module add profile                      # binding, controller, view, route
codz api add --into profile < request.txt    # new endpoint, called from ProfileController
codz api wire getProducts --into home        # existing endpoint into HomeController
codz module add catalog --api getProducts    # new module with an endpoint already wired
```

- `module add` creates `lib/app/modules/<name>/{bindings,controllers,views}` and registers the page in `lib/app/routes/app_pages.dart` and `app_routes.dart`. If those files don't exist yet, it creates them and points `GetMaterialApp` at `AppPages.routes`. Route constants follow your file: `Routes.PROFILE` in a GetX CLI project, `Routes.profile` otherwise. `--initial` makes the module the first screen.
- `api wire` adds the repository with `Get.find`, Rx state (`user`, `isUserLoading`, `userError`), and a `loadUser()` method with try/catch. When the call needs no arguments, `onInit` calls it automatically (`--no-load` to skip). Running it twice changes nothing.

### Importing a whole API

```bash
codz api import openapi.yaml                 # OpenAPI 3 (YAML or JSON)
codz api import swagger.json --tag users     # Swagger 2, only operations tagged "users"
codz api import shop.postman_collection.json --only getUser,listUsers
```

Every operation becomes an endpoint exactly as `api add` would write it. Shared schemas become one model, endpoints of one resource land in one file, and endpoints the project already has are skipped. Postman examples are used as response samples; requests without one are typed `unknown`/`dynamic` with a warning.

**From the browser (HAR).** In Chrome DevTools → Network, use "Save all as HAR with content", then:

```bash
codz api import app.har --list --base-url https://api.example.com   # see what it found
codz api import app.har --base-url https://api.example.com
```

JSON calls are grouped by method and path (`/users/42` and `/users/43` become `/users/{id}`, with both responses as samples). Analytics hosts, images, scripts and failed responses (`--include-errors` keeps those) are skipped. Headers and cookies are never read, secret query parameters are dropped, and response bodies are only used to work out types: no value from the file is written, cached or kept in history. A HAR file still holds your session cookies, so do not commit it.

**Filters** work with every format:

| Flag | Keeps |
| --- | --- |
| `--list` | nothing: prints what would be imported and stops |
| `--tag t` / `--only name` | operations with that tag (OpenAPI), folder (Postman) or host (HAR) / those names |
| `--path '/users/**'` | paths matching the glob: `*` is one segment, `**` any number; `{id}` and `:id` both match a parameter |
| `--method GET,POST` | those methods |
| `--max 20` | the first 20 that match |
| `--base-url <url>` | HAR: requests under that URL only |
| `--skip-conflicts` | imports what works when some endpoints cannot be added (by default codz lists them and stops) |

Imports of more than 50 operations need `--max` or `--yes`, so a whole spec is never added by accident.

The spec's server URL stands in for your app's own base URL (often another environment), so its host is never written into a call. When your client already has a base URL (Dio `BaseOptions(baseUrl: ...)`, Retrofit, a fetch helper, an axios instance), calls use the path only: `/v1/orders/$orderId`, or `/orders/$orderId` when the base URL already ends in `/v1`.

### Changing endpoints

```bash
codz api update getUser --sample new-user.json   # rebuild the model from a new response
codz api rename listUsers fetchUsers             # rename the function and every call site
codz api remove deleteUser                       # remove it; lists callers that will break
```

`api update` rewrites the model in place and prints the fields that were added, removed or changed type, plus every line in your code that uses a removed or changed field. Code you added to a model is kept: in Dart, every member codz does not generate (`copyWith`, `==`/`hashCode`, `toString`, getters, other constructors and methods) comes back after the regenerated fields, with a warning if one of them still uses a field that was removed; in TypeScript, comments above interface fields stay.

`api rename` and `api remove` find uses with your project's own TypeScript compiler when `typescript` is installed in it (it is in almost every Next.js project), so a local variable or parameter that happens to share the name, an object key, or another file's own function with that name is never touched. Without it, codz falls back to its text scanner (`CODZ_NO_AST=1` forces the fallback).

### Other stacks

codz writes in the style the project already uses:

- **axios (Next.js):** API functions call your `axios.create` instance (`const res = await api.get<User>(...)`), with query parameters as `{ params }`. Without an instance they call `axios` with the base URL from your environment. `mock add` adds a request interceptor to the instance.
- **TanStack Query (Next.js):** when the project already uses `@tanstack/react-query`, `api add` also writes a hook: `useQuery` for a GET (key `[resource, ...path params, query params]`), `useMutation` for the rest, invalidating the resource's queries on success. Hooks go into the hooks file that already imports from the same API file, otherwise `hooks/use-<resource>.ts`. Set `dataFetching: none` in `codz.config.yaml` to turn this off.
- **freezed (Flutter):** models are `@freezed` classes with a const factory constructor (`abstract class` for freezed 3, `class` for freezed 2, following your existing models). `api update` keeps your `@Default(...)` values and hand-written members. Run `dart run build_runner build` afterwards.
- **React Native:** the same TypeScript generation as Next.js (your `apiFetch` helper or axios instance, relative imports when the project has no `@/` alias), with the API URL from `src/config/env.ts`. Screens are React Navigation screens (an entry in `RootStackParamList` and a `<Stack.Screen>`) or Expo Router files under `app/` (`[id].tsx`, `useLocalSearchParams`); lists use `FlatList` with pull to refresh. Tests are Jest.
- **Android (Kotlin):** endpoints become `suspend` methods on a Retrofit interface per resource (`@GET("users/{id}") suspend fun getUser(@Path("id") id: Int): User`), with paths relative to the base URL. Models are data classes in the project's JSON library: kotlinx.serialization (`@Serializable`, `@SerialName`), Moshi (`@JsonClass`, `@Json`) or Gson (`@SerializedName`); optional fields default to `null`. A new interface is registered where Retrofit is created: a `@Provides` function in the Hilt module, a `single { }` in the Koin module, or a `by lazy` property on the service locator. `api update`, `rename` and `remove` work on Kotlin too. A `{"data": ...}` envelope needs `--no-unwrap`.
- **Retrofit (Flutter):** endpoints become annotated methods on your `@RestApi()` client (`@GET('/users/{id}') Future<User> getUser(@Path('id') int id);`), or on a new client registered like a repository. A `{"data": ...}` envelope needs `--no-unwrap`, because a Retrofit method returns the whole body.

### Keeping up with the API: api sync

```bash
codz api sync openapi.yaml            # update endpoints whose spec changed
codz api sync openapi.yaml --add      # ...and add the ones the project does not have yet
codz api sync openapi.yaml --remove   # ...and delete endpoints the spec no longer has
codz api sync openapi.yaml --check    # CI: exit 1 when the project is out of date with the spec
```

Endpoints are matched by method and path (a base prefix like `/v1` that your base URL already holds is allowed). A matched endpoint is rewritten from the spec in place: its response and request models (keeping your own members and comments, and the field order you have), its parameters, keeping your path and parameter names. Unchanged endpoints are left alone, and a second sync finds nothing to do. Changes that break callers (a response field removed or changed type, a new required parameter, a new request body) are listed with the lines that use them. Endpoints only in your project are listed, not removed, unless you pass `--remove`; they may belong to another API.

### Before you merge: api diff

```bash
codz api diff openapi-main.yaml openapi-pr.yaml                      # what changed, what breaks, where it is used
codz api diff old.yaml new.yaml --format md --report api-diff.md     # a pull request comment
codz api diff old.yaml new.yaml --format sarif --report api.sarif    # GitHub code scanning
codz api diff old.yaml new.yaml --fail-on warning                    # exit 1 on warnings too (default: breaking)
```

Breaking: an operation removed, a response field removed or retyped, a new path parameter, a new required request field. Warning: a response field that can now be null, a removed query parameter, a retyped request field. Added operations, response fields and optional request fields are listed as additions. Inside a project each change names the endpoint function and the files and lines that use it (its callers, the screens, the model); outside a project it compares the two files only. Nothing is written except the `--report` file.

### Mock responses

```bash
codz mock add --all                       # a mock for every endpoint
codz mock add getUser --sample user.json  # use a real response as the mock
```

- Flutter: `mocks/mock_responses.dart` and a `MockInterceptor` next to your Dio setup, added to Dio only when you run `flutter run --dart-define=USE_MOCKS=true`.
- Next.js: `mocks.ts` next to your request helper, checked first when `NEXT_PUBLIC_USE_MOCKS=true` (added to `.env.example` as `false`).

Mock data is generated from the models (`email` fields get emails, `id`s count up) and is yours to edit. With `--sample`, values that look like secrets or personal data (tokens, passwords, emails, phone numbers, names, addresses, long token-like strings) are replaced with examples before anything is written; `--keep-values` writes the sample exactly as given. Mocks are keyed by method and path, so renaming an endpoint keeps them. Running `mock add` again leaves mocks you edited by hand alone and says which ones it kept; `--sample` or `--force` replaces them.

### Locales

```bash
codz locale add hi                                   # copy every key from the default language
codz locale key cart.empty "Your cart is empty" --value hi="आपकी कार्ट खाली है"
```

Works with JSON message files (next-intl, i18next; `cart.empty` becomes a nested key), Flutter ARB files (keys become identifiers like `cartEmpty`, `{name}` placeholders get metadata) and GetX `Translations`. A GetX project without translations gets `lib/app/translations/app_translations.dart`, wired into `GetMaterialApp` with `translations:`, `locale:` and `fallbackLocale:`. Languages without a `--value` get the default text and are listed by `codz doctor` as untranslated. Only the changed keys are touched; the rest of each file keeps its formatting.

### Theme

```bash
codz theme set primary "#6750A4" radius 12 font Inter
```

The kind comes from the value: `#hex` is a color, a number is a size, anything else is a font.

- Flutter: `AppColors`, `AppSizes` and `AppTheme` (light and dark, seeded from `AppColors.primary`) in `lib/app/theme` (GetX) or `lib/core/theme`, or wherever your project already keeps `AppColors`. `MaterialApp` / `GetMaterialApp` gets `theme: AppTheme.light`. The Flutter template theme is replaced; a theme you wrote yourself is left alone, with a note.
- Next.js: Tailwind v4 `@theme` variables (`bg-primary`), Tailwind v3 `theme.extend` in `tailwind.config`, or plain CSS variables in `:root` in `globals.css`.
- React Native: `colors`, `sizes` and `fonts` in `src/theme/index.ts`.
- Android: `val Primary = Color(0xFF...)` in `ui/theme/Color.kt` and sizes as `dp` in `ui/theme/Dimens.kt` (a project made by `codz create` already feeds `Primary` into its Material 3 color scheme). Fonts are not set on Android yet.

### Whole features and sign-in

```bash
codz feature add orders --spec openapi.yaml       # endpoints, list, detail, create and edit screens, routes, tests
codz feature add users --spec openapi.yaml --tag users --no-tests
codz auth add                                     # sign-in screen, secure token storage, token on every request
codz auth add --login-path /v1/session --refresh-path /v1/session/refresh --public /pricing
```

`feature add` takes the operations whose path or tag names the feature (or `--tag` / `--path`), adds their endpoints, makes a list screen, a detail screen, a create form and an edit form where the API has them, links them (tapping a row opens the detail, a New button opens the form) and adds tests. Every step is planned in a private copy of the project and shown as one diff: one apply, one undo. A model clash stops the whole feature unless you pass `--skip-conflicts`.

A project with no API layer yet (fresh from `flutter create`, `create-next-app`, Vite, Expo, the React Native CLI, Android Studio or Xcode) is set up first, in the same change: the recommended architecture, or the one you pass with `--architecture` (Flutter: riverpod, getx, get_it, bloc; Next.js: fetch-helper, plain-fetch; React Native and React web: fetch-helper, axios, axios-react-query; Android: retrofit-hilt, retrofit-koin, retrofit; iOS: urlsession). The base URL comes from `--base-url` or the spec's server. Then the endpoints, screens and tests are written in that architecture, and new dependencies are installed after apply.

`auth add` adds sign-in to an existing project. Next.js: an HttpOnly cookie session, server actions, a login page and `middleware.ts` that sends signed-out visitors to `/login`. React Native: tokens in `expo-secure-store` or the Keychain, the token on every request and sign-out on 401, an `AuthProvider` and a login screen. Flutter: `flutter_secure_storage`, a Dio interceptor (with refresh when you pass `--refresh-path`) and a go_router redirect. Android (Hilt): encrypted token storage, an OkHttp interceptor, a login screen and ViewModel. When your network setup has a shape codz does not recognise, it says exactly what to add by hand.

### Screens

```bash
codz screen add catalog --api getProducts
codz screen add order-details --api getOrder --path /orders/:id
```

One change with the route, the page, the call to the endpoint, and the loading, error (with retry) and data states. Path parameters feed the endpoint's arguments by name.

- GetX: a module with the endpoint wired into the controller and an `Obx` view.
- Flutter with Riverpod or get_it: the page loads the endpoint in a `FutureBuilder` (`ref.read(provider)` or `getIt<Repository>()`), with pull to refresh for lists.
- Flutter with Bloc (`flutter_bloc`): a Cubit next to the page with sealed loading / loaded / failure states, and a page that provides it (`BlocProvider`) and switches on its state (`BlocBuilder`). The API class comes from get_it when the project uses it, otherwise from `context.read` (a `RepositoryProvider` above the page).
- Next.js: an async server page that awaits the endpoint, plus `loading.tsx` and `error.tsx` next to it.
- React Native: a screen that loads the endpoint (through its TanStack Query hook when there is one) with `ActivityIndicator`, the error with Retry, and a `FlatList` or the fields; registered in the navigator, or a file under `app/` with Expo Router.
- Android: a Compose screen and a ViewModel next to it. The ViewModel gets the Retrofit interface from Hilt (`@HiltViewModel`, `hiltViewModel()`), Koin (`viewModelOf(::X)` added to the module, `koinViewModel()`) or the service locator (a `ViewModelProvider.Factory`), reads route parameters from `SavedStateHandle` (converted to `Int` when the method wants one), and exposes `StateFlow<UiState<T>>` (`UiState.kt` with Loading, Success and Error is written once). The screen shows a spinner, the error with Retry, then a `LazyColumn` or the model's fields, and gets a `composable("orders/{id}")` entry in your `NavHost`.

Only GET endpoints make a data screen. For POST, PUT and PATCH endpoints, `--form` makes a form instead:

```bash
codz screen add new-user --api createUser --form
codz screen add edit-user --api updateUser --path /users/:id/edit --form
```

One input per field of the request model (text, email, number, checkbox, date, comma-separated list), required fields marked, and submit calling the endpoint with saving, saved and error states. Next.js gets a client page (`'use client'`, path parameters from `useParams`); Flutter gets a `Form` with validators and a `SnackBar` (Riverpod, get_it, Bloc and GetX; in GetX the module's view is the form, with route parameters from `Get.parameters`). React Native gets `TextInput`s and `Switch`es with an `Alert` on the result. Android gets `OutlinedTextField`s (number keyboard for numbers), `Switch`es for booleans and a Save button that calls `viewModel.submit(...)`, with the error shown and an `onDone` callback on success. A required field a form cannot fill, such as a nested object, stops the command with the field named.

### Tests for API functions

```bash
codz test add getUser        # one endpoint
codz test add --all          # every endpoint without a test
```

Tests that fake the network, so they run offline: Next.js tests (Vitest, or Jest when the project uses it) replace `fetch`, or the axios instance's method, with a spy that answers example data, then check the method, the URL and the result, and that a failed response throws. Flutter tests give Dio a fake `HttpClientAdapter`, check the method, the path and the typed result, and that a 500 throws a `DioException`. React Native tests are Jest. Android tests are JUnit tests on the JVM against OkHttp's `MockWebServer` (`app/src/test/java/.../UserApiTest.kt`): each one enqueues example JSON, calls the method, checks the method, the path and the parsed result, and one test per interface checks that a 500 throws `HttpException`; MockWebServer, kotlinx-coroutines-test and JUnit are added as `testImplementation` when missing. Run them with `./gradlew :app:testDebugUnitTest`. One test file per API file (`users.test.ts` next to it, or `test/.../user_repository_test.dart`); endpoints that already have a test are skipped.

### Custom templates

```bash
codz templates list                          # which templates the project customizes
codz templates init api-function.ts          # start one from a file that reproduces codz's output
```

Templates live in `codz/templates/` (`templatesFolder` in the config); commit them. A template is the text to write with `{{placeholders}}`; `{{default}}` is what codz would have written, so a template can wrap it or replace it.

| Template | Shapes | Placeholders |
| --- | --- | --- |
| `file-header.ts`, `file-header.dart` | the top of every new file | `{{file}}` |
| `api-function.ts` | a Next.js API function | `{{default}}`, `{{name}}`, `{{method}}`, `{{path}}`, `{{params}}`, `{{returnType}}` |
| `api-method.dart` | a Flutter repository or Retrofit method | `{{default}}`, `{{name}}`, `{{method}}`, `{{path}}`, `{{returnType}}` |
| `model.ts`, `model.dart` | a model | `{{default}}`, `{{name}}` |

Whatever a template writes must still be code codz can read back (an exported function, a class method), or later commands will not find it.

### Routes

```bash
codz route add settings
codz route add order-details --path /orders/:id
```

- GetX: a module (same as `module add`).
- go_router: a page widget next to your other pages and a `GoRoute` (path parameters passed to the page).
- Navigator: a page and an entry in `MaterialApp(routes: {...})`.
- Next.js: `app/orders/[id]/page.tsx` (async `params` on Next 15+), or `pages/` for the Pages Router.
- React Native: a screen registered in the navigator with typed params, or an Expo Router file.
- Android: a `@Composable` screen taking the parameters as `String`s and a `composable("orders/{id}") { entry -> ... }` entry in the `NavHost`.

### Doctor

```bash
codz doctor                   # everything
codz doctor --only locales    # locales, api, urls, models
codz doctor --strict --json   # for CI: exit 1 on warnings too
```

| Check | Reports |
| --- | --- |
| locales | missing keys (error), extra keys, texts identical to the default language, keys that look unused |
| api | calls with no try/catch, `.catch`, Riverpod `AsyncValue` or `snapshot.hasError`; endpoints without a typed response |
| urls | hardcoded `http(s)://` addresses outside your config and network setup |
| models | models nothing uses |

Each finding has a file and line and, where there is one, the command that fixes it. The exit code is 1 when there are errors.

```bash
codz doctor --fix             # repair what is safe, as one change: diff, confirm, undo
codz check                    # CI gate: config check + doctor; exit 1 on any error or warning
```

`doctor --fix` adds missing locale keys (with the default language's text, so they still show as untranslated), rewrites hardcoded URLs that start with your base URL (Next.js: `` `${process.env.NEXT_PUBLIC_API_URL}/path` ``; Flutter: a relative path inside Dio calls), and removes models nothing uses (a file left empty is deleted, with its barrel export). Untyped responses and calls without error handling are listed with the fix, because they need a real response or a decision about the error screen.

### Looking around: api list, api show, config, plans

```bash
codz api list                 # every endpoint: method, path, function, response, file
codz api list users           # filter by name, path or method
codz api show getUser         # signature, models with fields, every place that uses it

codz config                   # the conventions in use, marking which were detected
codz config get quote
codz config set modelsFolder src/types   # edits codz.config.yaml in place (diff, undo)
codz config set baseUrlEnv ''            # '' = go back to detecting it
codz config check             # tabs, unknown keys (with "did you mean"), bad values, paths

codz plans                    # saved --plan changes: ready, applied or stale
codz plans show <id>          # the diff again
codz plans clean              # remove applied and stale plans (--all for every plan)
```

**History.** `codz history` lists applied changes; `codz history show <id>` shows one change's files (and whether each was edited since) with the diff it made; `codz undo --to <id>` undoes every change back to that one, newest first.

**Workflow flags** for every command that changes code: `--commit` commits exactly the changed files (`--commit-message "..."`, or a message built from the summary), `--open` opens the diff in `$EDITOR` before asking, and `api add --clipboard` reads the cURL command from the clipboard (pbpaste, wl-paste, xclip or xsel). Every preview starts with a line like `4 files: 2 created, 2 changed (+17 −0 lines)`.

`config set` refuses values codz does not understand (for example `quote: backtick`) and paths outside the project. A plan is stale when a file it touches changed since it was made; `codz apply` refuses those, so make the change again.

### Pasting a cURL with its response

```
curl -X POST 'https://api.example.com/users/42/orders?expand=items' \
  -H 'Authorization: Bearer eyJ...' \
  --data-raw '{"product_id": 7, "qty": 2}'
response:
{"data": {"id": 9001, "total_price": 20, "items": [{"sku": "A1", "qty": 2}]}}
```

codz removes the `Authorization` header (and cookies, API keys, tokens in the query) and never writes them anywhere. It then generates:

- the models (`Order`, `OrderItem`, `CreateUserOrderRequest`) in your models folder, in your file naming;
- `createUserOrder(userId, body, params?)` in the existing `users` API file or repository, through your own request helper when you have one;
- the registration your project uses (barrel `index.ts` exports, a Riverpod provider, or a get_it registration).

## What it supports

| Framework | Supported setup | Not yet |
| --- | --- | --- |
| Next.js | App Router, TypeScript, `fetch` directly or through a shared helper (e.g. `apiFetch<T>(path, init)`), axios (an `axios.create` instance, named or default export, or `axios` itself), TanStack Query hooks, path aliases, per-file or single-file models, barrel files | Pages Router, object-style clients (`api.get(...)` wrappers around fetch), SWR |
| Flutter | Dio from repository/service classes or Retrofit (`@RestApi`) clients; hand-written `fromJson`/`toJson` (factory or plain constructor), json_serializable or freezed (2 and 3); GetX bindings, Riverpod or get_it; Cubit screens in Bloc projects; go_router/auto_route routes; ARB locales or GetX Translations | `http` package, Chopper, full `Bloc` (events) screens |
| React Native | Expo and bare React Native CLI projects, TypeScript; `fetch` through a shared helper or an axios instance, TanStack Query hooks; React Navigation (native stack) or Expo Router; API URL in a config file | Redux Toolkit Query, plain JavaScript projects |
| React (web) | Vite or Create React App, TypeScript; `fetch` through a shared helper or an axios instance, TanStack Query hooks; React Router (`<Routes>` or `createBrowserRouter`); API URL from `VITE_API_URL` / `REACT_APP_API_URL` | `auth add`, Next.js-style server components (use the Next.js adapter) |
| Android | Kotlin app module; Retrofit with `suspend` functions; kotlinx.serialization, Moshi or Gson data classes; Hilt, Koin or a service locator object; screens in Jetpack Compose (Navigation Compose) or XML Views (an Activity, a layout and a ViewModel per screen, registered in the manifest); version catalog or direct Gradle Kotlin DSL dependencies | Ktor, Java sources, Fragments, `mock add` |
| iOS | Swift with SwiftUI: an `APIClient` over URLSession with async/await, `Codable` structs, SwiftUI views with `ObservableObject` view models, `NavigationLink` navigation; Xcode 16 synchronized folders (older projects: codz lists the files to add to the target) | UIKit screens, Alamofire, `test add`, `mock add`, `auth add` |
| Anything else | Generic adapter: structure, locale files and `.env` base URLs in `explain` | `api add`, `theme`, `route` |

When something is outside the supported setup, codz says so before doing anything rather than generating the wrong style.

## How it decides what to write

- **Conventions** (folders, naming, quotes, semicolons, helper, DI, imports) are detected on `init` and saved to `codz.config.yaml`. Correct anything wrong once and commit the file; codz uses your values from then on.
- **The project map** is a cache in `.codz/` (git-ignored). It is rebuilt automatically when files change, so hand edits never leave it stale.
- **Model inference** follows fixed rules: several `--sample`s are merged; a field missing or null in any sample is nullable; money-like names (`price`, `amount`, `lat`, ...) become doubles; ISO strings become dates; enums are never guessed; a field that is only ever `null`, or a list that is only ever empty, is marked unknown with a warning instead of a guess; `{"data": ...}` envelopes are unwrapped (`--no-unwrap` to keep them).
- **Existing models** with the same name and fields are reused. A different model with the same name stops the run (`--model-name` to choose another name); nested clashes get a prefixed name.
- **Base URLs**: when the URL's host matches a configured base URL (`.env` for Next.js, Dio's `baseUrl` for Flutter), only the path is written, minus any prefix like `/v1`.

## Safety

- A diff before every write; `--dry-run` and `--plan` never write.
- Refuses to apply over uncommitted git changes unless `--allow-dirty`.
- Checks that every target file is unchanged since the preview; otherwise nothing is applied.
- Writes all files to temporary names first and swaps them in together; any failure restores everything.
- Runs your formatter (Prettier, `dart format`) and analyzer (`tsc`, `dart analyze`) when installed. If the analyzer reports a new error in a changed file, the change is reverted (`--no-verify` to skip).
- `codz undo` restores from backups in `.codz/backups/`, and refuses (without `--force`) if you edited the files since.
- Never edits outside the project root or inside `.codz/`. No network access, no telemetry.

## For scripts and AI agents

Every command accepts `--json` and prints one JSON object: `{"ok": true, ...}` or `{"ok": false, "error": {"code", "message", "hint"}}`. A typical agent flow:

```bash
codz explain --json                          # learn the project
codz api add --curl "..." --plan --json      # get the diff and a plan id
codz apply <plan-id> --json                  # apply exactly what was shown
```

### MCP server

```bash
codz mcp                 # in the project folder (or: codz mcp --cwd /path/to/project)
```

`codz mcp` serves codz over the Model Context Protocol on stdio, for AI agents and editors that support MCP. Every command becomes a tool (`api add` → `api_add`, `api sync` → `api_sync`, `doctor`, ...), with a JSON schema built from its options. Tools that edit code never write: they return the diff and a `planId`, and the `apply` tool applies that plan exactly as shown. Two resources: `codz://project` (what codz knows about the project) and `codz://commands` (every command and option).

To add it to an MCP client, register a stdio server whose command is `codz` with the arguments `["mcp", "--cwd", "/path/to/project"]`. Many clients take a JSON entry like:

```json
{ "mcpServers": { "codz": { "command": "codz", "args": ["mcp", "--cwd", "/path/to/project"] } } }
```

### VS Code extension

`extensions/vscode` runs codz from the command palette: add an endpoint from a cURL command or URL, sync with a spec, show an endpoint and jump to its uses, rename, mock and test every endpoint, doctor findings in the Problems panel, undo. Every change opens as a diff first and is applied only when you click Apply. Package it with `npx @vscode/vsce package` in that folder and install the `.vsix`; see its README.

## Beta testers

See [BETA.md](BETA.md): install, the first 10 minutes, what is stable, and how to send feedback with `codz report`.

## Development

```bash
npm test                       # unit, golden and CLI integration tests (node:test)
npm run test:update-golden     # accept intended changes to generated output
npm run typecheck              # needs: npm i -D typescript @types/node
./scripts/check-generated.sh   # compile generated code with real SDKs (Flutter + tsc), pages (.tsx) included
node scripts/starters.ts check starters/*/   # starter publishing gates (manifest, hashes, secrets, determinism)
./scripts/check-android.sh     # create an Android project per architecture, run a session, then Gradle assembleDebug + unit tests (needs the Android SDK)
./scripts/corpus.sh            # run codz (read-only, --dry-run) on the public projects in scripts/corpus.txt
npm run docs                   # regenerate docs/COMMANDS.md from the command table
npm run check:all              # beta build check: feature/auth/screen add on every platform, then real builds (tsc, vitest, dart analyze, Gradle, swiftc)
npm run beta:pack              # tests + dist/ + release/codz-cli-<version>.tgz, checked by installing it in a clean folder
FUZZ_RUNS=5000 FUZZ_SEED=3 node --test test/fuzz.test.ts   # fuzz the parsers harder
```

Every command and option is defined once, in `src/core/commands.ts`: `--help`, `codz <command> --help`, shell completion, the option parser and [docs/COMMANDS.md](docs/COMMANDS.md) are generated from it, and a test fails if the CLI handles a command or reads an option the table does not list. A mistyped option (`--dryrun`) is an error with a suggestion, never silently ignored.

CI (`.github/workflows/ci.yml`) runs the tests and the typecheck on Linux, macOS and Windows, fuzzes the parsers, checks that docs/COMMANDS.md is current for every push and pull request, and runs `check-generated.sh` with Flutter installed, so the Dart output is analyzed too: on the fixtures and on a project made by `flutter create`. An `android` job runs `check-android.sh` with Java 17, Gradle and the runner's Android SDK, so the Kotlin that codz writes (setup, endpoints, screens, forms, routes, tests, theme) is compiled and its generated tests run. `.github/workflows/corpus.yml` runs the corpus check weekly; a crash or a timeout on any project fails it.

Layout:

```
bin/codz.js         entry point
src/cli.ts             commands and flags
src/core/              types, cache, config and YAML reader, JSON editing, diff, change sets, git
src/input/             cURL, paste, OpenAPI/Swagger/Postman parsing, naming, model inference
src/core/commands.ts   the command and option table (help, completion, parser, docs, MCP tools)
src/skills/mcp.ts      codz mcp: the Model Context Protocol server
src/starters/          codz new and the starter catalog (the only network code; loaded on demand)
starters/              the internal starter templates; scripts/starters.ts publishes them
extensions/vscode/     the VS Code extension
dist/                  compiled output for the npm package (npm run build; not committed)
src/adapters/          nextjs (+ Scan, Gen, Setup), flutter (+ Scan, Gen, Styles, Setup), reactNative (+ Setup),
                       android (+ Setup, kotlinGen), getx, dartGen, reactQuery, generic
src/skills/            init, setup, explain, api add/import/update/remove/rename, module add,
                       api wire, mock, locale, theme, route, screen, test, doctor, create
                       (+ androidSkeleton, androidUi, androidTests, reactNativeUi)
fixtures/              sample projects used by the tests (two of them fresh)
test/golden/           expected output for every fixture scenario
```

## Known limits

- Scanning uses careful text parsing (brace- and string-aware). `api rename`/`api remove` use the TypeScript compiler when the project has it; everything else, and all Dart code, uses the text scanner. It is checked against the fixtures and, weekly, against real public projects (`scripts/corpus.txt`); please report a scan that maps something wrong.
- Next.js output was compiled with `tsc --strict` during development. Flutter output was reviewed but not compiled, because the Dart SDK was not available in the build environment. Run `./scripts/check-generated.sh` on a machine with Flutter to check it. The same goes for Kotlin: neither the Android SDK nor the Maven repositories were reachable while it was built, so Android output is checked by the CI `android` job (`./scripts/check-android.sh`), not by the local test run.
- `doctor` uses the same text scanning, so its "unused" and "no error handling" findings are hints to check, not proof. Keys looked up dynamically (``t(`x.${y}`)``) cannot be traced.
- The VS Code extension has unit tests for its logic but has not been run in VS Code by these tests; try it with "Run Extension" from that folder before packaging it.
