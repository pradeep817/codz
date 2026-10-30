#!/usr/bin/env bash
# Creates an Android project for every architecture, runs a full codz session
# on each (endpoints, screens, form, route, tests, theme), then builds the app
# and runs the generated unit tests with Gradle. Needs Java 17+, the Android SDK
# (ANDROID_HOME) and Gradle on PATH (for the wrapper); CI has all three.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DT=(node "$ROOT/bin/codz.js")
IN="$ROOT/test/inputs"
WORK="$(mktemp -d)"
FLAGS=(--yes --allow-dirty --no-verify --no-color)
status=0

if [ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]; then
  echo "No Android SDK (ANDROID_HOME); skipping the Android build check."
  exit 0
fi

for arch in retrofit-hilt retrofit-koin retrofit; do
  name="shop-${arch//-/}"; d="$WORK/$name"
  run() { (cd "$d" && "${DT[@]}" "$@" "${FLAGS[@]}" >/dev/null 2>&1) || { echo "✗ $arch: codz $*"; status=1; }; }
  (cd "$WORK" && "${DT[@]}" create "$name" --type android --org com.acme --architecture "$arch" --base-url https://api.example.com/v1 --primary '#0F766E' --no-git --no-install --yes --no-color >/dev/null 2>&1) || { echo "✗ create $arch"; status=1; continue; }
  run api add --url 'https://api.example.com/v1/products?category=home' --sample "$IN/products.json"
  run api add --url 'https://api.example.com/v1/users/{id}' --sample "$IN/user.json"
  run api add --curl "curl -X POST https://api.example.com/v1/orders -d '{\"product_id\":3,\"qty\":2,\"gift\":true,\"note\":\"x\"}'" --name createOrder --model-name CreatedOrder --sample "$IN/user.json"
  run api add --curl "curl -X DELETE https://api.example.com/v1/orders/7" --name deleteOrder
  run screen add products --api getProducts
  run screen add user --api getUser --path /users/:id
  run screen add new-order --api createOrder --form
  run route add settings --path /settings/:section
  run test add --all
  run theme set primary '#0F766E' radius 12
  if [ ! -x "$d/gradlew" ]; then echo "✗ $arch: no gradlew (is Gradle on PATH?)"; status=1; continue; fi
  (cd "$d" && ./gradlew --no-daemon -q :app:assembleDebug :app:testDebugUnitTest) \
    && echo "✓ android $arch (endpoints, screens, form, route, tests, theme): assembleDebug + unit tests pass" \
    || { echo "✗ android $arch: Gradle build failed in $d"; status=1; }
done

exit $status
