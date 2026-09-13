// Auto-apply engine (ported from the proven JobPilotAssist background worker).
// Exposed as handleAutoApplyMessage() so ZesumeClipper's single service-worker
// message router can delegate auto-apply message types to it.

import { callLLM } from "./llm-backend.js";
import { buildRankingPrompt, buildFieldMappingPrompt } from "./prompts.js";
import { logRemote, setRunId, flushRemote } from "./remote-log.js";
import { getApiUrl, ENDPOINTS } from "./config.js";

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
    workAuthorization: "Yes",
    sponsorshipRequired: "No",
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

function normalizeLabel(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/[*:?]+$/g, "").trim();
}

async function getAnswersMemory() {
  const { answersMemory = {} } = await chrome.storage.local.get("answersMemory");
  return answersMemory;
}

async function saveAnswersMemory(entries) {
  const mem = await getAnswersMemory();
  for (const [label, value] of Object.entries(entries)) {
    const key = normalizeLabel(label);
    if (!key) continue;
    mem[key] = value;
  }
  await chrome.storage.local.set({ answersMemory: mem });
}

function memoryFillsFor(fields, memory) {
  const fills = [];
  const usedSelectors = new Set();
  for (const f of fields) {
    const key = normalizeLabel(f.label);
    if (!key) continue;
    if (memory[key] !== undefined && memory[key] !== "") {
      fills.push({ selector: f.selector, value: memory[key], confidence: "high", source: "memory" });
      usedSelectors.add(f.selector);
    }
  }
  return { fills, usedSelectors };
}

