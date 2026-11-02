#!/usr/bin/env bash
# Runs codz commands (api add/import/update/rename/remove, mocks,
# locales, theme, routes) on copies of the fixture projects, then compiles the
# result with the real toolchains: `dart analyze` for Flutter (needs the
# Flutter SDK) and `tsc` for Next.js (downloaded through npx).
# Usage: ./scripts/check-generated.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
DT=(node "$ROOT/bin/codz.js")
IN="$ROOT/test/inputs"
FLAGS=(--yes --allow-dirty --no-verify --no-color)
status=0

copy() { cp -R "$ROOT/fixtures/$1" "$WORK/$1"; echo "$WORK/$1"; }
# Long tool runs get a time limit, so a hang fails one check instead of the whole job.
tmo() { if command -v timeout >/dev/null 2>&1; then timeout 600 "$@"; else "$@"; fi; }
# Runs one codz command quietly; when it fails, says which and shows its output,
# and the check keeps going (the script still exits 1 at the end).
dtq() {
  if ! "${DT[@]}" "$@" > "$WORK/last.log" 2>&1; then
    echo "✗ codz $(printf '%s ' "$@" | cut -c1-160)failed in ${PWD#"$WORK"/}:"
    tail -n 15 "$WORK/last.log" | sed 's/^/    | /'
    touch "$WORK/failed"
  fi
}

