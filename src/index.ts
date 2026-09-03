/**
 * @argszero/cordis-plugin-session-audit — Cordis plugin entry.
 *
 * Mount via a bare package name in a `cordis.yml` resolution manifest:
 *
 * ```yaml
 * - insert:
 *     - id: session-audit
 *       name: '@argszero/cordis-plugin-session-audit'
 * ```
 *
 * The plugin registers a `/session-audit` slash command that runs the
 * completeness audit (`./audit.ts`) over every stored session log under the
 * configured JSONL root (or a specific one, via `id: <substring>`), then
 * prints a diagnostic report. It is a diagnostic tool — it never mutates a log.
 *
 * @module @argszero/cordis-plugin-session-audit
 */

import type { Context } from '@deepseek-ai/cordis'
import { auditSessionLog, formatAudit, type SessionAudit } from './audit.js'

// Minimal structural augmentation so a bare `@deepseek-ai/cordis` context is
// adequate for the command-registration call shape. A full harness workspace
// provides the real `commands` runtime; this keeps the standalone build green.
declare module '@deepseek-ai/cordis' {
  interface Context {
    commands: {
      register(definition: {
        name: string
        description: string
        input?: { hint: string }
        recordInput?: boolean
        handler: (invocation: { rawInput: string }) => unknown
      }): void
    }
    get<T = unknown>(name: string): T | undefined
  }
}

/**
 * Minimal structural faces for the command registration. The plugin only needs
 * the parts of the harness command contract it calls. Declared locally so the
 * package builds and runs without a full harness workspace installed.
 */
interface CommandInvocation {
  readonly rawInput: string
}
type CommandResult =
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string }

/** Plugin config: the sessions JSONL root to scan. */
export interface SessionAuditConfig {
  /** The JSONL session root (e.g. `$DSH_HOME/sessions`). */
  root?: string
}

/** Walk a sessions JSONL root, collecting every plaintext `.jsonl` artifact path. */
async function walkSessionLogs(root: string): Promise<string[]> {
  const { readdir, realpath } = await import('node:fs/promises')
  const { join, isAbsolute, resolve } = await import('node:path')
  const absoluteRoot = isAbsolute(root) ? root : await realpath(resolve(root))
  const found: string[] = []
  const projects = await readdir(absoluteRoot, { withFileTypes: true }).catch(() => [])
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const projDir = join(absoluteRoot, proj.name)
    const sessionDirs = await readdir(projDir, { withFileTypes: true }).catch(() => [])
    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue
      const sessionDir = join(projDir, sd.name)
      const files = await readdir(sessionDir).catch(() => [])
      for (const file of files) {
        if (file.endsWith('.jsonl')) found.push(join(sessionDir, file))
      }
    }
  }
  return found
}

/** The slash-command handler: audit the current session or all sessions. */
async function executeAuditCommand(invocation: CommandInvocation, ctx: Context): Promise<CommandResult> {
  const config = (ctx.get('sessionAudit') ?? {}) as SessionAuditConfig
  const raw = invocation.rawInput.trim()
  const idFilter = raw.includes('id=') ? raw.split('id=')[1]?.trim().split(' ')[0] : undefined

  const root = config.root ?? process.env.DSH_HOME?.concat('/sessions') ?? ''
  if (!root) {
    return { kind: 'error', text: 'No sessions root configured. Pass `root` in the plugin config or set DSH_HOME.' }
  }
  const paths = await walkSessionLogs(root)
  const filtered = idFilter !== undefined ? paths.filter(p => p.includes(idFilter)) : paths
  if (filtered.length === 0) {
    return { kind: 'success', text: idFilter !== undefined
      ? `No .jsonl session log matched "${idFilter}" under ${root}`
      : `No .jsonl session logs found under ${root}` }
  }
  const audits: SessionAudit[] = []
  const { readFile } = await import('node:fs/promises')
  for (const p of filtered) {
    try {
      audits.push(auditSessionLog(await readFile(p), p))
    } catch {
      audits.push({
        sessionId: '(unknown)', path: p, formatVersion: -1, inheritedEventCount: 0,
        eventCount: 0, byteLength: 0,
        findings: [{ code: 'UNREADABLE', severity: 'warn', detail: 'Could not read (possibly .jsonl.zstd compressed); use `session-audit` on the plaintext artifact.' }],
        needsManual: false,
      })
    }
  }
  const summary = audits.filter(a => !a.needsManual).length === audits.length
    ? `✓ ${audits.length} session(s) audited — no needs-manual corruption`
    : `⚠ ${audits.filter(a => a.needsManual).length}/${audits.length} session(s) need manual attention`
  return { kind: 'success', text: audits.map(formatAudit).join('\n\n') + `\n\n${summary}` }
}

/** Register the `/session-audit` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'session-audit',
    description: 'audit session logs for corruption (seq gaps, index-reuse, orphan tool calls, version drift)',
    input: { hint: '[all|id=<substring>]' },
    recordInput: false,
    handler: invocation => executeAuditCommand(invocation, ctx),
  })
}

export { auditSessionLog, formatAudit } from './audit.js'
