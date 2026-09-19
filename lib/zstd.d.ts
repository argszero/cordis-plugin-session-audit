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
/** A byte range holding one structurally complete Zstandard frame. */
export interface ZstdFrameRange {
    /** Inclusive frame start. */
    start: number;
    /** Exclusive frame end. */
    end: number;
}
/** The structural scan result for a concatenated Zstandard artifact. */
export interface ZstdFrameScan {
    /** Complete frames, in file order. */
    frames: ZstdFrameRange[];
    /** Start of an incomplete final frame, when EOF interrupts one. */
    tornStart?: number;
}
/**
 * A structural defect in the Zstandard container.
 *
 * `reason` mirrors the upstream wording so a report from this tool can be
 * matched against a harness startup error verbatim.
 */
export declare class ZstdStructureError extends Error {
    /** The byte offset the defect was found at. */
    readonly offset: number;
    /** The defect in the harness's own words. */
    readonly reason: string;
    /**
     * @param reason - defect description, matching the harness wording.
     * @param offset - the byte offset the defect was found at.
     */
    constructor(reason: string, offset: number);
}
/** True when the artifact begins with a Zstandard frame magic. */
export declare function looksLikeZstd(bytes: Buffer): boolean;
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
export declare function scanZstdFrames(buffer: Buffer, maxFrames?: number): ZstdFrameScan;
/** Whether the running Node exposes synchronous Zstandard decompression. */
export declare function zstdDecodeSupported(): boolean;
/** The outcome of decoding a concatenated Zstandard artifact. */
export interface DecodedZstd {
    /** The concatenated frame plaintext, as UTF-8. */
    text: string;
    /** How many complete frames were decoded. */
    frameCount: number;
    /** Bytes belonging to an incomplete final frame, `0` when none. */
    tornBytes: number;
    /** Plaintext recovered from a torn final frame, when it could be read. */
    tornText?: string;
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
export declare function decodeZstdArtifact(bytes: Buffer): DecodedZstd;
