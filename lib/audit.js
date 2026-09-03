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
/** The harness's current on-disk session format version. */
const SESSION_FORMAT_VERSION = 0;
/** Known session event types (the build understands this vocabulary). */
const KNOWN_TYPES = new Set([
    'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked',
    'approval/decided', 'approval/policy', 'assistant/chunk', 'assistant/message',
    'command/done', 'command/run', 'compaction/end', 'compaction/prune',
    'compaction/start', 'compaction/summary', 'feedback/record', 'goal/change',
    'hook/invoked', 'hook/result', 'llm/retry', 'llm/retry-started',
    'model/selection', 'permission/preset', 'plan/mode', 'request/context',
    'request/header', 'sandbox/mode', 'schedule/change',
    'session-log-deepseek/delivery-accepted', 'session/end-seed', 'session/title',
    'session/title-llm-request', 'step/end', 'step/start', 'subagent/descriptor',
    'subagent/model-selection-policy', 'team/member', 'team/message/delivered',
    'team/message/queued', 'team/task', 'todo/write', 'tool-workflow/agent-end',
    'tool-workflow/agent-start', 'tool-workflow/run-end', 'tool-workflow/run-start',
    'tool/call', 'tool/code-dispatch', 'tool/code-dispatch-start', 'tool/result',
    'turn/end', 'turn/start', 'user/message', 'web/deepseek-search-llm-request',
]);
/**
 * Decode one stored JSONL line into audit events. A line is either a single
 * session event, or a packed chunk row (`text-chunks` / `reasoning-chunks` /
 * `tool-call-chunks`) that expands to its member `assistant/chunk` events.
 * Returns `null` when the line is not a recognizable record.
 */
function decodeLine(line, lineNo) {
    let raw;
    try {
        raw = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null)
        return null;
    const rec = raw;
    const type = rec['type'];
    // Packed chunk row: expand to member events.
    if (type === 'text-chunks' || type === 'reasoning-chunks' || type === 'tool-call-chunks') {
        const seq0 = rec['seq0'];
        const time0 = rec['time0'];
        const data = rec['data'];
        if (!Number.isSafeInteger(seq0) || !Number.isSafeInteger(time0) || !data)
            return null;
        const turn = data['turn'];
        const step = data['step'];
        const dt = data['dt'];
        const members = type === 'tool-call-chunks'
            ? data['args'] ?? []
            : data['texts'] ?? [];
        const runKind = type === 'text-chunks' ? 'text-delta'
            : type === 'reasoning-chunks' ? 'reasoning-delta'
                : 'tool-call-delta';
        const callId = type === 'tool-call-chunks' ? data['id'] : undefined;
        const callName = type === 'tool-call-chunks' ? data['name'] : undefined;
        if (!Array.isArray(dt))
            return null;
        const events = [];
        let seq = seq0;
        let time = time0;
        for (let k = 0; k < members.length; k++) {
            const chunkData = { block: data['index'], delta: runKind };
            if (type === 'tool-call-chunks') {
                chunkData['callId'] = callId;
                if (callName !== undefined)
                    chunkData['name'] = callName;
                chunkData['text'] = members[k];
            }
            else {
                chunkData['text'] = members[k];
            }
            events.push({
                type: 'assistant/chunk',
                seq: seq + k,
                time: time + (dt[k] ?? 0),
                data: { turn, step, chunk: chunkData },
            });
        }
        return events;
    }
    // Single session event.
    if (typeof type !== 'string')
        return null;
    const seq = rec['seq'];
    const time = rec['time'];
    if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(time))
        return null;
    return [{
            type,
            seq: seq,
            time: time,
            data: rec['data'] ?? {},
            ...(rec['ignorable'] === true ? { ignorable: true } : {}),
        }];
}
/** Decode the header line of a session log. */
function decodeHeader(line) {
    let raw;
    try {
        raw = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null)
        return null;
    const rec = raw;
    if (rec['type'] !== 'session')
        return null;
    const id = rec['id'];
    const version = rec['version'];
    if (typeof id !== 'string' || !Number.isSafeInteger(version))
        return null;
    return {
        id,
        version: version,
        seedLength: rec['seedLength'] ?? 0,
    };
}
/**
 * Audit one stored session log (plaintext `.jsonl` bytes).
 * @param bytes - the raw file contents (header line first).
 * @param path - the artifact path, for the report.
 * @returns a {@link SessionAudit}.
 */
