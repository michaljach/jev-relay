// Thin client for TypeSafe's System One endpoint (Jev).
// Backends: "http" (TYPESAFE_API_KEY set), "mock" (JEV_RELAY_BACKEND=mock), or none.
// Every failure resolves to null so callers can fail open.
import { readFileSync } from 'node:fs'

const ENDPOINT = process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1/systemone'

export function backend() {
  if (process.env.JEV_RELAY_BACKEND === 'mock') return 'mock'
  if (process.env.TYPESAFE_API_KEY) return 'http'
  return null
}

export async function ask(state, questions, { model = 'jev-latest', timeoutMs = 2500 } = {}) {
  const kind = backend()
  if (!kind || Object.keys(questions).length === 0) return null
  const started = Date.now()
  try {
    const res = kind === 'mock'
      ? mock(questions)
      : await http({ state, model, questions }, timeoutMs)
    return res && { ...res, ms: Date.now() - started, backend: kind }
  } catch (err) {
    return { error: String(err?.message || err), ms: Date.now() - started, backend: kind, answers: null }
  }
}

async function http(body, timeoutMs) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`typesafe ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

// Canned answers for tests: JEV_RELAY_MOCK points at {"<question id>": <answer>}.
// Unlisted questions get a neutral answer (noul 0.5, first choice at 0.5 confidence).
function mock(questions) {
  let canned = {}
  if (process.env.JEV_RELAY_MOCK) canned = JSON.parse(readFileSync(process.env.JEV_RELAY_MOCK, 'utf8'))
  const answers = {}
  for (const [id, q] of Object.entries(questions)) {
    if (canned[id] !== undefined) {
      answers[id] = typeof canned[id] === 'object' ? { type: q.type, ...canned[id] } : { type: q.type, [q.type]: canned[id] }
      if (q.type === 'choice' && answers[id].confidence === undefined) answers[id].confidence = 0.9
    } else if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: 0.5 }
    } else if (q.type === 'choice') {
      answers[id] = { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 0.5 }
    } else {
      answers[id] = { type: 'score', score: 0, confidence: 0.5 }
    }
  }
  return { model: 'mock', answers, usage: { input_tokens: 0, output_tokens: 0 } }
}
