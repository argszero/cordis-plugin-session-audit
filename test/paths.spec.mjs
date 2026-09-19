/**
 * Path-identity tests: matrix row 4 of discussion #7161.
 *
 * The backend refuses to read an artifact that is not where its own header says
 * it is (`assertStoredIdentity` →
 * `corrupt session log "…": header id "…" and cwd identify "…"`), and in
 * `0.1.6-alpha.2` that refusal escapes the artifact listing and takes the whole
 * application boot down. The audit predicts it by re-deriving the location the
 * way the backend derives it.
 *
 * The derivation is *the* thing under test, so it is not tested against itself:
 * the first test loads the harness's own implementation when a checkout is
 * available and compares both functions over a corpus of awkward inputs
 * (separators, escapes, Unicode, long names, reserved dot names). When no
 * checkout is present the test skips rather than asserting a copy against a
 * copy — a green tick over two identical-but-both-wrong implementations is
 * worse than a skip.
 *
 * The remaining tests drive the finding through `auditSessionLog`, so what is
 * exercised is the finding a user sees, not just the helper.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { auditSessionArtifact, auditSessionLog } from '../lib/audit.js'
import { encodeSegment, expectedProjectDirName, projectKey } from '../lib/paths.js'

const HARNESS = process.env.DSH_CHECKOUT
  ?? '/Users/argszero/scm/github.com/deepseek-ai/deepseek-harness'

const FORMAT_TS = path.join(
  HARNESS, 'packages/session/session-persistence-jsonl/src/format.ts',
)

/**
 * Cut one top-level function out of the harness source, verbatim.
 *
 * The checkout ships TypeScript with no build output and unresolved workspace
 * imports, so the file cannot simply be imported. Slicing the function text out
 * and evaluating it as-is keeps the oracle honest: what runs is the harness's
 * own source, not a paraphrase of it. If the text stops looking the way this
 * expects, extraction throws and the test fails — it never degrades into
 * "compared nothing, passed".
 */
function extractFunction(source, name) {
  const start = source.indexOf(`export function ${name}(`)
  assert.notEqual(start, -1, `${name} is no longer a top-level export of format.ts`)
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, `no body found for ${name}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1).replace('export function', 'function')
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`)
}

/** The harness's own `encodeSegment`/`projectKey`, loaded from its source. */
async function harnessFormat() {
  if (!fs.existsSync(FORMAT_TS)) return undefined
  const source = fs.readFileSync(FORMAT_TS, 'utf8')
  const body = [
    extractFunction(source, 'encodeSegment'),
    extractFunction(source, 'projectKey'),
  ].join('\n\n')
  // The slice is still TypeScript; Node strips the annotations itself. The
  // harness checkout is read-only to this task, so the scratch file goes to the
  // OS temp directory: the snippet has no relative imports, and `format.ts`
  // stays the single source of truth — nothing is copied into this repository.
  const scratch = path.join(os.tmpdir(), `session-audit-oracle-${process.pid}.ts`)
  fs.writeFileSync(scratch, `${body}\nexport { encodeSegment, projectKey }\n`)
  try {
    const mod = await import(pathToFileURL(scratch).href)
    return { encodeSegment: mod.encodeSegment, projectKey: mod.projectKey }
  } finally {
    fs.rmSync(scratch, { force: true })
  }
}

const CORPUS = [
  'simple',
  'with-dash-and_underscore',
  'a b',
  'a/b',
  'a\\b',
  'C:',
  'C:\\Users\\x',
  '/Users/argszero/scm/github.com',
  '~tilde',
  'a~b',
  '.',
  '..',
  '..~..~',
  '\u00e9t\u00e9',
  '\u4f60\u597d\u4e16\u754c',
  '\ud83d\ude00emoji',
  'a'.repeat(300),
  'x'.repeat(251) + '/tail',
  '_no-cwd',
  '(unreadable container)',
  'tab\there',
  'new\nline',
]

test('encodeSegment agrees with the harness implementation over the corpus', async (t) => {
  const format = await harnessFormat()
  if (!format) {
    t.skip(`no harness checkout at ${HARNESS} — nothing to compare against`)
    return
  }
  assert.equal(typeof format.encodeSegment, 'function')
  for (const raw of CORPUS) {
    if (raw.length === 0) continue
    assert.equal(
      encodeSegment(raw), format.encodeSegment(raw),
      `encodeSegment disagrees for ${JSON.stringify(raw)}`,
    )
  }
})

