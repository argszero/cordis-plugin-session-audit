/**
 * Container tests: the Zstandard half of the audit.
 *
 * Every fixture here is built with the harness's own frame options —
 * `zstdCompressSync` with `ZSTD_c_checksumFlag` — and assembled the way the
 * backend assembles them: several independently compressed frames concatenated
 * into one artifact. Nothing is hand-written JSON standing in for a container.
 *
 * The first test records the reason this module exists at all. Node's
 * `zstdDecompressSync` accepts a concatenated buffer and decodes **only the
 * first frame**, with no error: a one-shot decode of a real session artifact
 * silently returns the header batch and drops every later batch. An audit built
 * on it would report a badly truncated session as clean. Per-frame scanning is
 * therefore not an optimization, it is the difference between a correct verdict
 * and a confidently wrong one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import {
  ZstdStructureError, decodeZstdArtifact, looksLikeZstd, scanZstdFrames, zstdDecodeSupported,
} from '../lib/zstd.js'
import { auditSessionArtifact, formatAudit } from '../lib/audit.js'

const FRAME_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }

/** Compress one independently decodable, checksummed frame, as the backend does. */
function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'), FRAME_OPTIONS)
}

/** Concatenate per-batch frames into one artifact, as the backend appends them. */
function container(...texts) {
  return Buffer.concat(texts.map(frame))
}

const HEADER = `${JSON.stringify({ type: 'session', id: 'sess-1', version: 0, seedLength: 0 })}\n`
const evt = (type, seq, data) => `${JSON.stringify({ type, seq, time: 1000 + seq, data })}\n`

// --------------------------------------------------------------- the flat spot

test('a one-shot decode of a concatenated container loses every frame but the first', () => {
  const artifact = container('batch-one\n', 'batch-two\n', 'batch-three\n')

  // The naive call: no error, wrong answer. This is the trap the module avoids.
  const naive = zlib.zstdDecompressSync(artifact).toString('utf8')
  assert.equal(naive, 'batch-one\n')
  assert.ok(!naive.includes('batch-two'), 'the naive decode silently dropped later batches')

  // The scanner sees all three, and the decoder returns all three.
  assert.equal(scanZstdFrames(artifact).frames.length, 3)
  assert.equal(decodeZstdArtifact(artifact).text, 'batch-one\nbatch-two\nbatch-three\n')
})

// --------------------------------------------------------------- happy paths

test('looksLikeZstd recognises the container and rejects plaintext', () => {
  assert.equal(looksLikeZstd(container('x\n')), true)
  assert.equal(looksLikeZstd(Buffer.from(HEADER, 'utf8')), false)
  assert.equal(looksLikeZstd(Buffer.alloc(2)), false)
})

test('a healthy compressed session audits identically to its plaintext twin', () => {
  const body =
    evt('turn/start', 0, { turn: 1 })
    + evt('tool/call', 1, { callId: 'c1', name: 'read' })
    + evt('tool/result', 2, { callId: 'c1' })
    + evt('turn/end', 3, { turn: 1 })
  const artifact = container(HEADER, body)

  const compressed = auditSessionArtifact(artifact, 'sess.jsonl.zstd')
  const plain = auditSessionArtifact(Buffer.from(HEADER + body, 'utf8'), 'sess.jsonl')

  assert.equal(compressed.container, 'zstd')
  assert.equal(plain.container, undefined)
  assert.equal(compressed.frameCount, 2)
  assert.equal(compressed.sessionId, 'sess-1')
  assert.equal(compressed.eventCount, plain.eventCount)
  assert.deepEqual(
    compressed.findings.map(f => f.code),
    plain.findings.map(f => f.code),
    'container choice must not change the findings',
  )
  assert.equal(compressed.needsManual, false)
})

test('byteLength reports the file on disk, not the decoded plaintext', () => {
  const body = evt('turn/start', 0, { turn: 1 }) + evt('turn/end', 1, { turn: 1 })
  const artifact = container(HEADER, body)
  const audit = auditSessionArtifact(artifact, 'sess.jsonl.zstd')

  assert.equal(audit.byteLength, artifact.length)
  assert.ok(audit.byteLength !== (HEADER + body).length, 'compressed and plaintext sizes differ here')
})

