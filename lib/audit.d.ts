/**
 * Session-log completeness audit engine.
 *
 * The dsh harness persists every agent interaction to an append-only JSONL
 * session log. The in-tree repair path (`repair.ts`) is narrow: it only
 * synthesizes replay-time closers for a crash tail (open-turn truncation), and
 * the storage-contract read path (`validateStoredEvents`) is a fail-closed
 * load-time check that rejects an unrecognized/structurally-invalid log
 * outright. Neither systematically diagnoses the full corruption surface that
 * has produced 14+ distinct bug reports upstream (see the session
 * corruption family in the harness memory index).
 *
 * This plugin is NOT a fix. It is a proactive **audit**: it reads one (or every)
 * stored session log and produces a diagnostic report that distinguishes
 * *recoverable* corruption (the harness can resume/replay with a loss) from
 * *needs-manual* corruption (the log cannot be interpreted and would hard-fail
 * a replay). The goal is to give a user a precise, actionable picture BEFORE
 * replay crashes or silently drops history.
 *
 * The engine is deliberately dependency-minimal for the CLI path: it reads raw
 * bytes and decodes JSONL lines itself, so it runs under plain Node without a
 * bundled harness. The Cordis `apply(ctx)` entry (`./index.ts`) wraps the same
 * engine and exposes it as a `/session-audit` command.
 *
 * @module @argszero/cordis-plugin-session-audit/audit
 */
/** What the engine found wrong with one session log. */
export interface AuditFinding {
    /** Machine-readable finding id (stable for tooling). */
    code: string;
    /** Severity: `error` means the log cannot be interpreted; `warn` means data may have silently dropped. */
    severity: 'error' | 'warn' | 'info';
    /** Human-readable description. */
    detail: string;
    /** The event seq or byte position the finding concerns, when known. */
    at?: number;
}
/** The audit result for one session log. */
export interface SessionAudit {
    sessionId: string;
    path: string;
    /** Format-version drift vs the harness's current SESSION_FORMAT_VERSION (0). */
    formatVersion: number;
    inheritedEventCount: number;
    eventCount: number;
    byteLength: number;
    findings: AuditFinding[];
    /** True when the log has structural damage that a replay would fail on. */
    needsManual: boolean;
}
/**
 * Audit one stored session log (plaintext `.jsonl` bytes).
 * @param bytes - the raw file contents (header line first).
 * @param path - the artifact path, for the report.
 * @returns a {@link SessionAudit}.
 */
export declare function auditSessionLog(bytes: Buffer, path: string): SessionAudit;
/** Format a session audit as human-readable text. */
export declare function formatAudit(audit: SessionAudit): string;
