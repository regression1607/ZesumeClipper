// Batched, best-effort remote logger for auto-apply. Streams structured events
// (job outcomes, failures, and — most importantly — live selector/button
// snapshots) to the Zesume backend so we can debug user complaints and patch
// selectors after LinkedIn layout changes.
//
// Design notes:
//   - Non-blocking: logging failures NEVER interrupt an auto-apply run.
//   - Batched: events are buffered and flushed together to respect rate limits.
//   - Session-cookie auth: same `credentials: "include"` as the AI calls.
//   - Privacy: callers must pass labels/selectors only, never answer VALUES.

import { getApiUrl, ENDPOINTS } from "./config.js";

const FLUSH_INTERVAL_MS = 4000;
const MAX_BUFFER = 25;
// Events important enough to flush immediately rather than wait for the timer.
const URGENT = new Set(["selectors-broken", "applied", "failed", "run-ended"]);

let buffer = [];
let runId = null;
let flushTimer = null;
let flushing = false;

function extVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch (_) {
    return "";
  }
}

export function setRunId(id) {
  runId = id || null;
}

export function logRemote(event, data = {}) {
  try {
    buffer.push({
      event,
      board: data.board,
      jobUrl: data.jobUrl || data.url,
      company: data.company,
      role: data.role,
      reason: data.reason,
      message: data.message,
      snapshot: data.snapshot,
    });
    if (buffer.length >= MAX_BUFFER || URGENT.has(event)) {
      flushRemote();
    } else {
      scheduleFlush();
    }
  } catch (_) {
    /* never throw from logging */
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushRemote();
  }, FLUSH_INTERVAL_MS);
}

export async function flushRemote() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const events = buffer.splice(0, MAX_BUFFER);
  try {
    const apiUrl = await getApiUrl();
    await fetch(`${apiUrl}${ENDPOINTS.autoApplyLog}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId, extVersion: extVersion(), events }),
    });
  } catch (_) {
    // Drop on failure — logs are best-effort; don't retry aggressively or block.
  } finally {
    flushing = false;
    // If more piled up while we were sending, schedule another pass.
    if (buffer.length > 0) scheduleFlush();
  }
}
