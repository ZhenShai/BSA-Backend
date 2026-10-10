# BSA-Backend — eBiblical Study

Secure backend for the **eBiblical Study** Android application, using Groq as the primary AI and Google Gemini as backup.

## How AI routing works

- **Groq first**: Requests use the `GROQ_MODEL` model (default `openai/gpt-oss-120b`) when `GROQ_API_KEY` is configured.
- **Gemini backup**: If Groq fails, times out, reaches a rate limit, or returns an empty/incomplete answer, the same study request is sent to Gemini.
- **Source-backed research**: If `ENABLE_WEB_SEARCH=true` and the request sets `includeSources=true`, the backend chooses Gemini with Google Search grounding. Groq is not used for this path, so citations are not silently lost.
- **Gemini-only mode**: If no Groq key is configured, Gemini continues to work exactly as before.
- **No paid OpenAI usage**: The `OPENAI_API_KEY` environment variable is not used by this backend.

## Render environment

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Secret Groq API key (store only in Render, never in the Android app). |
| `GROQ_MODEL` | Optional; defaults to `openai/gpt-oss-120b`. |
| `GEMINI_API_KEY` | Secret Gemini API key, retained for automatic backup. |
| `GEMINI_MODEL` | Optional; preserves existing model setting. |
| `GROQ_TIMEOUT_MS` | Optional; default 90000 milliseconds. |
| `GEMINI_TIMEOUT_MS` | Optional; preserves existing timeout. |
| `ENABLE_WEB_SEARCH` | Optional; when `true`, sourced requests use Gemini grounding. |
| `BSA_APP_TOKEN` | Existing application authentication secret; do not remove. |

## Free-tier safeguards

Groq's free GPT-OSS 120B quota includes 8,000 tokens per minute, which can be reached well before 1,000 daily requests on a long Bible study. This does not mean the daily request limit is exhausted.

- `GROQ_MAX_PROMPT_CHARS` (default `20000`): A conservative preflight text-size safeguard. Very large multi-stage study inputs go directly to Gemini; nothing is truncated or deleted. Character count is only an approximation of token cost, not an exact tokenizer.
- `GROQ_MAX_COMPLETION_TOKENS` (default `6000`): Caps **only Groq** output allowance; the Gemini settings remain unchanged. Incomplete Groq generations fall back to Gemini.
- After a Groq `429`, the backend respects the `Retry-After` response header, with at least 60 seconds of cooldown, so repeated stages do not waste time making predictably rejected Groq calls.
- Gemini is retried **once** after a transient `503` overload, with a short delay. API authentication errors and daily quota errors are never retried automatically.
- The ordinary app rate limiter still defaults to `MAX_REQUESTS_PER_WINDOW=20` per client address every `RATE_WINDOW_MS=900000` (15 minutes); this is separate from Groq quotas.

These protections work in memory on each Render instance. The best long-term option for many simultaneous users is a shared rate budget; the free plan does not include that automatically.

For both providers, requests continue to pass through the same `POST /v1/study` endpoint. Response fields `result`, `responseId`, `sources`, and `usage` are unchanged. Additional response fields `provider` and `model` identify the service that answered.

`GET /health` reports which providers are configured, without returning API keys.

## Run and test

Requires Node.js 20 or newer.

```bash
npm install
npm test
npm start
```

Tests use simulated provider responses and do not consume API quota. They check primary routing, fallback, source-grounded requests, and response normalization.

## Important notes

A successful unit test does **not** verify that a live Groq or Gemini key is accepted. After deploying, confirm `GET /health` and generate a short Bible study in the Android app. Check Render logs for which provider handled it. Free provider plans have rate and token limits. Long studies can exceed Groq's free quota and require fallback.
