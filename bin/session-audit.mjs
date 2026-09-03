#!/usr/bin/env node
/**
 * One-shot session-log audit CLI.
 *
 * Walks a dsh JSONL sessions root and audits every plaintext `.jsonl` session
 * log for the full corruption surface (seq gaps, index-reuse, duplicates,
 * out-of-order seqs, format-version drift, unknown-required types, orphan
 * tool calls, open-turn tails). Prints a diagnostic report per session and a
 * summary. Never mutates a log.
 *
 * Usage:
 *   node session-audit.mjs <sessions-root>
 *   node session-audit.mjs <sessions-root> --id <session-id-substring>
 *   DSH_HOME=... node session-audit.mjs            # defaults to $DSH_HOME/sessions
 */

import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { auditSessionLog, formatAudit } = await import(new URL('../lib/audit.js', import.meta.url).href)

// --- argument parsing ---
const args = process.argv.slice(2)
let rootArg = null
let idFilter = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--id') { idFilter = args[++i]; continue }
  if (args[i].startsWith('--')) continue
  rootArg = args[i]
}
const root = rootArg ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : '')
if (!root) {
  console.error('Usage: node session-audit.mjs <sessions-root> [--id <substring>]')
  process.exit(2)
}

async function walkSessionLogs(rootDir) {
  const absoluteRoot = isAbsolute(rootDir) ? rootDir : resolve(rootDir)
  const found = []
  let projects
  try { projects = await readdir(absoluteRoot, { withFileTypes: true }) } catch (e) {
    console.error(`Cannot read sessions root ${absoluteRoot}: ${e.message}`)
    process.exit(2)
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const projDir = join(absoluteRoot, proj.name)
    let sessionDirs
    try { sessionDirs = await readdir(projDir, { withFileTypes: true }) } catch { continue }
    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue
      const sessionDir = join(projDir, sd.name)
      let files
      try { files = await readdir(sessionDir) } catch { continue }
      for (const file of files) {
        if (file.endsWith('.jsonl')) found.push(join(sessionDir, file))
      }
    }
  }
  return found
}

// --- audit each session ---
const paths = await walkSessionLogs(root)
const reports = []
let errorCount = 0, warnCount = 0, needsManual = 0, okCount = 0
for (const p of paths) {
  if (idFilter && !p.includes(idFilter)) continue
  let bytes
  try { bytes = await readFile(p) } catch {
    reports.push(`\n${p}\n  [warn] UNREADABLE — could not read (possibly .jsonl.zstd compressed)`)
    warnCount++
    continue
  }
  const audit = auditSessionLog(bytes, p)
  reports.push('\n' + formatAudit(audit))
  for (const f of audit.findings) {
    if (f.severity === 'error') errorCount++
    else if (f.severity === 'warn') warnCount++
  }
  if (audit.needsManual) needsManual++
  else okCount++
}

console.log(reports.join('\n'))
console.log(`\n=== summary ===`)
console.log(`  sessions scanned: ${paths.filter(p => !idFilter || p.includes(idFilter)).length}`)
console.log(`  clean: ${okCount} · needs-manual: ${needsManual} · error findings: ${errorCount} · warn findings: ${warnCount}`)
