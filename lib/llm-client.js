// Provider-agnostic LLM client. Never logs the API key or resume.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Cheapest generally-available models per provider.
const ANTHROPIC_MODEL = "claude-3-5-haiku-latest";
const OPENAI_MODEL = "gpt-4.1-nano";

function stripFences(text) {
  if (!text) return text;
  let t = text.trim();
  // Strip leading ```json / ``` and trailing ```
  t = t.replace(/^```(?:json)?\s*/i, "");
  t = t.replace(/\s*```$/i, "");
  return t.trim();
}

function tryParseJson(text) {
  const cleaned = stripFences(text);
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Attempt to extract first JSON object/array
    const match = cleaned.match(/[\[{][\s\S]*[\]}]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e) {
        throw new Error("LLM returned non-JSON response");
      }
    }
    throw new Error("LLM returned non-JSON response");
  }
}

async function callAnthropic(systemPrompt, userPrompt, apiKey) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("");
  return text;
}

async function callOpenAI(systemPrompt, userPrompt, apiKey) {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 2000,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  return text;
}

export async function callLLM(systemPrompt, userPrompt, provider, apiKey) {
  if (!apiKey) throw new Error("Missing API key. Set it in the options page.");
  if (!provider) throw new Error("Missing LLM provider.");

  let raw;
  if (provider === "anthropic") {
    raw = await callAnthropic(systemPrompt, userPrompt, apiKey);
  } else if (provider === "openai") {
    raw = await callOpenAI(systemPrompt, userPrompt, apiKey);
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  return tryParseJson(raw);
}
