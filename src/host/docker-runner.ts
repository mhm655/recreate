/**
 * The real runner: one container per pass (and per retry within a pass -- see
 * src/host/supervise.ts), gVisor as the security boundary.
 *
 * Channel layout inside the container:
 *
 *   fd 0  request payload (trusted, written by us)
 *   fd 1  RESULT CHANNEL  -- plain unsigned NDJSON; see src/channel.ts and the
 *         Security model section of README.md for why no signature is needed
 *   fd 2  console output from untrusted code, plus runtime diagnostics
 *
 * Results ride fd 1 here rather than fd 3 because `docker run` forwards exactly
 * three descriptors into a container; there is no way to hand it a fourth. The
 * property the design actually needs is that results and untrusted console output
 * never share a descriptor, and that holds: `SANDBOX_RESULT_FD=1` tells the sandbox
 * to put results on fd 1 and route all its own stdio to fd 2.
 *
 * Every pass attempt gets its own fresh container. Fresh container means fresh
 * tmpfs, fresh process, fresh everything, so state cannot leak from the ordered
 * pass into the shuffled one by any route -- not module scope, not the filesystem
 * -- and a retry after a hang/OOM starts equally clean.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import type { SandboxRequest } from '../protocol';
import { supervisePass, type Attempt, type AttemptExit, type SpawnedAttempt } from './supervise';
import type { RunnerResult, SandboxRunner } from './runner';

export interface DockerRunnerOptions {
  image?: string;
  /**
   * Container runtime. `runsc` is gVisor and is the point of the exercise. Anything
   * else means the only thing between untrusted code and the host kernel is a
   * namespace, which is a much weaker claim -- hence the loud flag below.
   */
  runtime?: string;
  /** Required to use a runtime other than runsc. Nothing else unlocks it. */
  allowUnsafeRuntime?: boolean;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  tmpfsSizeMb?: number;
  /** Path to a seccomp profile, or the literal 'unconfined' / 'default'. */
  seccompProfile?: string;
  user?: string;
  dockerPath?: string;
  /** Extra flags, for local experimentation. Appended before the image name. */
  extraArgs?: string[];
}

const DEFAULTS = {
  image: 'ts-sandbox-harness:latest',
  runtime: 'runsc',
  memoryMb: 256,
  cpus: 1,
  pidsLimit: 128,
  tmpfsSizeMb: 16,
  user: '10001:10001',
  dockerPath: 'docker',
};

export class DockerRunner implements SandboxRunner {
  readonly isolated = true;
  private readonly opts: Required<Omit<DockerRunnerOptions, 'seccompProfile' | 'extraArgs' | 'allowUnsafeRuntime'>> & {
    seccompProfile: string;
    extraArgs: string[];
    allowUnsafeRuntime: boolean;
  };

  constructor(options: DockerRunnerOptions = {}) {
    this.opts = {
      image: options.image ?? DEFAULTS.image,
      runtime: options.runtime ?? DEFAULTS.runtime,
      memoryMb: options.memoryMb ?? DEFAULTS.memoryMb,
      cpus: options.cpus ?? DEFAULTS.cpus,
      pidsLimit: options.pidsLimit ?? DEFAULTS.pidsLimit,
      tmpfsSizeMb: options.tmpfsSizeMb ?? DEFAULTS.tmpfsSizeMb,
      user: options.user ?? DEFAULTS.user,
      dockerPath: options.dockerPath ?? DEFAULTS.dockerPath,
      seccompProfile:
        options.seccompProfile ?? path.join(__dirname, '..', '..', '..', 'docker', 'seccomp.json'),
      extraArgs: options.extraArgs ?? [],
      allowUnsafeRuntime: options.allowUnsafeRuntime ?? false,
    };

    if (this.opts.runtime !== 'runsc' && !this.opts.allowUnsafeRuntime) {
      throw new Error(
        `refusing to run untrusted code under container runtime '${this.opts.runtime}'. ` +
          'gVisor (runsc) is the security boundary in this design; with runc, a container ' +
          'escape is a host compromise. To override deliberately, pass allowUnsafeRuntime ' +
          '(CLI: --unsafe-runtime).',
      );
    }
  }