# Paged and searchable lists: page + limit + server search, offset paging, and search over loaded items.
paged_screens() {
  (cd "$1" && dtq api add --url 'https://api.example.com/catalog?page=1&limit=20&q=lamp' --sample "$IN/products.json" --name listCatalog "${FLAGS[@]}")
  (cd "$1" && dtq api add --url 'https://api.example.com/feed?offset=0' --sample "$IN/products.json" --name listFeed "${FLAGS[@]}")
  (cd "$1" && dtq screen add catalog --api listCatalog --paginate --search "${FLAGS[@]}")
  (cd "$1" && dtq screen add feed --api listFeed --paginate "${FLAGS[@]}")
  (cd "$1" && dtq api add --url 'https://api.example.com/shelf' --sample "$IN/products.json" --name listShelf "${FLAGS[@]}")
  (cd "$1" && dtq screen add shelf --api listShelf --search "${FLAGS[@]}")
  (cd "$1" && dtq env add staging --base-url https://staging.example.com "${FLAGS[@]}")
}

echo "Working in $WORK"

if command -v flutter >/dev/null 2>&1; then
  d=$(copy flutter-riverpod)
  (cd "$d" && dtq api add "${FLAGS[@]}" < "$IN/order-curl.txt")
  (cd "$d" && dtq api add --url 'https://api.example.com/products?category=home' --sample "$IN/products.json" "${FLAGS[@]}")
  echo "→ $(basename "$d"): pub get, analyze"
  (cd "$d" && tmo flutter pub get >/dev/null && dart analyze lib) && echo "✓ flutter-riverpod: dart analyze clean" || { echo "✗ flutter-riverpod"; status=1; }

  d=$(copy flutter-getit)
  (cd "$d" && dtq api add "${FLAGS[@]}" < "$IN/visit-curl.txt")
  echo "→ $(basename "$d"): pub get, analyze"
  (cd "$d" && tmo flutter pub get >/dev/null && { tmo dart run build_runner build --delete-conflicting-outputs > "$WORK/br.log" 2>&1 || { echo "build_runner failed:"; grep -m 1 -B 2 -A 30 -E "Error|Exception|SEVERE|Bad state" "$WORK/br.log" || head -n 40 "$WORK/br.log"; false; }; } && dart analyze lib) && echo "✓ flutter-getit: dart analyze clean" || { echo "✗ flutter-getit"; status=1; }

  for arch in getx riverpod get_it; do
    d="$WORK/fresh-$arch"; cp -R "$ROOT/fixtures/flutter-fresh" "$d"
    (cd "$d" && dtq setup --architecture "$arch" --base-url https://api.example.com "${FLAGS[@]}")
    (cd "$d" && dtq api add "${FLAGS[@]}" < "$IN/order-curl.txt")
    echo "→ $(basename "$d"): pub get, analyze"
    (cd "$d" && tmo flutter pub get >/dev/null && dart analyze lib) && echo "✓ flutter-fresh + $arch setup: dart analyze clean" || { echo "✗ flutter-fresh + $arch"; status=1; }
  done

  for fx in flutter-fresh flutter-getx-cli; do
    d="$WORK/modules-$fx"; cp -R "$ROOT/fixtures/$fx" "$d"
    (cd "$d" && dtq setup --architecture getx --base-url https://api.example.com "${FLAGS[@]}")
    [ -d "$d/lib/app/modules/home" ] || (cd "$d" && dtq module add home "${FLAGS[@]}")
    (cd "$d" && dtq module add order_details "${FLAGS[@]}")
    (cd "$d" && dtq api add --into order_details "${FLAGS[@]}" < "$IN/order-curl.txt")
    (cd "$d" && dtq api add --url 'https://api.example.com/products' --sample "$IN/products.json" --into home "${FLAGS[@]}")
    echo "→ $(basename "$d"): pub get, analyze"
    (cd "$d" && tmo flutter pub get >/dev/null && dart analyze lib) && echo "✓ $fx + GetX modules: dart analyze clean" || { echo "✗ $fx + GetX modules"; status=1; }
  done
  # Every other command on one project per architecture: import, edit, mocks, locales, theme, routes.
  printf '{"id": 7, "name": "Bo", "email": "b@x.com", "created_at": "2026-01-02T00:00:00Z", "role": "admin", "phone": "+91 99999"}' > "$WORK/user-v2.json"
  for arch in getx riverpod get_it; do
    d="$WORK/session-$arch"; cp -R "$ROOT/fixtures/flutter-fresh" "$d"
    (cd "$d" && dtq setup --architecture "$arch" --base-url https://api.example.com "${FLAGS[@]}")
    (cd "$d" && dtq api import "$IN/shop-openapi.yaml" "${FLAGS[@]}")
    if [ "$arch" = getx ]; then (cd "$d" && dtq module add users --api listUsers "${FLAGS[@]}"); fi
    (cd "$d" && dtq api update getUser --sample "$WORK/user-v2.json" "${FLAGS[@]}")
    (cd "$d" && dtq field add User nickname:string? score:int? "${FLAGS[@]}")
    (cd "$d" && dtq field remove User nickname "${FLAGS[@]}")
    (cd "$d" && dtq api rename listUsers fetchUsers "${FLAGS[@]}")
    (cd "$d" && dtq api remove deleteUser "${FLAGS[@]}")
    (cd "$d" && dtq mock add --all "${FLAGS[@]}")
    if [ "$arch" = getx ]; then
      (cd "$d" && dtq locale key home.title Welcome "${FLAGS[@]}")
      (cd "$d" && dtq locale add hi "${FLAGS[@]}")
    fi
    (cd "$d" && dtq theme set primary '#6750A4' radius 12 "${FLAGS[@]}")
    (cd "$d" && dtq route add settings "${FLAGS[@]}")
    (cd "$d" && dtq route add order-details --path /orders/:id "${FLAGS[@]}")
    (cd "$d" && dtq screen add people --api fetchUsers "${FLAGS[@]}")
    paged_screens "$d"
    (cd "$d" && dtq api import "$IN/shop.har" --base-url https://api.shop.dev --skip-conflicts "${FLAGS[@]}")
    (cd "$d" && dtq doctor --fix "${FLAGS[@]}")
    echo "→ $(basename "$d"): pub get, analyze"
    (cd "$d" && tmo flutter pub get >/dev/null && dart analyze lib) && echo "✓ flutter-fresh + $arch, full session: dart analyze clean" || { echo "✗ flutter-fresh + $arch full session"; status=1; }
  done

  # freezed models + Retrofit clients + Cubit screens (get_it), with build_runner.
  d=$(copy flutter-bloc-retrofit)
  printf '{"id": 1, "title": "Ship", "due_at": "2026-01-02T00:00:00Z", "done": false, "priority": 2}' > "$WORK/task-v2.json"
  (cd "$d" && dtq api add --url 'https://api.taskboard.dev/v1/projects/{projectId}/members?role=admin' --sample "$IN/products.json" "${FLAGS[@]}")
  (cd "$d" && dtq api add --curl "curl -X POST https://api.taskboard.dev/v1/tasks -d '{\"title\":\"x\"}'" --name createTask --model-name CreatedTask --sample "$IN/user.json" "${FLAGS[@]}")
  (cd "$d" && dtq api update getTask --sample "$WORK/task-v2.json" "${FLAGS[@]}")
  (cd "$d" && dtq field add Task notes:string? labels:string[]? "${FLAGS[@]}")
  (cd "$d" && dtq api rename getTasks fetchTasks "${FLAGS[@]}")
  (cd "$d" && dtq screen add task-details --api getTask --path /tasks/:id "${FLAGS[@]}")
  (cd "$d" && dtq screen add members --api getProjectMembers --path /projects/:projectId/members "${FLAGS[@]}")
  paged_screens "$d"
  (cd "$d" && dtq mock add --all "${FLAGS[@]}")
  (cd "$d" && dtq test add --all "${FLAGS[@]}")
  echo "→ $(basename "$d"): pub get, analyze"
  (cd "$d" && tmo flutter pub get >/dev/null && { tmo dart run build_runner build --delete-conflicting-outputs > "$WORK/br.log" 2>&1 || { echo "build_runner failed:"; grep -m 1 -B 2 -A 30 -E "Error|Exception|SEVERE|Bad state" "$WORK/br.log" || head -n 40 "$WORK/br.log"; false; }; } && dart analyze lib test && tmo flutter test) && echo "✓ flutter-bloc-retrofit (freezed, Retrofit, Cubit screens): dart analyze clean" || { echo "✗ flutter-bloc-retrofit"; status=1; }

  d=$(copy flutter-riverpod)
  d2="$WORK/riverpod-session"; mv "$d" "$d2"; d="$d2"
  (cd "$d" && dtq route add order-details --path /orders/:orderId "${FLAGS[@]}")
  (cd "$d" && dtq theme set primary '#0F766E' "${FLAGS[@]}")
  (cd "$d" && dtq locale key welcomeUser 'Welcome {name}' "${FLAGS[@]}")
  (cd "$d" && dtq screen add user-details --api getUser --path /users/:id "${FLAGS[@]}")
  (cd "$d" && dtq api sync "$IN/shop-openapi.yaml" --add "${FLAGS[@]}")
  (cd "$d" && dtq screen add new-user --api createUser --form "${FLAGS[@]}")
  echo "→ $(basename "$d"): pub get, analyze"
  (cd "$d" && tmo flutter pub get >/dev/null && dart analyze lib) && echo "✓ flutter-riverpod + go_router route, theme, ARB key: dart analyze clean" || { echo "✗ flutter-riverpod session"; status=1; }
else
  echo "- Flutter SDK not found; skipping the Dart checks"
fi

# The repo's own TypeScript when installed: a bare `npx tsc` outside a project
# fetches the unrelated "tsc" package, which always fails.
if [ -z "${TSC:-}" ] && [ -f "$ROOT/node_modules/typescript/bin/tsc" ]; then TSC="node $ROOT/node_modules/typescript/bin/tsc"; fi
TSC="${TSC:-npx -y -p typescript tsc}"
TSC_OPTS='"strict": true, "noEmit": true, "target": "ES2022", "module": "esnext", "moduleResolution": "bundler", "lib": ["ES2022", "DOM"], "types": []'

d=$(copy nextjs-helper)
(cd "$d" && dtq api add "${FLAGS[@]}" < "$IN/order-curl.txt")
(cd "$d" && dtq api add --url 'https://api.example.com/products?category=home&page=1' --sample "$IN/products.json" "${FLAGS[@]}")
(cd "$d" && dtq api add --curl 'curl -X DELETE https://api.example.com/users/5' "${FLAGS[@]}")
printf '{ "compilerOptions": { %s, "paths": { "@/*": ["./*"] } }, "include": ["lib/**/*.ts", "types/**/*.ts", "env.d.ts"] }\n' "$TSC_OPTS" > "$d/tsconfig.check.json"
printf 'declare const process: { env: Record<string, string | undefined> };\n' > "$d/env.d.ts"
(cd "$d" && $TSC -p tsconfig.check.json) && echo "✓ nextjs-helper: tsc clean" || { echo "✗ nextjs-helper"; status=1; }

d=$(copy nextjs-plain)
(cd "$d" && dtq api add --url 'https://api.acme.dev/v1/teams/7f3e9d2a-1b4c-4e5f-8a9b-0c1d2e3f4a5b' --sample "$IN/team-1.json" --sample "$IN/team-2.json" --model-name TeamDetail "${FLAGS[@]}")
(cd "$d" && dtq api add --url 'POST https://api.acme.dev/v1/users' --request-sample "$IN/user.json" --sample "$IN/user.json" "${FLAGS[@]}")
printf '{ "compilerOptions": { %s }, "include": ["src/services/*.ts", "src/models/*.ts", "env.d.ts"] }\n' "$TSC_OPTS" > "$d/tsconfig.check.json"
printf 'declare const process: { env: Record<string, string | undefined> };\n' > "$d/env.d.ts"
(cd "$d" && $TSC -p tsconfig.check.json) && echo "✓ nextjs-plain: tsc clean" || { echo "✗ nextjs-plain"; status=1; }

for arch in fetch-helper plain-fetch; do
  d="$WORK/next-fresh-$arch"; cp -R "$ROOT/fixtures/nextjs-fresh" "$d"
  (cd "$d" && dtq setup --architecture "$arch" --base-url https://api.example.com "${FLAGS[@]}")
  (cd "$d" && dtq api add "${FLAGS[@]}" < "$IN/order-curl.txt")
  printf '{ "compilerOptions": { %s, "paths": { "@/*": ["./*"] } }, "include": ["lib/**/*.ts", "types/**/*.ts", "env.d.ts"] }\n' "$TSC_OPTS" > "$d/tsconfig.check.json"
  printf 'declare const process: { env: Record<string, string | undefined> };\n' > "$d/env.d.ts"
  (cd "$d" && $TSC -p tsconfig.check.json) && echo "✓ nextjs-fresh + $arch setup: tsc clean" || { echo "✗ nextjs-fresh + $arch"; status=1; }
done

d="$WORK/next-session"; cp -R "$ROOT/fixtures/nextjs-helper" "$d"
(cd "$d" && dtq api import "$IN/petstore-swagger.json" "${FLAGS[@]}")
(cd "$d" && dtq api import "$IN/shop-postman.json" "${FLAGS[@]}")
(cd "$d" && dtq api update getUser --sample "$IN/user.json" "${FLAGS[@]}")
(cd "$d" && dtq field add User nickname:string? score:int "${FLAGS[@]}")
(cd "$d" && dtq api rename listPets fetchPets "${FLAGS[@]}")
(cd "$d" && dtq mock add --all "${FLAGS[@]}")
(cd "$d" && dtq doctor --fix "${FLAGS[@]}")
printf '{ "compilerOptions": { %s, "paths": { "@/*": ["./*"] } }, "include": ["lib/**/*.ts", "types/**/*.ts", "env.d.ts"] }\n' "$TSC_OPTS" > "$d/tsconfig.check.json"
printf 'declare const process: { env: Record<string, string | undefined> };\n' > "$d/env.d.ts"
(cd "$d" && $TSC -p tsconfig.check.json) && echo "✓ nextjs-helper, import + update + rename + mocks: tsc clean" || { echo "✗ nextjs-helper session"; status=1; }

# Pages (.tsx): screens, routes and the fixture's own pages after a rename, with
# React's types. Without network access a small JSX shim stands in, which still
# checks everything except the JSX element types.
# Type stand-ins for when packages cannot be installed: JSX and React hooks
# (jsx-shim.d.ts, only without @types/react) and next/navigation (always,
# since installing next itself is too heavy for this check).
write_shims() {
  cat > "$1/jsx-shim.d.ts" <<'SHIM'
declare namespace JSX {
  interface IntrinsicElements { [name: string]: { onChange?: (e: { target: { value: string; checked: boolean } }) => void; [prop: string]: unknown } }
  interface Element {}
}
declare namespace React { type ReactNode = unknown }
declare module 'next/link' { const Link: (props: { href: string; children?: unknown; [prop: string]: unknown }) => JSX.Element; export default Link; }
declare module 'react' {
  export function useState<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void];
  export type FormEvent<T = unknown> = { preventDefault(): void; currentTarget: T };
}
SHIM
  cat > "$1/vitest-shim.d.ts" <<'SHIM'
declare module 'vitest' {
  type Spy = { mockResolvedValue(v: unknown): Spy; mock: { calls: any[][] } };
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => Promise<void> | void): void;
  export function afterEach(fn: () => void): void;
  export function expect(v: unknown): { toBe(x: unknown): void; toEqual(x: unknown): void; toContain(x: string): void; toBeUndefined(): void; rejects: { toThrow(): Promise<void> } };
  export const vi: { spyOn(obj: object, method: string): Spy; restoreAllMocks(): void };
}
SHIM
  printf "declare module 'next/navigation' {\n  export function useParams<T>(): T;\n  export function useRouter(): { push(href: string): void };\n}\n" > "$1/next-shim.d.ts"
}
TYPES="$WORK/tsx-types"; mkdir -p "$TYPES"
if (cd "$TYPES" && npm init -y >/dev/null 2>&1 && npm install --no-save --no-audit --no-fund @types/react@19 >/dev/null 2>&1); then
  JSX_TYPES="\"typeRoots\": [\"$TYPES/node_modules/@types\"], \"types\": [\"react\"]"; JSX_SHIM=""
else
  echo "- @types/react not installable here; using a JSX shim"
  JSX_TYPES='"types": []'; JSX_SHIM="jsx-shim.d.ts"
fi
TSX_OPTS='"strict": true, "noEmit": true, "target": "ES2022", "module": "esnext", "moduleResolution": "bundler", "lib": ["ES2022", "DOM"], "jsx": "preserve"'
d="$WORK/next-pages"; cp -R "$ROOT/fixtures/nextjs-helper" "$d"
(cd "$d" && dtq screen add user-profile --api getUser --path /users/:id "${FLAGS[@]}")
(cd "$d" && dtq route add settings "${FLAGS[@]}")
(cd "$d" && dtq api rename getUser fetchUser "${FLAGS[@]}")
(cd "$d" && dtq api sync "$IN/shop-openapi.yaml" --add "${FLAGS[@]}")
(cd "$d" && dtq screen add new-user --api createUser --form "${FLAGS[@]}")
(cd "$d" && dtq screen add edit-user --api updateUser --path /users/:id/edit --form "${FLAGS[@]}")
paged_screens "$d"
(cd "$d" && dtq test add --all "${FLAGS[@]}")
printf 'declare const process: { env: Record<string, string | undefined> };\n' > "$d/env.d.ts"
write_shims "$d"
printf '{ "compilerOptions": { %s, %s, "paths": { "@/*": ["./*"] } }, "include": ["app/**/*.tsx", "components/**/*.tsx", "lib/**/*.ts", "types/**/*.ts", "env.d.ts", "next-shim.d.ts", "vitest-shim.d.ts"%s] }\n' \
  "$TSX_OPTS" "$JSX_TYPES" "${JSX_SHIM:+, \"$JSX_SHIM\"}" > "$d/tsconfig.check.json"
(cd "$d" && $TSC -p tsconfig.check.json) && echo "✓ nextjs-helper pages (.tsx) after screen + form screens + route + rename + sync: tsc clean" || { echo "✗ nextjs-helper pages"; status=1; }

# axios + TanStack Query: API functions through the axios instance, and hooks.
d="$WORK/next-axios"; cp -R "$ROOT/fixtures/nextjs-axios" "$d"
(cd "$d" && dtq api add --url 'https://api.crm.dev/v1/deals/{dealId}/notes?page=1&q=x' --sample "$IN/products.json" "${FLAGS[@]}")
(cd "$d" && dtq api add --curl "curl -X PATCH https://api.crm.dev/v1/deals/7 -d '{\"stage\":\"won\"}'" --name updateDeal --model-name DealResult --sample "$IN/user.json" "${FLAGS[@]}")
(cd "$d" && dtq api add --curl 'curl -X DELETE https://api.crm.dev/v1/deals/7' --name deleteDeal "${FLAGS[@]}")
(cd "$d" && dtq api add --curl 'curl -X POST https://api.crm.dev/v1/deals/7/archive' --name archiveDeal "${FLAGS[@]}")
(cd "$d" && dtq api rename getContact fetchContact "${FLAGS[@]}")
(cd "$d" && dtq mock add --all "${FLAGS[@]}")
(cd "$d" && dtq test add --all "${FLAGS[@]}")
(cd "$d" && dtq screen add contact --api fetchContact --path /contacts/:id "${FLAGS[@]}")
if (cd "$TYPES" && npm install --no-save --no-audit --no-fund axios@1 @tanstack/react-query@5 >/dev/null 2>&1); then
  LIB_TYPES="\"paths\": { \"@/*\": [\"./src/*\"], \"axios\": [\"$TYPES/node_modules/axios\"], \"@tanstack/react-query\": [\"$TYPES/node_modules/@tanstack/react-query\"] }"; LIB_SHIM=""
else
  echo "- axios / @tanstack/react-query not installable here; using type shims"
  LIB_TYPES='"paths": { "@/*": ["./src/*"] }'; LIB_SHIM="lib-shim.d.ts"
  cat > "$d/lib-shim.d.ts" <<'SHIM'
declare module 'axios' {
  interface AxiosResponse<T> { data: T }
  interface AxiosInstance {
    get<T = any>(url: string, config?: object): Promise<AxiosResponse<T>>;
    delete<T = any>(url: string, config?: object): Promise<AxiosResponse<T>>;
    head<T = any>(url: string, config?: object): Promise<AxiosResponse<T>>;
    post<T = any>(url: string, data?: unknown, config?: object): Promise<AxiosResponse<T>>;
    put<T = any>(url: string, data?: unknown, config?: object): Promise<AxiosResponse<T>>;
    patch<T = any>(url: string, data?: unknown, config?: object): Promise<AxiosResponse<T>>;
    interceptors: { request: { use(fn: (config: { method?: string; url?: string; adapter?: unknown }) => unknown): number } };
  }
  const axios: AxiosInstance & { create(config?: object): AxiosInstance };
  export default axios;
}
declare module '@tanstack/react-query' {
  export function useQuery<T>(o: { queryKey: unknown[]; queryFn: () => Promise<T> }): { data: T | undefined };
  export function useMutation<T, V = void>(o: { mutationFn: (v: V) => Promise<T>; onSuccess?: () => unknown }): { mutate(v: V): void };
  export function useQueryClient(): { invalidateQueries(o: { queryKey: unknown[] }): Promise<void> };
}
SHIM
fi
printf 'declare const process: { env: Record<string, string | undefined> };\n' > "$d/env.d.ts"
write_shims "$d"
printf '{ "compilerOptions": { %s, %s, %s }, "include": ["src/**/*.ts", "src/**/*.tsx", "env.d.ts", "next-shim.d.ts", "vitest-shim.d.ts"%s%s] }\n' \
  "$TSX_OPTS" "$JSX_TYPES" "$LIB_TYPES" "${JSX_SHIM:+, \"$JSX_SHIM\"}" "${LIB_SHIM:+, \"$LIB_SHIM\"}" > "$d/tsconfig.check.json"
(cd "$d" && $TSC -p tsconfig.check.json) && echo "✓ nextjs-axios (axios + TanStack Query hooks): tsc clean" || { echo "✗ nextjs-axios"; status=1; }

# codz create: brand-new projects for every architecture, then an endpoint each.
if command -v flutter >/dev/null 2>&1; then
  for arch in riverpod getx bloc get_it; do
    (cd "$WORK" && dtq create "made_$arch" --type flutter --architecture "$arch" --base-url https://api.example.com --no-git --no-install --yes --no-color)
    (cd "$WORK/made_$arch" && dtq api add "${FLAGS[@]}" < "$IN/order-curl.txt")
    (cd "$WORK/made_$arch" && flutter pub get >/dev/null && dart analyze lib && tmo flutter test) && echo "✓ codz create flutter + $arch (demo screen in that architecture): dart analyze clean, widget test passes" || { echo "✗ codz create flutter + $arch"; status=1; }
  done
fi
for arch in fetch-helper plain-fetch; do
  d="$WORK/made-next-$arch"
  (cd "$WORK" && dtq create "made-next-$arch" --type nextjs --architecture "$arch" --base-url https://api.example.com --offline --no-git --no-install --yes --no-color)
  (cd "$d" && dtq api add "${FLAGS[@]}" < "$IN/order-curl.txt")
  printf 'declare const process: { env: Record<string, string | undefined> };\n' > "$d/env.d.ts"
  write_shims "$d"
  printf '{ "compilerOptions": { %s, %s, "paths": { "@/*": ["./*"] } }, "include": ["app/page.tsx", "app/demo-task-list.tsx", "lib/**/*.ts", "types/**/*.ts", "env.d.ts"%s] }\n' "$TSX_OPTS" "$JSX_TYPES" "${JSX_SHIM:+, \"$JSX_SHIM\"}" > "$d/tsconfig.check.json"
  (cd "$d" && $TSC -p tsconfig.check.json) && echo "✓ codz create nextjs + $arch (demo page, client list): tsc clean" || { echo "✗ codz create nextjs + $arch"; status=1; }
done

# React Native: codz create (Expo and CLI, every architecture), then endpoints,
# screens, a form, a route, mocks, tests and the theme, type-checked with stand-in

# types for react-native, React Navigation, TanStack Query, axios and Jest.
write_rn_shims() {
  cat > "$1/rn-shim.d.ts" <<'SHIM'
declare namespace JSX { interface IntrinsicElements { [name: string]: any } interface Element {} interface ElementChildrenAttribute { children: {} } }
declare const process: { env: Record<string, string | undefined> };
declare module 'react' {
  export function useState<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void];
  export function useEffect(fn: () => void | (() => void), deps?: unknown[]): void;
  export function useCallback<T extends (...a: any[]) => any>(fn: T, deps: unknown[]): T;
  export function useRef<T>(initial: T): { current: T };
}
declare module 'react-native' {
  type C = (props: any) => JSX.Element;
  export const View: C, Text: C, ScrollView: C, Button: C, ActivityIndicator: C, Pressable: C;
  export function FlatList<T>(props: { data: readonly T[] | null | undefined; keyExtractor?: (item: T, index: number) => string; renderItem: (info: { item: T; index: number }) => JSX.Element; [prop: string]: unknown }): JSX.Element;
  export function TextInput(props: { value?: string; onChangeText?: (text: string) => void; [prop: string]: unknown }): JSX.Element;
  export function Switch(props: { value?: boolean; onValueChange?: (value: boolean) => void; [prop: string]: unknown }): JSX.Element;
  export const StyleSheet: { create<T>(s: T): T; hairlineWidth: number };
  export const Alert: { alert(title: string, message?: string): void };
  export const AppRegistry: { registerComponent(name: string, fn: () => unknown): void };
}
declare module '@react-navigation/native' { export const NavigationContainer: (props: any) => JSX.Element; }
declare module '@react-navigation/native-stack' {
  export type NativeStackScreenProps<P, K extends keyof P> = { route: { params: P[K] }; navigation: { navigate(...args: any[]): void; goBack(): void; addListener(event: string, fn: () => void): () => void } };
  export function createNativeStackNavigator<P>(): { Navigator: (props: any) => JSX.Element; Screen: (props: { name: keyof P; component: unknown }) => JSX.Element };
}
declare module 'expo-router' { export function useLocalSearchParams<T>(): T; export const Stack: (props: any) => JSX.Element; export const router: { push(href: string): void; back(): void }; export function useFocusEffect(fn: () => void | (() => void)): void; }
declare module 'expo' { export function registerRootComponent(c: unknown): void; }
declare module '@tanstack/react-query' {
  export class QueryClient {}
  export const QueryClientProvider: (props: any) => JSX.Element;
  export function useQuery<T>(o: { queryKey: unknown[]; queryFn: () => Promise<T> }): { data: T | undefined; isLoading: boolean; isFetching: boolean; isRefetching: boolean; error: unknown; refetch: () => Promise<unknown> };
  export function useInfiniteQuery<T, P>(o: { queryKey: unknown[]; queryFn: (ctx: { pageParam: P }) => Promise<T>; initialPageParam: P; getNextPageParam: (last: T, all: T[]) => P | undefined }): { data: { pages: T[] } | undefined; error: unknown; isLoading: boolean; isFetching: boolean; isFetchingNextPage: boolean; hasNextPage: boolean; fetchNextPage: () => Promise<unknown>; refetch: () => Promise<unknown> };
  export function useMutation<T, V = void>(o: { mutationFn: (v: V) => Promise<T>; onSuccess?: () => unknown }): { mutate(v: V): void };
  export function useQueryClient(): { invalidateQueries(o: { queryKey: unknown[] }): Promise<void> };
}
declare module 'axios' {
  interface AxiosResponse<T> { data: T }
  interface AxiosInstance {
    get<T = any>(url: string, config?: object): Promise<AxiosResponse<T>>;
    delete<T = any>(url: string, config?: object): Promise<AxiosResponse<T>>;
    post<T = any>(url: string, data?: unknown, config?: object): Promise<AxiosResponse<T>>;
    put<T = any>(url: string, data?: unknown, config?: object): Promise<AxiosResponse<T>>;
    patch<T = any>(url: string, data?: unknown, config?: object): Promise<AxiosResponse<T>>;
    interceptors: { request: { use(fn: (config: { method?: string; url?: string; adapter?: unknown }) => unknown): number } };
  }
  const axios: AxiosInstance & { create(config?: object): AxiosInstance };
  export default axios;
}
declare const jest: { spyOn(obj: object, method: string): { mockResolvedValue(v: unknown): any; mock: { calls: any[][] } }; restoreAllMocks(): void };
declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => Promise<void> | void): void;
declare function afterEach(fn: () => void): void;
declare function expect(v: unknown): { toBe(x: unknown): void; toEqual(x: unknown): void; toContain(x: string): void; toBeUndefined(): void; rejects: { toThrow(): Promise<void> } };
declare module '@jest/globals' {
  export const jest: { spyOn(obj: object, method: string): { mockResolvedValue(v: unknown): any; mock: { calls: any[][] } }; restoreAllMocks(): void };
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => Promise<void> | void): void;
  export function afterEach(fn: () => void): void;
  export function expect(v: unknown): { toBe(x: unknown): void; toEqual(x: unknown): void; toContain(x: string): void; toBeUndefined(): void; rejects: { toThrow(): Promise<void> } };
}
SHIM
}
for flavor in expo bare; do
  for arch in fetch-helper axios axios-react-query; do
    name="rn-$flavor-$arch"; d="$WORK/$name"
    (cd "$WORK" && dtq create "$name" --type react-native --flavor "$flavor" --architecture "$arch" --base-url https://api.example.com --offline --no-git --no-install --yes --no-color)
    (cd "$d" && dtq api add --url 'https://api.example.com/products?category=home' --sample "$IN/products.json" "${FLAGS[@]}")
    (cd "$d" && dtq api add "${FLAGS[@]}" < "$IN/order-curl.txt")
    (cd "$d" && dtq api add --url 'https://api.example.com/users/{id}' --sample "$IN/user.json" "${FLAGS[@]}")
    (cd "$d" && dtq api add --curl "curl -X POST https://api.example.com/orders -d '{\"product_id\":3,\"qty\":2,\"gift\":true,\"note\":\"x\"}'" --name createOrder --model-name CreatedOrder --sample "$IN/user.json" "${FLAGS[@]}")
    (cd "$d" && dtq screen add products --api getProducts "${FLAGS[@]}")
    (cd "$d" && dtq screen add user --api getUser --path /users/:id "${FLAGS[@]}")
    (cd "$d" && dtq screen add new-order --api createOrder --form "${FLAGS[@]}")
    paged_screens "$d"
    (cd "$d" && dtq route add settings "${FLAGS[@]}")
    (cd "$d" && dtq mock add --all "${FLAGS[@]}")
    (cd "$d" && dtq test add --all "${FLAGS[@]}")
    (cd "$d" && dtq theme set primary '#0F766E' radius 12 "${FLAGS[@]}")
    write_rn_shims "$d"
    alias=''; if [ "$flavor" = expo ]; then alias=', "paths": { "@/*": ["./src/*"] }'; fi
    printf '{ "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "esnext", "moduleResolution": "bundler", "lib": ["ES2022", "DOM"], "jsx": "preserve", "types": [], "skipLibCheck": true%s }, "include": ["App.tsx", "src/**/*.ts", "src/**/*.tsx", "rn-shim.d.ts"] }\n' "$alias" > "$d/tsconfig.check.json"
    (cd "$d" && $TSC -p tsconfig.check.json) && echo "✓ react-native $flavor + $arch (screens, form, route, mocks, tests, theme): tsc clean" || { echo "✗ react-native $flavor + $arch"; status=1; }
  done
done

# codz new: the internal starters exactly as a user gets them (real flutter create / npm install),
# then the init contract, an endpoint and a screen, then the platform's own checks.
if command -v flutter >/dev/null 2>&1; then
  d="$WORK/starter_app"
  (cd "$WORK" && dtq new starter_app --template "$ROOT/starters/flutter-riverpod-dio" --org com.acme --yes --no-color) || { echo "✗ codz new flutter-riverpod-dio"; status=1; }
  if [ -d "$d" ]; then
    (cd "$d" && dtq init --yes --no-color)
    (cd "$d" && dtq api add --url 'https://api.example.com/products?category=home' --sample "$IN/products.json" "${FLAGS[@]}")
    (cd "$d" && dtq screen add products --api getProducts "${FLAGS[@]}")
    echo "→ $(basename "$d"): pub get, analyze"
    (cd "$d" && tmo flutter pub get >/dev/null && flutter analyze --no-fatal-infos && tmo flutter test) && echo "✓ codz new flutter-riverpod-dio + api add + screen: analyze and tests pass" || { echo "✗ starter flutter-riverpod-dio"; status=1; }
  fi
fi
d="$WORK/starter-next"
(cd "$WORK" && dtq new starter-next --template "$ROOT/starters/nextjs-app-router-fetch" --yes --no-color) || { echo "✗ codz new nextjs-app-router-fetch"; status=1; }
if [ -d "$d/node_modules/next" ]; then
  (cd "$d" && dtq init --yes --no-color)
  (cd "$d" && dtq api add --url 'https://api.example.com/products' --sample "$IN/products.json" "${FLAGS[@]}")
  (cd "$d" && dtq screen add products --api getProducts "${FLAGS[@]}")
  (cd "$d" && npx --no-install tsc --noEmit && NEXT_TELEMETRY_DISABLED=1 tmo npx --no-install next build >/dev/null) && echo "✓ codz new nextjs-app-router-fetch + api add + screen: tsc and next build pass" || { echo "✗ starter nextjs-app-router-fetch"; status=1; }
else
  echo "- codz new nextjs-app-router-fetch: npm install did not run (offline?), so the build check was skipped"
fi
node "$ROOT/scripts/starters.ts" check "$ROOT"/starters/*/ >/dev/null && echo "✓ starters pass the publishing gates" || { echo "✗ starters publishing gates"; node "$ROOT/scripts/starters.ts" check "$ROOT"/starters/*/; status=1; }

# A project made by `flutter create` (not a hand-written fixture), with a full session on it.
if command -v flutter >/dev/null 2>&1; then
  d="$WORK/created_app"
  (cd "$WORK" && flutter create --no-pub --project-name created_app created_app >/dev/null)
  (cd "$d" && dtq setup --architecture riverpod --base-url https://api.example.com "${FLAGS[@]}")
  (cd "$d" && dtq api import "$IN/shop-openapi.yaml" "${FLAGS[@]}")
  (cd "$d" && dtq screen add people --api listUsers "${FLAGS[@]}")
  (cd "$d" && dtq mock add --all "${FLAGS[@]}")
  echo "→ $(basename "$d"): pub get, analyze"
  (cd "$d" && tmo flutter pub get >/dev/null && dart analyze lib) && echo "✓ flutter create + riverpod session: dart analyze clean" || { echo "✗ flutter create session"; status=1; }
fi

[ -f "$WORK/failed" ] && status=1
exit $status
