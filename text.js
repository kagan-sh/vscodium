// The plain words the panel shows, and the one refusal an agent reads. Raw process output and file
// paths stay in the log, except where plainError repeats a refusal so the agent can act on it.

import { isNotGranted } from './server.js';

export const STARTING = 'Starting VSCodium. The first start can take a few minutes.';

export const ONLY_MACOS = 'This page works on macOS only for now.';

export const NO_THREAD = 'Open a thread first. There is no workspace to open.';

export const STARTUP_TIMEOUT = 'VSCodium took too long to start. Press Try again.';

/** @typedef {import('./server.js').FailureKind} FailureKind */

/** @type {Record<FailureKind, string>} */
const PANEL_TEXT = {
  start: 'VSCodium did not start. Press Try again.',
  missing: 'VSCodium was not found on this computer. Install VSCodium, then in VSCodium run "Shell Command: Install \'codium\' command in PATH". Then press Try again.',
  denied: "VSCodium cannot use a permission it needs yet. Approve this plugin's permissions, then press Try again.",
  port: 'Another program is using a port VSCodium needs. Close it, then press Try again.',
  timeout: STARTUP_TIMEOUT,
  stopped: 'VSCodium stopped. Press Try again.',
  folder: "VSCodium could not open this thread's folder. Press Try again.",
};

/**
 * @param {FailureKind} kind
 * @returns {string}
 */
export function panelText(kind) {
  return PANEL_TEXT[kind];
}

/**
 * @param {string} platform
 * @returns {boolean}
 */
export function pageOnThisSystem(platform) {
  // Node says darwin. This runtime says macos.
  return platform === 'darwin' || platform === 'macos';
}

/**
 * The message a person can act on: a denied power names the permission, anything else says what happened.
 * @param {unknown} error
 * @returns {string}
 */
export function plainError(error) {
  if (isNotGranted(error)) {
    return "VSCodium cannot use a permission it needs yet. Approve this plugin's permissions, then try again.";
  }
  return error instanceof Error ? error.message : String(error);
}