export function auditSessionLog(bytes, path) {
    const text = bytes.toString('utf8');
    const lines = text.split('\n');
    const headerLine = lines[0] ?? '';
    const header = decodeHeader(headerLine);
    const result = {
        sessionId: header?.id ?? '(missing header)',
        path,
        formatVersion: header?.version ?? -1,
        inheritedEventCount: header?.seedLength ?? 0,
        eventCount: 0,
        byteLength: bytes.length,
        findings: [],
        needsManual: false,
    };
    if (!header) {
        result.findings.push({
            code: 'HEADER_MISSING',
            severity: 'error',
            detail: 'First line is not a session header (type:"session"); the log cannot be interpreted',
            at: 0,
        });
        result.needsManual = true;
        return result;
    }
    // Format-version drift.
    if (header.version !== SESSION_FORMAT_VERSION) {
        const future = header.version > SESSION_FORMAT_VERSION;
        result.findings.push({
            code: 'FORMAT_VERSION_DRIFT',
            severity: 'error',
            detail: `Log format v${header.version} differs from the harness's v${SESSION_FORMAT_VERSION} (` +
                `written by a ${future ? 'newer' : 'older'} harness)`,
        });
        result.needsManual = true;
    }
    // Decode event lines (skip the header and blank trailing line).
    const events = [];
    const decodeErrors = [];
    let lineNo = 0;
    for (let i = 1; i < lines.length; i++) {
        lineNo = i;
        const line = lines[i];
        if (line === '')
            continue;
        const decoded = decodeLine(line, lineNo);
        if (decoded === null) {
            decodeErrors.push(i + 1);
            continue;
        }
        events.push(...decoded);
    }
    result.eventCount = events.length;
    // Unparsable committed line = structural damage.
    if (decodeErrors.length > 0) {
        result.findings.push({
            code: 'UNPARSABLE_LINE',
            severity: 'error',
            detail: `${decodeErrors.length} line(s) could not be decoded as a session record: line ${decodeErrors.join(', ')}`,
        });
        result.needsManual = true;
    }
    // Seq-contiguity scan (index-reuse, gaps, duplicates, out-of-order).
    let expectedSeq = header.seedLength;
    const seenSeqs = new Set();
    const gapAt = [];
    const dupAt = [];
    const reorderedAt = [];
    for (const ev of events) {
        if (seenSeqs.has(ev.seq)) {
            dupAt.push(ev.seq);
            continue;
        }
        if (ev.seq < expectedSeq) {
            // A lower seq than the watermark: index-reuse or reordering.
            reorderedAt.push(ev.seq);
            continue;
        }
        if (ev.seq > expectedSeq) {
            gapAt.push(ev.seq);
            // Don't advance past a gap; the next contiguous event still anchors.
        }
        seenSeqs.add(ev.seq);
        expectedSeq = Math.max(expectedSeq, ev.seq + 1);
    }
    if (gapAt.length > 0) {
        result.findings.push({
            code: 'SEQ_GAP',
            severity: 'error',
            detail: `${gapAt.length} seq gap(s) in the committed region near seq ${gapAt[0]} — events are missing between ` +
                `${result.inheritedEventCount} and ${expectedSeq}`,
        });
        result.needsManual = true;
    }
    if (dupAt.length > 0) {
        result.findings.push({
            code: 'SEQ_DUPLICATE',
            severity: 'warn',
            detail: `${dupAt.length} duplicate seq(s) (${dupAt.slice(0, 5).join(', ')}${dupAt.length > 5 ? ', …' : ''}) — index reuse`,
        });
    }
    if (reorderedAt.length > 0) {
        result.findings.push({
            code: 'SEQ_REORDERED',
            severity: 'warn',
            detail: `${reorderedAt.length} event(s) appeared at seq ${reorderedAt[0]} below the contiguous watermark — ` +
                `out-of-order or reused seq`,
        });
    }
    // Unknown-type events (not marked ignorable) → the storage read path would refuse.
    const unknownRequired = [];
    for (const ev of events) {
        if (!KNOWN_TYPES.has(ev.type) && ev.ignorable !== true) {
            unknownRequired.push(ev.seq);
        }
    }
    if (unknownRequired.length > 0) {
        result.findings.push({
            code: 'UNKNOWN_REQUIRED_TYPE',
            severity: 'warn',
            detail: `${unknownRequired.length} event(s) have a type outside the known vocabulary and are not marked ` +
                `ignorable (seq ${unknownRequired.slice(0, 5).join(', ')}${unknownRequired.length > 5 ? ', …' : ''}); ` +
                `a newer-harness reader may refuse this log`,
        });
    }
    // Scan ALL events for tool/call ↔ tool/result pairing (orphan detection also
    // runs over a log that lost events, so a requested-but-uncompleted call is a
    // first-class finding independent of the surface-eligible set).
    const callIds = new Map();
    const completedCallIds = new Set();
    for (const ev of events) {
        if (ev.type !== 'tool/call' && ev.type !== 'tool/result')
            continue;
        const d = ev.data;
        if (ev.type === 'tool/call') {
            const callId = d['callId'];
            if (callId === undefined || callId === '') {
                result.findings.push({
                    code: 'TOOL_CALL_NO_ID',
                    severity: 'warn',
                    detail: `tool/call at seq ${ev.seq} has no usable callId — the call cannot be paired with a result`,
                    at: ev.seq,
                });
            }
            else {
                callIds.set(callId, { seq: ev.seq });
            }
        }
        else {
            const msg = d['message'];
            const content = msg?.['content'];
            const block = (Array.isArray(content) ? (content[0] ?? {}) : {});
            const callId = (block['toolCallId'] ?? d['callId']);
            if (callId === undefined || callId === '') {
                result.findings.push({
                    code: 'TOOL_RESULT_NO_ID',
                    severity: 'warn',
                    detail: `tool/result at seq ${ev.seq} carries no paired callId`,
                    at: ev.seq,
                });
            }
            else {
                completedCallIds.add(callId);
            }
        }
    }
    // Orphan tool calls: requested but never completed.
    for (const [callId, info] of callIds) {
        if (!completedCallIds.has(callId)) {
            result.findings.push({
                code: 'ORPHAN_TOOL_CALL',
                severity: 'info',
                detail: `tool/call ${callId} at seq ${info.seq} has no matching tool/result — ` +
                    `an interrupted turn whose outcome was never durably recorded`,
                at: info.seq,
            });
        }
    }
    // Turn-open detection: a turn that never closed (open tail).
    let openTurn = null;
    let closedTurn = -1;
    for (const ev of events) {
        const d = ev.data;
        if (ev.type === 'turn/start')
            openTurn = d['turn'] ?? null;
        else if (ev.type === 'turn/end') {
            closedTurn = d['turn'] ?? -1;
            if (d['turn'] === openTurn)
                openTurn = null;
        }
    }
    if (openTurn !== null) {
        result.findings.push({
            code: 'OPEN_TURN',
            severity: 'info',
            detail: `turn ${openTurn} opened but never closed — an open tail (crash interruption). ` +
                `The in-tree repair synthesizes closers for this exact case.`,
        });
    }
    return result;
}
/** Format a session audit as human-readable text. */
export function formatAudit(audit) {
    const lines = [];
    lines.push(`Session ${audit.sessionId} — ${audit.path}`);
    lines.push(`  format v${audit.formatVersion} · ${audit.eventCount} events · ${audit.byteLength} bytes · ` +
        `seed length ${audit.inheritedEventCount}`);
    if (audit.findings.length === 0) {
        lines.push('  OK — no corruption findings.');
        return lines.join('\n');
    }
    lines.push(`  findings: ${audit.findings.length}`);
    for (const f of audit.findings) {
        lines.push(`    [${f.severity}] ${f.code}${f.at !== undefined ? ` @${f.at}` : ''} — ${f.detail}`);
    }
    lines.push(audit.needsManual ? '  ⚠ needs manual attention (replay would fail or drop history)' : '  ✓ log is interpretable (warnings only)');
    return lines.join('\n');
}
