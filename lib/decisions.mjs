// The four decisions. Pattern for each: code prepares a closed set of options,
// Jev picks one with a probability, code validates against a threshold and acts.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import { ask } from './jev.mjs'
import { emitBlock, emitContext, emitUpdatedInput, log, sessionState } from './harness.mjs'

const TEXT_EXT = new Set(['.md', '.mdx', '.txt'])

// ---------------------------------------------------------------------------
// 1 + 2. UserPromptSubmit: pick project notes and decide routing in ONE Jev call.
export async function onPrompt(input, cfg, harness) {
  const prompt = stripPasteMarkers(input.prompt || '')
  if (!prompt.trim() || prompt.startsWith('/')) return

  const notes = cfg.notes.enabled ? collectNotes(input.cwd, cfg.notes) : []
  const wantRoute = cfg.route.enabled && prompt.length >= cfg.route.minPromptChars

  const questions = {}
  notes.forEach((_, i) => {
    questions[`note_${i}`] = {
      type: 'noul',
      instructions: `Would an engineer carrying out \`request\` need to read \`notes[${i}]\` first?`,
      criteria: {
        true: 'The note documents a convention, system, or decision the request touches',
        false: 'The note is about an unrelated area of the project',
      },
    }
  })
  if (wantRoute) {
    questions.route = {
      type: 'choice',
      instructions: 'Who should carry out `request`?',
      criteria: {
        main: 'Needs design judgment, debugging with an unknown cause, coordinated changes across several files, ambiguous requirements, or discussion with the user',
        fast_worker: 'Mechanical and fully specified: a rename, reformat, small well-defined function, lookup, running a command and reporting, or boilerplate',
      },
    }
  }

  const state = { request: prompt.slice(0, 6000), notes: notes.map(n => ({ path: n.path, title: n.title, preview: n.preview })) }
  const res = await ask(state, questions, cfg)
  if (!res?.answers) return log({ decision: 'prompt', harness, session: input.session_id, skipped: res?.error || 'no backend' })

  const picked = notes
    .map((n, i) => ({ ...n, p: res.answers[`note_${i}`]?.noul ?? 0 }))
    .filter(n => n.p >= cfg.notes.threshold)
    .sort((a, b) => b.p - a.p)
    .slice(0, cfg.notes.maxPick)

  const route = res.answers.route
  const delegate = route?.choice === 'fast_worker' && route.confidence >= cfg.route.threshold

  log({
    decision: 'prompt', harness, session: input.session_id, ms: res.ms, backend: res.backend, mode: cfg.mode,
    candidates: notes.length, picked: picked.map(n => [n.path, round(n.p)]),
    route: route && { choice: route.choice, confidence: round(route.confidence) }, delegate,
  })
  if (cfg.mode === 'shadow') return

  const parts = []
  if (picked.length) {
    parts.push('jev-relay selected these project notes as relevant to this request:')
    for (const n of picked) {
      parts.push(`\n<note path="${n.path}" relevance="${round(n.p)}">\n${readFileSync(n.abs, 'utf8').slice(0, cfg.notes.maxCharsEach)}\n</note>`)
    }
  }
  if (delegate) {
    parts.push(harness === 'claude'
      ? `\njev-relay routing (confidence ${round(route.confidence)}): this request looks mechanical and fully specified. Delegate the implementation to the \`jev-relay:fast-worker\` subagent with the Agent tool, then review its result yourself. If it is not actually mechanical, ignore this hint.`
      : `\njev-relay routing (confidence ${round(route.confidence)}): this request looks mechanical and fully specified. Keep reasoning minimal and, if subagents are available, hand it to one on a smaller model and review the result. If it is not actually mechanical, ignore this hint.`)
  }
  if (parts.length) emitContext('UserPromptSubmit', parts.join('\n'))
}

