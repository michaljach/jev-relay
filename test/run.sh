#!/usr/bin/env bash
# Offline smoke test: runs every hook handler against a throwaway git repo with the mock backend.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FX="$ROOT/test/fixtures"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export JEV_RELAY_BACKEND=mock JEV_RELAY_MOCK="$FX/mock.json" CLAUDE_PLUGIN_DATA="$TMP/data"

P="$TMP/repo"; mkdir -p "$P/docs" "$P/src" "$P/test"
printf '# Auth conventions\nTokens are JWTs signed with RS256.\n' > "$P/docs/auth.md"
printf '# Deploy runbook\nUse fly deploy.\n' > "$P/docs/deploy.md"
printf 'export const add=(a,b)=>a+b\n' > "$P/src/math.js"
printf 'export const hi=()=>"hi"\n' > "$P/src/greet.js"
printf 'import {add} from "../src/math.js"; if (add(1,2)!==3) { console.error("add broken"); process.exit(1) }\n' > "$P/test/math.test.mjs"
printf 'import {hi} from "../src/greet.js"; if (hi()!=="hi") process.exit(1)\n' > "$P/test/greet.test.mjs"
echo '{"checks":{"command":"for f in {files}; do node $f || exit 1; done"}}' > "$P/.jev-relay.json"
git -C "$P" init -q && git -C "$P" add -A && git -C "$P" -c user.email=t@t -c user.name=t commit -qm init

# run <command> <harness> <fixture|-> [extra json fields]
run() {
  local payload; if [ "$3" = - ]; then payload='{"session_id":"t"}'; else payload="$(cat "$FX/$3")"; fi
  node -e 'const [p,cwd,extra]=process.argv.slice(1);process.stdout.write(JSON.stringify({...JSON.parse(p),cwd,...JSON.parse(extra||"{}")}))' "$payload" "$P" "${4:-}" \
    | node "$ROOT/bin/jev-relay.mjs" "$1" --harness "$2"
}
fail=0
expect() { if grep -q -- "$2" <<<"$3"; then echo "ok   $1"; else echo "FAIL $1: got '$3'"; fail=1; fi; }
silent() { if [ -z "$2" ]; then echo "ok   $1"; else echo "FAIL $1: expected silence, got '$2'"; fail=1; fi; }

out=$(run prompt claude prompt.json);            expect "prompt picks relevant note"      'docs/auth.md' "$out"
grep -q deploy.md <<<"$out" && { echo "FAIL prompt included irrelevant note"; fail=1; } || echo "ok   prompt skips irrelevant note"
expect "prompt routes to fast worker"             'jev-relay:fast-worker' "$out"
out=$(run prompt codex prompt.json);             expect "codex prompt uses generic hint"  'smaller model' "$out"
out=$(run subagent claude subagent.json);        expect "subagent model rewritten"        '"model":"haiku"' "$out"
out=$(run subagent claude subagent-pinned.json); silent "explicit subagent model kept"    "$out"
out=$(run failure claude failure-claude.json);   expect "claude failure recovery"         'missing_dependency' "$out"
out=$(run failure codex failure-codex-fail.json); expect "codex failure detected"         '"hookEventName":"PostToolUse"' "$out"
out=$(run failure codex failure-codex-ok.json);  silent "codex success ignored"           "$out"
out=$(run stop claude -);                        silent "stop with clean tree"            "$out"
printf 'export const add=(a,b)=>a-b\n' > "$P/src/math.js"
out=$(run stop claude -);                        expect "stop blocks on focused failure"  '"decision":"block"' "$out"
grep -q greet <<<"$out" && { echo "FAIL ran unrelated test"; fail=1; } || echo "ok   unrelated test not run"
out=$(run stop claude -);                        silent "same diff not rechecked"         "$out"
printf 'export const add=(a,b)=>a*b\n' > "$P/src/math.js"
out=$(run stop claude - '{"stop_hook_active":true}'); silent "stop_hook_active respected" "$out"
out=$(JEV_RELAY_BACKEND= run prompt claude prompt.json); silent "no backend fails open"   "$out"
grep -q crash "$TMP/data/decisions.jsonl" && { echo "FAIL crash in log"; grep crash "$TMP/data/decisions.jsonl"; fail=1; } || echo "ok   no crashes logged"
exit $fail
