import test from "node:test";
import assert from "node:assert/strict";
import { generateGroq, generateWithFallback } from "../src/ai-providers.mjs";

const groqResult = { provider: "groq", result: "Narrative result" };
const geminiResult = { provider: "google-gemini", result: "Parsing result" };

test("Groq is the primary AI when both providers are available", async () => {
  let usedGemini = false;
  const result = await generateWithFallback({
    groqEnabled: true, geminiEnabled: true,
    runGroq: async () => groqResult,
    runGemini: async () => { usedGemini = true; return geminiResult; },
  });
  assert.equal(result, groqResult);
  assert.equal(usedGemini, false);
});

test("Groq 429 rate limits automatically fall back to Gemini", async () => {
  const notices = [];
  const result = await generateWithFallback({
    groqEnabled: true, geminiEnabled: true,
    runGroq: async () => { const e = new Error("rate limit"); e.status = 429; throw e; },
    runGemini: async () => geminiResult,
    onFallback: (notice) => notices.push(notice),
  });
  assert.equal(result, geminiResult);
  assert.equal(notices[0].status, 429);
});

test("Gemini remains functional when Groq is not configured", async () => {
  const result = await generateWithFallback({
    groqEnabled: false, geminiEnabled: true,
    runGroq: async () => { throw new Error("Groq should not run"); },
    runGemini: async () => geminiResult,
  });
  assert.equal(result, geminiResult);
});

test("Grounded web research chooses Gemini, not unsourced Groq", async () => {
  const result = await generateWithFallback({
    groqEnabled: true, geminiEnabled: true, needsGrounding: true,
    runGroq: async () => { throw new Error("Groq should not run"); },
    runGemini: async () => geminiResult,
  });
  assert.equal(result, geminiResult);
});

test("No available provider fails safely", async () => {
  await assert.rejects(generateWithFallback({
    groqEnabled: false, geminiEnabled: false,
  }), /No AI provider/);
});

test("Groq request and response are correctly formatted", async () => {
  let requestOptions;
  const output = await generateGroq({
    apiKey: "mock-secret", model: "openai/gpt-oss-120b",
    instructions: "Study faithfully", input: "John 1:1", maxTokens: 1000,
    fetchImpl: async (url, request) => {
      assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
      requestOptions = request;
      return { ok: true, json: async () => ({
        id: "chatcmpl-123",
        choices: [{ message: { content: "  Faithful study  " }, finish_reason: "stop" }],
        usage: { prompt_tokens: 200, completion_tokens: 500 },
      }) };
    },
  });
  assert.equal(output.result, "Faithful study");
  assert.equal(output.provider, "groq");
  assert.deepEqual(output.usage, { inputTokens: 200, outputTokens: 500 });
  assert.equal(JSON.parse(requestOptions.body).messages[0].content, "Study faithfully");
});

test("Incomplete Groq output is rejected for Gemini fallback", async () => {
  await assert.rejects(generateGroq({
    apiKey: "mock-secret", model: "any", instructions: "", input: "", maxTokens: 3,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "truncated" }, finish_reason: "length" }],
      }),
    }),
  }), /incomplete/);
});
