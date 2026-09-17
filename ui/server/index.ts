import { createApp } from './app.js';

const PORT = 8787;

createApp().listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`ts-sandbox-harness UI server on http://localhost:${PORT} (LocalRunner -- not isolated)`);
});
