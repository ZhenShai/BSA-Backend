import http from "node:http";
import crypto from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { buildInput, buildInstructions } from "./prompts.mjs";
import { validateStudyRequest, ValidationError } from "./validation.mjs";

const port = integerEnv("PORT", 8787);
const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const appToken = process.env.BSA_APP_TOKEN || "";
const enableWebSearch = process.env.ENABLE_WEB_SEARCH === "true";
const trustProxy = process.env.TRUST_PROXY === "true";
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean),
);

const maxRequests = integerEnv("MAX_REQUESTS_PER_WINDOW", 20);
const rateWindowMs = integerEnv("RATE_WINDOW_MS", 15 * 60 * 1000);
const geminiTimeoutMs = integerEnv(
  "GEMINI_TIMEOUT_MS",
  integerEnv("OPENAI_TIMEOUT_MS", 180_000),
);
const standardTokens = integerEnv("MAX_OUTPUT_TOKENS_STANDARD", 8_000);
const finalTokens = integerEnv("MAX_OUTPUT_TOKENS_FINAL", 14_000);
const rateBuckets = new Map();
const rateCleanup = setInterval(() => {
  const cutoff = Date.now() - rateWindowMs;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.startedAt < cutoff) rateBuckets.delete(key);
  }
}, rateWindowMs).unref();

let gemini;
function getGemini() {
  if (!process.env.GEMINI_API_KEY) {
    throw new ServerConfigError("The server GEMINI_API_KEY is not configured.");
  }
  gemini ||= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return gemini;
}

const server = http.createServer(async (request, response) => {
  const requestId = crypto.randomUUID();
  setSecurityHeaders(response, request, requestId);

  if (request.method === "OPTIONS") {
    response.writeHead(originAllowed(request) ? 204 : 403).end();
    return;
  }

  if (!originAllowed(request)) {
    sendJson(response, 403, { message: "Origin is not allowed.", requestId });
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "biblical-study-assistant-backend",
      provider: "google-gemini",
      model,
      apiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
    });
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/study") {
    sendJson(response, 404, { message: "Not found.", requestId });
    return;
  }

  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    sendJson(response, 415, { message: "Content-Type must be application/json.", requestId });
    return;
  }

  if (!authenticate(request)) {
    sendJson(response, 401, { message: "The app is not authorized to use this server.", requestId });
    return;
  }

  const rate = takeRateSlot(clientAddress(request));
  if (!rate.allowed) {
    response.setHeader("Retry-After", Math.ceil(rate.retryAfterMs / 1000));
    sendJson(response, 429, { message: "Too many study requests. Please wait and try again.", requestId });
    return;
  }

  const startedAt = Date.now();

  try {
    const rawBody = await readJsonBody(request, 1_500_000);
    const studyRequest = validateStudyRequest(rawBody);

    const tools =
      studyRequest.includeSources && enableWebSearch
        ? [{ googleSearch: {} }]
        : undefined;

    const apiResponse = await getGemini().models.generateContent({
      model,
      contents: buildInput(studyRequest),
      config: {
        systemInstruction: buildInstructions(studyRequest),
        maxOutputTokens:
          studyRequest.stage === "FINAL_RESULT" ? finalTokens : standardTokens,
        httpOptions: {
          timeout: geminiTimeoutMs,
        },
        ...(tools ? { tools } : {}),
      },
    });

    const result = apiResponse.text?.trim();
    if (!result) throw new Error("The model returned an empty result.");

    const sources = extractSources(apiResponse);

    sendJson(response, 200, {
      result,
      responseId: apiResponse.responseId || "",
      sources,
      usage: {
        inputTokens: apiResponse.usageMetadata?.promptTokenCount ?? null,
        outputTokens: apiResponse.usageMetadata?.candidatesTokenCount ?? null,
      },
    });

    console.info(JSON.stringify({
      requestId,
      status: 200,
      provider: "google-gemini",
      model,
      stage: studyRequest.stage,
      operation: studyRequest.operation,
      durationMs: Date.now() - startedAt,
      responseId: apiResponse.responseId || null,
      inputTokens: apiResponse.usageMetadata?.promptTokenCount ?? null,
      outputTokens: apiResponse.usageMetadata?.candidatesTokenCount ?? null,
    }));
  } catch (error) {
    const mapped = mapError(error);
    sendJson(response, mapped.status, { message: mapped.message, requestId });

    console.error(JSON.stringify({
      requestId,
      status: mapped.status,
      provider: "google-gemini",
      error: error?.name || "Error",
      detail: safeErrorMessage(error),
      durationMs: Date.now() - startedAt,
    }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.info(
    `Biblical Study Assistant backend listening on port ${port} using ${model}.`,
  );
});

function originAllowed(request) {
  const origin = request.headers.origin;
  return !origin || (allowedOrigins.size > 0 && allowedOrigins.has(origin));
}

function setSecurityHeaders(response, request, requestId) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Request-Id", requestId);

  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-BSA-Client",
    );
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
}

