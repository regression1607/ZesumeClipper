// Auto-apply engine (ported from the proven JobPilotAssist background worker).
// Exposed as handleAutoApplyMessage() so ZesumeClipper's single service-worker
// message router can delegate auto-apply message types to it.

import { callLLM } from "./llm-backend.js";
import { buildRankingPrompt, buildFieldMappingPrompt } from "./prompts.js";
import { logRemote, setRunId, flushRemote } from "./remote-log.js";
import { getApiUrl, ENDPOINTS } from "./config.js";
import { approvedJobUrl, reviewApplication } from './application-security.js';

const DEFAULT_SETTINGS = {
  provider: "anthropic",
  apiKey: "",
  profile: {
    name: "",
    email: "",
    phone: "",
    location: "",
    currentRole: "",
    experienceYears: "",
    linkedin: "",
    github: "",
    workAuthorization: "",
    sponsorshipRequired: "",
    noticePeriod: "",
    expectedSalary: "",
    resumeText: "",
    coverLetterTemplate: "",
    links: ""
  },
  rateLimitSeconds: 25,
  batchSize: 5
};

// In-memory run state. Persisted mirror lives in chrome.storage.local.searchState.
const run = {
  running: false,
  paused: false,
  stopRequested: false,
  criteria: null,
  jobBoardUrl: null,
  matchedJobs: [],
  currentIndex: 0,
  batchCount: 0,
  heldQueue: [], // {job, fills, lowFields, tabId}
  waiter: null, // resolves when popup returns from batch checkpoint
  boardTabId: null,
  askWaiter: null // resolves with {answers, remember} from popup
};

// --------- answers memory (persisted user answers keyed by label) ---------

async function askUser(questions, jobContext) {
  if (run.stopRequested) return { skip: true };
  // Persist so popup can restore even if it was closed.
  await chrome.storage.local.set({
    pendingQuestions: { questions, jobContext, ts: Date.now() }
  });
  broadcast({ type: "ask-user", questions, jobContext });
  try {
    await chrome.action.setBadgeText({ text: "?" });
    await chrome.action.setBadgeBackgroundColor({ color: "#0a66c2" });
  } catch (_) {}

  // Automatically open the side panel so the user sees the question immediately
  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currentTab?.windowId && chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: currentTab.windowId });
    }
  } catch (_) {}

  if (run.stopRequested) return { skip: true };
  const result = await new Promise((resolve) => {
    run.askWaiter = resolve;
  });
  run.askWaiter = null;

  await chrome.storage.local.remove("pendingQuestions");
  try { await chrome.action.setBadgeText({ text: "" }); } catch (_) {}
  return result || { answers: {}, remember: {} };
}

// ---------- utilities ----------

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}), profile: { ...DEFAULT_SETTINGS.profile, ...(settings?.profile || {}) } };
}

