# @argszero/cordis-plugin-session-audit

A **proactive session-log completeness audit** for the [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) agent harness. It never fixes a log — it **diagnoses** the full corruption surface and prints a report *before replay crashes* or silently drops history.

## Why this exists

The dsh harness persists every agent interaction to an append-only JSONL session log. Two in-tree mechanisms already exist, but neither is a full diagnostic:

- `repair.ts` (`interruptedTurnClosers`) is **narrow** — it only synthesizes replay-time closers for a crash tail (open-turn truncation), one mechanism.
- `validateStoredEvents` (storage-contract) is a **fail-closed load-time check** — it refuses an unrecognized/structurally-invalid log outright, but tells you only "this log is bad", not *which* of the many corruption classes is present.

Upstream, the session-log corruption family has produced 14+ distinct bug reports (seq gaps, index-reuse, format-version drift, empty-id duplicates, orphan `tool_calls`, turn-reason loss). This plugin audits for **all of them at once** and classifies each finding as `error` (replay would fail / needs manual) vs `warn` (data may have silently dropped) vs `info` (recoverable — e.g. the open-turn tail the in-tree repair already handles).

## Detection surface

| Code | Severity | What it means |
|------|----------|---------------|
| `HEADER_MISSING` | error | First line is not a session header; log unusable |
| `FORMAT_VERSION_DRIFT` | error | Log format vN differs from the harness's `SESSION_FORMAT_VERSION` (written by newer/older harness) |
| `UNPARSABLE_LINE` | error | A committed line is not a decodeable session record |
| `SEQ_GAP` | error | Events are missing between seqs (contiguity break) |
| `SEQ_DUPLICATE` | warn | Same seq appears twice (index reuse) |
| `SEQ_REORDERED` | warn | An event appears below the contiguous watermark (out-of-order / reused seq) |
| `UNKNOWN_REQUIRED_TYPE` | warn | A type outside the known vocabulary and not marked `ignorable` (a newer-harness reader may refuse) |
| `TOOL_CALL_NO_ID` / `TOOL_RESULT_NO_ID` | warn | tool/call or tool/result carries no usable call identity |
| `ORPHAN_TOOL_CALL` | info | A tool was requested (`tool/call`) but its outcome was never durably recorded (`tool/result`) |
| `OPEN_TURN` | info | A turn opened but never closed (crash interruption; the in-tree repair synthesizes closers for this) |

## Usage

### As a mounted Cordis plugin (slash command)

Add it to a `cordis.yml` resolution manifest:

```yaml
- insert:
    - id: session-audit
      name: '@argszero/cordis-plugin-session-audit'
```

Then `/session-audit` audits every `.jsonl` session log under the JSONL root, and `/session-audit id=<substring>` narrows to matching session ids. Configure the root via plugin `config`:

```yaml
- insert:
    - id: session-audit
      name: '@argszero/cordis-plugin-session-audit'
      config:
        root: !!js dshHomePath('sessions')
```

### As a one-shot CLI (no harness needed)

The package ships a `session-audit` bin that runs under plain Node and needs zero dsh runtime:

```sh
# audit a whole sessions root
npx @argszero/cordis-plugin-session-audit /path/to/sessions

# narrow to one session id
npx @argszero/cordis-plugin-session-audit /path/to/sessions --id <substring>

# default root from DSH_HOME
DSH_HOME=/path/to/home npx @argszero/cordis-plugin-session-audit
```

## Notes

- The audit reads **plaintext `.jsonl`** artifacts. A `.jsonl.zstd` (compressed) artifact is reported as `UNREADABLE` — decompress it first, or point the audit at a root configured with `compression: none`.
- **Non-mutating.** This plugin never appends to, truncates, or rewrites a session log.
- It is a **diagnostic companion**, not a replacement for `repair.ts` or a fix. Use it to understand *what* is wrong, then decide whether the in-tree repair or a manual migration is appropriate.

## License

MIT
