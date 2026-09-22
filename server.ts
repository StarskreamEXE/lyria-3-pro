import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { generateLyria, listGenerations, LyriaValidationError, analyzeGeneration, AnalysisNotFoundError, renameGeneration, GenerationNotFoundError, InvalidIdError, MissingKeyError, mockModifyText, mockEnhancePrompt, mapOpenRouterCreditsResponse } from "./server/lyria";
import type { AnalyzeGenerationCallAiArgs } from "./server/lyria";
import { listProjects, createProject, updateProject, archiveProject, ProjectNotFoundError } from "./server/projects";

// .env.local (documented setup) wins over .env; real environment variables win over both.
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

function getAiClient(clientKey?: string): GoogleGenAI {
  const key = clientKey || process.env.GEMINI_API_KEY;
  if (!key || key === "MY_GEMINI_API_KEY" || key === "") {
    throw new MissingKeyError("GEMINI_API_KEY is not configured. Please add it in the Settings.");
  }
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        'User-Agent': 'lyria-3-pro',
      }
    }
  });
}

function resolveProvider(req: express.Request): 'gemini' | 'openrouter' {
  const headerProvider = req.headers['x-ai-provider'] as string | undefined;
  const provider = headerProvider || process.env.AI_PROVIDER || 'gemini';
  return provider === 'openrouter' ? 'openrouter' : 'gemini';
}

function getOpenRouterKey(req: express.Request): string | undefined {
  const clientKey = req.headers['x-openrouter-api-key'] as string | undefined;
  return clientKey || process.env.OPENROUTER_API_KEY;
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
    throw new Error(`OpenRouter request failed (${response.status}): ${errText}`);
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
    throw new Error(`OpenRouter request failed (${response.status}): ${errText}`);
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
    try {
      const { type, instruction, currentText, selectedText } = req.body;
      const clientKey = req.headers['x-gemini-api-key'] as string;
      const provider = resolveProvider(req);

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

      let modifiedText: string;
      if (provider === 'openrouter') {
        const openRouterKey = getOpenRouterKey(req);
        if (!openRouterKey) {
          throw new MissingKeyError("OPENROUTER_API_KEY is not configured. Please add it in the Settings.");
        }
        modifiedText = await openRouterText(openRouterKey, promptText);
      } else {
        const ai = getAiClient(clientKey);
        const response = await ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: promptText,
        });
        modifiedText = response.text || "";
      }

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
      console.error("AI Modify error:", error);
      res.status(500).json({ error: error.message || "An error occurred during modification" });
    }
  });

  // API Endpoint to automatically enhance a music prompt
  app.post("/api/ai/enhance-prompt", async (req, res) => {
    try {
      const { prompt } = req.body;
      const clientKey = req.headers['x-gemini-api-key'] as string;
      const provider = resolveProvider(req);

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

      let enhancedText: string;
      if (provider === 'openrouter') {
        const openRouterKey = getOpenRouterKey(req);
        if (!openRouterKey) {
          throw new MissingKeyError("OPENROUTER_API_KEY is not configured. Please add it in the Settings.");
        }
        enhancedText = (await openRouterText(openRouterKey, promptText)).trim();
      } else {
        const ai = getAiClient(clientKey);
        const response = await ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: promptText,
        });
        enhancedText = (response.text || "").trim();
      }

      res.json({ result: enhancedText });
    } catch (error: any) {
      if (error instanceof MissingKeyError) {
        return res.status(400).json({ error: error.message });
      }
      console.error("AI Enhance error:", error);
      res.status(500).json({ error: error.message || "An error occurred during enhancement" });
    }
  });

  // Real audio analysis of a persisted generation (cached in the manifest unless force=true).
  // LYRIA_MOCK=1 short-circuits inside analyzeGeneration (right before callAi would run):
  // deterministic mock analysis, no key needed, no paid call, nothing persisted.
  app.post("/api/ai/analyze", async (req, res) => {
    try {
      const { id, force } = req.body;
      const clientKey = req.headers['x-gemini-api-key'] as string;
      const provider = resolveProvider(req);

      if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: "id is required" });
      }

      const callAi = async ({ audioBase64, mimeType, format, prompt }: AnalyzeGenerationCallAiArgs): Promise<string> => {
        if (provider === 'openrouter') {
          const openRouterKey = getOpenRouterKey(req);
          if (!openRouterKey) {
            throw new MissingKeyError("OPENROUTER_API_KEY is not configured. Please add it in the Settings.");
          }
          return openRouterAudioAnalyze(openRouterKey, prompt, audioBase64, format);
        }

        const ai = getAiClient(clientKey);
        const response = await ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: [
            { inlineData: { data: audioBase64, mimeType } },
            prompt,
          ],
        });
        return response.text || "";
      };

      const analysis = await analyzeGeneration({ id, force: Boolean(force), callAi });
      res.json({ analysis });
    } catch (error: any) {
      if (error instanceof InvalidIdError || error instanceof MissingKeyError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof AnalysisNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      console.error("AI Analyze error:", error);
      res.status(500).json({ error: error.message || "An error occurred during analysis" });
    }
  });

  // Real Lyria generation (LYRIA_MOCK=1 → local mock WAV, no API cost)
  app.post("/api/lyria/generate", async (req, res) => {
    try {
      const clientKey = req.headers['x-gemini-api-key'] as string;
      const provider = resolveProvider(req);
      const openRouterKey = getOpenRouterKey(req);

      let ai: any = null;
      if (process.env.LYRIA_MOCK !== '1' && provider !== 'openrouter') {
        ai = getAiClient(clientKey);
      }

      const result = await generateLyria(ai, req.body, { provider, openRouterKey });
      res.json(result);
    } catch (error: any) {
      if (error instanceof LyriaValidationError || error instanceof MissingKeyError) {
        return res.status(400).json({ error: error.message });
      }
      console.error("Lyria generate error:", error);
      res.status(500).json({ error: error.message || "Generation failed" });
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
      const openRouterKey = getOpenRouterKey(req);
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

  // Key/provider status for the Settings modal — booleans only, never key material
  app.get("/api/settings/status", (_req, res) => {
    const geminiKey = process.env.GEMINI_API_KEY;
    res.json({
      geminiServerKey: Boolean(geminiKey && geminiKey !== "MY_GEMINI_API_KEY"),
      openRouterServerKey: Boolean(process.env.OPENROUTER_API_KEY),
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
