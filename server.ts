import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { generateLyria, listGenerations, LyriaValidationError, analyzeGeneration, AnalysisNotFoundError, renameGeneration, GenerationNotFoundError, InvalidIdError, MissingKeyError, mockModifyText, mockEnhancePrompt, mapOpenRouterCreditsResponse } from "./server/lyria";
import type { AnalyzeGenerationCallAiArgs } from "./server/lyria";
import { listProjects, createProject, updateProject, archiveProject, ProjectNotFoundError } from "./server/projects";
import { resolveKeys, numberedEnvValues, withKeyFailover, AllKeysFailedError } from "./server/keys";
import type { KeyAttempt } from "./server/keys";

// .env.local (documented setup) wins over .env; real environment variables win over both.
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

type ProviderName = 'gemini' | 'openrouter';

/** Message kept identical to the pre-failover one so the Settings UI copy still matches. */
const MISSING_KEY_MESSAGE: Record<ProviderName, string> = {
  gemini: "GEMINI_API_KEY is not configured. Please add it in the Settings.",
  openrouter: "OPENROUTER_API_KEY is not configured. Please add it in the Settings.",
};

/** Builds a client for one specific key — key selection/failover happens in the routes. */
function getAiClient(apiKey: string): GoogleGenAI {
  if (!apiKey) {
    throw new MissingKeyError(MISSING_KEY_MESSAGE.gemini);
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'lyria-3-pro',
      }
    }
  });
}

function resolveProvider(req: express.Request): ProviderName {
  const headerProvider = req.headers['x-ai-provider'] as string | undefined;
  const provider = headerProvider || process.env.AI_PROVIDER || 'gemini';
  return provider === 'openrouter' ? 'openrouter' : 'gemini';
}

/** A repeated header arrives as an array; join it so it parses as one comma-separated list. */
function headerValue(req: express.Request, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw.join(',') : raw;
}

/**
 * Ordered Gemini keys for this request: browser list header, then the legacy single
 * header, then GEMINI_API_KEY (which may itself be a list), then GEMINI_API_KEY_2, _3...
 * parseKeyList inside resolveKeys drops blanks, duplicates and the MY_GEMINI_API_KEY
 * placeholder shipped in .env.example.
 */
function resolveGeminiKeys(req: express.Request): string[] {
  return resolveKeys({
    listHeader: headerValue(req, 'x-gemini-api-keys'),
    singleHeader: headerValue(req, 'x-gemini-api-key'),
    env: process.env.GEMINI_API_KEY,
    numberedEnv: numberedEnvValues(process.env, 'GEMINI_API_KEY'),
  });
}

/** Ordered OpenRouter keys for this request; same precedence as resolveGeminiKeys. */
function resolveOpenRouterKeys(req: express.Request): string[] {
  return resolveKeys({
    listHeader: headerValue(req, 'x-openrouter-api-keys'),
    singleHeader: headerValue(req, 'x-openrouter-api-key'),
    env: process.env.OPENROUTER_API_KEY,
    numberedEnv: numberedEnvValues(process.env, 'OPENROUTER_API_KEY'),
  });
}

/** Keys the SERVER itself holds (no request headers) — used by /api/settings/status counts. */
function resolveServerKeys(prefix: 'GEMINI_API_KEY' | 'OPENROUTER_API_KEY'): string[] {
  return resolveKeys({
    env: process.env[prefix],
    numberedEnv: numberedEnvValues(process.env, prefix),
  });
}

function resolveProviderKeys(req: express.Request, provider: ProviderName): string[] {
  return provider === 'openrouter' ? resolveOpenRouterKeys(req) : resolveGeminiKeys(req);
}

/** Same as resolveProviderKeys but turns "nothing configured at all" into the 400 the UI expects. */
function requireProviderKeys(req: express.Request, provider: ProviderName): string[] {
  const keys = resolveProviderKeys(req, provider);
  if (!keys.length) {
    throw new MissingKeyError(MISSING_KEY_MESSAGE[provider]);
  }
  return keys;
}

