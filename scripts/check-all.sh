#!/usr/bin/env bash
# Beta build check: runs the commands testers will use first (feature add,
# auth add, screen add) on sample projects for every platform, then installs
# the real dependencies and builds the result with each platform's own tools.
#
#   Next.js        npm install, tsc --noEmit, vitest (the generated tests)
#   React (Vite)   npm install, tsc --noEmit, vitest
#   React Native   npm install, tsc --noEmit
#   Flutter        flutter pub get, build_runner (when used), dart analyze, flutter test
#                  for riverpod, getx, get_it and bloc
#   Android        Gradle assembleDebug + unit tests, Compose (hilt, koin, service
#                  locator) and XML Views; needs ANDROID_HOME
#   iOS            swiftc -typecheck against the iOS simulator SDK; needs Xcode
#
# A platform whose tools are missing is skipped, not failed. Every check writes
# a log; the summary at the end says where. Exit 1 when any check fails.
# CHECK_STRICT=1 (CI) turns a skipped check into a failure.
#
# Usage: scripts/check-all.sh [--only next,react,rn,flutter,android,ios] [--keep]
#   --keep    keep the work folder (it is printed) to open the projects

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DT=(node "$ROOT/bin/codz.js")
SPEC="$ROOT/examples/openapi.yaml"
FLAGS=(--yes --allow-dirty --no-verify --no-color)
WORK="$(mktemp -d "${TMPDIR:-/tmp}/codz-check.XXXXXX")"
LOGS="$WORK/logs"
mkdir -p "$LOGS"
ONLY=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY=",$2,"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "Unknown option $1"; exit 2 ;;
  esac
done
# Android builds need several GB (Gradle caches and build output): warn early instead of failing halfway.
free_gb=$(df -Pk "$WORK" 2>/dev/null | awk 'NR==2 {print int($4 / 1048576)}')
if [ -n "${free_gb:-}" ] && [ "$free_gb" -lt 8 ]; then
  echo "! Only ${free_gb} GB free on this disk; the Android checks need about 8 GB. Free some space (or run with --only next,react,rn,flutter,ios)."
fi
want() { [ -z "$ONLY" ] || [[ "$ONLY" == *",$1,"* ]]; }
have() { command -v "$1" >/dev/null 2>&1; }

RESULTS=()
FAILED=0
# check <platform> <name> <function>: runs the function with its log as stdout/stderr.
# The function returns 0 (pass), 77 (skipped: tools missing) or anything else (fail).
check() {
  local platform="$1" name="$2" fn="$3" log="$LOGS/$2.log"
  want "$platform" || return 0

  local start=$SECONDS before
  before="$(ls "$WORK")"
  ( set -e; "$fn" ) >"$log" 2>&1
  local code=$? took=$((SECONDS - start))
  if [ $code -eq 0 ]; then
    printf -- '✓ %-40s %4ss\n' "$name" "$took"; RESULTS+=("✓|$name|$log")
    # A passed project is not needed again; Android builds take about 1 GB each.
    if [ $KEEP -eq 0 ]; then
      for d in $(ls "$WORK"); do [ "$d" = logs ] || grep -qx "$d" <<<"$before" || rm -rf "${WORK:?}/$d"; done
    fi
  elif [ $code -eq 77 ] && [ "${CHECK_STRICT:-}" = 1 ]; then
    # CI: a missing tool means the runner is set up wrong, not that the check can be skipped.
    printf -- '✗ %-40s tools missing: %s\n' "$name" "$(tail -n 1 "$log")"; RESULTS+=("✗|$name|$log"); FAILED=1
  elif [ $code -eq 77 ]; then
    printf -- '- %-40s skipped (%s)\n' "$name" "$(tail -n 1 "$log")"; RESULTS+=("-|$name|$log")
  else
    printf -- '✗ %-40s %4ss  see %s\n' "$name" "$took" "$log"; RESULTS+=("✗|$name|$log"); FAILED=1
  fi
}

