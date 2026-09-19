/**
 * Storage-path identity, ported from the harness's naming rules.
 *
 * A stored session artifact lives at
 * `<root>/<project-dir>/<session-dir>/session[.vN].jsonl[.zstd]`, where the
 * project directory and session directory are *derived from the header* — the
 * session id and the recorded cwd. The backend re-derives that path when it
 * reads an artifact and refuses the read when the artifact is not where its own
 * header says it should be
 * (`assertStoredIdentity`, `session-persistence-jsonl/src/index.ts`):
 *
 *     corrupt session log "…": header id "X" and cwd identify "…"
 *
 * That refusal is one of the classes that aborts an artifact listing and with it
 * the whole application boot (discussion #7161, matrix row 4: a renamed session
 * directory). Reproducing the derivation here is what lets the audit predict it
 * without a harness.
 *
 * @module @argszero/cordis-plugin-session-audit/paths
 */
/** Encode one raw path segment the way the backend encodes a session id. */
export declare function encodeSegment(raw: string): string;
/**
 * Derive the human-navigable project directory name for a session's cwd.
 *
 * Separator replacement and truncation are intentionally lossy in the backend,
 * but deterministic: the same cwd always yields the same name, which is all a
 * prediction needs.
 */
export declare function projectKey(cwd: string): string;
/**
 * The project directory name a recorded cwd maps to.
 *
 * `undefined` selects the no-cwd bucket. An *empty* cwd has no derivable name
 * at all (the backend's `projectKey` rejects it, and the refusal surfaces as
 * "header id cannot name a storage path"), so it returns `undefined` here and
 * the caller skips the comparison rather than inventing an expectation.
 */
export declare function expectedProjectDirName(cwd: string | undefined): string | undefined;
/** Split a path into segments, accepting either separator. */
export declare function pathSegments(path: string): string[];
/** The name of the directory holding an artifact, or `undefined` at a root. */
export declare function parentName(path: string): string | undefined;
/** The name of the directory above an artifact's own directory, if present. */
export declare function grandparentName(path: string): string | undefined;