/**
 * Carries the upstream HTTP status on the Error so isKeyFault() in server/keys.ts can tell a
 * key problem (401/402/403/429 → try the next key) from a request problem (fail immediately).
 * Without this, an upstream body like `{"error":{"message":"User not found.","code":401}}`
 * would never be recognised as a key fault.
 */
class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Defence in depth: upstream error bodies are outside our control, so any configured key that
 * one of them echoed back is stripped before the text reaches a log, a header or a response.
 */
function redactKeys(text: string, keys: string[]): string {
  let out = text;
  for (const key of keys) {
    if (key.length < 8) continue; // too short to be a real key; avoid mangling unrelated text
    out = out.split(key).join('[redacted]');
  }
  return out;
}

/** Key-free, single-line, ASCII-only JSON for the x-lyria-key-attempts header. */
function attemptsHeaderValue(attempts: KeyAttempt[], keys: string[]): string {
  const compact = attempts.map(a => ({
    index: a.index,
    status: a.status,
    reason: redactKeys(a.reason, keys).replace(/[^\x20-\x7e]/g, ' ').slice(0, 160),
  }));
  // Headers must stay small, and truncating a JSON string would produce invalid JSON —
  // so drop detail in steps instead, keeping the value parseable at every step.
  let json = JSON.stringify(compact);
  if (json.length > 1000) json = JSON.stringify(compact.map(a => ({ ...a, reason: a.reason.slice(0, 40) })));
  if (json.length > 1000) json = JSON.stringify(compact.map(a => ({ index: a.index, status: a.status })));
  return json;
}

/** Reports which key was accepted, and which were rejected first, on a successful response. */
function setKeyHeaders(res: express.Response, usedIndex: number, attempts: KeyAttempt[], keys: string[]): void {
  if (res.headersSent) return;
  res.setHeader('x-lyria-key-index', String(usedIndex));
  if (attempts.length) {
    res.setHeader('x-lyria-key-attempts', attemptsHeaderValue(attempts, keys));
  }
}

/** Maps the final rejection onto an HTTP status: auth → 401, credit → 402, quota → 429, else 502. */
function keyFailureStatus(attempts: KeyAttempt[]): number {
  const statuses = attempts.map(a => a.status).filter((s): s is number => typeof s === 'number');
  const last = statuses.length ? statuses[statuses.length - 1] : undefined;
  if (last === 401 || last === 403) return 401;
  if (last === 402) return 402;
  if (last === 429) return 429;
  return 502;
}

/**
 * Terminal response for "every configured key was rejected". `error` stays the flat string the
 * client already reads; `attempts` lists each rejected key by index only — describeFailure()
 * never includes key material, and redactKeys() is a second guard over the upstream text.
 */
function sendKeyFailure(res: express.Response, error: AllKeysFailedError, keys: string[]) {
  const attempts = error.attempts.map(a => ({
    index: a.index,
    status: a.status,
    reason: redactKeys(a.reason, keys),
  }));
  return res.status(keyFailureStatus(error.attempts)).json({
    error: redactKeys(error.message, keys),
    attempts,
  });
}

/** Non-streaming Gemini text completion for one specific key. */
async function geminiText(apiKey: string, prompt: string): Promise<string> {
  const ai = getAiClient(apiKey);
  const response = await ai.models.generateContent({
    model: "gemini-3.5-flash",
    contents: prompt,
  });
  return response.text || "";
}

/** Gemini text completion with an inline audio part, for one specific key. */
async function geminiAudioAnalyze(
  apiKey: string,
  prompt: string,
  audioBase64: string,
  mimeType: string,
): Promise<string> {
  const ai = getAiClient(apiKey);
  const response = await ai.models.generateContent({
    model: "gemini-3.5-flash",
    contents: [
      { inlineData: { data: audioBase64, mimeType } },
      prompt,
    ],
  });
  return response.text || "";
}

/** Non-streaming OpenRouter chat completion; returns the raw text/lyrics/prompt content. */
async function openRouterText(apiKey: string, prompt: string): Promise<string> {
  const model = process.env.OPENROUTER_TEXT_MODEL || 'google/gemini-3.5-flash';
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new ProviderHttpError(`OpenRouter request failed (${response.status}): ${errText}`, response.status);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}

