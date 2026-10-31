#!/usr/bin/env bash
# CI only: turns the failure lines of a step's log into one GitHub annotation, so
# they can be read from the run's summary page and the checks API without
# downloading the full log.
# Usage: scripts/ci-annotate.sh <log file> [title]
log="$1"; title="${2:-Failures}"
[ -f "$log" ] || exit 0
lines=$(grep -E '✗|not ok|error|Error|FAIL|failed|Exception|e: ' "$log" | grep -v '^\s*$' | head -n 80)
[ -n "$lines" ] || lines=$(tail -n 40 "$log")
msg=$(printf '%s' "$lines" | sed -e 's/%/%25/g' -e 's/\r//g' | awk 'BEGIN{ORS="%0A"} {print}')
echo "::error title=${title}::${msg}"