test('projectKey agrees with the harness implementation over the corpus', async (t) => {
  const format = await harnessFormat()
  if (!format) {
    t.skip(`no harness checkout at ${HARNESS} — nothing to compare against`)
    return
  }
  assert.equal(typeof format.projectKey, 'function')
  for (const raw of CORPUS) {
    if (raw.length === 0) continue
    assert.equal(
      projectKey(raw), format.projectKey(raw),
      `projectKey disagrees for ${JSON.stringify(raw)}`,
    )
  }
})

test('the no-cwd bucket is selected only for an absent cwd', () => {
  assert.equal(expectedProjectDirName(undefined), '_no-cwd')
  // An empty cwd has no derivable name: the backend refuses the whole path, and
  // inventing an expectation here would be a fabricated finding.
  assert.equal(expectedProjectDirName(''), undefined)
  assert.equal(expectedProjectDirName('/tmp/x'), projectKey('/tmp/x'))
})

// ------------------------------------------------------------- end to end

const header = (over = {}) => `${JSON.stringify({
  type: 'session', id: 'sess-1', version: 0, seedLength: 0, cwd: '/tmp/proj', ...over,
})}\n`
const event = (seq) => `${JSON.stringify({ type: 'turn/start', seq, time: 1000 + seq, data: {} })}\n`

test('an artifact in its identified directory raises no path finding', () => {
  const dir = encodeSegment('sess-1')
  const proj = projectKey('/tmp/proj')
  const audit = auditSessionLog(
    Buffer.from(header() + event(0)), `/root/${proj}/${dir}/session.jsonl`,
  )
  assert.equal(audit.findings.filter(f => f.code.endsWith('PATH_MISMATCH')).length, 0)
})

test('a renamed session directory raises SESSION_PATH_MISMATCH and needs manual attention', () => {
  const proj = projectKey('/tmp/proj')
  const audit = auditSessionLog(
    Buffer.from(header() + event(0)), `/root/${proj}/session-sess-1/session.jsonl`,
  )
  const found = audit.findings.find(f => f.code === 'SESSION_PATH_MISMATCH')
  assert.ok(found, 'expected SESSION_PATH_MISMATCH')
  assert.equal(found.severity, 'error')
  assert.match(found.detail, /session-sess-1/)
  assert.match(found.detail, new RegExp(encodeSegment('sess-1')))
  assert.equal(audit.needsManual, true)
})

test('a relocated project directory is only a warning', () => {
  const dir = encodeSegment('sess-1')
  const audit = auditSessionLog(
    Buffer.from(header() + event(0)), `/root/--somewhere-else--/${dir}/session.jsonl`,
  )
  const found = audit.findings.find(f => f.code === 'PROJECT_PATH_MISMATCH')
  assert.ok(found, 'expected PROJECT_PATH_MISMATCH')
  assert.equal(found.severity, 'warn')
  assert.equal(audit.findings.some(f => f.code === 'SESSION_PATH_MISMATCH'), false)
  // An advisory finding must not escalate the whole artifact.
  assert.equal(audit.needsManual, false)
})

test('the check survives a shallow path and an unreadable header', () => {
  // Only a filename is known: nothing to compare, and nothing invented.
  const shallow = auditSessionLog(Buffer.from(header() + event(0)), 'session.jsonl')
  assert.equal(shallow.findings.some(f => f.code.endsWith('PATH_MISMATCH')), false)

  // No header at all: the missing header is the finding, not a path verdict.
  const headless = auditSessionLog(
    Buffer.from(`not a header\n`), '/root/--x--/wrong-name/session.jsonl',
  )
  assert.equal(headless.findings.some(f => f.code.endsWith('PATH_MISMATCH')), false)
  assert.ok(headless.findings.some(f => f.code === 'HEADER_MISSING'))
})

test('the check reaches the zstd container too', () => {
  const zlib = globalThis.process.getBuiltinModule('node:zlib')
  const bytes = zlib.zstdCompressSync(Buffer.from(header() + event(0), 'utf8'))
  const proj = projectKey('/tmp/proj').toString()
  const audit = auditSessionArtifact(bytes, `/root/${proj}/wrong/session.jsonl.zstd`)
  assert.equal(audit.container, 'zstd')
  assert.ok(audit.findings.some(f => f.code === 'SESSION_PATH_MISMATCH'))
})

test('an empty-cwd header compares against the no-cwd bucket', () => {
  const dir = encodeSegment('sess-1')
  const audit = auditSessionLog(
    Buffer.from(header({ cwd: undefined }) + event(0)),
    `/root/--whatever--/${dir}/session.jsonl`,
  )
  const found = audit.findings.find(f => f.code === 'PROJECT_PATH_MISMATCH')
  assert.ok(found, 'expected PROJECT_PATH_MISMATCH against _no-cwd')
  assert.match(found.detail, /_no-cwd/)
})
