# ts-sandbox-harness UI

A small local dev/demo tool for `ts-sandbox-harness`: paste a function, capture its
behaviour as a Challenge, paste a rewrite, see whether it's graded correctly and
how strong the captured suite actually is.

This is a **separate package** from the harness root (its own `package.json`,
`tsconfig.json`, dependencies) that consumes the harness as an ordinary installed
dependency (`file:..`) -- the harness stays a plain library with no UI or browser
concerns of its own.

## Why there's a server here

The harness's core functions (`captureChallenge`, `gradeAgainstChallenge`, ...) run
real untrusted TypeScript through Node child processes / worker threads and touch
`fs`, `node:crypto`, `Buffer`. None of that can run in a browser. `server/index.ts`
is a thin Express layer that calls the harness on the server and exposes exactly two
JSON endpoints (`/api/capture`, `/api/grade`); the React app in `src/` only ever
talks to those, never imports the harness directly.

**This server always uses `LocalRunner` -- it provides NO isolation.** It's a local
dev/demo tool for exercising the pipeline, not a place to grade untrusted
submissions for real; that needs `DockerRunner` on a Linux host with gVisor
registered, per the root README's security model.

## Running it

The harness root has to be built first -- `ui/`'s dependency on it resolves to
`../dist/src/index.js` (its compiled `main`, not the TypeScript source):

```bash
cd .. && npm run build && cd ui
```

Then, from this directory:

```bash
npm install
npm run dev
```

Starts the API server (port 8787) and the Vite dev server (port 5173, proxying
`/api` to the server) together. Open http://localhost:5173.

Or run them separately: `npm run dev:server` / `npm run dev:client`.