async function askUser(questions, jobContext) {
  // Persist so popup can restore even if it was closed.
  await chrome.storage.local.set({
    pendingQuestions: { questions, jobContext, ts: Date.now() }
  });
  broadcast({ type: "ask-user", questions, jobContext });
  try {
    await chrome.action.setBadgeText({ text: "?" });
    await chrome.action.setBadgeBackgroundColor({ color: "#0a66c2" });
  } catch (_) {}

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

const STRUCTURAL_REASONS = new Set(["no-easy-apply-button", "modal-did-not-open"]);

function flagSelectorsBroken(detail) {
  if (run.selectorsBroken) return;
  run.selectorsBroken = true;
  run.stopRequested = true; // stop the run; retrying won't help until patched
  broadcast({ type: "selectors-broken", detail });
  logRemote("selectors-broken", {
    reason: detail,
    message: "LinkedIn layout appears changed — selectors need update",
  });
  status(
    "⚠️ LinkedIn's page structure appears to have changed — the auto-apply " +
    "selectors need an update. Stopping this run so nothing is submitted blindly."
  );
}

// Called once per job attempt with whether we could open Easy Apply and why not.
function noteApplyOutcome(ok, reason) {
  run.attempts = (run.attempts || 0) + 1;
  if (ok) {
    run.consecStructural = 0;
    return;
  }
  if (STRUCTURAL_REASONS.has(reason)) {
    run.structuralFailures = (run.structuralFailures || 0) + 1;
    run.consecStructural = (run.consecStructural || 0) + 1;
    // Two structural misses in a row is a strong signal the DOM changed.
    if (run.consecStructural >= 2) flagSelectorsBroken(reason);
  } else {
    // e.g. external-redirect / already-applied — not a layout break.
    run.consecStructural = 0;
  }
}

async function saveDebugDump(dump) {
  try {
    const { debugDumps = [] } = await chrome.storage.local.get("debugDumps");
    debugDumps.push({ ...dump, ts: Date.now() });
    // keep last 20
    while (debugDumps.length > 20) debugDumps.shift();
    await chrome.storage.local.set({ debugDumps });
  } catch (_) {}
  // Ship the button/dialog/field snapshot to the backend — this is what lets us
  // fix selectors after LinkedIn changes their DOM.
  logRemote("debug-dump", {
    reason: dump.stage,
    company: dump.job?.company,
    role: dump.job?.role,
    jobUrl: dump.job?.url,
    snapshot: dump.response,
  });
}

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
  for (let i = 0; i < retries; i++) {
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
  run.maxJobs = maxJobs || null;
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
  status(`Opening: ${job.company} — ${job.title}`);
  let hostname = "";
  try {
    hostname = new URL(job.url).hostname;
  } catch (_) {}
  const isLinkedIn = /(^|\.)linkedin\.com$/i.test(hostname);
  const isWellfound = /(^|\.)wellfound\.com$|(^|\.)angel\.co$/i.test(hostname);
  const board = isLinkedIn ? "linkedin" : isWellfound ? "wellfound" : "other";

  logRemote("job-open", {
    board,
    company: job.company,
    role: job.title,
    jobUrl: job.url,
  });
  const tab = await chrome.tabs.create({ url: job.url, active: true });
  await new Promise((r) => setTimeout(r, 500));
  await waitForTabLoad(tab.id);
  await new Promise((r) => setTimeout(r, 2500));

  if (isLinkedIn) {
    return await processLinkedInEasyApply(job, tab, settings);
  }
  if (isWellfound) {
    return await processWellfoundApply(job, tab, settings);
  }
  return await processGenericForm(job, tab, settings);
}

async function processLinkedInEasyApply(job, tab, settings) {
  status(`Opening Easy Apply modal: ${job.company}`);
  const opened = await sendToTab(tab.id, { type: "linkedinOpenEasyApply" });
  if (!opened?.ok) {
    noteApplyOutcome(false, opened?.reason);
    // Persist the full dump so we can inspect it after the fact.
    await saveDebugDump({
      stage: "linkedinOpenEasyApply",
      job: { company: job.company, role: job.title, url: job.url },
      response: opened
    });
    throw new Error(
      `Could not open Easy Apply modal: ${opened?.reason || "unknown"} (see "Export debug dump" in popup for full button list)`
    );
  }
  noteApplyOutcome(true);
  await new Promise((r) => setTimeout(r, 1500));

  const profile = {
    ...settings.profile,
    jobContext: { company: job.company, role: job.title }
  };

  const MAX_STEPS = 20;
  let lastStepSignature = null;
  let stalledCount = 0;
  let lastFilledSelectors = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const state = await sendToTab(tab.id, { type: "linkedinModalState" });
    if (!state?.inModal) {
      // Apply flow isn't open. Only "Applied" if LinkedIn confirmed submission;
      // otherwise it closed before we could submit — report it honestly.
      if (state?.confirmed) {
        await finalizeApplied(job, tab, "confirmed-before-step", true);
      } else if (step === 0) {
        throw new Error("Apply flow closed immediately after opening");
      } else {
        await pushLog({
          company: job.company,
          role: job.title,
          url: job.url,
          status: "Failed",
          note: "Apply flow closed before Submit — not submitted"
        });
        status(`Not submitted: ${job.company} — ${job.title} (closed early)`);
        setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 8000);
      }
      return;
    }

    // Empty fields only (LinkedIn pre-fill is preserved).
    const emptyFields = state.fields.filter((f) => {
      const cv = f.currentValue;
      return cv === "" || cv === false || cv === null || cv === undefined;
    });
    const prefilledCount = state.fields.length - emptyFields.length;

    status(
      `Step ${step + 1}: "${state.primaryButtonText || "?"}" — ${state.fields.length} field(s)` +
      (prefilledCount ? ` (${prefilledCount} pre-filled)` : "")
    );

    // 1) Apply saved memory to what we can answer directly.
    const memory = await getAnswersMemory();
    const { fills: memoryFills, usedSelectors: memoryUsed } = memoryFillsFor(emptyFields, memory);
    const stillMissing = emptyFields.filter((f) => !memoryUsed.has(f.selector));

    // 2) Ask LLM to fill the rest.
    let llmFills = [];
    if (stillMissing.length > 0) {
      const { system, user } = buildFieldMappingPrompt(stillMissing, profile);
      const mapping = await callLLM(system, user, settings.provider, settings.apiKey);
      llmFills = Array.isArray(mapping?.fills) ? mapping.fills : [];
    }

    // 3) Decide what to do with low-confidence LLM fills.
    //    - REQUIRED low-confidence fields → ask the user (we must answer them).
    //    - OPTIONAL low-confidence fields → skip entirely (leave empty) so
    //      optional / promotional steps (e.g. "Mark this job as a top choice")
    //      never block the run; we just click Next.
    const requiredOf = (selector) => {
      const src = stillMissing.find((s) => s.selector === selector);
      return !!(src && src.required);
    };
    const lowLLM = llmFills.filter((f) => f.confidence !== "high");
    const lowRequired = lowLLM.filter((f) => requiredOf(f.selector));
    const lowOptionalSelectors = new Set(
      lowLLM.filter((f) => !requiredOf(f.selector)).map((f) => f.selector)
    );
    // Drop optional guesses so we don't submit low-confidence junk.
    llmFills = llmFills.filter((f) => !lowOptionalSelectors.has(f.selector));

    if (lowRequired.length > 0) {
      const questions = lowRequired.map((f) => {
        const src = stillMissing.find((s) => s.selector === f.selector);
        return {
          selector: f.selector,
          label: src?.label || f.selector,
          type: src?.type || "text",
          options: src?.options || null,
          suggested: f.value
        };
      });
      status(`Need your input on ${questions.length} required field(s) for ${job.company}. Open the popup.`);
      const { answers = {}, remember = {} } = await askUser(questions, {
        company: job.company,
        role: job.title,
        step: step + 1
      });
      // Save memory
      if (Object.keys(remember).length > 0) await saveAnswersMemory(remember);
      // Merge user answers into fills
      const answerFills = Object.entries(answers).map(([selector, value]) => ({
        selector,
        value,
        confidence: "high",
        source: "user"
      }));
      // Replace low-confidence required LLM fills with the user's answers.
      const lowSelectors = new Set(lowRequired.map((f) => f.selector));
      llmFills = llmFills.filter((f) => !lowSelectors.has(f.selector)).concat(answerFills);
    }

    const allFills = [...memoryFills, ...llmFills];
    if (allFills.length > 0) {
      await sendToTab(tab.id, { type: "fillForm", fills: allFills });
      await new Promise((r) => setTimeout(r, 800));
    }
    lastFilledSelectors = allFills.map((f) => f.selector);

    // 4) Final Submit step.
    if (state.primaryKind === "submit") {
      status(`Filled all steps. Submitting in 4s... (${job.company})`);
      await new Promise((r) => setTimeout(r, 4000));
      const clicked = await sendToTab(tab.id, { type: "linkedinClickPrimary" });
      if (!clicked?.ok) throw new Error(`Submit click failed: ${clicked?.reason}`);
      if (clicked.closed) {
        // Submit was the last step and the flow closed. Trust it as applied,
        // but mark confirmed only if LinkedIn showed the "application sent" text.
        await finalizeApplied(job, tab, "submit-closed", clicked.confirmed !== false);
        return;
      }

      // Modal is still open after Submit → LinkedIn likely rejected a field.
      // Surface the errors to the user, apply their answers, and retry once.
      const postSubmit = await sendToTab(tab.id, { type: "linkedinModalState" });
      const blockers = (postSubmit?.fields || []).filter((f) => {
        const cv = f.currentValue;
        const empty = cv === "" || cv === false || cv === null || cv === undefined;
        return f.error || (empty && f.required);
      });
      if (postSubmit?.inModal && blockers.length > 0) {
        const questions = blockers.map((f) => ({
          selector: f.selector,
          label: f.error ? `${f.label} (LinkedIn: ${f.error})` : f.label,
          type: f.type,
          options: f.options || null
        }));
        status(`Submit blocked — LinkedIn needs ${questions.length} field(s) for ${job.company}. Open the popup.`);
        const { answers = {}, remember = {} } = await askUser(questions, {
          company: job.company,
          role: job.title,
          step: step + 1
        });
        if (Object.keys(remember).length > 0) await saveAnswersMemory(remember);
        const fills = Object.entries(answers).map(([selector, value]) => ({
          selector, value, confidence: "high", source: "user"
        }));
        if (fills.length > 0) {
          await sendToTab(tab.id, { type: "fillForm", fills });
          await new Promise((r) => setTimeout(r, 800));
        }
        // Loop back around so the multi-step handler re-evaluates and re-submits.
        continue;
      }

      // Submit was clicked but the modal is still open and shows no blockers —
      // treat as submitted-but-unconfirmed rather than a guaranteed success.
      await finalizeApplied(job, tab, "submit-clicked", false);
      return;
    }

    // 5) Click Next / Review and see what happens.
    const clicked = await sendToTab(tab.id, { type: "linkedinClickPrimary" });
    if (!clicked?.ok) {
      await saveDebugDump({
        job: { company: job.company, role: job.title, url: job.url },
        stage: "linkedinClickPrimary-advance",
        step: step + 1,
        response: clicked
      });
      throw new Error(`Advance click failed: ${clicked?.reason}`);
    }
    if (clicked.closed) {
      // The apply flow ended on a Next/Review step (NOT the Submit step). This
      // means the application was almost certainly NOT submitted. Only count it
      // as applied if LinkedIn actually confirmed submission; otherwise report
      // it honestly as not-submitted instead of a false "Applied".
      if (clicked.confirmed) {
        await finalizeApplied(job, tab, "submit-confirmed", true);
      } else {
        await pushLog({
          company: job.company,
          role: job.title,
          url: job.url,
          status: "Failed",
          note: "Apply flow closed before reaching Submit — not submitted"
        });
        status(`Not submitted: ${job.company} — ${job.title} (closed before Submit)`);
        setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 8000);
      }
      return;
    }
    // Give LinkedIn time to render the next step.
    await new Promise((r) => setTimeout(r, 2000));

    const afterState = await sendToTab(tab.id, { type: "linkedinModalState" });
    const afterSelectors = (afterState?.fields || []).map((f) => f.selector).sort();
    const signature = JSON.stringify({
      btn: afterState?.primaryButtonText,
      selectors: afterSelectors
    });

    if (signature === lastStepSignature) {
      stalledCount++;
    } else {
      stalledCount = 0;
    }
    lastStepSignature = signature;

    // A step is "blocked" if LinkedIn rendered validation errors, or if we
    // didn't advance and there are still empty required fields. React to
    // explicit errors immediately; fall back to stall detection otherwise.
    const fieldsAfter = afterState?.fields || [];
    const erroredFields = fieldsAfter.filter((f) => f.error);
    const emptyRequired = fieldsAfter.filter((f) => {
      const cv = f.currentValue;
      const empty = cv === "" || cv === false || cv === null || cv === undefined;
      return empty && f.required;
    });
    const filledSomethingLastStep = lastFilledSelectors.length > 0;

    const blockedByErrors = erroredFields.length > 0;
    const blockedByStall =
      stalledCount >= 2 && filledSomethingLastStep && emptyRequired.length > 0;

    if (blockedByErrors || blockedByStall) {
      // Prefer the erroring fields; otherwise ask about the empty required ones.
      const targetFields = (erroredFields.length ? erroredFields : emptyRequired);
      const questions = targetFields.map((f) => ({
        selector: f.selector,
        label: f.error ? `${f.label} (LinkedIn: ${f.error})` : f.label,
        type: f.type,
        options: f.options || null
      }));
      status(
        blockedByErrors
          ? `LinkedIn flagged ${questions.length} field(s) for ${job.company}. Open the popup.`
          : `Step stuck after fill. Asking you for ${questions.length} field(s).`
      );
      const { answers = {}, remember = {} } = await askUser(questions, {
        company: job.company,
        role: job.title,
        step: step + 1
      });
      if (Object.keys(remember).length > 0) await saveAnswersMemory(remember);
      const fills = Object.entries(answers).map(([selector, value]) => ({
        selector, value, confidence: "high", source: "user"
      }));
      if (fills.length > 0) {
        await sendToTab(tab.id, { type: "fillForm", fills });
        await new Promise((r) => setTimeout(r, 600));
      }
      stalledCount = 0;
    }
  }

  throw new Error(`Exceeded max modal steps (${MAX_STEPS}) without reaching Submit`);
}

