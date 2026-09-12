// Zesume Clipper — background service worker.
// Orchestrates: scrape JD from the active tab, check Zesume auth, list the
// user's resumes, and tailor a chosen resume to the clipped JD.
// All authenticated calls go directly to the Zesume app origin with the user's
// session cookies (credentials: "include"). No API keys are stored.

import { getApiUrl, getAppUrl, ENDPOINTS, ROUTES } from "../lib/config.js";
import { handleAutoApplyMessage } from "../lib/auto-apply.js";

// Open the native side panel when the toolbar action icon is clicked.
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn("setPanelBehavior error:", e));
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.windowId) return;
  try {
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (e) {
    console.warn("Failed to open side panel:", e);
  }
});

async function api(path, options = {}) {
  const apiUrl = await getApiUrl();
  const res = await fetch(`${apiUrl}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  return res;
}

// ---------- JD scraping ----------

async function scrapeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "No active tab" };

  const send = () => chrome.tabs.sendMessage(tab.id, { type: "scrapeJD" });
  try {
    return await send();
  } catch (_) {
    // Content script not injected yet (e.g. installed after page load) — inject then retry.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-scripts/jd-scraper.js"],
      });
      await new Promise((r) => setTimeout(r, 300));
      return await send();
    } catch (e) {
      return { ok: false, error: "Can't read this page (try a job posting page)." };
    }
  }
}

// ---------- Zesume API ----------

async function checkAuth() {
  try {
    const res = await api(ENDPOINTS.me);
    if (!res.ok) return { loggedIn: false, status: res.status };
    const user = await res.json().catch(() => null);
    return { loggedIn: true, user: user?.user || user };
  } catch (e) {
    return { loggedIn: false, error: e.message };
  }
}

async function listResumes() {
  const res = await api(ENDPOINTS.resumes);
  if (!res.ok) {
    if (res.status === 401) return { ok: false, unauthorized: true };
    return { ok: false, error: `Failed to load resumes (${res.status})` };
  }
  const data = await res.json().catch(() => ({}));
  const resumes = (data.resumes || data || []).map((r) => ({
    id: r._id || r.id,
    title: r.title || "Untitled Resume",
    atsScore: r.atsScore,
    updatedAt: r.updatedAt,
  }));
  return { ok: true, resumes };
}

async function tailor({ resumeId, jd }) {
  if (!resumeId || !jd) return { ok: false, error: "Pick a resume and clip a job first." };
  const res = await api(ENDPOINTS.tailor, {
    method: "POST",
    body: JSON.stringify({ resumeId, jd }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) return { ok: false, unauthorized: true };
    return { ok: false, error: data?.error || `Tailor failed (${res.status})`, code: data?.code };
  }
  // Open the editor to view the tailored resume.
  const appUrl = await getAppUrl();
  const id = data?.resume?._id || data?.resume?.id || resumeId;
  await chrome.tabs.create({ url: `${appUrl}${ROUTES.editorFor(id)}` });
  return { ok: true, resumeId: id };
}

async function openApp(pathOrRoute) {
  const appUrl = await getAppUrl();
  const path = pathOrRoute || ROUTES.newResume;
  await chrome.tabs.create({ url: `${appUrl}${path}` });
  return { ok: true };
}

// ---------- clip history ----------

async function saveClip(clip) {
  const { clips = [] } = await chrome.storage.local.get("clips");
  clips.unshift({ ...clip, ts: Date.now() });
  while (clips.length > 25) clips.pop();
  await chrome.storage.local.set({ clips });
  return { ok: true };
}

// ---------- message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // Delegate auto-apply message types to the ported engine first.
      const aa = await handleAutoApplyMessage(msg);
      if (aa.handled) {
        sendResponse(aa.response);
        return;
      }
      switch (msg?.type) {
        case "scrape":
          sendResponse(await scrapeActiveTab());
          break;
        case "check-auth":
          sendResponse(await checkAuth());
          break;
        case "list-resumes":
          sendResponse(await listResumes());
          break;
        case "tailor":
          sendResponse(await tailor(msg.payload || {}));
          break;
        case "open-app":
          sendResponse(await openApp(msg.path));
          break;
        case "save-clip":
          sendResponse(await saveClip(msg.clip || {}));
          break;
        default:
          sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async
});
