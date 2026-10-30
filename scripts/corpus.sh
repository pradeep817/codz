#!/usr/bin/env bash
# Runs devtool against real public projects (scripts/corpus.txt) to catch what
# hand-written fixtures miss. Everything is read-only or --dry-run: nothing is
# written to the cloned projects.
#
# A project fails when devtool crashes (an "internal" error) or takes too long.
# Reporting that a project is not supported, or finding problems in it, is fine.
#
# Usage: ./scripts/corpus.sh [list-file]      (needs git and network access)
#        CORPUS_DIR=/path ./scripts/corpus.sh  reuses earlier clones
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIST="${1:-$ROOT/scripts/corpus.txt}"
WORK="${CORPUS_DIR:-$(mktemp -d)}"
DT=(node "$ROOT/bin/devtool.js")
LIMIT="${CORPUS_TIMEOUT:-120}"
status=0
rows=()

# Prints the error code of a --json result ("" when it succeeded).
error_code() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.ok===false?String(j.error?.code??"unknown"):"")}catch{process.stdout.write("not_json")}})'; }

echo "Working in $WORK"
while IFS= read -r line; do
  line="${line// /}"
  repo="${line%%#*}"
  sub=""; [[ "$line" == *"#"* ]] && sub="${line#*#}"
  dir="$WORK/${repo//\//__}"
  if [ ! -d "$dir/.git" ]; then
    git clone -q --depth 1 "https://github.com/$repo.git" "$dir" 2>/dev/null || { rows+=("$repo|clone failed|-"); continue; }
  fi
  proj="$dir${sub:+/$sub}"
  results=""
  failed=0
  for cmd in "doctor --setup" "doctor" "api list" "check" "api add --url https://api.example.com/corpus-items --sample $ROOT/test/inputs/products.json --dry-run"; do
    # shellcheck disable=SC2086
    label="${cmd%% https*}"; label="${label% --url}"
    out=$(cd "$proj" && timeout "$LIMIT" "${DT[@]}" $cmd --json --no-color 2>/dev/null)
    rc=$?
    code=$(printf '%s' "$out" | error_code)
    if [ $rc -eq 124 ]; then code="timeout"; fi
    case "$code" in
      internal|not_json|timeout) failed=1; results+="$label: $code; " ;;
      "") results+="$label: ok; " ;;
      *) results+="$label: $code; " ;;
    esac
  done
  if [ $failed -eq 1 ]; then status=1; rows+=("$repo${sub:+#$sub}|FAIL|$results"); else rows+=("$repo${sub:+#$sub}|pass|$results"); fi
done < <(grep -vE '^\s*(#|$)' "$LIST")

printf '\n%-45s %-6s %s\n' "Project" "Result" "Commands"
for r in "${rows[@]}"; do IFS='|' read -r a b c <<<"$r"; printf '%-45s %-6s %s\n' "$a" "$b" "$c"; done
exit $status
