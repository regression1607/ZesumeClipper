// Shared config for Zesume Clipper.
// Zesume runs on TWO origins:
//   - API/backend  (serves /api/*, sets the session cookie)
//   - Frontend app (SPA routes like /dashboard, /r/:id, /login)
// Both are user-configurable in Options.

// Backend API server (from VITE_APP_URL).
export const DEFAULT_API_URL = "https://api.zesume.in";
// Frontend SPA (from VITE_API_URL — where the app is served).
export const DEFAULT_APP_URL = "https://zesume.in";

// Endpoint paths (relative to the API origin) — in sync with
// Zesume-frontend/src/config/api.config.js.
export const ENDPOINTS = {
  me: "/api/auth/me",
  resumes: "/api/resumes",
  tailor: "/api/ai/tailor",
  agent: "/api/ai/agent",
  autoApplyLog: "/api/auto-apply/log",
  loginGoogle: "/api/auth/google",
};

// Frontend route builders — in sync with routes.config.js.
export const ROUTES = {
  login: "/login",
  newResume: "/new",
  dashboard: "/dashboard",
  pricing: "/pricing",
  editorFor: (id) => `/r/${id}`,
};

export function normalizeUrl(url, fallback) {
  let u = String(url || "").trim();
  if (!u) return fallback;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, "");
}

// The backend origin used for /api calls.
export async function getApiUrl() {
  const { apiUrl } = await chrome.storage.local.get("apiUrl");
  return normalizeUrl(apiUrl, DEFAULT_API_URL);
}

// The frontend origin used to open app routes.
export async function getAppUrl() {
  const { appUrl } = await chrome.storage.local.get("appUrl");
  return normalizeUrl(appUrl, DEFAULT_APP_URL);
}