async function finalizeApplied(job, tab, note, confirmed) {
  const finalStatus = confirmed ? "Applied" : "Applied (unconfirmed)";
  await pushLog({
    company: job.company,
    role: job.title,
    url: job.url,
    status: finalStatus,
    note
  });
  logRemote("applied", {
    company: job.company,
    role: job.title,
    jobUrl: job.url,
    reason: confirmed ? "confirmed" : "unconfirmed",
    message: note,
  });
  status(`${finalStatus}: ${job.company} — ${job.title}`);
  setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 12000);
}

function generateFallbackNote(questionLabel, job, profile) {
  const company = job?.company || "your team";
  const role = job?.title || "this position";

  if (profile?.coverLetterTemplate && profile.coverLetterTemplate.trim().length > 20) {
    return profile.coverLetterTemplate
      .replace(/\{company\}/gi, company)
      .replace(/\{role\}/gi, role);
  }

  const q = (questionLabel || "").toLowerCase();
  if (q.includes("interest") || q.includes("why") || q.includes("company") || q.includes("work")) {
    return `I am genuinely excited about the ${role} opening at ${company}. My engineering background and problem-solving skills align well with your team's mission, and I am eager to make a direct impact.`;
  }
  if (q.includes("experience") || q.includes("years") || q.includes("background")) {
    return `I have hands-on experience building and delivering reliable systems in fast-paced environments.`;
  }
  return `Hi, I am enthusiastic about the ${role} opportunity at ${company}. With my background and passion for problem solving, I would love to connect with your team.`;
}

