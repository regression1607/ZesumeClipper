import {
  DEFAULT_API_URL,
  DEFAULT_APP_URL,
  getApiUrl,
  getAppUrl,
  normalizeUrl,
} from "../lib/config.js";

const $ = (id) => document.getElementById(id);

function flash(text) {
  const note = $("saved");
  note.textContent = text;
  setTimeout(() => (note.textContent = ""), 2000);
}

async function load() {
  $("apiUrl").value = await getApiUrl();
  $("appUrl").value = await getAppUrl();
}

async function save() {
  const apiUrl = normalizeUrl($("apiUrl").value, DEFAULT_API_URL);
  const appUrl = normalizeUrl($("appUrl").value, DEFAULT_APP_URL);
  await chrome.storage.local.set({ apiUrl, appUrl });
  $("apiUrl").value = apiUrl;
  $("appUrl").value = appUrl;
  flash("Saved.");
}

$("save").addEventListener("click", save);
$("reset").addEventListener("click", async () => {
  await chrome.storage.local.set({ apiUrl: DEFAULT_API_URL, appUrl: DEFAULT_APP_URL });
  $("apiUrl").value = DEFAULT_API_URL;
  $("appUrl").value = DEFAULT_APP_URL;
  flash("Reset.");
});

// ---------- auto-apply profile settings ----------

async function loadAi() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const p = settings.profile || {};
  $("name").value = p.name || "";
  $("email").value = p.email || "";
  $("phone").value = p.phone || "";
  $("location").value = p.location || "";
  $("links").value = p.links || "";
  $("resumeText").value = p.resumeText || "";
  $("coverLetterTemplate").value = p.coverLetterTemplate || "";
  $("batchSize").value = settings.batchSize ?? 5;
  $("rateLimitSeconds").value = settings.rateLimitSeconds ?? 25;
}

async function saveAi() {
  const { settings: prev = {} } = await chrome.storage.local.get("settings");
  const settings = {
    ...prev,
    // AI runs through Zesume's backend — no provider/key stored.
    provider: "zesume",
    profile: {
      name: $("name").value,
      email: $("email").value,
      phone: $("phone").value,
      location: $("location").value,
      links: $("links").value,
      resumeText: $("resumeText").value,
      coverLetterTemplate: $("coverLetterTemplate").value,
    },
    batchSize: parseInt($("batchSize").value, 10) || 5,
    rateLimitSeconds: parseInt($("rateLimitSeconds").value, 10) || 25,
  };
  await chrome.storage.local.set({ settings });
  const note = $("saved-ai");
  note.textContent = "Saved.";
  setTimeout(() => (note.textContent = ""), 2000);
}

$("save-ai").addEventListener("click", saveAi);

load();
loadAi();