async function pushLog(entry) {
  const { jobLog = [] } = await chrome.storage.local.get("jobLog");
  jobLog.push({ ...entry, timestamp: Date.now() });
  if (jobLog.length > 500) jobLog.splice(0, jobLog.length - 500);
  await chrome.storage.local.set({ jobLog });
  broadcast({ type: "log-updated" });
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---------- selector self-check (detect LinkedIn layout changes) ----------
// Auto-apply reads LinkedIn's live DOM. If they redesign Easy Apply, our
// anchors stop matching. We watch for that signal and surface a clear
// "page changed — update needed" banner instead of silently failing.

function flagSelectorsBroken(detail) {
  // Only stop the entire run if the search page itself has no job cards
  if (detail !== "no-job-cards") {
    return;
  }
  if (run.selectorsBroken) return;
  run.selectorsBroken = true;
  run.stopRequested = true;
  broadcast({ type: "selectors-broken", detail });
  status("⚠️ Could not find any job cards on the search page. Check your search URL.");
}

// Called once per job attempt with whether we could open Easy Apply and why not.

async function status(text) {
  broadcast({ type: "status", text });
  try {
    const { statusFeed = [] } = await chrome.storage.local.get("statusFeed");
    statusFeed.push({ text, ts: Date.now() });
    if (statusFeed.length > 200) statusFeed.splice(0, statusFeed.length - 200);
    await chrome.storage.local.set({ statusFeed });
  } catch (_) {}
}

async function persistSearchState() {
  await chrome.storage.local.set({
    searchState: {
      running: run.running,
      paused: run.paused,
      currentIndex: run.currentIndex,
      criteria: run.criteria,
      batchCount: run.batchCount,
      heldQueue: run.heldQueue.map((h) => ({
        job: h.job,
        lowFields: h.lowFields
      }))
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    const check = () => {
      if (run.stopRequested) return resolve();
      setTimeout(resolve, ms);
    };
    check();
  });
}

async function waitWhilePaused() {
  while (run.paused && !run.stopRequested) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        finish();
      }
    };
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

async function sendToTab(tabId, message, retries = 3) {
  if (run.stopRequested) throw new Error('Stopped by user');
  for (let i = 0; i < retries; i++) {
    if (run.stopRequested) throw new Error('Stopped by user');
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      // content script may not be ready yet; inject and retry
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: [
            "content-scripts/apply-scraper.js",
            "content-scripts/apply-filler.js",
            "content-scripts/apply-submitter.js"
          ]
        });
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw new Error("Content script unreachable");
}

// ---------- orchestration ----------

async function startAutoApply({ criteria, jobBoardUrl, maxJobs }) {
  if (run.running) return { ok: false, error: "Already running" };
  approvedJobUrl(jobBoardUrl);
  const settings = await getSettings();
  // AI runs through the Zesume backend (your logged-in session) — no key needed.
  if (!settings.profile.name || !settings.profile.email) {
    return { ok: false, error: "Fill your profile (name/email) in Options first." };
  }

  // Pre-check credit balance directly from Zesume backend
  try {
    const apiUrl = await getApiUrl();
    const meRes = await fetch(`${apiUrl}${ENDPOINTS.me}`, {
      credentials: "include",
      headers: { "content-type": "application/json" }
    });
    if (meRes.ok) {
      const data = await meRes.json().catch(() => null);
      const user = data?.user || data;
      const balance = user?.credits?.balance ?? 0;
      if (balance <= 0) {
        return {
          ok: false,
          error: "You have 0 credits. Please buy credits first to use Auto Apply.",
          code: "no_credits"
        };
      }
    }

    // Pre-check that at least 1 resume exists in Zesume
    const resumesRes = await fetch(`${apiUrl}${ENDPOINTS.resumes}`, {
      credentials: "include",
      headers: { "content-type": "application/json" }
    });
    if (resumesRes.ok) {
      const rData = await resumesRes.json().catch(() => ({}));
      const resumesList = rData.resumes || (Array.isArray(rData) ? rData : []);
      if (!resumesList || resumesList.length === 0) {
        return {
          ok: false,
          error: "You have no resumes in Zesume. Please create or upload at least 1 resume first.",
          code: "no_resumes"
        };
      }
    }
  } catch (_) {}

  run.running = true;
  run.paused = false;
  run.stopRequested = false;
  run.criteria = criteria;
  run.jobBoardUrl = jobBoardUrl;
  run.matchedJobs = [];
  run.currentIndex = 0;
  run.batchCount = 0;
  run.heldQueue = [];
  run.maxJobs = Math.min(50, Math.max(1, Number(maxJobs) || 5));
  run.selectorsBroken = false;
  run.attempts = 0;
  run.structuralFailures = 0;
  run.consecStructural = 0;
  run.runId = (crypto.randomUUID && crypto.randomUUID()) || `run-${Date.now()}`;
  setRunId(run.runId);
  await chrome.storage.local.set({ statusFeed: [] });
  await persistSearchState();

  const board = /indeed\.com/i.test(jobBoardUrl || "")
    ? "indeed"
    : /wellfound\.com|angel\.co/i.test(jobBoardUrl || "")
    ? "wellfound"
    : "linkedin";
  logRemote("run-start", {
    board,
    jobUrl: jobBoardUrl,
    message: `maxJobs=${maxJobs || "all"}`,
    snapshot: { criteria },
  });

  runLoop(settings).catch(async (e) => {
    status(`Fatal error: ${e.message}`);
    await pushLog({ company: "-", role: "-", url: run.jobBoardUrl, status: "Failed", note: e.message });
    logRemote("failed", { reason: "fatal", message: e.message, jobUrl: run.jobBoardUrl });
    run.running = false;
    await persistSearchState();
    await flushRemote();
    broadcast({ type: "run-ended" });
  });

  return { ok: true };
}