test('an event split across frames is still contiguous after decoding', () => {
  // A frame boundary in the middle of the event stream must not read as a gap.
  const artifact = container(HEADER, evt('turn/start', 0, { turn: 1 }), evt('turn/end', 1, { turn: 1 }))
  const audit = auditSessionArtifact(artifact, 'sess.jsonl.zstd')
  assert.deepEqual(audit.findings.map(f => f.code), [])
  assert.equal(audit.frameCount, 3)
})

test('every frame-header variant the compressor emits is parsed', () => {
  // Payload size changes the frame header: `contentSizeFlag` widens the
  // content-size field, and above the window limit `singleSegment` clears and a
  // window-descriptor byte appears. A session log that crosses those thresholds
  // must not become unreadable to the audit — so each variant is exercised
  // against its own payload, and each frame is decoded to verify the scan
  // measured the frame correctly rather than merely not throwing.
  for (const size of [10, 200, 5000, 200_000]) {
    const body = 'x'.repeat(size)
    const artifact = Buffer.concat([frame(body), frame('tail')])
    const { frames } = scanZstdFrames(artifact)
    assert.equal(frames.length, 2, `payload ${size}: frame boundary not found`)
    const decoded = decodeZstdArtifact(artifact)
    assert.equal(decoded.text, `${body}tail`, `payload ${size}: decoded text differs`)
  }
})

// ------------------------------------------------- the boot-abort class (#7161)

test('a null-filled artifact reports the boot-aborting structural defect', () => {
  // Discussion #7161, matrix row 2: a file-recovery tool wrote a session log as
  // all-null, and `dsh web` could not start at all.
  const audit = auditSessionArtifact(Buffer.alloc(4096, 0), 'sess.jsonl.zstd')

  assert.equal(audit.needsManual, true)
  assert.equal(audit.findings.length, 1)
  const [finding] = audit.findings
  assert.equal(finding.code, 'UNREADABLE_ARTIFACT')
  assert.equal(finding.severity, 'error')
  assert.equal(finding.at, 0)
  assert.match(finding.detail, /invalid frame magic at byte 0/)
  // The detail has to say what the consequence is, and what to do about it.
  assert.match(finding.detail, /aborts/)
  assert.match(finding.detail, /move the file out of the sessions root/)
})

test('a damaged magic in a later frame is located precisely', () => {
  // #7161 matrix row 5: the first frame's magic is damaged. Here it is the
  // second frame, so the offset has to be the frame start, not 0.
  const artifact = container(HEADER, evt('turn/start', 0, { turn: 1 }))
  const firstEnd = scanZstdFrames(artifact).frames[0].end
  artifact[firstEnd] = 0x00

  const audit = auditSessionArtifact(artifact, 'sess.jsonl.zstd')
  assert.equal(audit.needsManual, true)
  assert.equal(audit.findings[0].code, 'UNREADABLE_ARTIFACT')
  assert.equal(audit.findings[0].at, firstEnd)
  assert.match(audit.findings[0].detail, new RegExp(`invalid frame magic at byte ${firstEnd}`))
})

test('a reserved frame-header bit rejects as structural damage', () => {
  const artifact = container(HEADER, evt('turn/start', 0, { turn: 1 }))
  const firstEnd = scanZstdFrames(artifact).frames[0].end
  artifact[firstEnd + 4] |= 0x08 // reserved bit in the second frame's descriptor

  assert.throws(
    () => scanZstdFrames(artifact),
    (error) => error instanceof ZstdStructureError && /reserved frame-header bit/.test(error.message),
  )
  assert.equal(auditSessionArtifact(artifact, 'sess.jsonl.zstd').needsManual, true)
})

test('a reserved block type rejects as structural damage', () => {
  const artifact = container(HEADER)
  // Descriptor at byte 4; walk its optional fields to reach the first block header.
  const descriptor = artifact.readUInt8(4)
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const dictionaryBytes = (descriptor & 0x03) === 3 ? 4 : (descriptor & 0x03)
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const blockAt = 4 + 1 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  const header = artifact.readUIntLE(blockAt, 3)
  artifact.writeUIntLE((header & ~0x06) | 0x06, blockAt, 3) // blockType = 0x03

  assert.throws(
    () => scanZstdFrames(artifact),
    (error) => error instanceof ZstdStructureError && /reserved block type/.test(error.message),
  )
})

