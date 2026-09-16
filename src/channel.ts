/**
 * Result channel framing.
 *
 * Every line is `<hmac-sha256-hex> <json>\n`. The HMAC key is generated per run by
 * the host, handed to the harness parent thread over stdin, and never exposed to
 * the worker thread that runs untrusted code.
 *
 * What this buys and what it does not:
 *
 *   IT DOES stop a submitted function from fabricating passing results. The worker
 *   can write to fd 3 -- file descriptors are process-wide, so `fs.writeSync(3, ...)`
 *   from inside the sandbox reaches the host. Without signing, a function could
 *   simply print the answers it wished it had produced. Unsigned lines are counted
 *   and rejected.
 *
 *   IT DOES NOT make the channel a trust boundary. The key lives in the JS heap of
 *   a thread inside the same OS process as the untrusted code, and a thread can read
 *   its own process memory (`/proc/self/mem`). A sufficiently determined escape
 *   could recover the key. The real boundary is the gVisor container; this is
 *   integrity for the *report*, defending against the realistic threat (a submission
 *   that games its own grade), not against a kernel-level attacker.
 *
 * The stronger variant -- running untrusted code in a child *process* so the fd can
 * be withheld entirely -- is noted as future work in the README; this session's spec
 * calls for a worker thread, which shares the fd table by construction.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function newResultKey(): string {
  return randomBytes(32).toString('hex');
}

function sign(key: string, payload: string): string {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(payload, 'utf8').digest('hex');
}

export function frame(key: string, value: unknown): string {
  const json = JSON.stringify(value);
  return `${sign(key, json)} ${json}\n`;
}

export interface ParsedChannel<T> {
  /** Lines whose signature verified and whose JSON parsed. */
  accepted: T[];
  /**
   * Lines present on the channel that failed verification or parsing.
   * `incomplete-line` is the benign case -- a container killed mid-write leaves a
   * partial final line -- and is reported separately so it is not mistaken for
   * tampering. `oversize` is also benign: it is checked only after the signature
   * verifies, so it means a genuine, correctly-signed result that was simply too
   * large to accept, not a forged or garbage line.
   */
  rejected: Array<{
    reason: 'bad-signature' | 'bad-json' | 'malformed' | 'oversize' | 'incomplete-line';
    preview: string;
  }>;
  /** True if the raw payload exceeded the cap and was cut short. */
  truncated: boolean;
}

/**
 * Parse the channel payload.
 *
 * Deliberately plain `JSON.parse` plus a size cap and nothing more powerful: the
 * shape of this data is attacker-influenced, so the parser must have no capability
 * beyond producing inert data. Structural validation happens afterwards, in the
 * orchestrator's reconciliation step.
 */
export function parseChannel<T = unknown>(
  key: string,
  raw: string,
  opts: { maxBytes: number; maxLineBytes?: number } = { maxBytes: 8 * 1024 * 1024 },
): ParsedChannel<T> {
  const maxLineBytes = opts.maxLineBytes ?? Math.min(opts.maxBytes, 4 * 1024 * 1024);
  const truncated = Buffer.byteLength(raw, 'utf8') > opts.maxBytes;
  const body = truncated ? raw.slice(0, opts.maxBytes) : raw;

  const accepted: T[] = [];
  const rejected: ParsedChannel<T>['rejected'] = [];

  // A payload not ending in a newline means the writer was cut off mid-line (the
  // container was killed). That final fragment is truncation, not tampering.
  const lines = body.split('\n');
  const lastIsPartial = body.length > 0 && !body.endsWith('\n');

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const isFinalFragment = lastIsPartial && li === lines.length - 1;
    if (line.trim() === '') continue;
    const reject = (reason: ParsedChannel<T>['rejected'][number]['reason']) => {
      rejected.push({
        reason: isFinalFragment ? 'incomplete-line' : reason,
        preview: line.slice(0, 80),
      });
    };

    const sep = line.indexOf(' ');
    if (sep !== 64) {
      reject('malformed');
      continue;
    }
    const mac = line.slice(0, 64);
    const json = line.slice(65);
    if (!/^[0-9a-f]{64}$/.test(mac)) {
      reject('malformed');
      continue;
    }
    const expected = sign(key, json);
    if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))) {
      reject('bad-signature');
      continue;
    }
    // Checked AFTER authentication, on purpose: the encode budget (src/encoding.ts)
    // can legitimately produce a multi-MB result, and the whole payload is already
    // buffered in memory by this point, so verifying first costs nothing. That way
    // 'oversize' always means "a genuine, signed line we won't accept," never a
    // garbage/forged line that happens to be long -- those already failed above.
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
      reject('oversize');
      continue;
    }
    try {
      accepted.push(JSON.parse(json) as T);
    } catch {
      reject('bad-json');
    }
  }

  return { accepted, rejected, truncated };
}