copy() { rm -rf "$WORK/$2"; cp -R "$ROOT/fixtures/$1" "$WORK/$2"; cd "$WORK/$2"; }
dt() { echo "\$ codz $*"; "${DT[@]}" "$@" "${FLAGS[@]}"; }
skip() { echo "$1"; exit 77; }

# ---------- Next.js ----------
next_fresh() {
  have npm || skip "npm not found"
  copy nextjs-fresh next-fresh
  dt feature add products --spec "$SPEC"
  dt feature add orders --spec "$SPEC"
  dt screen add order-tracking --api getOrderTracking --path /orders/:orderId/tracking
  dt auth add
  npm install --no-audit --no-fund --legacy-peer-deps
  npm install --no-audit --no-fund --legacy-peer-deps -D vitest@2
  printf '/// <reference types="next" />\n' > next-env.d.ts
  npx tsc --noEmit
  npx vitest run
}

next_helper() {
  have npm || skip "npm not found"
  copy nextjs-helper next-helper
  dt feature add products --spec "$SPEC"
  [ -f package.json ] || skip "fixture has no package.json"
  npm install --no-audit --no-fund --legacy-peer-deps
  npm install --no-audit --no-fund --legacy-peer-deps -D vitest@2 typescript@5
  npx tsc --noEmit
  npx vitest run
}

# ---------- React (Vite) ----------
react_fresh() {
  have npm || skip "npm not found"
  copy react-vite react-vite
  dt feature add products --spec "$SPEC"
  dt feature add orders --spec "$SPEC"
  dt screen add order-tracking --api getOrderTracking --path /orders/:orderId/tracking
  npm install --no-audit --no-fund --legacy-peer-deps
  npm install --no-audit --no-fund --legacy-peer-deps -D vitest@2
  npx tsc --noEmit -p tsconfig.json
  npx vitest run
  npx vite build
}

react_axios_query() {
  have npm || skip "npm not found"
  copy react-vite react-query
  dt feature add products --spec "$SPEC" --architecture axios-react-query
  npm install --no-audit --no-fund --legacy-peer-deps
  npm install --no-audit --no-fund --legacy-peer-deps -D vitest@2
  npx tsc --noEmit -p tsconfig.json
  npx vitest run
}

react_router() {
  have npm || skip "npm not found"
  copy react-router react-router
  dt feature add products --spec "$SPEC"
  npm install --no-audit --no-fund --legacy-peer-deps
  npx tsc --noEmit -p tsconfig.json
  npx vitest run
}

# ---------- React Native ----------
rn_navigation() {
  have npm || skip "npm not found"
  copy rn-app rn-app
  dt feature add products --spec "$SPEC"
  dt auth add
  npm install --no-audit --no-fund --legacy-peer-deps
  npx tsc --noEmit
}

rn_expo_router() {
  have npm || skip "npm not found"
  copy rn-expo-router rn-expo-router
  dt feature add products --spec "$SPEC"
  npm install --no-audit --no-fund --legacy-peer-deps
  npx tsc --noEmit
}

# ---------- Flutter ----------
flutter_arch() {
  local arch="$1"
  have flutter || skip "Flutter SDK not found"
  copy flutter-fresh "flutter-$arch"
  dt feature add products --spec "$SPEC" --architecture "$arch"
  dt feature add orders --spec "$SPEC"
  dt screen add order-tracking --api getOrderTracking --path /orders/:orderId/tracking
  dt auth add
  # flutter create's counter test checks the template home page, which GetX setup replaces (codz warns about it).
  if [ "$arch" = getx ] && grep -q 'Counter increments smoke test' test/widget_test.dart 2>/dev/null; then rm test/widget_test.dart; fi
  flutter pub get
  if grep -q build_runner pubspec.yaml; then dart run build_runner build --delete-conflicting-outputs; fi
  dart analyze lib test
  flutter test
}
flutter_riverpod() { flutter_arch riverpod; }
flutter_getx() { flutter_arch getx; }
flutter_get_it() { flutter_arch get_it; }
flutter_bloc() { flutter_arch bloc; }

