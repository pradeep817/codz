// Every command and flag codz accepts, in one table. Help, per-command
// help, shell completion, the flag parser (which flags take a value, which
// repeat), unknown-flag errors and docs/COMMANDS.md are all generated from it,
// so they cannot drift apart. A test checks that every command the CLI
// handles is listed here.

export interface FlagSpec {
  /** Placeholder for the value, when the flag takes one (`--sample <file>`). */
  value?: string;
  desc: string;
  /** May be given several times; values are collected in order. */
  repeat?: boolean;
  /** The value is a file or folder (the shell completes paths). */
  path?: boolean;
  /** Fixed choices offered by completion. */
  choices?: string[];
}

export const FLAGS: Record<string, FlagSpec> = {
  // Global
  json: { desc: 'Machine-readable output on stdout (for scripts and AI agents)' },
  cwd: { value: '<folder>', desc: 'Run as if started in <folder>', path: true },
  root: { value: '<folder>', desc: 'Project root (monorepos: which project)', path: true },
  'no-color': { desc: 'Plain output' },
  help: { desc: 'Show help (for one command: codz <command> --help)' },
  h: { desc: 'Same as --help' },
  version: { desc: 'Print the version' },
  v: { desc: 'Same as --version' },
  // Change options
  'dry-run': { desc: 'Show the diff only' },
  plan: { desc: 'Save the diff as a plan and print its id (apply later with codz apply)' },
  yes: { desc: 'Apply without asking' },
  y: { desc: 'Same as --yes' },
  'allow-dirty': { desc: 'Apply even if git has uncommitted changes' },
  'no-format': { desc: "Do not run the project's formatter" },
  'no-verify': { desc: "Do not run the project's analyzer after applying" },
  commit: { desc: 'Commit the applied files' },
  'commit-message': { value: '<text>', desc: 'Message for --commit (default: one from the summary)' },
  open: { desc: 'Open the diff in $EDITOR before asking' },
  // api add input and options
  curl: { value: "'<curl command>'", desc: 'A cURL command; secrets in it are removed, never written' },
  url: { value: "'<url>'", desc: 'A URL (or "POST https://...")' },
  method: { value: '<GET|POST|...>', desc: 'HTTP method (api add), or only these methods (api import)', choices: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  clipboard: { desc: 'Read the cURL command (and response) from the clipboard' },
  'from-clipboard': { desc: 'Read the JSON from the clipboard' },
  sample: { value: '<file.json>', desc: 'Response sample; repeat for several samples', repeat: true, path: true },
  'request-sample': { value: '<file.json>', desc: 'Request body sample', path: true },
  name: { value: '<functionName>', desc: 'Override the derived function name' },
  path: { value: '</users/{id}>', desc: 'Path parameters (api add), route path (screen/route add), or a path filter (import/sync)' },
  'model-name': { value: '<Name>', desc: 'Name the response model yourself' },
  'no-unwrap': { desc: 'Keep a {"data": ...} envelope instead of returning data' },
  into: { value: '<module>', desc: "Call the endpoint from that module's controller (GetX)" },
  // import / sync
  tag: { value: '<tag>', desc: 'Only operations with this tag (folder in Postman, host in HAR)', repeat: true },
  only: { value: '<name>', desc: 'Only these operations (import), or only these checks (doctor)', repeat: true },
  max: { value: '<n>', desc: 'Import at most n operations' },
  list: { desc: 'Show what would be imported and stop' },
  'base-url': { value: '<url>', desc: "The API's base URL (setup), or only HAR requests under it (import/sync)" },
  'include-errors': { desc: 'HAR: keep failed (non-2xx) responses' },
  'skip-conflicts': { desc: 'Import what works and report endpoints that cannot be added' },
  add: { desc: 'Also add operations the project does not have yet' },
  remove: { desc: 'Also delete endpoints the spec no longer has' },
  check: { desc: 'Report drift without writing; exit 1 when out of sync' },
  // module / wire / screen / route
  api: { value: '<endpoint>', desc: 'Endpoint to load (repeat for several in module add)', repeat: true },
  initial: { desc: 'Make it the first screen' },
  'no-load': { desc: 'Do not call the load method from onInit' },
  form: { desc: "A form that sends the endpoint's request body (POST, PUT, PATCH)" },
  // feature add
  spec: { value: '<file>', desc: 'OpenAPI, Swagger, Postman or HAR file to take the endpoints from', path: true },
  'no-forms': { desc: 'No create or edit form screens' },
  'no-tests': { desc: 'Do not generate tests' },
  // mock serve
  port: { value: '<n>', desc: 'Port for the mock API (default 4010)' },
  delay: { value: '<ms>', desc: 'Wait before each answer, so loading states show (default 300)' },
  items: { value: '<n>', desc: 'Items in each list to start with (default 5)' },
  lan: { desc: 'Listen on your network too, for a phone on the same Wi-Fi (default: this computer only)' },
  scenario: { value: '<name>', desc: 'How the mock answers at the start; switch live at /__codz', choices: ['normal', 'empty', 'error', 'unauthorized', 'slow', 'offline'] },
  // api diff
  format: { value: '<text|md|json|sarif>', desc: 'Report format (default text; md for a pull request comment, sarif for code scanning)', choices: ['text', 'md', 'json', 'sarif'] },
  report: { value: '<file>', desc: 'Write the report to a file', path: true },
  'fail-on': { value: '<breaking|warning|any|none>', desc: 'Exit 1 at this level (default breaking)', choices: ['breaking', 'warning', 'any', 'none'] },
  // auth add
  'login-path': { value: '</auth/login>', desc: 'Sign-in endpoint: POST { email, password }, answers with the token (default /auth/login)' },
  'me-path': { value: '</auth/me>', desc: 'Endpoint that returns the signed-in user (default /auth/me)' },
  'logout-path': { value: '</auth/logout>', desc: 'Sign-out endpoint, called on sign out (default /auth/logout)' },
  'refresh-path': { value: '</auth/refresh>', desc: 'Refresh endpoint: POST { refreshToken }; with it a 401 tries one refresh first (Flutter, React Native)' },
  'token-field': { value: '<name>', desc: 'Field of the login answer with the token (default token)' },
  'refresh-field': { value: '<name>', desc: 'Field with the refresh token (default refreshToken)' },
  public: { value: '</about>', desc: 'Next.js: a page that stays public (besides /login)', repeat: true },
  // mock / test
  all: { desc: 'Every endpoint (mock add, test add), or every plan (plans clean)' },
  'keep-values': { desc: "Write --sample values exactly as given (no secret or personal-data scrubbing)" },
  // locale
  from: { value: '<lang>', desc: 'Language to copy keys from (default: the default language)' },
  value: { value: 'lang="text"', desc: 'Text for one more language; repeat for several', repeat: true },
  // setup / init
  architecture: { value: '<id>', desc: 'Flutter: getx, riverpod, bloc, get_it. Next.js: fetch-helper, plain-fetch. React Native and React: fetch-helper, axios, axios-react-query. Android: retrofit-hilt, retrofit-koin, retrofit. iOS: urlsession' },
  // create
  type: { value: '<type>', desc: 'Project type: flutter, nextjs, react, react-native, android, ios', choices: ['flutter', 'nextjs', 'react', 'react-native', 'android', 'ios'] },
  flavor: { value: '<expo|bare>', desc: 'React Native: Expo (default) or the React Native CLI', choices: ['expo', 'bare'] },
  org: { value: '<com.example>', desc: 'Organization in reverse-domain form, for app ids (default com.example)' },
  tailwind: { desc: 'Next.js: use Tailwind CSS' },
  primary: { value: '<#rrggbb>', desc: "The theme's primary color" },
  offline: { desc: "Do not run the platform's creator; write codz's minimal project" },
  'no-install': { desc: 'Do not install dependencies' },
  'no-git': { desc: 'Do not run git init' },
  // doctor
  strict: { desc: 'Exit 1 on warnings too' },
  setup: { desc: 'Check that codz can run here: Node, git, config, formatter, analyzer' },
  fix: { desc: 'Repair what is safe as one previewed change; list the rest' },
  // explain / undo / config
  rescan: { desc: 'Scan again instead of using the cached project map' },
  force: { desc: 'Do it even when codz would normally refuse (see the command)' },
  to: { value: '<id>', desc: 'Undo every change back to and including <id>' },
  // codz new and the starter catalog
  template: { value: '<id[@version]|folder>', desc: 'The starter: a catalog id (pin a version with @x.y.z) or a template folder' },
  set: { value: '<key=value>', desc: "Answer one of the starter's questions; repeat for more", repeat: true },
  dir: { value: '<folder>', desc: 'Parent folder for the new project (default: the current folder)', path: true },
  framework: { value: '<name>', desc: 'Only starters for this framework', choices: ['flutter', 'nextjs', 'react-native', 'android'] },
  state: { value: '<name>', desc: 'Only starters with this state management (riverpod, get_it, ...)' },
  router: { value: '<name>', desc: 'Only starters with this router (go_router, ...)' },
  http: { value: '<name>', desc: 'Only starters with this HTTP client (dio, fetch, ...)' },
  cached: { desc: 'Use only starters and the catalog already downloaded on this machine (no network)' },
  'no-steps': { desc: 'Skip the setup steps after creating (flutter pub get, dart format, npm install)' },
  owned: { desc: 'Only starters your account owns (and free ones)' },
  free: { desc: 'Only free starters' },
  refresh: { desc: 'Download the catalog again even if it has not changed' },
  clear: { desc: 'Delete every downloaded starter' },
  'no-browser': { desc: 'Do not open the login page; print it only' },
  paginate: { desc: 'List screens: load page after page as you scroll (the endpoint needs a page or offset parameter)' },
  search: { desc: 'List screens: a search box (on the server with a q/search parameter, otherwise over the loaded items)' },
  'model-dir': { value: '<folder>', desc: 'Write new models into this folder for this command only (e.g. lib/features/orders/models); set modelsFolder in codz.config.yaml to change it for good', path: true },
};

export const GLOBAL_FLAGS = ['json', 'cwd', 'root', 'no-color', 'help', 'h', 'version', 'v'];
export const CHANGE_FLAGS = ['dry-run', 'plan', 'yes', 'y', 'allow-dirty', 'no-format', 'no-verify', 'commit', 'commit-message', 'open'];

/** What a command's positional arguments are, for completion. */
export type ArgKind = 'endpoint' | 'endpoints' | 'file' | 'plan' | 'configKey' | 'shell' | 'theme' | 'template';

export interface CommandSpec {
  cmd: string;
  sub?: string;
  /** Arguments after the command, as shown in help. */
  usage: string;
  summary: string;
  flags: string[];
  /** Accepts the change options (--dry-run, --plan, --yes, ...). */
  change?: boolean;
  args?: ArgKind;
  /** Extra lines for this command's help and docs. */
  notes?: string[];
  /** Help group. */
  group: 'Start' | 'Endpoints' | 'Screens and app' | 'Health' | 'Changes' | 'Setup' | 'Starters (online)';
}

export const COMMAND_LIST: CommandSpec[] = [
  { group: 'Start', cmd: 'create', usage: '[name] [--type <type>] [--architecture <id>]', summary: 'Create a new project and set it up: pick the type, architecture, name and options, then codz runs the platform creator and applies the architecture', flags: ['type', 'architecture', 'base-url', 'org', 'tailwind', 'flavor', 'primary', 'offline', 'no-install', 'no-git', 'dry-run', 'yes', 'y'], notes: ['Asks for anything not given as an option. Architectures: Flutter riverpod, getx, bloc, get_it, none; Next.js fetch-helper, plain-fetch, none; React Native fetch-helper, axios-react-query, axios, none (--flavor expo or bare); Android retrofit-hilt, retrofit-koin, retrofit, none (Kotlin, Jetpack Compose, version catalog); React (Vite) fetch-helper, axios, axios-react-query, none; iOS urlsession, none (SwiftUI, Xcode 16 project). The app opens on a demo screen written in the chosen architecture, on sample data. Without the platform creator (flutter, npx) or with --offline, codz writes a minimal project itself; Android, React (Vite) and iOS always use the built-in templates.'] },
  { group: 'Start', cmd: 'init', usage: '[--root <folder>] [--force]', summary: 'Detect the framework, scan, write codz.config.yaml; offers to set up an API layer when there is none', flags: ['force', 'architecture', 'base-url', 'yes', 'y'] },
  { group: 'Start', cmd: 'setup', usage: '[--architecture <id>] [--base-url <url>]', summary: 'Create the API layer for a fresh project', flags: ['architecture', 'base-url'], change: true },
  { group: 'Start', cmd: 'explain', usage: '[--rescan]', summary: 'Show routes, endpoints, models, locales and conventions', flags: ['rescan'] },
  { group: 'Endpoints', cmd: 'api', sub: 'add', usage: '[input] [options]', summary: 'Add an endpoint: model, function and registration', flags: ['curl', 'url', 'method', 'clipboard', 'sample', 'request-sample', 'name', 'path', 'model-name', 'no-unwrap', 'into', 'no-load', 'model-dir'], change: true, notes: ['Input: --curl, --url, --clipboard, or a cURL command or URL pasted on stdin, optionally followed by "response:" and JSON (and "request:" and JSON). A response sample is strongly recommended.'] },
  { group: 'Endpoints', cmd: 'api', sub: 'import', usage: '<file> [filters]', summary: 'Add every endpoint from an OpenAPI 3, Swagger 2, Postman or HAR file', flags: ['tag', 'only', 'path', 'method', 'max', 'list', 'base-url', 'include-errors', 'skip-conflicts', 'model-dir'], change: true, args: 'file' },
  { group: 'Endpoints', cmd: 'api', sub: 'sync', usage: '<file> [--add] [--remove] [--check]', summary: 'Bring endpoints in line with an API spec: update changed ones, report breaking changes', flags: ['add', 'remove', 'check', 'tag', 'path', 'base-url', 'model-dir'], change: true, args: 'file' },
  { group: 'Endpoints', cmd: 'api', sub: 'diff', usage: '<old spec> <new spec> [--format md] [--fail-on breaking]', summary: 'What changed between two API specs, what breaks, and the lines in this project that use it', flags: ['format', 'report', 'fail-on', 'tag', 'path'], notes: ['Breaking: an operation removed, a response field removed or retyped, a new path parameter, a new required request field. Warning: a field that can now be null, a removed query parameter, a retyped request field.', 'Inside a project each change lists the files and lines that use it. Works outside a project too.', 'CI: codz api diff main.yaml pr.yaml --format md --report api-diff.md (exit 1 on breaking changes); --format sarif for GitHub code scanning.'] },
  { group: 'Endpoints', cmd: 'api', sub: 'update', usage: '<endpoint> --sample <file>', summary: 'Rebuild the response model from new samples', flags: ['sample', 'no-unwrap'], change: true, args: 'endpoint' },
  { group: 'Endpoints', cmd: 'api', sub: 'remove', usage: '<endpoint>', summary: 'Remove an endpoint and list callers that break', flags: [], change: true, args: 'endpoint' },
  { group: 'Endpoints', cmd: 'api', sub: 'rename', usage: '<endpoint> <newName>', summary: 'Rename an endpoint and its call sites', flags: [], change: true, args: 'endpoint' },
  { group: 'Endpoints', cmd: 'api', sub: 'wire', usage: '<endpoint> --into <module>', summary: "Call an endpoint from a module's controller (GetX)", flags: ['into', 'no-load'], change: true, args: 'endpoint' },
  { group: 'Endpoints', cmd: 'api', sub: 'list', usage: '[filter]', summary: 'Every endpoint: method, path, function, response, file', flags: [] },
  { group: 'Endpoints', cmd: 'api', sub: 'show', usage: '<endpoint>', summary: 'One endpoint: signature, models, every place that uses it', flags: [], args: 'endpoint' },
  { group: 'Screens and app', cmd: 'assets', usage: '', summary: 'Typed names for images, icons and fonts, kept in step with the files; lists unused ones', flags: [], change: true, notes: ['Flutter: lib/gen/assets.dart (AppImages.logo, AppFonts.inter) and every asset folder and font family in pubspec.yaml. React Native: src/assets/index.ts with require() for each file. Next.js and Vite: paths for public/ (and imports for src/assets in Vite). Android and iOS already have typed resources; codz checks names and lists unused drawables.', 'Run it again after adding or removing files.'] },
  { group: 'Screens and app', cmd: 'env', sub: 'add', usage: '<name> --base-url <url>', summary: 'Add an API environment (staging, qa, ...) the app can run against', flags: ['base-url', 'force'], change: true, notes: ['Next.js and Expo: .env.<name> plus npm scripts that load it (dotenv-cli). Vite: .env.<name> and --mode <name>. React Native CLI: an API_URLS table in env.ts. Flutter: env/<name>.json for --dart-define-from-file, and a VS Code run configuration. Android: an apiUrls table in the app build file, picked with -PapiEnv=<name> into BuildConfig.BASE_URL. iOS: an AppEnvironment enum, picked with APP_ENV in the scheme.', 'The base URL you have now becomes the default environment. Never writes .env.local.'] },
  { group: 'Screens and app', cmd: 'env', sub: 'list', usage: '', summary: 'The API environments and their base URLs', flags: [] },
  { group: 'Screens and app', cmd: 'env', sub: 'use', usage: '<name>', summary: 'Switch the app to an environment (React Native CLI, Android, iOS)', flags: [], change: true },
  { group: 'Endpoints', cmd: 'model', usage: '<Name> --from-clipboard | --sample <file.json>', summary: 'A model (and its nested models) from JSON, without an endpoint', flags: ['from-clipboard', 'sample', 'model-dir', 'no-unwrap', 'force'], change: true, notes: ['Reads the JSON from --from-clipboard, --sample, or standard input (pipe or paste, then Ctrl+D). Nested objects become their own models (Order → OrderItem, OrderAddress); a list gives the model of its items; {"data": ...} is unwrapped unless --no-unwrap.', 'Writes into the models folder, or --model-dir <folder> for this model only. An existing model with the same name is replaced only with --force.'] },
  { group: 'Endpoints', cmd: 'field', sub: 'add', usage: '<Model> <name:type> [...]', summary: 'Add a field to a model, in every place the model spells it', flags: [], change: true, notes: ['Types: string, int, double, bool, date, any, a model name, or a list (string[], list<Category>). End with ? for an optional field: rating:double?. The name is the JSON key (created_at); codz writes the property name the project uses (createdAt).', 'TypeScript interfaces, Dart classes (plain, json_serializable, freezed: constructor, fromJson, field and toJson), Kotlin data classes and Swift Codable structs (CodingKeys too). Only the new lines are added; then it lists the files that use the model.'] },
  { group: 'Endpoints', cmd: 'field', sub: 'remove', usage: '<Model> <field> [...]', summary: 'Remove a field from a model and list the lines that still use it', flags: [], change: true },
  { group: 'Endpoints', cmd: 'mock', sub: 'serve', usage: '[--spec <file>] [--port 4010] [--delay 300] [--items 5] [--scenario normal] [--lan]', summary: 'A local fake API with sample data, so screens show data before the backend exists', flags: ['spec', 'port', 'delay', 'items', 'scenario', 'lan'], notes: ["Answers the project's endpoints, or every operation in --spec (OpenAPI, Swagger, Postman, HAR), with sample data from the response models. A list and its items share in-memory data, so create, edit and delete work and the list shows the change; restarting resets it. Paths match by their last segments, so /v1/products reaches GET /products. Prints how to point the app at it (emulator, simulator, phone).", 'Scenarios check every screen state: empty (empty lists), error (500), unauthorized (401), slow (3 s), offline (connection drops). Open http://localhost:4010/__codz to switch them, for every endpoint or one, reset the data, and see each request with its body.'] },
  { group: 'Endpoints', cmd: 'mock', sub: 'add', usage: '<endpoint>... | --all', summary: 'Mock responses for building screens before the backend', flags: ['all', 'sample', 'keep-values', 'force'], change: true, args: 'endpoints', notes: ['Next.js, React Native and Flutter. Not yet on Android.'] },
  { group: 'Endpoints', cmd: 'test', sub: 'add', usage: '<endpoint>... | --all', summary: 'Unit tests for API functions with the network faked', flags: ['all'], change: true, args: 'endpoints', notes: ['Next.js: Vitest or Jest. React Native: Jest. Flutter: flutter_test with a fake Dio adapter. Android: JUnit with MockWebServer (adds the test dependencies).'] },
  { group: 'Screens and app', cmd: 'screen', sub: 'add', usage: '<name> --api <endpoint> [--path /x/:id] [--paginate] [--search] [--form]', summary: 'A working screen (route, page, the call, loading, error, data), or a form with --form', flags: ['api', 'path', 'initial', 'form', 'paginate', 'search'], change: true, notes: ['Android: a Compose screen plus a ViewModel (Hilt, Koin or the service locator) with a UiState StateFlow, registered in the NavHost.'] },
  { group: 'Screens and app', cmd: 'route', sub: 'add', usage: '<name> [--path /x/:id]', summary: 'Add a screen and its route (GetX module, GoRoute, Next.js page, React Navigation or Expo Router screen, Compose NavHost entry)', flags: ['path', 'initial'], change: true },
  { group: 'Screens and app', cmd: 'feature', sub: 'add', usage: '<name> --spec <file> | --api <endpoint>...', summary: 'A whole feature in one change: endpoints, list, detail, create and edit screens, routes and tests', flags: ['spec', 'tag', 'path', 'api', 'base-url', 'architecture', 'initial', 'no-forms', 'no-tests', 'skip-conflicts', 'no-install', 'model-dir'], change: true, notes: ['A project with no API layer yet is set up first, in the same change: the recommended architecture (or --architecture), with the base URL from --base-url or the spec.', 'Without --tag or --path, the endpoints are those whose path or tag names the feature (orders: /orders, /orders/{id}, /users/{id}/orders).', 'Screens: a list for a GET that returns a list, a detail for a GET with an id, a create form for a POST with a body, an edit form for a PUT or PATCH with a body. Other endpoints are added and listed.', 'Everything is planned in a private copy of the project and shown as one diff: one apply, one undo.'] },
  { group: 'Screens and app', cmd: 'auth', sub: 'add', usage: '[--login-path /auth/login] [--me-path /auth/me]', summary: 'Sign-in for this project: secure token storage, the token on every request, sign out on 401, a login screen and a guard', flags: ['login-path', 'me-path', 'logout-path', 'refresh-path', 'token-field', 'refresh-field', 'public'], change: true, notes: ['Next.js: server actions, an HttpOnly session cookie, middleware that sends signed-out visitors to /login, withAuth() for server calls.', 'React Native: expo-secure-store (or react-native-keychain), the fetch helper or axios sends the token, AuthProvider and useAuth().', 'Flutter: flutter_secure_storage, a Dio interceptor (refresh or sign out on 401), AuthService, a go_router redirect.', 'Android (Hilt): EncryptedSharedPreferences, an OkHttp interceptor, AuthApi, AuthRepository, a login screen with a ViewModel.'] },
  { group: 'Screens and app', cmd: 'module', sub: 'add', usage: '<name> [--api <endpoint>]', summary: 'Create a GetX module: binding, controller, view, route', flags: ['api', 'initial', 'no-load'], change: true },
  { group: 'Screens and app', cmd: 'locale', sub: 'add', usage: '<lang> [--from en]', summary: 'Add a language: copies every key from the default one', flags: ['from'], change: true },
  { group: 'Screens and app', cmd: 'locale', sub: 'extract', usage: '[files...]', summary: 'Move the text in screens into the locale files and read it back', flags: [], change: true, args: 'file', notes: ['Finds Text(...) and hint, label and tooltip text (Flutter), JSX text and placeholder, title, alt and aria-label (React, Next.js, React Native), and Text("...") in Compose. Writes AppLocalizations.of(context)!.key (ARB, wiring it into MaterialApp the first time), \'key\'.tr (GetX), t(\'key\') with next-intl or react-i18next, or stringResource(R.string.key) with strings.xml.', 'Keys are named after the screen (products.nothingHereYet); text in several screens goes under common, and text that already has a key reuses it. Without files, every screen.'] },
  { group: 'Screens and app', cmd: 'locale', sub: 'key', usage: '<key> "<text>" [--value hi="..."]', summary: 'Add a text key to every language file', flags: ['value', 'force'], change: true },
  { group: 'Screens and app', cmd: 'theme', sub: 'set', usage: '<name> <value> [...]', summary: 'Set a color (#hex), size (number) or font in the app theme', flags: [], change: true, args: 'theme', notes: ['Example: codz theme set primary "#6750A4" radius 12 font Inter'] },
  { group: 'Screens and app', cmd: 'templates', sub: 'list', usage: '', summary: 'Which templates the project customizes', flags: [] },
  { group: 'Screens and app', cmd: 'templates', sub: 'init', usage: '[id...]', summary: "Start custom templates from files that reproduce codz's output", flags: [], change: true, args: 'template' },
  { group: 'Health', cmd: 'report', usage: '[--json]', summary: 'Usage summary for beta feedback: commands run, changes applied and undone, errors; no code, file names or URLs', flags: [], notes: ['Built from .codz/history.json and .codz/events.jsonl, which stay on this machine. CODZ_NO_EVENTS=1 stops recording commands.'] },
  { group: 'Health', cmd: 'doctor', usage: '[--only locales,api,urls,models] [--strict] [--fix] [--setup]', summary: 'Check locales, unhandled API errors, untyped responses, hardcoded URLs and unused models', flags: ['only', 'strict', 'fix', 'setup', 'force'], change: true, notes: ['Exit 1 on errors (--strict: on warnings too). --fix repairs what is safe (missing locale keys, base-URL literals, unused models) as one previewed change. --setup checks Node, git, the config, the formatter and the analyzer instead.'] },
  { group: 'Health', cmd: 'check', usage: '', summary: 'CI gate: config check + doctor; exit 1 on any error or warning', flags: [] },
  { group: 'Setup', cmd: 'config', sub: 'show', usage: '', summary: 'The conventions codz uses, and where each came from', flags: [] },
  { group: 'Setup', cmd: 'config', sub: 'get', usage: '<key>', summary: 'One convention', flags: [], args: 'configKey' },
  { group: 'Setup', cmd: 'config', sub: 'set', usage: '<key> <value>', summary: "Change one convention in codz.config.yaml ('' = detect)", flags: ['force'], change: true, args: 'configKey' },
  { group: 'Setup', cmd: 'config', sub: 'check', usage: '', summary: 'Find problems in codz.config.yaml (exit 1 on errors)', flags: [] },
  { group: 'Setup', cmd: 'completion', usage: 'bash|zsh|fish', summary: 'Print the shell completion script', flags: [], args: 'shell' },
  { group: 'Starters (online)', cmd: 'new', usage: '[name] --template <id[@version]|folder>', summary: 'Create a project from a ready-made starter: from the catalog (free or bought) or a template folder', flags: ['template', 'org', 'dir', 'set', 'framework', 'state', 'router', 'http', 'cached', 'no-steps', 'dry-run', 'plan', 'yes', 'y'], notes: ['Shows every file and step first, then creates the folder in one step; codz undo inside the new project removes it again while it is unchanged. Catalog starters are checked against the signed catalog, and template scripts never run. Next: cd <name> && codz init.', 'This and the other starter commands are the only ones that use the network, and only to reach the starter catalog.'] },
  { group: 'Starters (online)', cmd: 'starters', sub: 'list', usage: '[--framework flutter] [--free] [--owned]', summary: 'Starters in the catalog: id, latest version, framework, price, api add support', flags: ['framework', 'state', 'router', 'http', 'owned', 'free', 'refresh', 'cached'] },
  { group: 'Starters (online)', cmd: 'starters', sub: 'show', usage: '<id>[@version]', summary: 'One starter: what it includes beyond codz create, tested SDKs, license, versions', flags: ['refresh', 'cached'] },
  { group: 'Starters (online)', cmd: 'starters', sub: 'cache', usage: '[--clear]', summary: 'Starters downloaded on this machine (--clear deletes them)', flags: ['clear'] },
  { group: 'Starters (online)', cmd: 'login', usage: '[--no-browser]', summary: 'Log in to the starter catalog (prints a code to approve in the browser); needed only for paid starters', flags: ['no-browser'], notes: ['The token is kept in ~/.codz/auth.json, readable only by you. In CI, set CODZ_TOKEN instead.'] },
  { group: 'Starters (online)', cmd: 'logout', usage: '', summary: 'Log out: delete the token here and revoke it on the server', flags: [] },
  { group: 'Starters (online)', cmd: 'whoami', usage: '', summary: 'The logged-in account and the starters it owns', flags: [] },
  { group: 'Changes', cmd: 'plans', sub: 'list', usage: '', summary: 'Plans saved with --plan: ready, applied or stale', flags: [] },
  { group: 'Changes', cmd: 'plans', sub: 'show', usage: '<id>', summary: "One plan's summary and diff", flags: [], args: 'plan' },
  { group: 'Changes', cmd: 'plans', sub: 'clean', usage: '[--all]', summary: 'Delete applied and stale plans (--all: every plan)', flags: ['all'] },
  { group: 'Changes', cmd: 'apply', usage: '<plan-id>', summary: 'Apply a plan saved with --plan, exactly as previewed', flags: ['allow-dirty', 'no-format', 'no-verify', 'commit', 'commit-message'], args: 'plan' },
  { group: 'Changes', cmd: 'undo', usage: '[--to <id>] [--force]', summary: 'Revert the last applied change (or every change back to <id>)', flags: ['to', 'force', 'yes', 'y'] },
  { group: 'Changes', cmd: 'history', usage: '[show <id>]', summary: "List applied changes, or show one change's files and diff", flags: [] },
];

export const HISTORY_SUBS = ['show'];

/** The commands that take subcommands, and those subcommands. */
export function subcommands(cmd: string): string[] {
  return COMMAND_LIST.filter((c) => c.cmd === cmd && c.sub).map((c) => c.sub!);
}

export function findCommand(cmd: string, sub?: string): CommandSpec | undefined {
  return COMMAND_LIST.find((c) => c.cmd === cmd && c.sub === sub) ?? COMMAND_LIST.find((c) => c.cmd === cmd && !c.sub) ?? (sub === undefined ? COMMAND_LIST.find((c) => c.cmd === cmd) : undefined);
}

/** Flags a command accepts, including global and change options. */
export function allowedFlags(spec: CommandSpec): string[] {
  return [...new Set([...spec.flags, ...(spec.change ? CHANGE_FLAGS : []), ...GLOBAL_FLAGS])];
}

export const BOOLEAN_FLAGS = new Set(Object.entries(FLAGS).filter(([, f]) => !f.value).map(([n]) => n));
export const REPEATABLE_FLAGS = new Set(Object.entries(FLAGS).filter(([, f]) => f.repeat).map(([n]) => n));

const flagLabel = (n: string) => `--${n}${FLAGS[n]?.value ? ` ${FLAGS[n].value}` : ''}`;
const line = (left: string, right: string, width = 46) => (left.length < width ? `  ${left.padEnd(width)} ${right}` : `  ${left}\n  ${' '.repeat(width)} ${right}`);

export function renderHelp(version: string, configFile: string): string {
  const groups = [...new Set(COMMAND_LIST.map((c) => c.group))];
  const out = [`codz ${version}: understands your project, then changes it the same way every time.`, '', 'Usage: codz <command> [options]   (codz <command> --help for its options)'];
  for (const g of groups) {
    out.push('', g);
    for (const c of COMMAND_LIST.filter((x) => x.group === g)) out.push(line(`codz ${c.cmd}${c.sub ? ` ${c.sub}` : ''}${c.usage ? ` ${c.usage}` : ''}`, c.summary.replace('codz.config.yaml', configFile)));
  }
  out.push('', 'Change options (commands that edit code)');
  for (const f of CHANGE_FLAGS.filter((n) => n !== 'y')) out.push(line(flagLabel(f), FLAGS[f].desc, 24));
  out.push('', 'Global');
  for (const f of GLOBAL_FLAGS.filter((n) => !['h', 'v'].includes(n))) out.push(line(flagLabel(f), FLAGS[f].desc, 24));
  return out.join('\n') + '\n';
}

export function renderCommandHelp(spec: CommandSpec): string {
  const name = `codz ${spec.cmd}${spec.sub ? ` ${spec.sub}` : ''}`;
  const out = [`${name}${spec.usage ? ` ${spec.usage}` : ''}`, '', spec.summary];
  const own = spec.flags.filter((f) => !CHANGE_FLAGS.includes(f) && !GLOBAL_FLAGS.includes(f));
  if (own.length) {
    out.push('', 'Options');
    for (const f of own) out.push(line(flagLabel(f), FLAGS[f].desc, 28));
  }
  for (const n of spec.notes ?? []) out.push('', n);
  if (spec.change) out.push('', `Change options: ${CHANGE_FLAGS.filter((n) => n !== 'y').map((f) => `--${f}`).join(', ')}`);
  out.push(`Global: ${GLOBAL_FLAGS.filter((n) => !['h', 'v'].includes(n)).map((f) => `--${f}`).join(', ')}`);
  return out.join('\n') + '\n';
}

/** docs/COMMANDS.md. */
export function renderMarkdown(version: string): string {
  const out = ['# codz commands', '', `Generated from \`src/core/commands.ts\` (codz ${version}). Do not edit by hand; run \`npm run docs\`.`, ''];
  for (const g of [...new Set(COMMAND_LIST.map((c) => c.group))]) {
    out.push(`## ${g}`, '');
    for (const c of COMMAND_LIST.filter((x) => x.group === g)) {
      out.push(`### \`codz ${c.cmd}${c.sub ? ` ${c.sub}` : ''}${c.usage ? ` ${c.usage}` : ''}\``, '', c.summary + '.', '');
      for (const n of c.notes ?? []) out.push(n, '');
      const own = c.flags.filter((f) => !CHANGE_FLAGS.includes(f) && !GLOBAL_FLAGS.includes(f));
      if (own.length) {
        out.push('| Option | |', '| --- | --- |');
        for (const f of own) out.push(`| \`${flagLabel(f).replace(/\|/g, '\\|')}\` | ${FLAGS[f].desc.replace(/\|/g, '\\|')}${FLAGS[f].repeat ? ' (repeatable)' : ''} |`);
        out.push('');
      }
      if (c.change) out.push('Accepts the change options.', '');
    }
  }
  out.push('## Change options', '', '| Option | |', '| --- | --- |');
  for (const f of CHANGE_FLAGS) out.push(`| \`${flagLabel(f)}\` | ${FLAGS[f].desc} |`);
  out.push('', '## Global options', '', '| Option | |', '| --- | --- |');
  for (const f of GLOBAL_FLAGS) out.push(`| \`${flagLabel(f)}\` | ${FLAGS[f].desc} |`);
  return out.join('\n') + '\n';
}