async function runLoop(settings) {
  status("Opening job board...");
  const boardTab = await chrome.tabs.create({ url: run.jobBoardUrl, active: true });
  run.boardTabId = boardTab.id;
  await waitForTabLoad(boardTab.id);
  await new Promise((r) => setTimeout(r, 2500)); // let dynamic content settle

  status("Scraping listings (Easy Apply only)...");
  const listings = await sendToTab(boardTab.id, { type: "scrapeListings" });
  const meta = listings?.meta || {};
  if (!listings || !Array.isArray(listings.jobs) || listings.jobs.length === 0) {
    const isLinkedInBoard = /linkedin\.com/i.test(run.jobBoardUrl || "");
    if (isLinkedInBoard && (meta.inspected || 0) === 0) {
      // We didn't even find any job-card anchors on a LinkedIn search page —
      // that means the listing selectors broke (or the search truly returned
      // nothing). Surface it clearly rather than a bland "no listings".
      flagSelectorsBroken("no-job-cards");
    } else if (meta.inspected > 0 && meta.rejectedNonEasy > 0) {
      status(
        `No Easy Apply jobs found (${meta.rejectedNonEasy} listings skipped — external redirects). Try filtering the search URL to Easy Apply only.`
      );
    } else {
      status("No listings found.");
    }
    run.running = false;
    await persistSearchState();
    await flushRemote();
    broadcast({ type: "run-ended" });
    return;
  }

  // Filter out jobs already recorded in jobLog as Applied
  const { jobLog = [] } = await chrome.storage.local.get("jobLog");
  const appliedUrls = new Set(
    jobLog
      .filter((j) => j.status === "Applied" || j.status === "Applied (unconfirmed)" || j.status === "already-applied")
      .map((j) => j.url)
  );

  const availableJobs = listings.jobs.filter((j) => !appliedUrls.has(j.url));
  if (availableJobs.length < listings.jobs.length) {
    status(`Skipped ${listings.jobs.length - availableJobs.length} previously applied job(s).`);
  }

  if (availableJobs.length === 0) {
    status("All Easy Apply listings on this page have already been applied to.");
    run.running = false;
    await persistSearchState();
    await flushRemote();
    broadcast({ type: "run-ended" });
    return;
  }

  status(
    `Found ${availableJobs.length} available Easy Apply listings (skipped ${meta.rejectedNonEasy || 0} external). Ranking against your criteria...`
  );
  const ranking = await rankJobs(availableJobs, run.criteria, settings);
  run.matchedJobs = ranking.filter((j) => j.shouldApply);
  if (run.maxJobs && run.matchedJobs.length > run.maxJobs) {
    status(`Capping to ${run.maxJobs} job(s) for this run (test mode).`);
    run.matchedJobs = run.matchedJobs.slice(0, run.maxJobs);
  }
  status(`Matched ${run.matchedJobs.length} of ${availableJobs.length} jobs.`);

  for (let i = 0; i < run.matchedJobs.length; i++) {
    if (run.stopRequested) break;
    await waitWhilePaused();
    if (run.stopRequested) break;

    run.currentIndex = i;
    const job = run.matchedJobs[i];

    try {
      await processJob(job, settings);
    } catch (e) {
      status(`Failed: ${job.company} — ${job.title}: ${e.message}`);
      await pushLog({
        company: job.company,
        role: job.title,
        url: job.url,
        status: "Failed",
        note: e.message
      });
      logRemote("failed", {
        company: job.company,
        role: job.title,
        jobUrl: job.url,
        message: e.message,
      });
    }

    run.batchCount++;
    await persistSearchState();

    // Stop early if the DOM changed under us — no point burning the rate limit.
    if (run.selectorsBroken) break;

    const isLast = i === run.matchedJobs.length - 1;
    if (run.batchCount >= settings.batchSize || isLast) {
      await runBatchCheckpoint(settings);
    }

    if (!isLast && !run.selectorsBroken) {
      status(`Waiting ${settings.rateLimitSeconds}s (rate limit)...`);
      await sleep(settings.rateLimitSeconds * 1000);
    }
  }

  // If every job we attempted failed structurally (e.g. only 1 job in test
  // mode), treat that as a likely layout change too.
  if (!run.selectorsBroken && run.attempts > 0 && run.structuralFailures === run.attempts) {
    flagSelectorsBroken("all-structural");
  }

  status(run.selectorsBroken ? "Auto-apply stopped (page changed)." : "Auto-apply run complete.");
  run.running = false;
  await persistSearchState();
  logRemote("run-ended", {
    reason: run.selectorsBroken ? "selectors-broken" : "complete",
    message: `attempts=${run.attempts || 0}, structuralFails=${run.structuralFailures || 0}`,
  });
  await flushRemote();
  broadcast({ type: "run-ended" });
}

