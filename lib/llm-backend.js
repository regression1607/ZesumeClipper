// Backend-backed LLM client for auto-apply. Instead of a user-provided
// Anthropic/OpenAI key, this routes prompts through Zesume's own AI endpoint
// (POST /api/ai/agent) using the user's logged-in session cookie. Drop-in
// replacement for lib/llm-client.js's callLLM(system, user, ...).

import { getApiUrl, ENDPOINTS } from "./config.js";

function stripFences(text) {
  if (!text) return text;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, "");
  t = t.replace(/\s*```$/i, "");
  return t.trim();
}

function tryParseJson(text) {
  const cleaned = stripFences(text);
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/[\[{][\s\S]*[\]}]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e) {
        throw new Error("AI returned non-JSON response");
      }
    }
    throw new Error("AI returned non-JSON response");
  }
}

// Signature-compatible with lib/llm-client.js — extra args (provider/apiKey)
// are ignored because auth is via the Zesume session cookie.
export async function callLLM(systemPrompt, userPrompt) {
  const apiUrl = await getApiUrl();
  const res = await fetch(`${apiUrl}${ENDPOINTS.agent}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ system: systemPrompt, user: userPrompt }),
  });

  if (res.status === 401) {
    throw new Error("Not signed in to Zesume — open Zesume and log in, then retry.");
  }
  if (res.status === 402) {
    const d = await res.json().catch(() => ({}));
    // Credit system: out of credits → point the user to top up.
    const msg = d?.code === "insufficient_credits"
      ? (d?.error || "Out of Zesume credits — buy more credits to keep auto-applying.")
      : (d?.error || "Not enough Zesume credits for this action.");
    const e = new Error(msg);
    e.code = "insufficient_credits";
    throw e;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Zesume AI error ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => ({}));
  return tryParseJson(data?.content || "");
}