  get name(): string {
    return `docker:${this.opts.runtime}:${this.opts.image}`;
  }

  async preflight(): Promise<{ ok: boolean; detail: string }> {
    const version = await exec(this.opts.dockerPath, ['version', '--format', '{{.Server.Version}}'], 15_000);
    if (version.code !== 0) {
      return { ok: false, detail: `docker unavailable: ${(version.stderr || version.stdout).trim().slice(0, 300)}` };
    }
    const info = await exec(this.opts.dockerPath, ['info', '--format', '{{json .Runtimes}}'], 15_000);
    const runtimes = info.stdout.trim();
    if (info.code === 0 && this.opts.runtime !== 'runc' && !runtimes.includes(`"${this.opts.runtime}"`)) {
      return {
        ok: false,
        detail:
          `container runtime '${this.opts.runtime}' is not registered with this daemon (saw ${runtimes || '{}'}). ` +
          'See README "gVisor setup".',
      };
    }
    const image = await exec(this.opts.dockerPath, ['image', 'inspect', this.opts.image], 30_000);
    if (image.code !== 0) {
      return { ok: false, detail: `image '${this.opts.image}' not found; run: npm run image` };
    }
    return { ok: true, detail: `docker ok, runtime=${this.opts.runtime}, image=${this.opts.image}` };
  }

  /**
   * The full `docker run` argument list. `entrypoint` is only for verifyIsolation(),
   * which needs to run probes under exactly the flags real submissions get.
   * `maxOldSpaceMb` is unset for verifyIsolation's probe, which doesn't run a
   * submission and so has no request-specific limits to apply.
   */
  private buildArgs(containerName: string, entrypoint?: { command: string; args: string[] }, maxOldSpaceMb?: number): string[] {
    const o = this.opts;
    const args = [
      'run',
      '--name', containerName,
      '--interactive',
      // Not --rm: the container is inspected for OOMKilled after exit, then removed
      // in a finally block. --rm would race that inspection away.
      '--runtime', o.runtime,
      // No network at all. Not a filtered network -- none.
      '--network', 'none',
      // Root filesystem is read-only; the only writable area is a small noexec tmpfs.
      '--read-only',
      '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${o.tmpfsSizeMb}m`,
      '--memory', `${o.memoryMb}m`,
      // Equal to --memory means zero swap: the memory cap is a real cap, not a
      // slow slide into swap thrash.
      '--memory-swap', `${o.memoryMb}m`,
      '--cpus', String(o.cpus),
      // Caps total tasks in the cgroup, which is what stops a fork bomb. Only one
      // process/thread runs in here now (see README.md's Security model section),
      // but Node still uses a handful of internal threads (libuv pool, V8 helpers),
      // so this cannot be set as low as intuition suggests.
      '--pids-limit', String(o.pidsLimit),
      '--user', o.user,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--ulimit', 'nofile=256:256',
      '--ulimit', 'core=0:0',
      // Deliberately no --init. The seccomp profile only permits clone(2) for
      // threads, so nothing in the container can create a process -- including
      // docker-init, which would need to fork node. With no child processes possible
      // there are no zombies to reap.
      // Logs are read from the attached streams; a log driver would only buffer
      // untrusted output into the daemon.
      '--log-driver', 'none',
      '--env', 'SANDBOX_RESULT_FD=1',
      '--env', 'NODE_ENV=production',
      '--workdir', '/app',
    ];

    // The V8 heap cap is per-request (Limits.workerMaxOldGenerationMb), so it can't
    // be baked into the image's static ENTRYPOINT the way --disallow-code-generation-
    // from-strings is; NODE_OPTIONS is Node's own supported way to add V8 flags at
    // startup without changing argv.
    if (maxOldSpaceMb !== undefined) {
      args.push('--env', `NODE_OPTIONS=--max-old-space-size=${maxOldSpaceMb}`);
    }

    if (this.opts.seccompProfile === 'unconfined') {
      args.push('--security-opt', 'seccomp=unconfined');
    } else if (this.opts.seccompProfile !== 'default') {
      args.push('--security-opt', `seccomp=${this.opts.seccompProfile}`);
    }

    if (entrypoint) args.push('--entrypoint', entrypoint.command);
    args.push(...o.extraArgs, o.image);
    if (entrypoint) args.push(...entrypoint.args);
    return args;
  }

