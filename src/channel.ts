/**
 * Result channel framing: plain NDJSON, one JSON value per line.
 *
 * Earlier versions of this signed every line with a per-pass HMAC key, because the
 * sandbox held a privileged "harness" thread (trusted, held the key) and an
 * unprivileged "worker" thread (ran the submission) sharing one OS process and one
 * fd table -- the signature was how the host told which of the two had written a
 * given line. That split is gone: the sandbox is now a single process with no
 * privileged component inside it (see README.md's Security model section), so
 * there is nothing left for a signature to distinguish. Every byte that arrives on
 * this channel is the sandbox's own self-report, and the host is the only reader of
 * the private pipe/stream it created for exactly this sandbox instance -- nothing
 * else has a handle to write to it. What still needs defending against is not "who
 * wrote this line" but "is this a genuine, complete result set", which
 * src/host/orchestrator.ts's reconciliation (exact id set, no duplicates, no
 * missing) still handles.
 */

export function frame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export interface ParsedChannel<T> {
  /** Lines whose JSON parsed successfully. */
  accepted: T[];
  /**
   * Lines present on the channel that failed parsing. `incomplete-line` is the
   * benign case -- a sandbox killed mid-write leaves a partial final line -- and is
   * reported separately so it is not mistaken for a genuinely malformed line.
   * `oversize` is also benign: a line that is valid JSON but simply too large to
   * accept.
   */
  rejected: Array<{
    reason: 'bad-json' | 'oversize' | 'incomplete-line';
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
  raw: string,
  opts: { maxBytes: number; maxLineBytes?: number } = { maxBytes: 8 * 1024 * 1024 },
): ParsedChannel<T> {
  const maxLineBytes = opts.maxLineBytes ?? Math.min(opts.maxBytes, 4 * 1024 * 1024);
  const truncated = Buffer.byteLength(raw, 'utf8') > opts.maxBytes;
  const body = truncated ? raw.slice(0, opts.maxBytes) : raw;

  const accepted: T[] = [];
  const rejected: ParsedChannel<T>['rejected'] = [];

  // A payload not ending in a newline means the writer was cut off mid-line (the
  // sandbox was killed). That final fragment is truncation, not a malformed line.
  const lines = body.split('\n');
  const lastIsPartial = body.length > 0 && !body.endsWith('\n');

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const isFinalFragment = lastIsPartial && li === lines.length - 1;
    if (line.trim() === '') continue;

    if (isFinalFragment) {
      rejected.push({ reason: 'incomplete-line', preview: line.slice(0, 80) });
      continue;
    }
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
      rejected.push({ reason: 'oversize', preview: line.slice(0, 80) });
      continue;
    }
    try {
      accepted.push(JSON.parse(line) as T);
    } catch {
      rejected.push({ reason: 'bad-json', preview: line.slice(0, 80) });
    }
  }

  return { accepted, rejected, truncated };
}
