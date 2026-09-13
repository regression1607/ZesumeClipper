import { getAppUrl, ROUTES } from "../lib/config.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let currentClip = null;

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text || "";
  el.className = `status ${kind}`;
}

// ---------- JD scraping ----------

async function scan() {
  setStatus("Reading this page…");
  const res = await send({ type: "scrape" });
  if (!res?.ok) {
    $("job-details").classList.add("hidden");
    $("job-empty").classList.remove("hidden");
    $("job-empty").innerHTML = res?.error
      ? escapeHtml(res.error)
      : "No job description found on this page.";
    currentClip = null;
    updateTailorEnabled();
    setStatus("");
    return;
  }
  currentClip = res;
  $("job-empty").classList.add("hidden");
  $("job-details").classList.remove("hidden");
  $("job-title").textContent = res.title || "(untitled role)";
  $("job-company").textContent = res.company || "";
  $("jd-chars").textContent = `${res.chars.toLocaleString()} chars`;
  send({ type: "save-clip", clip: { title: res.title, company: res.company, url: res.url } });
  updateTailorEnabled();
  setStatus("");
}

// ---------- auth + resumes ----------

async function refreshAuth() {
  const auth = await send({ type: "check-auth" });
  const dot = $("auth-dot");
  const text = $("auth-text");
  const action = $("auth-action");
  const chip = $("credits-chip");
  const buy = $("buy-credits");
  if (auth?.loggedIn) {
    dot.className = "dot on";
    const name = auth.user?.name || auth.user?.email || "your account";
    text.textContent = `Signed in as ${name}`;
    action.classList.add("hidden");
    // Show live credit balance + a top-up link.
    const bal = auth.user?.credits?.balance ?? 0;
    chip.textContent = `${bal} credit${bal === 1 ? "" : "s"}`;
    chip.classList.remove("hidden");
    buy.classList.remove("hidden");
    await loadResumes();
  } else {
    dot.className = "dot off";
    text.textContent = "Not signed in to Zesume";
    action.textContent = "Sign in";
    action.classList.remove("hidden");
    chip.classList.add("hidden");
    buy.classList.add("hidden");
    $("resume-select").innerHTML = '<option value="">Sign in to load resumes…</option>';
    $("resume-select").disabled = true;
    updateTailorEnabled();
  }
}

async function loadResumes() {
  const res = await send({ type: "list-resumes" });
  const sel = $("resume-select");
  if (!res?.ok) {
    sel.innerHTML = '<option value="">Couldn\'t load resumes</option>';
    sel.disabled = true;
    if (!res?.unauthorized) setStatus(res?.error || "Failed to load resumes", "err");
    updateTailorEnabled();
    return;
  }
  if (!res.resumes.length) {
    sel.innerHTML = '<option value="">No resumes yet — create one in Zesume</option>';
    sel.disabled = true;
    updateTailorEnabled();
    return;
  }
  sel.innerHTML = res.resumes
    .map((r) => `<option value="${r.id}">${escapeHtml(r.title)}</option>`)
    .join("");
  sel.disabled = false;
  updateTailorEnabled();
}

function updateTailorEnabled() {
  const sel = $("resume-select");
  const hasResume = sel && !sel.disabled && sel.value;
  const hasJD = !!(currentClip && currentClip.ok);
  $("tailor-btn").disabled = !(hasResume && hasJD);
  $("copy-jd").disabled = !hasJD;
}

// ---------- actions ----------

async function tailor() {
  const resumeId = $("resume-select").value;
  if (!resumeId || !currentClip) return;
  $("tailor-btn").disabled = true;
  setStatus("Tailoring your resume… this can take ~15s.");
  const res = await send({ type: "tailor", payload: { resumeId, jd: currentClip.jd } });
  if (res?.ok) {
    setStatus("Done! Opened the tailored resume in Zesume.", "ok");
  } else if (res?.unauthorized) {
    setStatus("Session expired — sign in to Zesume and try again.", "err");
    await refreshAuth();
  } else if (res?.code === "limit_reached") {
    setStatus(res.error || "AI limit reached — upgrade in Zesume.", "err");
  } else {
    setStatus(res?.error || "Tailoring failed.", "err");
  }
  updateTailorEnabled();
}

