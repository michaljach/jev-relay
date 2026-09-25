#!/usr/bin/env node
// Usage: jev-relay <prompt|subagent|failure|stop> --harness <claude|codex>
// Reads the hook payload on stdin. Always exits 0: a broken decision layer must never
// block the session, so errors are logged and the hook falls through.
import { loadConfig, log, readInput } from '../lib/harness.mjs'
import { onFailure, onPrompt, onStop, onSubagent } from '../lib/decisions.mjs'

const HANDLERS = { prompt: onPrompt, subagent: onSubagent, failure: onFailure, stop: onStop }

const [cmd, ...rest] = process.argv.slice(2)
const flag = rest.indexOf('--harness')
const harness = (flag >= 0 && rest[flag + 1]) || (process.env.CLAUDE_PLUGIN_ROOT ? 'claude' : 'codex')

try {
  const input = await readInput()
  const cfg = loadConfig(input.cwd || process.cwd())
  if (!HANDLERS[cmd]) throw new Error(`unknown command: ${cmd}`)
  await HANDLERS[cmd](input, cfg, harness)
} catch (err) {
  try { log({ decision: cmd, harness, crash: String(err?.stack || err) }) } catch {}
}
process.exit(0)