  /**
   * Probe the isolation claims from INSIDE a container launched with the production
   * flags. Intended to be run once on a new host (see scripts/check-sandbox.sh),
   * because several layers -- the seccomp profile, gVisor's --oci-seccomp setting --
   * fail open when misconfigured rather than failing loudly.
   */
  async verifyIsolation(): Promise<Array<{ check: string; ok: boolean; detail: string }>> {
    const name = `tsbox-verify-${randomUUID().slice(0, 8)}`;
    const args = this.buildArgs(name, { command: 'node', args: ['-e', ISOLATION_PROBE] });
    try {
      const res = await exec(this.opts.dockerPath, args, 60_000);
      const lastLine = res.stdout.trim().split('\n').pop() ?? '';
      try {
        return JSON.parse(lastLine) as Array<{ check: string; ok: boolean; detail: string }>;
      } catch {
        return [{
          check: 'probe container ran',
          ok: false,
          detail: `exit ${String(res.code)}: ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
        }];
      }
    } finally {
      await exec(this.opts.dockerPath, ['rm', '--force', name], 20_000).catch(() => undefined);
    }
  }

  run(request: SandboxRequest, timeoutMs: number): Promise<RunnerResult> {
    return supervisePass({
      tests: request.tests,
      limits: request.limits,
      hostTimeoutMs: timeoutMs,
      // Matches STARTUP_GRACE_MS.isolated in host/orchestrator.ts: gVisor + a fresh
      // container's cold start is a real, variable cost that isn't the submission's
      // fault.
      startupGraceMs: 30_000,
      passId: request.passId,
      spawnAttempt: (tests, generation) => this.spawnOne(request, tests, generation),
    });
  }

  /** One container: one attempt at (a subset of) one pass. See src/host/supervise.ts. */
  private spawnOne(request: SandboxRequest, tests: SandboxRequest['tests'], generation: number): SpawnedAttempt {
    const attemptRequest: SandboxRequest = { ...request, tests, generation };
    const containerName = `tsbox-${request.runId.slice(0, 8)}-${request.passId}-g${generation}-${randomUUID().slice(0, 8)}`;
    const args = this.buildArgs(containerName, undefined, request.limits.workerMaxOldGenerationMb);
    const cap = request.limits.maxResultBytes;

    const child = spawn(this.opts.dockerPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const resultCallbacks: Array<(chunk: string) => void> = [];
    const rawCallbacks: Array<(chunk: string) => void> = [];
    let resultBytes = 0;

    child.stdout.on('data', (chunk: Buffer) => {
      if (resultBytes >= cap) return;
      resultBytes += chunk.byteLength;
      const text = chunk.toString('utf8');
      for (const cb of resultCallbacks) cb(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const cb of rawCallbacks) cb(text);
    });

    const closed = new Promise<{ code: number | null; signal: string | null; startupError?: string }>((resolve) => {
      let settled = false;
      const finish = (code: number | null, signal: string | null, startupError?: string) => {
        if (settled) return;
        settled = true;
        resolve({ code, signal, startupError });
      };
      child.on('error', (err) => finish(null, null, `failed to spawn docker: ${err.message}`));
      child.on('close', (code, signal) => finish(code, signal));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(attemptRequest));

    const exited: Promise<AttemptExit> = closed.then(async (outcome) => {
      let oomKilled = false;
      let exitCode = outcome.code;
      try {
        const inspect = await exec(
          this.opts.dockerPath,
          ['inspect', '--format', '{{.State.OOMKilled}}|{{.State.ExitCode}}', containerName],
          15_000,
        );
        if (inspect.code === 0) {
          const [oom, code] = inspect.stdout.trim().split('|');
          oomKilled = oom === 'true';
          const parsed = Number(code);
          if (Number.isFinite(parsed)) exitCode = parsed;
        }
      } catch {
        /* inspection is best-effort; the run is already over */
      } finally {
        await exec(this.opts.dockerPath, ['rm', '--force', containerName], 20_000).catch(() => undefined);
      }
      return { exitCode, signal: outcome.signal, oomKilled, startupError: outcome.startupError };
    });

    const attempt: Attempt = {
      exited,
      // SIGKILL the container itself, not just the docker client: killing the
      // client would leave the workload running.
      kill: () => {
        void exec(this.opts.dockerPath, ['kill', '--signal', 'KILL', containerName], 20_000);
      },
    };

    return {
      attempt,
      onResultData: (cb) => resultCallbacks.push(cb),
      onRawData: (cb) => rawCallbacks.push(cb),
    };
  }
}

/**
 * Runs inside the verification container as plain `node -e`. Every check records
 * what it observed; `ok` means the isolation property held.
 */
const ISOLATION_PROBE = `
const fs = require('fs');
const results = [];
const rec = (check, ok, detail) => results.push({ check, ok: !!ok, detail: String(detail).slice(0, 300) });
const code = (e) => (e && (e.code || e.message)) || String(e);

try { rec('runs as non-root', process.getuid() !== 0, 'uid=' + process.getuid()); } catch (e) { rec('runs as non-root', false, code(e)); }
// Checked from mount options, not a write attempt: as a non-root user a write to /
// fails with EACCES regardless, which would say nothing about --read-only.
try {
  const root = fs.readFileSync('/proc/mounts', 'utf8').split(String.fromCharCode(10)).map((l) => l.split(' ')).find((f) => f[1] === '/');
  const opts = root ? root[3].split(',') : [];
  rec('root filesystem is mounted read-only', opts.includes('ro'), root ? root.join(' ') : 'no / entry in /proc/mounts');
} catch (e) { rec('root filesystem is mounted read-only', false, code(e)); }
try { fs.writeFileSync('/app/probe', 'x'); rec('app directory is not writable', false, 'write to /app succeeded'); } catch (e) { rec('app directory is not writable', true, code(e)); }
try { fs.writeFileSync('/tmp/probe', 'x'); rec('scratch tmpfs is writable', true, '/tmp ok'); } catch (e) { rec('scratch tmpfs is writable', false, code(e)); }

try {
  const r = require('child_process').spawnSync(process.execPath, ['-e', '0'], { timeout: 5000 });
  rec('process creation is blocked (seccomp clone rule)', !!r.error || r.status !== 0, r.error ? code(r.error) : 'child exited ' + r.status);
} catch (e) { rec('process creation is blocked (seccomp clone rule)', true, code(e)); }

try {
  const v = fs.readFileSync('/proc/version', 'utf8');
  // gVisor reports a synthetic kernel whose version string names it.
  rec('kernel is gVisor', /gvisor/i.test(v), v.trim());
} catch (e) { rec('kernel is gVisor', false, code(e)); }

let pending = 1;
const done = () => { if (--pending === 0) { console.log(JSON.stringify(results)); process.exit(0); } };

try {
  const sock = require('net').connect({ host: '1.1.1.1', port: 80 });
  const t = setTimeout(() => { rec('no network egress', true, 'connect timed out'); sock.destroy(); done(); }, 4000);
  sock.on('connect', () => { clearTimeout(t); rec('no network egress', false, 'connected to 1.1.1.1:80'); sock.destroy(); done(); });
  sock.on('error', (e) => { clearTimeout(t); rec('no network egress', true, code(e)); done(); });
} catch (e) { rec('no network egress', true, code(e)); done(); }
`;

function exec(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      stderr += err.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