async function copyJD() {
  if (!currentClip?.jd) return;
  try {
    await navigator.clipboard.writeText(currentClip.jd);
    setStatus("Job description copied to clipboard.", "ok");
  } catch (_) {
    setStatus("Couldn't copy — select and copy manually.", "err");
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---------- wire up ----------

$("rescan").addEventListener("click", scan);
$("tailor-btn").addEventListener("click", tailor);
$("copy-jd").addEventListener("click", copyJD);
$("resume-select").addEventListener("change", updateTailorEnabled);
$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("close-panel").addEventListener("click", () => {
  window.close();
});
$("open-zesume").addEventListener("click", () => send({ type: "open-app", path: ROUTES.dashboard }));
$("buy-credits").addEventListener("click", () => send({ type: "open-app", path: ROUTES.pricing }));
$("auth-action").addEventListener("click", async () => {
  const appUrl = await getAppUrl();
  chrome.tabs.create({ url: `${appUrl}/login` });
});

// ---------- auto-apply (LinkedIn / Indeed) ----------

function appendFeed(text) {
  const feed = $("feed");
  feed.classList.remove("hidden");
  const line = document.createElement("div");
  const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  line.innerHTML = `<span class="t">[${t}]</span> ${escapeHtml(text)}`;
  feed.appendChild(line);
  feed.scrollTop = feed.scrollHeight;
  while (feed.children.length > 200) feed.removeChild(feed.firstChild);
}

function setApplyRunning(running) {
  const chip = $("apply-state");
  chip.classList.remove("hidden");
  chip.textContent = running ? "running" : "idle";
  chip.className = `chip ${running ? "running" : ""}`;
  $("auto-apply").classList.toggle("hidden", running);
  $("stop-apply").classList.toggle("hidden", !running);
}

async function startAutoApply() {
  const jobBoardUrl = $("board-url").value.trim();
  const maxJobs = parseInt($("max-jobs").value, 10) || 5;
  const keywords = $("criteria").value.trim() || currentClip?.title || "";
  if (!jobBoardUrl) {
    setStatus("Paste a LinkedIn / Indeed / Wellfound search results URL first.", "err");
    return;
  }

  // Check auth & credit balance before starting
  const auth = await send({ type: "check-auth" });
  if (!auth?.loggedIn) {
    setStatus("Sign in to Zesume first (top of this popup).", "err");
    return;
  }
  const balance = auth.user?.credits?.balance ?? 0;
  if (balance <= 0) {
    $("no-credits-banner")?.classList.remove("hidden");
    setStatus("You have 0 credits. Please buy credits first to apply.", "err");
    appendFeed("⚠️ You have 0 credits. Please buy credits first to use Auto Apply.");
    return;
  }

  // Check that at least 1 resume exists in Zesume
  const resumeRes = await send({ type: "list-resumes" });
  const resumeCount = resumeRes?.ok && Array.isArray(resumeRes.resumes) ? resumeRes.resumes.length : 0;
  if (resumeCount === 0) {
    $("no-resumes-banner")?.classList.remove("hidden");
    setStatus("Upload or create at least 1 resume in Zesume first.", "err");
    appendFeed("⚠️ No resume found in your Zesume account. Please create or upload a resume first.");
    return;
  }

  setApplyRunning(true);
  $("selectors-broken").classList.add("hidden");
  $("no-credits-banner")?.classList.add("hidden");
  $("no-resumes-banner")?.classList.add("hidden");
  appendFeed(`Starting auto-apply (up to ${maxJobs} job${maxJobs > 1 ? "s" : ""})…`);
  const res = await send({
    type: "start-auto-apply",
    payload: { criteria: { keywords }, jobBoardUrl, maxJobs },
  });
  if (!res?.ok) {
    setApplyRunning(false);
    appendFeed(`Couldn't start: ${res?.error || "unknown error"}`);
    if (/credit|buy/i.test(res?.error || "") || res?.code === "no_credits") {
      $("no-credits-banner")?.classList.remove("hidden");
      setStatus("You have 0 credits. Please buy credits first to apply.", "err");
    } else if (/resume/i.test(res?.error || "") || res?.code === "no_resumes") {
      $("no-resumes-banner")?.classList.remove("hidden");
      setStatus("Upload or create at least 1 resume in Zesume first.", "err");
    } else if (/profile|name\/email/i.test(res?.error || "")) {
      setStatus("Add your name & email in Options to enable auto-apply.", "err");
    } else if (/sign|log ?in|401/i.test(res?.error || "")) {
      setStatus("Sign in to Zesume first (top of this popup).", "err");
    }
  }
}

function showCheckpoint(summary) {
  const box = $("checkpoint");
  box.classList.remove("hidden");
  $("checkpoint-text").textContent =
    `Batch checkpoint: ${summary.batchTotal - summary.heldCount} applied, ${summary.heldCount} held.`;
}

function hideCheckpoint() {
  $("checkpoint").classList.add("hidden");
}


function renderQuestions(questions, jobContext) {
  const modal = $("questions-modal");
  if (!modal) return;
  modal.classList.remove("hidden");

  $("questions-job-company").textContent = jobContext?.company || "Job Application";
  $("questions-job-subtitle").textContent =
    `Required by ${jobContext?.company || "employer"} · Step ${jobContext?.step || 1}`;

  const list = $("questions-list");
  list.innerHTML = "";

  (questions || []).forEach((q, idx) => {
    const item = document.createElement("div");
    item.className = "question-item";

    const lbl = document.createElement("label");
    lbl.textContent = q.label || `Field ${idx + 1}`;
    item.appendChild(lbl);

    let inputEl;
    if (Array.isArray(q.options) && q.options.length > 0) {
      inputEl = document.createElement("select");
      inputEl.className = "input";
      const optDefault = document.createElement("option");
      optDefault.value = "";
      optDefault.textContent = "-- Select an option --";
      inputEl.appendChild(optDefault);

      q.options.forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        if (q.suggested && String(q.suggested).toLowerCase() === String(opt).toLowerCase()) {
          o.selected = true;
        }
        inputEl.appendChild(o);
      });
    } else if (q.type === "textarea") {
      inputEl = document.createElement("textarea");
      inputEl.rows = 3;
      inputEl.value = q.suggested || "";
    } else if (q.type === "number") {
      inputEl = document.createElement("input");
      inputEl.type = "number";
      inputEl.value = q.suggested || "";
    } else {
      inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.value = q.suggested || "";
    }

    inputEl.setAttribute("data-selector", q.selector);
    inputEl.setAttribute("data-label", q.label || q.selector);
    item.appendChild(inputEl);
    list.appendChild(item);
  });

  const firstInput = list.querySelector("input, select, textarea");
  if (firstInput) setTimeout(() => firstInput.focus(), 150);
}

