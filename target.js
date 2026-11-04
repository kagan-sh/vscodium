// Which folder the panel shows: the thread on screen, or the folder it was opened for.
// Pure helpers with no kagan imports, so `node --test` can run them.

/** @typedef {{ request: string, path: string }} PanelRequest */
/** @typedef {{ folder: string, threadId: string | null }} Pin */
/** @typedef {{ pin: Pin | null, honoured: string }} TargetState */

/**
 * A panel opened for an explicit folder. Props carry the folder and a token for that open, so
 * opening the same folder again counts as a new request.
 * @param {unknown} props
 * @returns {PanelRequest | null}
 */
export function panelRequest(props) {
  if (props === null || typeof props !== 'object') return null;
  const { path, request } = /** @type {{ path?: unknown, request?: unknown }} */ (props);
  if (typeof request !== 'string' || request === '') return null;
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  return { request, path };
}

/**
 * The folder the panel was opened for, if that open is newer than the last one it honoured.
 * It lasts while the thread on screen stays the same, then the panel follows threads again.
 * @param {TargetState} state
 * @param {PanelRequest | null} request
 * @param {string | null} threadId
 * @returns {TargetState}
 */
export function pinState(state, request, threadId) {
  if (request && request.request !== state.honoured) {
    return { pin: { folder: request.path, threadId }, honoured: request.request };
  }
  if (state.pin && state.pin.threadId !== threadId) return { pin: null, honoured: state.honoured };
  return state;
}
