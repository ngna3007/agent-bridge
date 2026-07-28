#!/usr/bin/env bash
# Tier 3 — does a role file actually change a real agent's behavior?
#
# Chain under test:  .agentbridge/roles/<agent>.md
#                 -> abg roles apply
#                 -> AGENTS.md / CLAUDE.md marked block
#                 -> real agent process reads it
#                 -> observable behavior change
#
# The role text carries a distinctive token. If the token shows up in the
# agent's output, every link in that chain held. No mocks anywhere.
#
# Costs real model tokens and needs `codex` and `claude` on PATH, so it is
# not part of `bun test src`. Run it with `bun run test:live:roles`.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ABG="bun run $REPO/src/cli.ts"
LAB="${1:-${TMPDIR:-/tmp}/agentbridge-tier3-lab}"

pass=0; fail=0
check() { # check <name> <haystack-file> <needle>
  if grep -qF -- "$3" "$2" 2>/dev/null; then
    echo "  PASS  $1"; pass=$((pass+1))
  else
    echo "  FAIL  $1  (no '$3' in $2)"; fail=$((fail+1))
  fi
}
refute() { # refute <name> <haystack-file> <needle>
  if grep -qF -- "$3" "$2" 2>/dev/null; then
    echo "  FAIL  $1  (unexpected '$3' in $2)"; fail=$((fail+1))
  else
    echo "  PASS  $1"; pass=$((pass+1))
  fi
}

rm -rf "$LAB"; mkdir -p "$LAB/.agentbridge"; cd "$LAB" || exit 1

echo "== T3.1 seed + render =="
# With no EDITOR set, `roles edit` seeds the file and stops — which is
# exactly the "fresh project" state we want to start from.
$ABG roles edit codex  </dev/null >/dev/null 2>&1
$ABG roles edit claude </dev/null >/dev/null 2>&1
$ABG roles apply > apply1.txt 2>&1
cat apply1.txt
check "AGENTS.md rendered"  apply1.txt "AGENTS.md"
check "CLAUDE.md rendered"  apply1.txt "CLAUDE.md"

echo
echo "== T3.2 rewrite codex role with a distinctive marker =="
cat > .agentbridge/roles/codex.md <<'ROLE'
You are a terse assistant.

Protocol you must follow without exception:
Begin every single response with the exact token ZEBRA-7 on its own line.
Then answer in one short sentence. Nothing else.
ROLE
$ABG roles apply > apply2.txt 2>&1
cat apply2.txt
check "AGENTS.md updated from role file" apply2.txt "AGENTS.md: updated"
check "role text reached AGENTS.md"      AGENTS.md "ZEBRA-7"

echo
echo "== T3.3 real codex exec reads it =="
codex exec --skip-git-repo-check -C "$LAB" -s read-only \
  -o codex1.txt "What is 2+2? Answer per your protocol." >codex1.log 2>&1
echo "--- codex said ---"; cat codex1.txt 2>/dev/null || tail -5 codex1.log
check "codex obeyed the role" codex1.txt "ZEBRA-7"

echo
echo "== T3.4 edit the role, behavior follows =="
cat > .agentbridge/roles/codex.md <<'ROLE'
You are a terse assistant.

Protocol you must follow without exception:
Begin every single response with the exact token QUASAR-9 on its own line.
Then answer in one short sentence. Nothing else.
ROLE
$ABG roles apply > apply3.txt 2>&1
codex exec --skip-git-repo-check -C "$LAB" -s read-only \
  -o codex2.txt "What is 3+3? Answer per your protocol." >codex2.log 2>&1
echo "--- codex said ---"; cat codex2.txt 2>/dev/null || tail -5 codex2.log
check  "new role took effect"  codex2.txt "QUASAR-9"
refute "old role is gone"      codex2.txt "ZEBRA-7"

echo
echo "== T3.5 same chain for claude / CLAUDE.md =="
cat > .agentbridge/roles/claude.md <<'ROLE'
Begin every single response with the exact token ORYX-4 on its own line.
Then answer in one short sentence. Nothing else.
ROLE
$ABG roles apply > apply4.txt 2>&1
check "role text reached CLAUDE.md" CLAUDE.md "ORYX-4"
claude -p "What is 5+5?" > claude1.txt 2>claude1.log
echo "--- claude said ---"; cat claude1.txt 2>/dev/null || tail -5 claude1.log
check "claude obeyed the role" claude1.txt "ORYX-4"

echo
echo "== T3.6 empty role file aborts, does not silently default =="
: > .agentbridge/roles/codex.md
$ABG roles apply > apply5.txt 2>&1; rc=$?
echo "exit=$rc"; cat apply5.txt
check "error names the file" apply5.txt "Role file is empty"
if [ "$rc" -ne 0 ]; then
  echo "  PASS  nonzero exit"; pass=$((pass+1))
else
  echo "  FAIL  exit was 0"; fail=$((fail+1))
fi
# Assert on what the block SHOULD still contain (the T3.4 role), not on
# the absence of ZEBRA-7 — that token was already replaced in T3.4, so
# refuting it here would pass no matter what this step did.
check "AGENTS.md left alone" AGENTS.md "QUASAR-9"

echo
echo "== T3.7 deleting the role file restores the built-in default =="
rm .agentbridge/roles/codex.md
$ABG roles apply > apply6.txt 2>&1
cat apply6.txt
check "fell back to built-in default" apply6.txt "built-in default"
check "default mentions the markers"  AGENTS.md "[REPLY]"

echo
echo "======== T3 total: $pass passed, $fail failed ========"
[ "$fail" -eq 0 ]
