export interface LogLine {
  text: string;
  tone?: 'go' | 'warn' | 'stop';
}

/** A terminal-style transcript that reveals line by line -- the machine
 * narrating what it just did, instead of a result appearing all at once. */
export default function RunLog({ lines }: { lines: LogLine[] }) {
  return (
    <div className="run-log">
      <div className="run-log__label">Output</div>
      <div className="run-log__body">
        {lines.map((line, i) => (
          <div
            key={i}
            className="run-log__line"
            data-tone={line.tone}
            style={{ animationDelay: `${i * 90}ms` }}
          >
            <span className="run-log__prompt">&gt;</span> {line.text}
          </div>
        ))}
        <span className="run-log__cursor" style={{ animationDelay: `${lines.length * 90}ms` }} />
      </div>
    </div>
  );
}
