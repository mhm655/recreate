import { createApp } from './app.js';

const PORT = 8787;
// This server runs arbitrary submitted TypeScript through LocalRunner with NO
// isolation (see ui/README.md). Binding to the loopback address only, rather than
// Node's default of every interface, keeps its capture/grade endpoints off the LAN --
// otherwise any other device on the same network could reach them directly.
const HOST = '127.0.0.1';

createApp().listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`ts-sandbox-harness UI server on http://${HOST}:${PORT} (LocalRunner -- not isolated)`);
});