/** Non-streaming OpenRouter chat completion with an audio input part; returns the raw text content. */
async function openRouterAudioAnalyze(
  apiKey: string,
  prompt: string,
  audioBase64: string,
  format: 'wav' | 'mp3',
): Promise<string> {
  const model = process.env.OPENROUTER_ANALYZE_MODEL || 'google/gemini-3.5-flash';
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'input_audio', input_audio: { data: audioBase64, format } },
        ],
      }],
      stream: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new ProviderHttpError(`OpenRouter request failed (${response.status}): ${errText}`, response.status);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function startServer() {
  const app = express();
  // Default 3001 to avoid colliding with other local dev servers on 3000; override via PORT env.
  const PORT = Number(process.env.PORT) || 3001;

  app.use(express.json({ limit: '25mb' }));

  // API Endpoint to modify prompt or lyrics
  app.post("/api/ai/modify", async (req, res) => {
    const provider = resolveProvider(req);
    let keys: string[] = [];
    try {
      const { type, instruction, currentText, selectedText } = req.body;

      if (!instruction) {
        return res.status(400).json({ error: "Instruction is required" });
      }

      // $0 dev mode (LYRIA_MOCK=1): deterministic mock — no key needed, no paid call.
      // Gated before any provider/key resolution, mirroring /api/lyria/generate.
      if (process.env.LYRIA_MOCK === '1') {
        return res.json({ result: mockModifyText({ instruction, currentText, selectedText }) });
      }

      let promptText = "";
      if (type === "lyrics") {
        promptText = `You are an expert songwriter and lyric assistant. The user wants to modify their lyrics.
Current full lyrics:
"""
${currentText}
"""
${selectedText ? `The user has highlighted this specific part of the lyrics to modify: "${selectedText}"` : "The user wants to modify the entire lyrics."}

Instruction for modification: "${instruction}"

If a specific part was highlighted, please output the modified version of ONLY that highlighted part (as it should replace the highlighted section directly).
If no specific part was highlighted, please output the full updated lyrics.

CRITICAL: Output ONLY the requested raw replacement text or lyrics. Do not include any explanations, markdown code blocks (such as \`\`\`), introduction, quotes, or outer formatting. Your output will be directly pasted into the editor.`;
      } else {
        promptText = `You are an expert music prompt generator. The user wants to modify a music generation prompt.
Current full music prompt: "${currentText}"
${selectedText ? `The user has highlighted this specific part of the prompt to modify: "${selectedText}"` : "The user wants to modify the entire prompt."}

Instruction for modification: "${instruction}"

If a specific part was highlighted, please output the modified version of ONLY that highlighted part (as it should replace the highlighted section directly).
If no specific part was highlighted, please output the full updated music prompt.

CRITICAL: Output ONLY the requested raw replacement text or prompt. Do not include any explanations, markdown code blocks (such as \`\`\`), introduction, quotes, or outer formatting. Your output will be directly pasted into the editor.`;
      }

      // Walk the ordered key list: a key rejected for a key-level reason (revoked, no
      // credit, quota/entitlement wall) falls through to the next one.
      keys = requireProviderKeys(req, provider);
      const { value: modifiedText, usedIndex, attempts } = await withKeyFailover(keys, key =>
        provider === 'openrouter' ? openRouterText(key, promptText) : geminiText(key, promptText),
      );
      setKeyHeaders(res, usedIndex, attempts, keys);

      // Strip out code block markdown if the model wrapped it
      let cleanedText = modifiedText.trim();
      if (cleanedText.startsWith("```")) {
        const lines = cleanedText.split("\n");
        if (lines[0].startsWith("```")) {
          lines.shift();
        }
        if (lines[lines.length - 1].startsWith("```")) {
          lines.pop();
        }
        cleanedText = lines.join("\n").trim();
      }

      res.json({ result: cleanedText });
    } catch (error: any) {
      if (error instanceof MissingKeyError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof AllKeysFailedError) {
        console.error("AI Modify error: all configured keys were rejected");
        return sendKeyFailure(res, error, keys);
      }
      console.error("AI Modify error:", redactKeys(String(error?.message ?? error), keys));
      res.status(500).json({ error: redactKeys(error.message || "An error occurred during modification", keys) });
    }
  });

  // API Endpoint to automatically enhance a music prompt
  app.post("/api/ai/enhance-prompt", async (req, res) => {
    const provider = resolveProvider(req);
    let keys: string[] = [];
    try {
      const { prompt } = req.body;

      if (!prompt || !prompt.trim()) {
        return res.status(400).json({ error: "Prompt is required" });
      }

      // $0 dev mode (LYRIA_MOCK=1): deterministic mock — no key needed, no paid call.
      if (process.env.LYRIA_MOCK === '1') {
        return res.json({ result: mockEnhancePrompt(prompt) });
      }

      const promptText = `You are an expert music prompt engineer for a state-of-the-art music generator.
The user has provided a base music style description: "${prompt}"

Your job is to enhance this description into a highly detailed, professional, and evocative music generation prompt.
Add sensory details, specific instruments, tempo/BPM recommendations, mood, atmospheric texture, and production style terms.
Keep the enhanced prompt within 2-3 sentences. Do not make it overly long.

CRITICAL: Output ONLY the enhanced prompt. Do not include any conversational filler, quotes, explanations, markdown formatting (like \`\`\`), or extra text. Output the raw text directly.`;

      keys = requireProviderKeys(req, provider);
      const { value: enhancedText, usedIndex, attempts } = await withKeyFailover(keys, key =>
        provider === 'openrouter' ? openRouterText(key, promptText) : geminiText(key, promptText),
      );
      setKeyHeaders(res, usedIndex, attempts, keys);

      res.json({ result: enhancedText.trim() });
    } catch (error: any) {
      if (error instanceof MissingKeyError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof AllKeysFailedError) {
        console.error("AI Enhance error: all configured keys were rejected");
        return sendKeyFailure(res, error, keys);
      }
      console.error("AI Enhance error:", redactKeys(String(error?.message ?? error), keys));
      res.status(500).json({ error: redactKeys(error.message || "An error occurred during enhancement", keys) });
    }
  });

  // Real audio analysis of a persisted generation (cached in the manifest unless force=true).
  // LYRIA_MOCK=1 short-circuits inside analyzeGeneration (right before callAi would run):
  // deterministic mock analysis, no key needed, no paid call, nothing persisted.
  app.post("/api/ai/analyze", async (req, res) => {
    const provider = resolveProvider(req);
    // Resolved but NOT required up front: LYRIA_MOCK=1 short-circuits inside
    // analyzeGeneration without ever invoking callAi, so mock mode still needs no key.
    const keys = resolveProviderKeys(req, provider);
    try {
      const { id, force } = req.body;

      if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: "id is required" });
      }

      // analyzeGeneration owns the failover walk and hands each attempt the key to use; this
      // closure only builds the provider-specific request for that one key.
      const callAi = async ({ audioBase64, mimeType, format, prompt, apiKey }: AnalyzeGenerationCallAiArgs): Promise<string> => {
        const key = apiKey ?? keys[0];
        if (!key) {
          throw new MissingKeyError(MISSING_KEY_MESSAGE[provider]);
        }
        return provider === 'openrouter'
          ? openRouterAudioAnalyze(key, prompt, audioBase64, format)
          : geminiAudioAnalyze(key, prompt, audioBase64, mimeType);
      };

      const analysis = await analyzeGeneration({
        id,
        force: Boolean(force),
        callAi,
        provider,
        geminiKeys: provider === 'openrouter' ? undefined : keys,
        openRouterKeys: provider === 'openrouter' ? keys : undefined,
        // A cached analysis needs no provider call, so the accepted-key report arrives here
        // rather than on the return value.
        onKeyUsage: ({ keyUsedIndex, keyAttempts }) => setKeyHeaders(res, keyUsedIndex, keyAttempts, keys),
      });
      res.json({ analysis });
    } catch (error: any) {
      if (error instanceof InvalidIdError || error instanceof MissingKeyError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof AnalysisNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof AllKeysFailedError) {
        console.error("AI Analyze error: all configured keys were rejected");
        return sendKeyFailure(res, error, keys);
      }
      console.error("AI Analyze error:", redactKeys(String(error?.message ?? error), keys));
      res.status(500).json({ error: redactKeys(error.message || "An error occurred during analysis", keys) });
    }
  });

  // Real Lyria generation (LYRIA_MOCK=1 → local mock WAV, no API cost)
  app.post("/api/lyria/generate", async (req, res) => {
    const provider = resolveProvider(req);
    const geminiKeys = resolveGeminiKeys(req);
    const openRouterKeys = resolveOpenRouterKeys(req);
    const keys = provider === 'openrouter' ? openRouterKeys : geminiKeys;
    try {
      // A FACTORY, not a prebuilt client: per-key Gemini failover has to be able to build a
      // client per attempt. Mock mode needs no client at all.
      const aiFactory = process.env.LYRIA_MOCK !== '1' && provider !== 'openrouter' ? getAiClient : null;

      // Ordered lists per the server/lyria.ts contract (that layer owns the failover for its own
      // provider calls); the single-key fields stay set to the first key for compatibility.
      const result = await generateLyria(aiFactory, req.body, {
        provider,
        geminiKey: geminiKeys[0],
        openRouterKey: openRouterKeys[0],
        geminiKeys,
        openRouterKeys,
      });

      if (result.keyUsedIndex !== undefined) {
        setKeyHeaders(res, result.keyUsedIndex, result.keyAttempts ?? [], keys);
      }
      res.json(result);
    } catch (error: any) {
      if (error instanceof LyriaValidationError || error instanceof MissingKeyError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof AllKeysFailedError) {
        console.error("Lyria generate error: all configured keys were rejected");
        return sendKeyFailure(res, error, keys);
      }
      console.error("Lyria generate error:", redactKeys(String(error?.message ?? error), keys));
      res.status(500).json({ error: redactKeys(error.message || "Generation failed", keys) });
    }
  });

  // List persisted Lyria generations (newest-first) for the library UI
  app.get("/api/generations", async (_req, res) => {
    try {
      res.json({ generations: await listGenerations() });
    } catch (error: any) {
      console.error("List generations error:", error);
      res.status(500).json({ error: error.message || "Failed to list generations" });
    }
  });

  // Rename a persisted generation: updates manifest.title and re-embeds the tag in the audio file
  app.put("/api/generations/:id", async (req, res) => {
    try {
      const title = req.body?.title;
      if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: "Title is required" });
      }
      const generation = await renameGeneration(req.params.id, title);
      res.json({ generation });
    } catch (error: any) {
      if (error instanceof InvalidIdError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof GenerationNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      console.error("Rename generation error:", error);
      res.status(500).json({ error: error.message || "Failed to rename generation" });
    }
  });

  // List persisted projects (newest-first by updatedAt) for the project switcher UI
  app.get("/api/projects", async (_req, res) => {
    try {
      res.json({ projects: await listProjects() });
    } catch (error: any) {
      console.error("List projects error:", error);
      res.status(500).json({ error: error.message || "Failed to list projects" });
    }
  });

  // Create a new project; server fills id/createdAt/updatedAt and defaults
  app.post("/api/projects", async (req, res) => {
    try {
      const project = await createProject(req.body ?? {});
      res.json({ project });
    } catch (error: any) {
      console.error("Create project error:", error);
      res.status(500).json({ error: error.message || "Failed to create project" });
    }
  });

  // Update a subset of a project's mutable fields; bumps updatedAt
  app.put("/api/projects/:id", async (req, res) => {
    try {
      const project = await updateProject(req.params.id, req.body ?? {});
      res.json({ project });
    } catch (error: any) {
      if (error instanceof InvalidIdError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof ProjectNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      console.error("Update project error:", error);
      res.status(500).json({ error: error.message || "Failed to update project" });
    }
  });

  // Archive a project (move projects/<id>.json -> projects/archived/<id>.json); never deletes
  app.post("/api/projects/:id/archive", async (req, res) => {
    try {
      await archiveProject(req.params.id);
      res.json({ archived: true });
    } catch (error: any) {
      if (error instanceof InvalidIdError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof ProjectNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      console.error("Archive project error:", error);
      res.status(500).json({ error: error.message || "Failed to archive project" });
    }
  });

  // OpenRouter account balance — resolves the key the same way as the AI routes,
  // fetches the (free, no-spend) credits endpoint, and returns only derived numbers.
  // Docs-verified: GET /api/v1/credits requires a MANAGEMENT key, so a plain inference
  // key gets an upstream 403. mapOpenRouterCreditsResponse (server/lyria.ts, unit-tested)
  // translates that 403 to our 404, which the client already maps to null — the UI then
  // silently shows no balance instead of erroring on a perfectly valid inference key.
  app.get("/api/openrouter/credits", async (req, res) => {
    try {
      // Balance is per account, so only the first key in the resolved order is meaningful
      // (the browser's, when it sent any) — no failover here, and nothing is spent either way.
      const openRouterKey = resolveOpenRouterKeys(req)[0];
      if (!openRouterKey) {
        return res.status(404).json({ error: "No OpenRouter key configured" });
      }

      const response = await fetch('https://openrouter.ai/api/v1/credits', {
        headers: { 'Authorization': `Bearer ${openRouterKey}` },
      });

      const mapped = mapOpenRouterCreditsResponse(
        response.ok
          ? { ok: true, status: response.status, data: await response.json() }
          : { ok: false, status: response.status, errText: await response.text().catch(() => response.statusText) },
      );
      res.status(mapped.status).json(mapped.body);
    } catch (error: any) {
      console.error("OpenRouter credits error:", error);
      res.status(502).json({ error: error.message || "Failed to fetch OpenRouter credits" });
    }
  });

  // Key/provider status for the Settings modal — counts and booleans only, never key material.
  // The counts cover every server-side source (the list-valued GEMINI_API_KEY / OPENROUTER_API_KEY
  // plus the numbered _2, _3... variants); the booleans are kept for older clients.
  app.get("/api/settings/status", (_req, res) => {
    const geminiServerKeys = resolveServerKeys('GEMINI_API_KEY').length;
    const openRouterServerKeys = resolveServerKeys('OPENROUTER_API_KEY').length;
    res.json({
      geminiServerKey: geminiServerKeys > 0,
      openRouterServerKey: openRouterServerKeys > 0,
      geminiServerKeys,
      openRouterServerKeys,
      defaultProvider: process.env.AI_PROVIDER === 'openrouter' ? 'openrouter' : 'gemini',
    });
  });

  // Terminal error handler for the API routes above (registered before the Vite/static
  // middleware). Maps body-parser failures — oversize payloads (413) and malformed JSON
  // (400), per the body-parser error contract (err.type / SyntaxError with a `body`
  // property) — to friendly JSON instead of raw 500s, and never leaks a stack trace in
  // the response body.
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: "Request too large — reduce image count/size." });
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: "Malformed JSON body." });
    }
    console.error("Unhandled server error:", err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  });

  // Persisted generation audio. `fallthrough: false` keeps a miss inside this mount
  // instead of leaking into the SPA fallback (which would answer an <audio> request
  // with HTML), and the error handler below turns every failure into a clean response.
  app.use('/generations', express.static(path.join(process.cwd(), 'generations'), { fallthrough: false }));

  // Range/static error handler for /generations. Without it, serve-static forwards
  // send()'s errors to Express' default handler, which prints a stack trace and an HTML
  // error page — that is what produced "RangeNotSatisfiableError: Range Not Satisfiable"
  // in the log when the browser seeks with a range whose start is at or past the end of
  // the file (e.g. the open-ended `bytes=<size>-`). send() has already set the
  // `Content-Range: bytes */<size>` that RFC 9110 requires on a 416, so all that is left
  // is to answer with the bare status and no body.
  app.use('/generations', (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }
    const status = typeof err?.status === 'number' ? err.status : 500;
    if (status === 416) {
      res.removeHeader('Content-Type');
      res.setHeader('Content-Length', '0');
      return res.status(416).end();
    }
    if (status === 404) {
      return res.status(404).json({ error: "Generation not found" });
    }
    if (status === 405) {
      return res.status(405).json({ error: "Method not allowed" });
    }
    console.error("Generation asset error:", err?.message || err);
    return res.status(status >= 400 && status < 600 ? status : 500).json({ error: "Failed to serve generation asset" });
  });

  // Serve static assets or use Vite dev server
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
