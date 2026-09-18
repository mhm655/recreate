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
real untrusted TypeScript through Node child processes and touch
`fs`, `node:crypto`, `Buffer`. None of that can run in a browser. `server/app.ts` is
a thin Express layer that calls the harness on the server; the React app in `src/`
only ever talks to its JSON endpoints, never imports the harness directly.

| Endpoint | Does |
|---|---|
| `POST /api/capture` | Captures a challenge, then persists it (see below) |
| `GET /api/challenges` | Lists saved challenges, newest first |
| `GET /api/challenges/:id` | Loads one saved challenge in full |
| `POST /api/grade` | Grades a rewrite against a challenge the client sends |

## Persistence

A captured challenge is written to `server/data/challenges/<id>.json` -- one file
per challenge, named by its content-hash id (see the root README's "Challenge data
model"). That's it: no database, because this tool doesn't have the concurrency or
multi-user needs one would justify. The directory is gitignored and overridable via
the `CHALLENGES_DIR` env var, which is how `server/app.test.ts` points persistence
at a throwaway temp directory instead of the real one.

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

## Testing

```bash
npm test
```

`server/app.test.ts` makes real HTTP requests (via `fetch`) against a real Express
app on an ephemeral port -- capture, list, load, grade -- through the actual
harness, not mocked. `src/summarize.test.ts` covers the one piece of client logic
worth unit-testing on its own (formatting an `Outcome` for display); the rest of
the client is thin enough that the server tests plus manual browser verification
cover it.