async function processWellfoundApply(job, tab, settings) {
  status(`[1/4] Loaded job: ${job.company} — ${job.title}`);
  status(`[2/4] Clicking "Apply" on ${job.company}...`);
  const opened = await sendToTab(tab.id, { type: "wellfoundOpenApply" });
  if (!opened?.ok) {
    if (opened?.reason === "already-applied") {
      status(`ℹ️ Already applied to ${job.company || "job"} — skipping.`);
      await finalizeApplied(job, tab, "already-applied", true);
      return;
    }
    if (opened?.reason === "location-restricted") {
      status(`⚠️ ${job.company} not accepting from your location — skipping.`);
      await pushLog({
        company: job.company, role: job.title, url: job.url,
        status: "Skipped", note: "Location restricted"
      });
      setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 3000);
      return;
    }
    const checkState = await sendToTab(tab.id, { type: "wellfoundModalState" });
    if (!checkState?.inModal) {
      if (checkState?.confirmed) {
        status(`ℹ️ Previously applied to ${job.company} (confirmed) — skipping.`);
        await finalizeApplied(job, tab, "confirmed-on-open", true);
        return;
      }
      if (checkState?.locationRestricted) {
        status(`⚠️ ${job.company} not accepting from your location — skipping.`);
        await pushLog({
          company: job.company, role: job.title, url: job.url,
          status: "Skipped", note: "Location restricted"
        });
        setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 3000);
        return;
      }
      noteApplyOutcome(false, opened?.reason);
      throw new Error(`Could not open Wellfound apply modal (${opened?.reason || "button not found"})`);
    }
  }
  noteApplyOutcome(true);
  status(`[2/4] Application modal opened for ${job.company}.`);
  await new Promise((r) => setTimeout(r, 1200));

  let state = await sendToTab(tab.id, { type: "wellfoundModalState" });
  if (!state?.inModal) {
    if (state?.confirmed) {
      await finalizeApplied(job, tab, "confirmed-on-open", true);
      return;
    }
    throw new Error("Wellfound application modal not found");
  }

  // Check if modal immediately displays location restriction banner
  if (state?.locationRestricted) {
    status(`⚠️ ${job.company} not accepting from your location — skipping.`);
    await pushLog({
      company: job.company,
      role: job.title,
      url: job.url,
      status: "Skipped",
      note: "Location restricted (timezone/relocation constraints)"
    });
    setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 2000);
    return;
  }

  const profile = {
    ...settings.profile,
    jobContext: { company: job.company, role: job.title }
  };

  // STEP 1: Handle Location Combobox if present (REQUIRED FIRST by Wellfound)
  if (state.hasLocationInput || state.hasLocationError) {
    const preferredLoc = profile.location || state.jobLocation || "Bengaluru";
    status(`[3/4] Selecting city "${preferredLoc}" for ${job.company}...`);
    const locRes = await sendToTab(tab.id, { type: "wellfoundFillLocation", location: preferredLoc });
    status(`[3/4] Location set: ${locRes?.cityUsed || preferredLoc}.`);
    await new Promise((r) => setTimeout(r, 1200));
    state = await sendToTab(tab.id, { type: "wellfoundModalState" });
  }

  // PRE-FILL VALIDATION: If location is restricted or fields are disabled, skip BEFORE filling!
  const isLocationRestricted = state?.locationRestricted ||
                               state?.hasLocationError ||
                               state?.allTextareasDisabled;

  if (isLocationRestricted) {
    const reasonMsg = state?.locationErrorText || (state?.allTextareasDisabled ? "form disabled for location" : "location constraint");
    status(`⚠️ ${job.company} location requirement not met (${reasonMsg}) — skipping without filling.`);
    await pushLog({
      company: job.company,
      role: job.title,
      url: job.url,
      status: "Skipped",
      note: `Location requirement not met (${reasonMsg})`
    });
    setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 2000);
    return;
  }

  // STEP 2: Fill textareas (questions & pitch notes)
  const textareas = state.textareas || [];
  for (let tIdx = 0; tIdx < textareas.length; tIdx++) {
    const ta = textareas[tIdx];
    const qLabel = ta.label || "What interests you about working for this company?";
    status(`[3/4] Answering question ${tIdx + 1}/${textareas.length}: "${qLabel.slice(0, 45)}…"`);

    let answerText = "";
    if (profile.coverLetterTemplate && profile.coverLetterTemplate.trim().length > 20) {
      answerText = profile.coverLetterTemplate
        .replace(/\{company\}/gi, job.company)
        .replace(/\{role\}/gi, job.title);
    }

    if (!answerText || answerText.length < 20) {
      try {
        const pitchSystem =
          "You are an assistant answering a job application question on Wellfound. Keep the answer authentic, direct, and 2-3 sentences. No fluff. Return ONLY plain text.";
        const pitchUser = JSON.stringify({
          question: qLabel,
          candidate: {
            name: profile.name,
            skills: profile.resumeText ? profile.resumeText.slice(0, 1000) : "",
            location: profile.location
          },
          job: {
            company: job.company,
            role: job.title,
            description: job.description ? job.description.slice(0, 1000) : ""
          }
        });
        const aiRes = await callLLM(pitchSystem, pitchUser, settings.provider, settings.apiKey);
        answerText = typeof aiRes === "string" ? aiRes : (aiRes?.answer || aiRes?.note || aiRes?.content || "");
      } catch (e) {
        if (/credit|402/i.test(e.message || "")) {
          status("AI credits low — using profile template fallback.");
        }
        answerText = generateFallbackNote(qLabel, job, profile);
      }
    }

    if (!answerText) {
      answerText = generateFallbackNote(qLabel, job, profile);
    }

    await sendToTab(tab.id, {
      type: "wellfoundFillTextarea",
      selector: ta.selector,
      value: answerText.trim()
    });
    await new Promise((r) => setTimeout(r, 600));
  }

  // STEP 3: Fill any remaining form fields (radios, dropdowns, screening questions)
  const fills = [];
  const otherFields = (state.fields || []).filter(
    (f) => !f.type.includes("textarea") && !/downshift/i.test(f.selector)
  );
  if (otherFields.length > 0) {
    const memory = await getAnswersMemory();
    const { fills: memoryFills, usedSelectors } = memoryFillsFor(otherFields, memory);
    fills.push(...memoryFills);

    const remaining = otherFields.filter((f) => !usedSelectors.has(f.selector));
    if (remaining.length > 0) {
      try {
        const { system, user } = buildFieldMappingPrompt(remaining, profile);
        const mapping = await callLLM(system, user, settings.provider, settings.apiKey);
        const llmFills = Array.isArray(mapping?.fills) ? mapping.fills : [];
        fills.push(...llmFills.filter((f) => f.confidence === "high" || f.required));
      } catch (e) {
        for (const f of remaining) {
          if (f.options && f.options.length > 0) {
            const yesOpt = f.options.find((o) => /^(yes|authorized|eligible|true)/i.test(o));
            fills.push({ selector: f.selector, value: yesOpt || f.options[0], confidence: "high" });
          } else if (f.type === "number") {
            fills.push({ selector: f.selector, value: "2", confidence: "high" });
          }
        }
      }
    }
  }

  if (fills.length > 0) {
    status(`[3/4] Filling ${fills.length} screening fields for ${job.company}...`);
    await sendToTab(tab.id, { type: "fillForm", fills });
    await new Promise((r) => setTimeout(r, 800));
  }

  // STEP 4: Submit Application (waits for button to be enabled and clicks it)
  status(`[4/4] Submitting application to ${job.company}...`);
  const sendRes = await sendToTab(tab.id, { type: "wellfoundClickSend" });
  await new Promise((r) => setTimeout(r, 2000));
  if (!sendRes?.ok) {
    const errReason = sendRes?.error || "submit button disabled";
    status(`⚠️ ${job.company} could not submit (${errReason}) — skipping.`);
    await pushLog({
      company: job.company,
      role: job.title,
      url: job.url,
      status: "Skipped",
      note: `Could not submit: ${errReason}`
    });
    setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 2000);
    return;
  }

  await new Promise((r) => setTimeout(r, 2500));

  // Check confirmation
  const finalState = await sendToTab(tab.id, { type: "wellfoundModalState" });
  const confirmed = !finalState?.inModal || !!finalState?.confirmed || !!sendRes?.confirmed;
  await finalizeApplied(job, tab, "wellfound-applied", confirmed);
}

