/** Groq chat completions adapter. Returns the same response shape as the Gemini adapter. */
export async function generateGroq({
  apiKey, model, instructions, input, maxTokens, timeoutMs = 90_000,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error("Groq is not configured.");

  const response = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: input },
      ],
      reasoning_effort: "medium",
      max_completion_tokens: maxTokens,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    // Do not expose external provider errors or any API key to Android clients.
    const error = new Error(`Groq returned HTTP ${response.status}.`);
    error.status = response.status;
    if (response.status === 429) {
      const seconds = Number(response.headers?.get?.("retry-after"));
      error.retryAfterMs = Number.isFinite(seconds) && seconds > 0
        ? Math.min(seconds * 1000, 24 * 60 * 60 * 1000)
        : null;
    }
    throw error;
  }

  const body = await response.json();
  const choice = body.choices?.[0];
  const result = choice?.message?.content?.trim();
  if (!result || choice?.finish_reason === "length") {
    throw new Error("Groq produced an empty or incomplete answer.");
  }

  return {
    result,
    responseId: body.id || "",
    sources: [],
    usage: {
      inputTokens: body.usage?.prompt_tokens ?? null,
      outputTokens: body.usage?.completion_tokens ?? null,
    },
    provider: "groq",
    model,
  };
}

/**
 * Run Groq first when the caller does not require Google Search grounding.
 * Any Groq failure (including rate limits and timeouts) falls back to Gemini.
 * If web-search grounding is requested and enabled, go straight to Gemini.
 */
export async function generateWithFallback({
  groqEnabled, geminiEnabled, needsGrounding = false,
  runGroq, runGemini, onFallback = () => {},
}) {
  if (needsGrounding) {
    if (geminiEnabled) return runGemini();
    const error = new Error("Gemini is required for sourced research but is not configured.");
    error.status = 503;
    throw error;
  }

  if (groqEnabled) {
    try {
      return await runGroq();
    } catch (error) {
      if (!geminiEnabled) throw error;
      onFallback({ from: "groq", to: "google-gemini", status: error.status || null });
    }
  }

  if (geminiEnabled) return runGemini();
  const error = new Error("No AI provider is configured.");
  error.status = 503;
  throw error;
}


/**
 * In-memory protection for Groq's short-term token rate limit.
 * Does not modify quotas, prompts, or user study content.
 */
export function createGroqGuard({
  maxPromptChars = 20_000,
  minimumCooldownMs = 60_000,
  now = Date.now,
} = {}) {
  let cooldownUntil = 0;

  return {
    reason(promptChars) {
      // Large cumulative study stages should go directly to Gemini, not
      // repeatedly send a known-oversized request to Groq.
      if (promptChars > maxPromptChars) return "large_study_context";
      if (now() < cooldownUntil) return "rate_limit_cooldown";
      return null;
    },
    onGroqError({ status, retryAfterMs }) {
      if (status === 429) {
        const requestedWait = Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? Math.min(retryAfterMs, 24 * 60 * 60 * 1000)
          : 0;
        cooldownUntil = Math.max(
          cooldownUntil,
          now() + Math.max(minimumCooldownMs, requestedWait),
        );
      }
    },
    remainingCooldownMs() {
      return Math.max(0, cooldownUntil - now());
    },
  };
}

/**
 * A temporary overloaded Gemini service can recover after a short pause.
 * Only retry server-side 503 (not quota 429 or invalid credentials).
 */
export async function withGeminiAvailabilityRetry(
  task,
  { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    delayMs = 1250 } = {},
) {
  try {
    return await task();
  } catch (error) {
    const status = Number(error?.status || error?.code || 0);
    if (status !== 503) throw error;
    await sleep(delayMs);
    return task();
  }
}
