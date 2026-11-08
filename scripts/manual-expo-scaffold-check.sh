#!/usr/bin/env bash
# Manual check for: empty folder + "generate a fresh new react native expo project"
# Expected: project files present; npm install either exits 0 with a verification command recorded,
# or fails and the mission report says dependencies were not installed with the real error text.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/kern-expo-manual-XXXXXX)"
echo "Workspace: $WORK"
echo "Open this folder in KERN and run the agent with:"
echo "  generate a fresh new react native expo project"
echo
echo "After the mission finishes, verify:"
echo "  1) ls -la \"$WORK\""
echo "  2) test -f \"$WORK/package.json\""
echo "  3) Mission summary does NOT say Verified unless a check/install/build/test command recorded exit 0"
echo "  4) If npm install failed, summary includes real stderr (not only 'network error')"
echo
echo "Baseline network check outside the agent:"
cd "$WORK"
if npm ping >/dev/null 2>&1; then
  echo "npm registry reachable from this shell."
else
  echo "npm ping failed in this shell — agent install failures may be environmental, not broker bugs."
fi
echo "WORKSPACE=$WORK"
