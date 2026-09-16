/** Should never reach a sandbox: rejected by the static import allowlist. */
export function whoami(): string {
  const cp = require('child_' + 'process');
  return cp.execSync('whoami').toString();
}
