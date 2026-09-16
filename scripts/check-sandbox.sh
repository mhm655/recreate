#!/usr/bin/env bash
# Bring-up check for a Linux host. Run from the repository root:
#   ./scripts/check-sandbox.sh
#
# Verifies, in order: gVisor is registered, the image builds, the isolation layers
# actually hold from inside a container started with production flags, a real
# submission runs end to end, and the hostile suite passes against Docker.
set -euo pipefail

say() { printf '\n==> %s\n' "$*"; }

say "checking docker and the runsc runtime"
docker info --format '{{json .Runtimes}}' | grep -q '"runsc"' || {
  echo "runsc is not registered with dockerd. See README: gVisor setup." >&2
  exit 1
}

say "building host code"
npm ci --no-audit --no-fund
npm run build

say "building sandbox image"
npm run image

say "preflight"
node dist/src/cli.js preflight --runner docker

say "verifying isolation from inside the container"
node dist/src/cli.js verify-isolation

say "running a well-behaved submission"
node dist/src/cli.js run --source examples/slugify.ts --tests examples/slugify.tests.json

say "running a stateful submission (expect NON-DETERMINISTIC, exit 1)"
node dist/src/cli.js run --source examples/counter.ts --tests examples/counter.tests.json || true

say "running the hostile suite against docker + gVisor"
TSBOX_TEST_RUNNER=docker node --test dist/test/hostile-pipeline.test.js

say "all checks passed"
