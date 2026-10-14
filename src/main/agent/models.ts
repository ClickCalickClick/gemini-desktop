/**
 * Parses the model list of Antigravity CLI.
 *
 * `agy models` prints "Fetching available models..." and then one `<id>\t<display name>`
 * line per model; `agy -p /model` prints the default model's line in the same format.
 * Any other line is ignored.
 *
 * @module agent/models
 */

import type { AgentModel } from '../../shared/types/agent';

/** Most models kept from one listing. */
export const MAX_MODELS = 200;
const MAX_NAME_LENGTH = 100;

/** Model ids the app passes to `--model` (same rule as the Model setting). */
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

// eslint-disable-next-line no-control-regex -- terminal escape sequences
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Parse `<id>\t<name>` lines. Duplicates and malformed lines are skipped. */
export function parseModelLines(text: string): AgentModel[] {
    const models: AgentModel[] = [];
    const seen = new Set<string>();
    for (const rawLine of text.replace(ANSI_PATTERN, '').split(/\r?\n/)) {
        const tab = rawLine.indexOf('\t');
        if (tab <= 0) {
            continue;
        }
        const id = rawLine.slice(0, tab).trim();
        const name = rawLine
            .slice(tab + 1)
            .replace(/\s+/g, ' ')
            .trim();
        if (!MODEL_ID_PATTERN.test(id) || name.length === 0 || seen.has(id)) {
            continue;
        }
        seen.add(id);
        models.push({ id, name: name.slice(0, MAX_NAME_LENGTH) });
        if (models.length >= MAX_MODELS) {
            break;
        }
    }
    return models;
}