function authenticate(request) {
  if (!appToken) return true;

  const header = request.headers.authorization || "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedBuffer = Buffer.from(appToken);
  const candidateBuffer = Buffer.from(candidate);

  return (
    expectedBuffer.length === candidateBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, candidateBuffer)
  );
}

function clientAddress(request) {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (forwarded) {
      return String(Array.isArray(forwarded) ? forwarded[0] : forwarded)
        .split(",")[0]
        .trim();
    }
  }

  return String(request.socket.remoteAddress || "unknown");
}

function takeRateSlot(key) {
  const now = Date.now();
  const existing = rateBuckets.get(key);

  if (!existing || now - existing.startedAt >= rateWindowMs) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (existing.count >= maxRequests) {
    return {
      allowed: false,
      retryAfterMs: rateWindowMs - (now - existing.startedAt),
    };
  }

  existing.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

async function readJsonBody(request, byteLimit) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > byteLimit) throw new PayloadTooLargeError();

  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > byteLimit) throw new PayloadTooLargeError();
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) throw new ValidationError("The request body is empty.");

  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("The request body is not valid JSON.");
  }
}

function extractSources(apiResponse) {
  const unique = new Map();

  for (const candidate of apiResponse.candidates || []) {
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];

    for (const chunk of chunks) {
      const web = chunk?.web;
      if (!web?.uri) continue;

      if (!unique.has(web.uri)) {
        unique.set(web.uri, {
          title: web.title || web.uri,
          url: web.uri,
        });
      }
    }
  }

  return [...unique.values()];
}

function mapError(error) {
  if (error instanceof ValidationError) {
    return { status: 400, message: error.message };
  }

  if (error instanceof PayloadTooLargeError) {
    return { status: 413, message: "The study request is too large." };
  }

  if (error instanceof ServerConfigError) {
    return { status: 503, message: error.message };
  }

  const status = Number(error?.status || error?.code || 0);

  if (status === 429) {
    return {
      status: 429,
      message:
        "The AI service is busy or the Gemini usage limit was reached. Please wait and retry.",
    };
  }

  if (status === 401 || status === 403) {
    return {
      status: 503,
      message:
        "The secure AI server cannot authenticate with Gemini. Check the Gemini API key in Render.",
    };
  }

  if (
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    /timeout|timed out/i.test(String(error?.message || ""))
  ) {
    return {
      status: 504,
      message:
        "The study request took too long. Your saved work is safe. Please retry.",
    };
  }

  return {
    status: 502,
    message:
      "Unable to complete the study request. Your saved work is safe. Please try again.",
  };
}

function safeErrorMessage(error) {
  const message = String(error?.message || "");
  return message
    .replaceAll(process.env.GEMINI_API_KEY || "__NO_KEY__", "[REDACTED]")
    .slice(0, 500);
}

function sendJson(response, status, payload) {
  if (response.writableEnded) return;
  response.writeHead(status).end(JSON.stringify(payload));
}

function integerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

class PayloadTooLargeError extends Error {}
class ServerConfigError extends Error {}

function shutdown(signal) {
  console.info(`${signal} received; shutting down.`);
  clearInterval(rateCleanup);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