async function processGenericForm(job, tab, settings) {
  status(`Scraping form: ${job.company}`);
  const form = await sendToTab(tab.id, { type: "scrapeForm" });
  if (!form || !Array.isArray(form.fields) || form.fields.length === 0) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error("No form fields found on apply page");
  }

  const profile = {
    ...settings.profile,
    jobContext: { company: job.company, role: job.title }
  };
  const { system, user } = buildFieldMappingPrompt(form.fields, profile);
  const mapping = await callLLM(system, user, settings.provider, settings.apiKey);
  const fills = Array.isArray(mapping?.fills) ? mapping.fills : [];
  if (fills.length === 0) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error("LLM returned no fills");
  }

  status(`Filling form: ${job.company}`);
  await sendToTab(tab.id, { type: "fillForm", fills });

  const lowFields = fills.filter((f) => f.confidence !== "high");
  if (lowFields.length === 0) {
    status(`Filled. Submitting in 4s... (${job.company})`);
    await new Promise((r) => setTimeout(r, 4000));
    const submitResult = await sendToTab(tab.id, { type: "submitForm" });
    const finalStatus = submitResult?.confirmed ? "Applied" : "Applied (unconfirmed)";
    await pushLog({
      company: job.company,
      role: job.title,
      url: job.url,
      status: finalStatus,
      note: submitResult?.note || ""
    });
    status(`${finalStatus}: ${job.company} — ${job.title}`);
    setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 12000);
  } else {
    const flagged = lowFields.map((f) => f.selector).slice(0, 5).join(", ");
    status(`Held: ${job.company} — ${job.title} (uncertain: ${flagged})`);
    await pushLog({
      company: job.company,
      role: job.title,
      url: job.url,
      status: "Held",
      note: `Low-confidence fields: ${flagged}`
    });
    run.heldQueue.push({
      job,
      tabId: tab.id,
      lowFields: lowFields.map((f) => ({ selector: f.selector, value: f.value }))
    });
  }
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

