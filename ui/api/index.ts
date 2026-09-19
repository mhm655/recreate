/**
 * Vercel entry point: every request under /api/* is rewritten here (see
 * ../vercel.json), and Vercel's Node runtime can invoke an Express app directly as
 * the request handler. No app.listen() here -- that's server/index.ts, used only for
 * local dev; Vercel owns the actual HTTP server in production.
 */
import { createApp } from '../server/app.js';

export default createApp();
