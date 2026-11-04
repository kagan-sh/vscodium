// Holds the latest request per thread until the panel is shown, or it gets too old.
// Pure helpers with no kagan imports.

/** How long an off-screen editor_open is kept. */
export const PENDING_MS = 10 * 60 * 1000;

/**
 * The queue a panel takes requests from.
 * @template T
 * @typedef {{ put(threadId: string, value: T): void, take(threadId: string): T | null, size(): number }} Pending
 */

/**
 * @template T
 * @param {number} ttlMs
 * @param {() => number} [now]
 * @returns {Pending<T>}
 */
export function createPending(ttlMs, now = Date.now) {
  /** @type {Map<string, { value: T, at: number }>} */
  const entries = new Map();
  const sweep = () => {
    for (const [threadId, entry] of entries) {
      if (now() - entry.at > ttlMs) entries.delete(threadId);
    }
  };
  return {
    /**
     * @param {string} threadId
     * @param {T} value
     */
    put(threadId, value) {
      sweep();
      entries.set(threadId, { value, at: now() });
    },
    /**
     * @param {string} threadId
     * @returns {T | null}
     */
    take(threadId) {
      sweep();
      const entry = entries.get(threadId);
      entries.delete(threadId);
      return entry?.value ?? null;
    },
    size() {
      sweep();
      return entries.size;
    },
  };
}