function hideQuestions() {
  $("questions-modal")?.classList.add("hidden");
}

async function restoreApplyState() {
  const { searchState, statusFeed = [], pendingCheckpoint } =
    await chrome.storage.local.get(["searchState", "statusFeed", "pendingCheckpoint"]);
  if (statusFeed.length) {
    statusFeed.slice(-40).forEach((s) => appendFeed(s.text));
  }
  if (searchState?.running) setApplyRunning(true);
  if (pendingCheckpoint) showCheckpoint(pendingCheckpoint);

  const { pendingQuestions } = await chrome.storage.local.get("pendingQuestions");
  if (pendingQuestions && Array.isArray(pendingQuestions.questions) && pendingQuestions.questions.length > 0) {
    renderQuestions(pendingQuestions.questions, pendingQuestions.jobContext);
  }
}

// Live updates from the background engine.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.type) return;
  if (msg.type === "status") appendFeed(msg.text);
  else if (msg.type === "batch-checkpoint") showCheckpoint(msg.summary);
  else if (msg.type === "no-credits") {
    $("no-credits-banner")?.classList.remove("hidden");
    appendFeed("⚠️ Out of credits. Please buy credits to continue auto-applying.");
    setApplyRunning(false);
  } else if (msg.type === "selectors-broken") {
    $("selectors-broken").classList.remove("hidden");
    appendFeed("⚠️ LinkedIn's layout changed — auto-apply stopped. See the notice above.");
    setApplyRunning(false);
  } else if (msg.type === "run-ended") {
    hideQuestions();
    setApplyRunning(false);
    appendFeed("Auto-apply run ended.");
    refreshAuth(); // refresh the credit balance after a run
  } else if (msg.type === "ask-user") {
    renderQuestions(msg.questions, msg.jobContext);
    appendFeed(`Needs your input on ${msg.questions?.length || 0} field(s) for ${msg.jobContext?.company || "job"}.`);
  }
});

