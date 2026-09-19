/**
 * End-to-end CLI test: a real sessions root, in the shape the harness writes.
 *
 * The unit tests above prove the engine's classification. This one proves the
 * thing a user actually runs — `session-audit <root>` — finds every artifact,
 * reports the boot-aborting one by name, and exits non-zero so it can gate a
 * launch. The tree mirrors `$DSH_HOME/sessions/<project>/<session-id>/`, and
 * the artifacts are written by the real compressor with real session content.
 *
 * Before 0.1.4 the walk accepted only `.jsonl`, so on a machine with compression
 * enabled it found nothing at all and printed "No .jsonl session logs found" —
 * the exact machine that has the corruption.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'session-audit.mjs')
const FRAME_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }

const frame = text => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), FRAME_OPTIONS)
const evt = (type, seq, data) => `${JSON.stringify({ type, seq, time: 1000 + seq, data })}\n`
const header = id => `${JSON.stringify({ type: 'session', id, version: 0, seedLength: 0 })}\n`

/** Invoke the CLI and capture its exit code rather than throwing. */
async function cliExit(args) {
  try {
    const { stdout } = await run(process.execPath, [cli, ...args])
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '' }
  }
}

test('the CLI finds, reports and gates on a real sessions tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-audit-e2e-'))
  try {
    const project = join(root, 'project-a')

    // 1. A healthy compressed session.
    const healthy = join(project, 'session-healthy')
    await mkdir(healthy, { recursive: true })
    await writeFile(join(healthy, 'session.jsonl.zstd'), Buffer.concat([
      frame(header('healthy-1')),
      frame(evt('turn/start', 0, { turn: 1 })),
      frame(evt('turn/end', 1, { turn: 1 })),
    ]))

    // 2. The #7161 artifact: a session log a file-recovery tool wrote as all-null.
    const broken = join(project, 'session-broken')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'session.jsonl.zstd'), Buffer.alloc(2048, 0))

    const result = await cliExit([root])

    assert.ok(
      result.stdout.includes('session-healthy'),
      'the compressed healthy session must be found by the walk',
    )
    assert.ok(
      result.stdout.includes('session-broken'),
      'the compressed broken session must be found by the walk',
    )
    assert.match(result.stdout, /UNREADABLE_ARTIFACT/)
    assert.match(result.stdout, /invalid frame magic at byte 0/)
    assert.match(result.stdout, /sessions scanned: 2/)
    assert.match(result.stdout, /clean: 1 · needs-manual: 1/)
    assert.equal(result.code, 1, 'a boot-aborting artifact must make the CLI exit non-zero')

    // 3. The same root with the broken artifact removed gates clean.
    await rm(broken, { recursive: true })
    const clean = await cliExit([root])
    assert.equal(clean.code, 0)
    assert.match(clean.stdout, /clean: 1 · needs-manual: 0/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the CLI --id filter narrows to the artifact that matters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-audit-id-'))
  try {
    const project = join(root, 'project-a')
    for (const id of ['alpha', 'beta']) {
      const dir = join(project, `session-${id}`)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'session.jsonl.zstd'), Buffer.concat([
        frame(header(`${id}-1`)),
        frame(evt('turn/start', 0, { turn: 1 })),
        frame(evt('turn/end', 1, { turn: 1 })),
      ]))
    }
    const result = await cliExit([root, '--id', 'beta'])
    assert.ok(result.stdout.includes('beta-1'))
    assert.ok(!result.stdout.includes('alpha-1'), 'the filter must exclude the other session')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
