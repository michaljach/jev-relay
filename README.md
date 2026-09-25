# jev-relay

A two-model relay for Claude Code and Codex. The harness lays out a closed set of options, [Jev](https://docs.typesafe.ai/introduction) (TypeSafe's System One decision model) picks one with a probability, and code checks it against a threshold before acting. The main model (Opus or GPT) only does the work that needs text or code.

Jev never sees a free-form "what should I do?". Every decision is a `noul` or a `choice` over options this plugin defines.

## The four decisions

| Decision | Claude Code event | Codex event | Jev question | What happens |
|---|---|---|---|---|
| **Pick project notes** | `UserPromptSubmit` | `UserPromptSubmit` | one `noul` per note in `docs/`, `notes/`, `.notes/`, `.claude/notes/`: "does the request need this?" | Top 3 at p ≥ 0.6 are inlined as `additionalContext` |
| **Route to a faster worker** | `UserPromptSubmit` (same Jev call) | `UserPromptSubmit` | `choice`: `main` vs `fast_worker` | At confidence ≥ 0.8, the model is told to delegate to `jev-relay:fast-worker` (Haiku) and review the result |
| **Subagent model** | `PreToolUse` on `Agent` | n/a | `choice`: `haiku` / `sonnet` / `opus` for the subagent prompt | Rewrites `tool_input.model` through `updatedInput`, only when the caller left it unset |
| **Recovery after a failed tool call** | `PostToolUseFailure` (Bash) | `PostToolUse` (failure detected from the exit code) | `choice` over 6 paths: retry, fix_invocation, missing_dependency, inspect_first, ask_user, change_approach | A one-line recovery instruction is added. The state includes how many times this exact command has failed, so repeated failures push toward `change_approach` |
| **Focused checks** | `Stop` | `Stop` | one `noul` per candidate test file (ranked first in code by shared path tokens): "could this diff break it?" | Runs only the picked tests. On failure, `decision: block` keeps the turn going with the failing output. Won't recheck the same diff, respects `stop_hook_active`, and stops after 2 blocks per session |

The note picking and routing questions go out in **one** request (speculative fan-out), so each prompt costs one Jev call: about 70–500 ms and a fraction of a cent.

## Install

```sh
export TYPESAFE_API_KEY=...        # from console.typesafe.ai

# Claude Code (local)
claude --plugin-dir /path/to/jev-relay

# Codex: the plugin ships .codex-plugin/plugin.json + hooks/hooks.codex.json.
# Add it through a local marketplace (`codex plugin marketplace add ...`), then trust its hooks in /hooks.
```

With no `TYPESAFE_API_KEY`, every hook does nothing. The plugin fails open everywhere: timeouts, HTTP errors and crashes are logged and the session continues untouched.

## Config

Optional `.jev-relay.json` in the project root (merged over the defaults in `lib/harness.mjs`):

```json
{
  "mode": "shadow",
  "notes":  { "dirs": ["docs", "adr"], "threshold": 0.6 },
  "route":  { "threshold": 0.85 },
  "checks": { "command": "npx vitest run {files}" }
}
```

Focused checks only run when `checks.command` is set. `{files}` is replaced with the shell-quoted test paths.

**Start in `"mode": "shadow"`.** Jev still gets asked, and every decision (latency, choice, confidence) goes to `decisions.jsonl` in the plugin data directory, but nothing is injected. Read a few days of that log before letting it act.

## Test

```sh
test/run.sh     # offline, uses the mock backend (JEV_RELAY_BACKEND=mock + canned answers)
```

## Caveats

- **Data leaves the machine.** Prompts, note previews (300 chars each), failing commands with their error tails, and diffs (first 12 KB) are sent to TypeSafe.
- **Routing in the main session is advisory.** A hook can't switch the main model mid-session. It can only add context. The enforced route is the subagent `model` rewrite.
- **Jev 1.13 weak spots** ([jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)): it reads questions literally, can't count or do math, can be steered by adversarial state. That's why every question here is a narrow yes/no or a pick from a labelled menu, and all arithmetic, file discovery and ranking happens in code.
- **Codex parts not yet run live:** the `PostToolUse` matcher names for the shell tool, the shape of `tool_response`, and whether Codex expands `$PLUGIN_ROOT` in the command string.
