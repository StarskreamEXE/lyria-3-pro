# Lyria 3 Pro

Professional AI music generation interface. React 19 + Tailwind v4 frontend served by an Express server with AI-assisted prompt and lyric editing.

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Create your local env file from the template and add your key:
   `cp .env.example .env.local` — then set `GEMINI_API_KEY` (or `OPENROUTER_API_KEY`) in `.env.local`. You can also set a key later in the in-app Settings.
3. Run the app:
   `npm run dev`

The app serves on http://localhost:3001.

Set `LYRIA_MOCK=1` to develop against a locally synthesized WAV instead of a real (paid) generation call.

## Scripts

- `npm run dev` — start the dev server (Express + Vite middleware) on port 3001
- `npm run build` — build the SPA and bundle the server to `dist/`
- `npm run start` — run the production bundle
- `npm run lint` — type-check only (`tsc --noEmit`)
- `npm test` — run the vitest suite
