export default function DocsPage() {
  return (
    <div className="page page--enter docs-page">
      <header className="page-header">
        <h1>Docs</h1>
        <p className="page-sub">How the harness thinks about a challenge, a rewrite, and a grade.</p>
      </header>

      <section className="panel panel--static">
        <div className="panel__header-static">Oracle &amp; rewrite</div>
        <div className="panel__body panel__body--pad docs-body">
          <p>
            The <strong>oracle</strong> is the function you trust -- paste it in on the Capture page and the harness
            runs it against a generated spread of inputs, recording exactly what it returns, throws, or times out
            on. That recording becomes a <strong>challenge</strong>: a fixed, frozen test suite for that function's
            behaviour.
          </p>
          <p>
            A <strong>rewrite</strong> is any other implementation of the same function -- a refactor, an
            LLM-generated attempt, a bug fix. Grading runs the rewrite against the challenge's saved inputs and
            checks whether every outcome still matches, including what the rewrite left behind in its arguments
            (functions that mutate their inputs are graded on that too).
          </p>
        </div>
      </section>

      <section className="panel panel--static">
        <div className="panel__header-static">Mutation testing</div>
        <div className="panel__body panel__body--pad docs-body">
          <p>
            A high pass rate only tells you the rewrite matches -- it says nothing about whether the test suite
            itself would catch a <em>wrong</em> rewrite. Mutation testing answers that: the harness makes small
            deliberate mutations to the oracle (flipping a comparison, off-by-one an index, dropping a
            statement) and reruns the captured tests against each mutant.
          </p>
          <ul className="docs-list">
            <li><strong>Killed</strong> -- a mutant that the tests caught (a mismatch was produced). Good: the suite is doing its job.</li>
            <li><strong>Survived</strong> -- a mutant that slipped through undetected. The suite has a blind spot at that line.</li>
            <li><strong>Inconclusive</strong> -- a mutant the harness couldn't safely score (e.g. it also broke the oracle itself).</li>
          </ul>
          <p>The mutation score is killed / (killed + survived) -- the share of introduced bugs the suite would actually catch.</p>
        </div>
      </section>

      <section className="panel panel--static">
        <div className="panel__header-static">Verdicts</div>
        <div className="panel__body panel__body--pad docs-body">
          <ul className="docs-list">
            <li><strong>Passed</strong> -- every test matched the oracle's recorded outcome.</li>
            <li><strong>Failed</strong> -- at least one test produced a different return value, thrown error, or argument mutation than the oracle.</li>
            <li><strong>Rewrite invalid</strong> -- the rewrite didn't compile, didn't export the expected entry point, or crashed the harness itself before grading could run.</li>
          </ul>
        </div>
      </section>

      <section className="panel panel--static">
        <div className="panel__header-static">Isolation</div>
        <div className="panel__body panel__body--pad docs-body">
          <p>
            This UI always runs challenges through <code>LocalRunner</code>, which provides <strong>no process
            isolation</strong> -- it's a local dev/demo tool for exercising the pipeline, not a place to grade
            untrusted submissions for real. Grading arbitrary untrusted code needs <code>DockerRunner</code> on a
            Linux host with gVisor registered, per the harness's security model.
          </p>
        </div>
      </section>
    </div>
  );
}