test('an intact container whose frame fails validation is not mislabelled structural', () => {
  const artifact = container(HEADER, evt('turn/start', 0, { turn: 1 }))
  const { frames } = scanZstdFrames(artifact)
  // Corrupt a compressed payload byte inside the second frame's block, leaving
  // the frame structure intact: the scan succeeds, the decode must not.
  artifact[frames[1].start + frames[1].end - frames[1].start - 5] ^= 0xFF

  const audit = auditSessionArtifact(artifact, 'sess.jsonl.zstd')
  // Either the checksum catches it (UNDECODABLE_FRAME) or the entropy decode
  // produces different bytes that no longer parse as events. Both are honest
  // outcomes; what must never happen is a silent "clean" verdict on a damaged
  // frame, and it must never be reported as a structural (boot-aborting) defect.
  assert.notEqual(audit.findings[0]?.code, 'UNREADABLE_ARTIFACT')
  if (audit.findings.some(f => f.code === 'UNDECODABLE_FRAME')) {
    assert.equal(audit.needsManual, true)
  }
})

// --------------------------------------------------------------- the crash tail

test('a torn final frame is reported as a tolerated crash tail, not as fatal', () => {
  // #7161 matrix row 3: a half-truncated file starts normally. The harness
  // recovers this class, so calling it fatal would be a false alarm.
  const full = container(HEADER, evt('turn/start', 0, { turn: 1 }))
  const artifact = full.subarray(0, full.length - 6)

  const { frames, tornStart } = scanZstdFrames(artifact)
  assert.equal(frames.length, 1)
  assert.equal(tornStart, frames[0].end)

  const audit = auditSessionArtifact(artifact, 'sess.jsonl.zstd')
  const torn = audit.findings.find(f => f.code === 'TORN_FINAL_FRAME')
  assert.ok(torn, 'the torn tail must be reported')
  assert.equal(torn.severity, 'info')
  assert.equal(audit.needsManual, false, 'a crash tail is recoverable and must not read as fatal')
  assert.ok(audit.tornBytes > 0)
  assert.match(torn.detail, /not the class that aborts a boot/)
})

test('plaintext recovery from a torn tail is best-effort and never fatal', () => {
  const decoded = decodeZstdArtifact(container(HEADER, evt('turn/start', 0, { turn: 1 })).subarray(0, 60))
  assert.ok(decoded.tornBytes >= 0)
  assert.doesNotThrow(() => decodeZstdArtifact(container(HEADER).subarray(0, 30)))
})

// --------------------------------------------------------------- reporting

test('the report names the container and the frame count', () => {
  const artifact = container(HEADER, evt('turn/start', 0, { turn: 1 }))
  const text = formatAudit(auditSessionArtifact(artifact, 'sess.jsonl.zstd'))
  assert.match(text, /zstd · 2 frame\(s\)/)
  assert.match(text, /sess-1/)
})

test('an empty artifact is not corruption: the harness skips it', () => {
  // #7161 matrix row 6: an empty file starts normally. `readFirstZstdLine`
  // returns undefined on EOF and listing skips the entry, so reporting this as
  // needing manual attention would be a false alarm on a healthy machine.
  for (const name of ['sess.jsonl.zstd', 'sess.jsonl']) {
    const audit = auditSessionArtifact(Buffer.alloc(0), name)
    assert.equal(audit.findings[0]?.code, 'EMPTY_ARTIFACT')
    assert.equal(audit.findings[0]?.severity, 'info')
    assert.equal(audit.needsManual, false, `${name} must not read as corruption`)
  }
})

test('a mislabelled artifact is judged by its name, as the harness judges it', () => {
  // The harness selects the container from its compression configuration, not
  // by sniffing the bytes, so a `.jsonl.zstd` file holding plaintext fails the
  // same way an all-null one does: the frame magic is not there.
  const audit = auditSessionArtifact(Buffer.from(HEADER, 'utf8'), 'sess.jsonl.zstd')
  assert.equal(audit.findings[0]?.code, 'UNREADABLE_ARTIFACT')
  assert.equal(audit.needsManual, true)
})

test('zstd support is reported honestly for the running runtime', () => {
  assert.equal(typeof zstdDecodeSupported(), 'boolean')
  assert.equal(zstdDecodeSupported(), true, 'Node >= 22.15 provides zstdDecompressSync')
})