async function approveHeldJobs() {
  const settings = await getSettings();
  for (const held of run.heldQueue) {
    if (run.stopRequested) break;
    try {
      let tabId = held.tabId;
      let alive = true;
      try {
        await chrome.tabs.get(tabId);
      } catch {
        alive = false;
      }
      const isLinkedIn = /(^|\.)linkedin\.com$/i.test(new URL(held.job.url).hostname);

      if (!alive) {
        const tab = await chrome.tabs.create({ url: held.job.url, active: true });
        await waitForTabLoad(tab.id);
        await new Promise((r) => setTimeout(r, 2500));
        tabId = tab.id;
        if (isLinkedIn) {
          // Re-run the multi-step flow but auto-submit on the final step regardless of confidence.
          await sendToTab(tabId, { type: "linkedinOpenEasyApply" });
          await new Promise((r) => setTimeout(r, 1500));
          for (let step = 0; step < 10; step++) {
            const state = await sendToTab(tabId, { type: "linkedinModalState" });
            if (!state?.inModal) break;
            if (state.fields.length > 0) {
              const profile = { ...settings.profile, jobContext: { company: held.job.company, role: held.job.title } };
              const { system, user } = buildFieldMappingPrompt(state.fields, profile);
              const mapping = await callLLM(system, user, settings.provider, settings.apiKey);
              await sendToTab(tabId, { type: "fillForm", fills: mapping.fills || [] });
              await new Promise((r) => setTimeout(r, 600));
            }
            const clicked = await sendToTab(tabId, { type: "linkedinClickPrimary" });
            if (clicked?.closed) break;
            await new Promise((r) => setTimeout(r, 600));
          }
        } else {
          try {
            const form = await sendToTab(tabId, { type: "scrapeForm" });
            const profile = { ...settings.profile, jobContext: { company: held.job.company, role: held.job.title } };
            const { system, user } = buildFieldMappingPrompt(form.fields, profile);
            const mapping = await callLLM(system, user, settings.provider, settings.apiKey);
            await sendToTab(tabId, { type: "fillForm", fills: mapping.fills || [] });
          } catch (_) {}
          await sendToTab(tabId, { type: "submitForm" });
        }
      } else {
        // Tab still open — just click through remaining steps / submit.
        if (isLinkedIn) {
          for (let step = 0; step < 5; step++) {
            const state = await sendToTab(tabId, { type: "linkedinModalState" });
            if (!state?.inModal) break;
            const clicked = await sendToTab(tabId, { type: "linkedinClickPrimary" });
            if (clicked?.closed) break;
            await new Promise((r) => setTimeout(r, 800));
          }
        } else {
          await sendToTab(tabId, { type: "submitForm" });
        }
      }

      await pushLog({
        company: held.job.company,
        role: held.job.title,
        url: held.job.url,
        status: "Applied",
        note: "Approved from held queue"
      });
      status(`Applied: ${held.job.company} — ${held.job.title}`);
      setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 8000);
    } catch (e) {
      await pushLog({
        company: held.job.company,
        role: held.job.title,
        url: held.job.url,
        status: "Failed",
        note: `Approve failed: ${e.message}`
      });
    }
    await sleep(3000);
  }
  run.heldQueue = [];
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
      if (run.waiter) run.waiter();
      status("Stopping...");
      return { handled: true, response: { ok: true } };
    case "approve-held-jobs":
      await approveHeldJobs();
      if (run.waiter) run.waiter();
      return { handled: true, response: { ok: true } };
    case "skip-held-jobs":
      await skipHeldJobs();
      if (run.waiter) run.waiter();
      return { handled: true, response: { ok: true } };
    case "user-answers":
      if (run.askWaiter) {
        run.askWaiter({ answers: msg.answers || {}, remember: msg.remember || {} });
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