function reportIssue(context = "") {
  const manifest = chrome.runtime.getManifest();
  const version = manifest?.version || "0.1.0";
  const board = $("board-select")?.value || "unknown";
  const currentUrl = currentClip?.url || "";
  const company = currentClip?.company || "";
  const role = currentClip?.role || "";
  const subject = `[Zesume Clipper Issue] Selector / Auto-Apply feedback (${board})`;
  const body = [
    "Hi Zesume team,",
    "",
    "I am reporting an issue with Zesume Clipper Auto-Apply:",
    "----------------------------------------------------",
    `Job Board: ${board}`,
    `Extension Version: v${version}`,
    `Company: ${company}`,
    `Role: ${role}`,
    `Job Page URL: ${currentUrl}`,
    `Issue Summary: ${context || "Page layout changed / unhandled field / error encountered"}`,
    "",
    "[IMPORTANT: Please attach a screenshot of the job application page and paste any console logs or error messages below]",
    "",
    "----------------------------------------------------",
    "Console Logs & Additional Details:",
    "",
  ].join("\n");
  const mailto = `mailto:ekanshrajput1607@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  chrome.tabs.create({ url: mailto });
}

$("report-broken-btn")?.addEventListener("click", () => {
  reportIssue("Job board changed their page layout / apply controls could not be found.");
});
$("help-report-btn")?.addEventListener("click", () => {
  reportIssue();
});

$("dismiss-broken").addEventListener("click", () => {
  $("selectors-broken").classList.add("hidden");
});
$("buy-credits-banner-btn")?.addEventListener("click", () => {
  send({ type: "open-app", path: ROUTES.pricing });
});
$("dismiss-no-credits")?.addEventListener("click", () => {
  $("no-credits-banner")?.classList.add("hidden");
});
$("create-resume-btn")?.addEventListener("click", () => {
  send({ type: "open-app", path: ROUTES.newResume });
});
$("dismiss-no-resumes")?.addEventListener("click", () => {
  $("no-resumes-banner")?.classList.add("hidden");
});

$("submit-user-answers")?.addEventListener("click", async () => {
  const modal = $("questions-modal");
  const inputs = modal.querySelectorAll("[data-selector]");
  const answers = {};
  const remember = {};
  const shouldRemember = $("remember-answers-check")?.checked ?? true;

  inputs.forEach((inp) => {
    const selector = inp.getAttribute("data-selector");
    const label = inp.getAttribute("data-label");
    const val = inp.value ? inp.value.trim() : "";
    answers[selector] = val;
    if (shouldRemember && label && val) {
      remember[label] = val;
    }
  });

  hideQuestions();
  appendFeed(`Answers submitted for ${$("questions-job-company").textContent}. Resuming apply…`);
  await send({
    type: "user-answers",
    answers,
    remember
  });
});

$("skip-user-questions")?.addEventListener("click", async () => {
  hideQuestions();
  appendFeed(`Skipped ${$("questions-job-company").textContent} by user request.`);
  await send({
    type: "user-answers",
    answers: {},
    skip: true
  });
});

$("auto-apply").addEventListener("click", startAutoApply);
$("stop-apply").addEventListener("click", async () => {
  await send({ type: "stop" });
  setApplyRunning(false);
  appendFeed("Stopping…");
});
$("approve-held").addEventListener("click", async () => {
  hideCheckpoint();
  appendFeed("Approving held jobs…");
  await send({ type: "approve-held-jobs" });
});
$("skip-held").addEventListener("click", async () => {
  hideCheckpoint();
  appendFeed("Skipping held jobs…");
  await send({ type: "skip-held-jobs" });
});

// --- Persist the auto-apply inputs so they survive panel reopen/reload. ---
const APPLY_INPUTS_KEY = "applyInputs";
const applyInputFields = ["board-url", "criteria", "max-jobs", "board-select"];

// True once the user manually edits the URL — then we stop auto-overwriting it.
let boardUrlEdited = false;

async function restoreApplyInputs() {
  const { [APPLY_INPUTS_KEY]: saved } = await chrome.storage.local.get(APPLY_INPUTS_KEY);
  if (!saved) return;
  for (const id of applyInputFields) {
    if (saved[id] !== undefined && saved[id] !== "") {
      const el = $(id);
      el.value = saved[id];
      // If we restored a disabled option (like linkedin coming soon), force to wellfound
      if (id === "board-select" && el.options[el.selectedIndex]?.disabled) {
        el.value = "wellfound";
      }
    }
  }
  boardUrlEdited = !!saved.boardUrlEdited;
}

async function saveApplyInputs() {
  const data = { boardUrlEdited };
  for (const id of applyInputFields) data[id] = $(id).value;
  await chrome.storage.local.set({ [APPLY_INPUTS_KEY]: data });
}

// Location comes from the saved auto-apply profile in Options.
async function getSavedLocation() {
  const { settings } = await chrome.storage.local.get("settings");
  return (settings?.profile?.location || "").trim();
}

// Build a job-board search URL from board + keywords + saved location.
function buildBoardUrl(board, keywords, location) {
  const kw = (keywords || "").trim();
  const loc = (location || "").trim();
  if (board === "indeed") {
    const p = new URLSearchParams();
    if (kw) p.set("q", kw);
    if (loc) p.set("l", loc);
    return `https://www.indeed.com/jobs?${p.toString()}`;
  }
  if (board === "wellfound") {
    const p = new URLSearchParams();
    if (kw) p.set("q", kw);
    if (loc) p.set("location", loc);
    return `https://wellfound.com/jobs?${p.toString()}`;
  }
  // Default: LinkedIn Easy Apply search, jobs from the last 24h.
  const p = new URLSearchParams();
  if (kw) p.set("keywords", kw);
  if (loc) p.set("location", loc);
  p.set("f_AL", "true"); // Easy Apply only
  p.set("f_TPR", "r86400"); // past 24 hours
  p.set("origin", "JOB_SEARCH_PAGE_SEARCH_BUTTON");
  p.set("refresh", "true");
  return `https://www.linkedin.com/jobs/search/?${p.toString()}`;
}

