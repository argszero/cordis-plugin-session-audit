/**
 * Dependency-free Zstandard reader for stored session logs.
 *
 * The harness's JSONL backend does not store one Zstandard frame per file: it
 * owns a **concatenated-frame container**, so new durable batches can be
 * appended and a torn tail can be recovered without decompressing the whole
 * artifact (`packages/session/session-persistence-jsonl/src/zstd.ts` upstream).
 * That container shape is what makes corruption *classifiable* here:
 *
 * - a structural defect at a frame boundary (`invalid frame magic`, a reserved
 *   frame-header bit, a reserved block type) aborts the harness's listing pass
 *   and therefore the whole application boot — this is the
 *   [discussion #7161](https://github.com/deepseek-ai/deepseek-harness/discussions/7161)
 *   failure;
 * - an **incomplete final frame** is a crash tail, which the same pass tolerates
 *   (`scanZstdFrames` returns `tornStart` for the repair path) and which must not
 *   be reported as fatal.
 *
 * The structural scan below needs nothing but `Buffer` — no `node:zlib` — so the
 * classification that matters for a pre-boot check works on every supported Node
 * version. Decompression is a separate, optional step; when the running Node has
 * no Zstandard support the audit still reports the structural verdict and says
 * plainly that content could not be read.
 *
 * @module @argszero/cordis-plugin-session-audit/zstd
 */

import nodeZlib from 'node:zlib'

/** The Zstandard frame magic number (`0xFD2FB528`), little-endian on disk. */
const ZSTD_MAGIC = 0xFD2FB528

/** A byte range holding one structurally complete Zstandard frame. */
export interface ZstdFrameRange {
  /** Inclusive frame start. */
  start: number
  /** Exclusive frame end. */
  end: number
}

/** The structural scan result for a concatenated Zstandard artifact. */
export interface ZstdFrameScan {
  /** Complete frames, in file order. */
  frames: ZstdFrameRange[]
  /** Start of an incomplete final frame, when EOF interrupts one. */
  tornStart?: number
}

/**
 * A structural defect in the Zstandard container.
 *
 * `reason` mirrors the upstream wording so a report from this tool can be
 * matched against a harness startup error verbatim.
 */
export class ZstdStructureError extends Error {
  /** The byte offset the defect was found at. */
  readonly offset: number

  /** The defect in the harness's own words. */
  readonly reason: string

  /**
   * @param reason - defect description, matching the harness wording.
   * @param offset - the byte offset the defect was found at.
   */
  constructor(reason: string, offset: number) {
    super(`corrupt Zstandard session log: ${reason} at byte ${offset}`)
    this.name = 'ZstdStructureError'
    this.reason = reason
    this.offset = offset
  }
}

/** True when the artifact begins with a Zstandard frame magic. */
export function looksLikeZstd(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === ZSTD_MAGIC
}

/**
 * Locate complete Zstandard frames without decompressing their blocks.
 *
 * This is a port of the frame-walking half of the harness's `scanZstdFrames`,
 * from the public Zstandard frame format: a frame is a 4-byte magic, a frame
 * header descriptor whose bits select the optional dictionary / content-size /
 * single-segment fields, then blocks until a block marked `last`, then an
 * optional 4-byte checksum. Reserved encodings reject; EOF inside the final
 * frame reports its start instead.
  *
 * @param buffer - the complete bytes currently present in the artifact.
 * @param maxFrames - optional complete-frame limit for header-only readers.
 * @returns the complete frame ranges and an optional torn-final-frame start.
 * @throws ZstdStructureError when a complete frame is structurally invalid.
 */
export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new ZstdStructureError('invalid frame magic', offset)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new ZstdStructureError('reserved frame-header bit', offset - 1)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new ZstdStructureError('reserved block type', offset - 3)
      }
      // A raw block (0x00) and a compressed block (0x02) carry `blockSize`
      // payload bytes; an RLE block (0x01) carries exactly one.
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }

  return { frames }
}

/** Whether the running Node exposes synchronous Zstandard decompression. */
export function zstdDecodeSupported(): boolean {
  return typeof zstdSync() === 'function'
}

/** The synchronous zstd decompressor, or `undefined` on a Node without one. */
function zstdSync(): ((input: Buffer, options?: { finishFlush?: number }) => Buffer) | undefined {
  return (nodeZlib as { zstdDecompressSync?: (input: Buffer, options?: { finishFlush?: number }) => Buffer })
    .zstdDecompressSync
}

/** The outcome of decoding a concatenated Zstandard artifact. */
export interface DecodedZstd {
  /** The concatenated frame plaintext, as UTF-8. */
  text: string
  /** How many complete frames were decoded. */
  frameCount: number
  /** Bytes belonging to an incomplete final frame, `0` when none. */
  tornBytes: number
  /** Plaintext recovered from a torn final frame, when it could be read. */
  tornText?: string
}

/**
 * Decode a concatenated Zstandard artifact into its plaintext.
 *
 * Complete frames are decoded individually, which is both what the container
 * requires and what keeps a torn tail from poisoning the frames before it.
 * A torn final frame is reported in the result rather than thrown, because the
 * harness treats it as recoverable; its partial plaintext is recovered when the
 * running Node supports a flush-terminated decode.
 *
 * A torn tail's plaintext is returned **separately**, never appended to `text`.
 * The tail is not durable content — it ends mid-line by definition — so folding
 * it into the audited stream would report the crash boundary itself as an
 * unparsable committed line.
 *
 * @param bytes - the complete artifact bytes.
 * @returns the decoded plaintext and the container accounting.
 * @throws ZstdStructureError for a structural defect (fatal to the harness).
 * @throws Error when the container is structurally sound but a frame fails to
 *   decode, or when this Node has no Zstandard support.
 */
export function decodeZstdArtifact(bytes: Buffer): DecodedZstd {
  const scan = scanZstdFrames(bytes)
  const sync = zstdSync()
  if (sync === undefined) {
    throw new Error(
      'this Node has no zstdDecompressSync, so the container could not be read '
      + `(${scan.frames.length} frame(s) are structurally intact); Node >= 22.15 provides it`,
    )
  }

  const parts: string[] = []
  for (const frame of scan.frames) {
    let plaintext: Buffer
    try {
      plaintext = sync(bytes.subarray(frame.start, frame.end))
    } catch (error) {
      throw new Error(
        `Zstandard frame at byte ${frame.start} failed validation `
        + `(checksum or entropy decode): ${(error as Error).message}`,
        { cause: error },
      )
    }
    parts.push(plaintext.toString('utf8'))
  }

  let tornBytes = 0
  let tornText: string | undefined
  if (scan.tornStart !== undefined) {
    const tail = bytes.subarray(scan.tornStart)
    tornBytes = tail.length
    try {
      const flush = (nodeZlib.constants as { ZSTD_e_flush?: number }).ZSTD_e_flush ?? 1
      const recovered = sync(tail, { finishFlush: flush })
      if (recovered.length > 0) tornText = recovered.toString('utf8')
    } catch {
      // A torn tail that cannot be flushed is expected at a crash boundary; the
      // structural verdict already stands, so content recovery stays best-effort.
    }
  }

  return { text: parts.join(''), frameCount: scan.frames.length, tornBytes, tornText }
}
