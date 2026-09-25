// Normalizes Claude Code and Codex hook I/O, config, and the decision log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULTS = {
  // "advise": act on decisions. "shadow": ask Jev and log, but never touch the session.
  mode: 'advise',
  model: 'jev-latest',
  timeoutMs: 2500,
  notes: { enabled: true, dirs: ['docs', 'notes', '.notes', '.claude/notes'], maxCandidates: 60, threshold: 0.6, maxPick: 3, maxCharsEach: 4000 },
  route: { enabled: true, threshold: 0.8, minPromptChars: 20 },
  subagentModel: { enabled: true, threshold: 0.75 },
  recover: { enabled: true, threshold: 0.6 },
  // command gets {files} replaced by the selected test paths, e.g. "npx vitest run {files}"
  checks: { enabled: true, command: null, threshold: 0.5, maxTests: 8, maxCandidates: 80, timeoutMs: 180000, maxBlocks: 2 },
}

export async function readInput() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

export function loadConfig(cwd) {
  const cfg = structuredClone(DEFAULTS)
  const file = join(cwd || '.', '.jev-relay.json')
  if (!existsSync(file)) return cfg
  const user = JSON.parse(readFileSync(file, 'utf8'))
  for (const [k, v] of Object.entries(user)) {
    cfg[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...cfg[k], ...v } : v
  }
  return cfg
}

export function dataDir() {
  const dir = process.env.CLAUDE_PLUGIN_DATA || process.env.PLUGIN_DATA || join(homedir(), '.jev-relay')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function log(entry) {
  appendFileSync(join(dataDir(), 'decisions.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
}

// Small per-session scratch state (failure streaks, check fingerprints, block counts).
export function sessionState(sessionId) {
  const file = join(dataDir(), `session-${(sessionId || 'none').replace(/[^\w-]/g, '')}.json`)
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  return { state, save: () => writeFileSync(file, JSON.stringify(state)) }
}

// Both harnesses accept hookSpecificOutput.additionalContext for these events.
export function emitContext(event, text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }))
}

export function emitUpdatedInput(input, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: input, additionalContext: reason },
  }))
}

export function emitBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
}
