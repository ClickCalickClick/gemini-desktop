/**
 * Small helpers for untrusted JSON from the agent CLIs and their settings files.
 *
 * @module agent/json
 */

export type JsonObject = Record<string, unknown>;

/** True for a plain JSON object (not null, not an array). */
export function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