function collectNotes(cwd, opts) {
  const out = []
  for (const dir of opts.dirs) {
    const root = join(cwd, dir)
    let entries
    try { entries = readdirSync(root, { recursive: true }) } catch { continue }
    for (const rel of entries) {
      const abs = join(root, rel)
      if (!TEXT_EXT.has(extname(abs)) || String(rel).includes('node_modules')) continue
      try { if (!statSync(abs).isFile()) continue } catch { continue }
      const text = readFileSync(abs, 'utf8')
      out.push({
        abs,
        path: relative(cwd, abs),
        title: text.match(/^#\s+(.+)$/m)?.[1] || basename(abs),
        preview: text.replace(/\s+/g, ' ').slice(0, 300),
      })
      if (out.length >= opts.maxCandidates) return out
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 2b. PreToolUse on the Agent tool (Claude Code): pick the subagent's model.
const MODEL_OPTIONS = {
  haiku: 'Searching, reading and summarizing files, or mechanical edits with exact instructions',
  sonnet: 'Ordinary implementation or investigation with a clear goal',
  opus: 'Open-ended design, subtle debugging, security-sensitive work, or anything where a wrong answer is costly',
}

export async function onSubagent(input, cfg, harness) {
  const ti = input.tool_input || {}
  if (!cfg.subagentModel.enabled || ti.model || ti.subagent_type === 'fork' || !ti.prompt) return

  const res = await ask(
    { task: ti.description || '', instructions: ti.prompt.slice(0, 8000), agent_type: ti.subagent_type || 'general-purpose' },
    { model: { type: 'choice', instructions: 'Which model tier is the cheapest one that can reliably do `instructions`?', criteria: MODEL_OPTIONS } },
    cfg,
  )
  const a = res?.answers?.model
  const act = !!a && a.confidence >= cfg.subagentModel.threshold
  log({ decision: 'subagent', harness, session: input.session_id, ms: res?.ms, choice: a?.choice, confidence: round(a?.confidence), act, error: res?.error })
  if (!act || cfg.mode === 'shadow') return
  emitUpdatedInput({ ...ti, model: a.choice }, `jev-relay set this subagent's model to ${a.choice} (confidence ${round(a.confidence)}).`)
}

// ---------------------------------------------------------------------------
// 3. Tool failure: choose a recovery path.
const RECOVERY = {
  retry: ['Transient: network timeout, rate limit, lock held by another process, or a known-flaky step', 'Rerun the same command once, unchanged. If it fails again, treat it as not transient.'],
  fix_invocation: ['The command itself is wrong: typo, wrong flag, wrong path or working directory, or wrong script name', 'Correct the invocation (check `--help`, package.json scripts, or the path) instead of changing code.'],
  missing_dependency: ['A tool, package, module, or binary is not installed or not built', 'Install or build the missing dependency with the project\'s package manager, then rerun.'],
  inspect_first: ['The error points at code or config that must be read before fixing: stack trace, failing assertion, compile or type error', 'Read the file and lines the error names before editing anything. Do not guess at a fix.'],
  ask_user: ['Needs credentials, permissions, paid resources, or a decision only the user can make', 'Stop and ask the user. Do not work around auth or permission errors.'],
  change_approach: ['The approach is blocked, and further variations of the same command will not help', 'Step back and choose a different approach. Explain briefly why the current one is blocked.'],
}

export async function onFailure(input, cfg, harness) {
  if (!cfg.recover.enabled || input.is_interrupt) return
  const error = failureText(input, harness)
  if (!error) return

  const command = input.tool_input?.command || JSON.stringify(input.tool_input || {}).slice(0, 500)
  const s = sessionState(input.session_id)
  const key = createHash('sha1').update(command).digest('hex').slice(0, 12)
  s.state.failures ||= {}
  s.state.failures[key] = (s.state.failures[key] || 0) + 1
  s.save()

  const criteria = Object.fromEntries(Object.entries(RECOVERY).map(([k, [desc]]) => [k, desc]))
  const res = await ask(
    { tool: input.tool_name, command, error: error.slice(-3000), times_this_exact_command_failed: s.state.failures[key] },
    { path: { type: 'choice', instructions: 'Given `error`, what is the best next step after this failed tool call?', criteria } },
    cfg,
  )
  const a = res?.answers?.path
  const act = !!a && a.confidence >= cfg.recover.threshold
  log({ decision: 'recover', harness, session: input.session_id, ms: res?.ms, tool: input.tool_name, choice: a?.choice, confidence: round(a?.confidence), act, error: res?.error })
  if (!act || cfg.mode === 'shadow') return

  const event = harness === 'claude' ? 'PostToolUseFailure' : 'PostToolUse'
  emitContext(event, `jev-relay recovery path: ${a.choice} (confidence ${round(a.confidence)}). ${RECOVERY[a.choice][1]}`)
}

// Claude Code has a dedicated failure event with `error`. Codex runs PostToolUse for
// every call, so detect failure from the response ourselves.
function failureText(input, harness) {
  if (harness === 'claude') return input.error || ''
  const r = input.tool_response
  if (r == null) return ''
  if (typeof r === 'object') {
    const code = r.exit_code ?? r.exitCode ?? r.metadata?.exit_code
    const out = [r.stderr, r.output, r.stdout].filter(Boolean).join('\n')
    return code && code !== 0 ? `Exit code ${code}\n${out}` : ''
  }
  const text = String(r)
  return /(exit code|exited with code|Process exited with code)[:\s]+[1-9]/i.test(text) ? text : ''
}

// ---------------------------------------------------------------------------
// 4. Stop: run the tests Jev thinks the change touches before the turn ends.
export async function onStop(input, cfg, harness) {
  const c = cfg.checks
  if (!c.enabled || !c.command || input.stop_hook_active) return
  const cwd = input.cwd
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (git('rev-parse', '--is-inside-work-tree').status !== 0) return

  const changed = [
    ...git('diff', '--name-only', 'HEAD').stdout.split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').stdout.split('\n'),
  ].filter(Boolean)
  if (!changed.length) return

  const diff = git('diff', 'HEAD').stdout
  const fingerprint = createHash('sha1').update(diff + changed.join('\n')).digest('hex')
  const s = sessionState(input.session_id)
  if (s.state.checkedFingerprint === fingerprint) return
  if ((s.state.checkBlocks || 0) >= c.maxBlocks) return

  const isTest = f => /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/i.test(f)
  const tracked = git('ls-files').stdout.split('\n').filter(isTest)
  const candidates = preRank([...new Set([...tracked, ...changed.filter(isTest)])], changed).slice(0, c.maxCandidates)
  if (!candidates.length) return

  const questions = {}
  candidates.forEach((_, i) => {
    questions[`t_${i}`] = {
      type: 'noul',
      instructions: `Could the change in \`diff\` break a behavior that \`tests[${i}]\` verifies?`,
      criteria: { true: 'The test exercises code the diff modifies or depends on', false: 'The test covers unrelated code' },
    }
  })
  const res = await ask({ changed_files: changed, diff: diff.slice(0, 12000), tests: candidates }, questions, cfg)
  if (!res?.answers) return

  // Changed test files always run; the rest are Jev's picks.
  const picked = candidates
    .map((t, i) => ({ t, p: changed.includes(t) ? 1 : res.answers[`t_${i}`]?.noul ?? 0 }))
    .filter(x => x.p >= c.threshold)
    .sort((a, b) => b.p - a.p)
    .slice(0, c.maxTests)
    .map(x => x.t)

  const entry = { decision: 'checks', harness, session: input.session_id, ms: res.ms, candidates: candidates.length, picked }
  if (!picked.length || cfg.mode === 'shadow') {
    s.state.checkedFingerprint = fingerprint
    s.save()
    return log(entry)
  }

  const cmd = c.command.replace('{files}', picked.map(shellQuote).join(' '))
  const run = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: c.timeoutMs })
  s.state.checkedFingerprint = fingerprint
  log({ ...entry, cmd, exit: run.status })

  if (run.status === 0) return s.save()
  s.state.checkBlocks = (s.state.checkBlocks || 0) + 1
  s.save()
  const tail = `${run.stdout || ''}\n${run.stderr || ''}`.trim().slice(-4000)
  emitBlock(`jev-relay ran the focused tests for your change and they failed.\n$ ${cmd}\n${tail}\n\nFix these before finishing, then run the full suite.`)
}

// Cheap code-side ranking so Jev only sees plausible candidates: shared path tokens.
function preRank(tests, changed) {
  const tokens = f => new Set(f.toLowerCase().split(/[/._-]+/).filter(t => t.length > 2 && !['test', 'tests', 'spec', 'src', 'lib', 'index'].includes(t)))
  const changedTokens = new Set(changed.flatMap(f => [...tokens(f)]))
  return tests
    .map(t => ({ t, s: [...tokens(t)].filter(x => changedTokens.has(x)).length }))
    .sort((a, b) => b.s - a.s)
    .map(x => x.t)
}

function stripPasteMarkers(s) {
  return s.replace(/^<\/?pasted_content id="[^"]*">$/gm, '')
}

const shellQuote = s => `'${s.replace(/'/g, `'\\''`)}'`
const round = n => (typeof n === 'number' ? Math.round(n * 100) / 100 : n)
