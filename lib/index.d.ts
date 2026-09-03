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
import type { Context } from '@deepseek-ai/cordis';
declare module '@deepseek-ai/cordis' {
    interface Context {
        commands: {
            register(definition: {
                name: string;
                description: string;
                input?: {
                    hint: string;
                };
                recordInput?: boolean;
                handler: (invocation: {
                    rawInput: string;
                }) => unknown;
            }): void;
        };
        get<T = unknown>(name: string): T | undefined;
    }
}
/** Plugin config: the sessions JSONL root to scan. */
export interface SessionAuditConfig {
    /** The JSONL session root (e.g. `$DSH_HOME/sessions`). */
    root?: string;
}
/** Register the `/session-audit` command for every composed command adapter. */
export declare function apply(ctx: Context): void;
export { auditSessionLog, formatAudit } from './audit.js';