async function rankJobs(listings, criteria, settings) {
  const kw = (criteria?.keywords || "").trim().toLowerCase();
  const hasKeywords = kw.length > 0;

  // Cap candidate listings sent to AI to avoid prompt bloat and response token truncation
  const limit = Math.min(listings.length, Math.max((run.maxJobs || 5) * 2, 12));
  const candidateListings = listings.slice(0, limit).map((l) => ({
    title: l.title,
    company: l.company || "Unknown",
    location: l.location || "",
    url: l.url
  }));

  try {
    const { system, user } = buildRankingPrompt(candidateListings, criteria);
    const result = await callLLM(system, user, settings.provider, settings.apiKey);
    if (Array.isArray(result) && result.length > 0) {
      const matchMap = new Map();
      for (const r of result) {
        if (r && r.url) {
          matchMap.set(r.url, r.shouldApply !== false);
        }
      }
      const matched = listings.filter((l) => matchMap.get(l.url) === true);
      if (matched.length > 0) {
        return matched.map((l) => ({
          ...l,
          shouldApply: true,
          reason: "Matched criteria"
        }));
      }
    }
  } catch (e) {
    if (/credit|402/i.test(e.message || "")) {
      status("AI credits low — proceeding with keyword-matched jobs.");
    } else {
      status(`AI ranking skipped (${e.message.slice(0, 45)}) — using search listings.`);
    }
  }

  // Fallback 1: Keyword matching if user provided keywords
  if (hasKeywords) {
    const words = kw.split(/\s+/).filter((w) => w.length > 2);
    const kwMatched = listings.filter((l) => {
      const text = `${l.title} ${l.company} ${l.description || ""}`.toLowerCase();
      return words.length === 0 || words.some((w) => text.includes(w));
    });
    if (kwMatched.length > 0) {
      return kwMatched.map((l) => ({
        ...l,
        shouldApply: true,
        reason: "Matched keyword search"
      }));
    }
  }

  // Fallback 2: Apply to all listings from the search page (user explicitly searched for them!)
  return listings.map((l) => ({
    ...l,
    shouldApply: true,
    reason: "Matched search criteria"
  }));
}

async function processJob(job, settings) {
  approvedJobUrl(job.url);
  if (run.stopRequested) return;
  status(`Opening: ${job.company} - ${job.title}`);
  const tab = await chrome.tabs.create({ url: job.url, active: true });
  run.applicationTabId = tab.id;
  await new Promise((r) => setTimeout(r, 500));
  await waitForTabLoad(tab.id);
  await new Promise((r) => setTimeout(r, 2500));
  await reviewApplication({
    job, tab, settings, send: sendToTab, ask: askUser, status,
    cancelled: () => run.stopRequested,
    generate: async (fields, profile) => {
      const { system, user } = buildFieldMappingPrompt(fields, profile);
      const mapping = await callLLM(system, user);
      return mapping?.fills || [];
    },
  });
  await pushLog({ company: job.company, role: job.title, url: job.url, status: 'Reviewed', note: 'Submission controlled by user in job page' });
}

