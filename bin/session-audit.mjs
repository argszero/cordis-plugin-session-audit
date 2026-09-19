#!/usr/bin/env node
/**
 * One-shot session-log audit CLI.
 *
 * Walks a dsh sessions root and audits every stored session artifact — both
 * `.jsonl` and the `.jsonl.zstd` concatenated-frame container the harness
 * writes when compression is enabled — for the full corruption surface (seq
 * gaps, index-reuse, duplicates, out-of-order seqs, format-version drift,
 * unknown-required types, orphan tool calls, open-turn tails, torn tails, and
 * the container defects that abort a boot).
 *
 * Prints a diagnostic report per session and a summary. Never mutates a log.
 *
 * Exit code is 1 when any artifact needs manual attention, so this can be used
 * as a pre-boot gate; 0 when every artifact is interpretable.
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
const { auditSessionArtifact, formatAudit } = await import(new URL('../lib/audit.js', import.meta.url).href)

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

/** The stored session artifact suffixes the harness writes. */
const ARTIFACT_SUFFIXES = ['.jsonl', '.jsonl.zstd']

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
        if (ARTIFACT_SUFFIXES.some(suffix => file.endsWith(suffix))) found.push(join(sessionDir, file))
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
  try { bytes = await readFile(p) } catch (e) {
    reports.push(`\n${p}\n  [error] UNREADABLE_ARTIFACT — could not read the file: ${e.message}`)
    errorCount++
    needsManual++
    continue
  }
  const audit = auditSessionArtifact(bytes, p)
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
if (needsManual > 0) {
  console.log(`\n  ⚠ ${needsManual} artifact(s) would abort a boot or lose history — resolve these before launching dsh.`)
  process.exit(1)
}