# ---------- Android ----------
android_project() {
  local arch="$1" ui="$2" name="shop$3"
  [ -n "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ] || skip "no Android SDK (set ANDROID_HOME)"
  have java || skip "Java not found"
  rm -rf "$WORK/$name"; cd "$WORK"
  "${DT[@]}" create "$name" --type android --org com.acme --architecture "$arch" --base-url https://api.example.com/v1 --no-git --no-install --yes --no-color
  cd "$WORK/$name"
  if [ "$ui" = views ]; then dt config set ui views; fi
  dt feature add products --spec "$SPEC"
  if [ "$arch" = retrofit-hilt ]; then dt auth add; fi
  [ -x ./gradlew ] || { echo "no gradlew in the created project"; exit 1; }
  ./gradlew --no-daemon :app:assembleDebug :app:testDebugUnitTest
}
android_hilt() { android_project retrofit-hilt compose hilt; }
android_koin() { android_project retrofit-koin compose koin; }
android_locator() { android_project retrofit compose locator; }
android_views() { android_project retrofit-hilt views views; }

# ---------- iOS ----------
ios_swiftui() {
  have xcrun || skip "Xcode not found"
  xcrun --sdk iphonesimulator --show-sdk-path >/dev/null 2>&1 || skip "no iOS simulator SDK (install Xcode's iOS platform)"
  copy ios-swiftui ios-swiftui
  dt feature add products --spec "$SPEC" --initial
  dt feature add orders --spec "$SPEC"
  dt screen add order-tracking --api getOrderTracking --path /orders/:orderId/tracking
  # #Preview needs Xcode's macro plugins, which plain swiftc does not load: check a copy without previews.
  local src="$WORK/ios-typecheck"; rm -rf "$src"; mkdir -p "$src"
  find ShopApp -name '*.swift' | while read -r f; do perl -0pe 's/\n#Preview \{.*\z//s' "$f" > "$src/$(echo "$f" | tr '/' '_')"; done
  local arch; arch="$(uname -m)"; [ "$arch" = arm64 ] || arch=x86_64
  xcrun --sdk iphonesimulator swiftc -typecheck -target "$arch-apple-ios17.0-simulator" "$src"/*.swift
}

echo "codz beta build check — work folder: $WORK"
check next next-fresh next_fresh
check next next-helper next_helper
check react react-vite react_fresh
check react react-axios-query react_axios_query
check react react-router react_router
check rn rn-navigation rn_navigation
check rn rn-expo-router rn_expo_router
check flutter flutter-riverpod flutter_riverpod
check flutter flutter-getx flutter_getx
check flutter flutter-get_it flutter_get_it
check flutter flutter-bloc flutter_bloc
check android android-compose-hilt android_hilt
check android android-compose-koin android_koin
check android android-compose-locator android_locator
check android android-views android_views
check ios ios-swiftui ios_swiftui

pass=0; fail=0; skipped=0
for r in "${RESULTS[@]}"; do
  case "${r%%|*}" in "✓") pass=$((pass + 1)) ;; "✗") fail=$((fail + 1)) ;; *) skipped=$((skipped + 1)) ;; esac
done
echo
echo "$pass passed, $fail failed, $skipped skipped. Logs: $LOGS"
if [ $fail -gt 0 ]; then
  echo "Failed:"
  for r in "${RESULTS[@]}"; do [ "${r%%|*}" = "✗" ] && { IFS='|' read -r _ n l <<<"$r"; echo "  $n  →  $l"; }; done
  echo "Send the failed logs (they hold only build output from the sample projects)."
fi
if [ $KEEP -eq 0 ] && [ $fail -eq 0 ]; then rm -rf "$WORK"; else echo "Projects kept in $WORK"; fi
exit $FAILED
