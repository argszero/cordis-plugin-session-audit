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
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Derive the human-navigable project directory name for a session's cwd.
 *
 * Separator replacement and truncation are intentionally lossy in the backend,
 * but deterministic: the same cwd always yields the same name, which is all a
 * prediction needs.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * The project directory name a recorded cwd maps to.
 *
 * `undefined` selects the no-cwd bucket. An *empty* cwd has no derivable name
 * at all (the backend's `projectKey` rejects it, and the refusal surfaces as
 * "header id cannot name a storage path"), so it returns `undefined` here and
 * the caller skips the comparison rather than inventing an expectation.
 */
export function expectedProjectDirName(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return '_no-cwd'
  if (cwd === '') return undefined
  return projectKey(cwd)
}

/** Split a path into segments, accepting either separator. */
export function pathSegments(path: string): string[] {
  return path.split(/[/\\]+/).filter(segment => segment.length > 0)
}

/** The name of the directory holding an artifact, or `undefined` at a root. */
export function parentName(path: string): string | undefined {
  const segments = pathSegments(path)
  return segments.length >= 2 ? segments[segments.length - 2] : undefined
}

/** The name of the directory above an artifact's own directory, if present. */
export function grandparentName(path: string): string | undefined {
  const segments = pathSegments(path)
  return segments.length >= 3 ? segments[segments.length - 3] : undefined
}