async function runBatchCheckpoint(settings) {
  // If no jobs were held for manual review, continue without pausing
  if (run.heldQueue.length === 0) {
    run.batchCount = 0;
    return;
  }

  const held = run.heldQueue.map((h) => ({
    company: h.job.company,
    role: h.job.title,
    url: h.job.url,
    lowFields: h.lowFields
  }));

  const summary = {
    batchTotal: run.batchCount,
    heldCount: run.heldQueue.length,
    held
  };

  // Persist pending checkpoint so popup can restore it after being reopened.
  await chrome.storage.local.set({ pendingCheckpoint: summary });

  status(`Batch checkpoint: ${run.batchCount - run.heldQueue.length} applied, ${run.heldQueue.length} held. Open the popup and click Approve or Skip.`);
  broadcast({ type: "batch-checkpoint", summary });

  // Also nudge the extension icon so the user notices.
  try {
    await chrome.action.setBadgeText({ text: String(run.heldQueue.length || "!") });
    await chrome.action.setBadgeBackgroundColor({ color: "#f2c94c" });
  } catch (_) {}

  // Wait for popup to send approve-held-jobs or skip-held-jobs
  await new Promise((resolve) => {
    run.waiter = resolve;
  });
  run.waiter = null;

  await chrome.storage.local.remove("pendingCheckpoint");
  try { await chrome.action.setBadgeText({ text: "" }); } catch (_) {}

  run.batchCount = 0;
  await persistSearchState();
}

async function skipHeldJobs() {
  for (const held of run.heldQueue) {
    await pushLog({
      company: held.job.company,
      role: held.job.title,
      url: held.job.url,
      status: "Skipped",
      note: "Skipped from held queue"
    });
    chrome.tabs.remove(held.tabId).catch(() => {});
  }
  run.heldQueue = [];
}

// ---------- message handler (delegated from the main service worker) ----------

// Returns { handled: true, response } for auto-apply message types, otherwise
// { handled: false } so the caller can handle its own messages.
export async function handleAutoApplyMessage(msg) {
  switch (msg?.type) {
    case "start-auto-apply":
      return { handled: true, response: await startAutoApply(msg.payload) };
    case "pause":
      run.paused = true;
      await persistSearchState();
      status("Paused.");
      return { handled: true, response: { ok: true } };
    case "resume":
      run.paused = false;
      await persistSearchState();
      status("Resumed.");
      return { handled: true, response: { ok: true } };
    case "stop":
      run.stopRequested = true;
      run.paused = false;
      if (run.askWaiter) run.askWaiter({ skip: true });
      if (run.applicationTabId) await chrome.tabs.sendMessage(run.applicationTabId, { type: 'cancelApplication' }).catch(() => {});
      if (run.waiter) run.waiter();
      status("Stopping...");
      return { handled: true, response: { ok: true } };
    case "approve-held-jobs":
      return { handled: true, response: { ok: false, error: 'Review and submit each application in its job page.' } };
    case "skip-held-jobs":
      await skipHeldJobs();
      if (run.waiter) run.waiter();
      return { handled: true, response: { ok: true } };
    case "user-answers":
      if (run.askWaiter) {
        run.askWaiter({ answers: msg.answers || {}, remember: msg.remember || {}, skip: !!msg.skip });
      }
      return { handled: true, response: { ok: true } };
    case "get-apply-state":
      return {
        handled: true,
        response: {
          running: run.running,
          paused: run.paused,
          heldQueue: run.heldQueue.map((h) => ({
            company: h.job.company,
            role: h.job.title,
            url: h.job.url,
            lowFields: h.lowFields
          }))
        }
      };
    default:
      return { handled: false };
  }
}