// Rebuild the URL field from the current board + keywords + saved location,
// unless the user has manually overridden it.
async function syncBoardUrl({ force = false } = {}) {
  const location = await getSavedLocation();
  const hint = $("board-loc-hint");
  if (hint) {
    hint.textContent = location
      ? `Location: ${location} (from Options)`
      : "Tip: set your location in Options to target a city.";
  }
  if (boardUrlEdited && !force) return;
  const board = $("board-select").value;
  const keywords = $("criteria").value;
  $("board-url").value = buildBoardUrl(board, keywords, location);
  await saveApplyInputs();
}

// Board or keywords change → regenerate the URL (respecting manual overrides).
$("board-select").addEventListener("change", () => syncBoardUrl());
$("criteria").addEventListener("input", () => syncBoardUrl());
// Typing directly in the URL field marks it as a manual override.
$("board-url").addEventListener("input", () => {
  boardUrlEdited = true;
  saveApplyInputs();
});

for (const id of ["criteria", "max-jobs", "board-select"]) {
  $(id).addEventListener("change", saveApplyInputs);
}

// Initial load.
(async () => {
  await Promise.all([scan(), refreshAuth(), restoreApplyState(), restoreApplyInputs()]);
  // Fill the URL if it wasn't restored from a manual override.
  if (!$("board-url").value || !boardUrlEdited) await syncBoardUrl();
  else await syncBoardUrl(); // still refresh the location hint
})();
