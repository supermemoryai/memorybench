// ARICORD provider answer prompt.
//
// ARICORD's /context/shape returns a fully-formed `answer_prompt` (the shaped
// memory bundle + ARICORD's generalist answer instructions + the question).
// AricordProvider forwards it as the `__aricord_answer_prompt__` sentinel entry; this
// builder returns it verbatim. The prompt-engineering lives entirely in ARICORD's
// product surface -- the same prompt every consumer gets (/answer, the MCP
// client, this harness, any app). Every memorybench provider supplies its own
// answer prompt (see src/providers/*/prompts.ts); ours sources it from ARICORD at
// runtime instead of hard-coding it. There is no harness-side fallback prompt
// on purpose: if /context/shape didn't return `answer_prompt`, that is a bug
// (an out-of-date ARICORD, or the question fell through to the /search 503 path)
// and we fail loudly rather than silently answer from a worse prompt.
//
// The one thing the harness adds is a [Reference time] line: only the consumer
// knows "now" (here, LongMemEval-S's simulated question_date) -- ARICORD's
// /context/shape isn't given it -- and a real app integrating ARICORD does the
// same: prepend today's date. If the consumer doesn't supply it, we don't
// invent one (no synthesising "now" from memory timestamps) -- the prompt
// already tells the model to fall back to the latest [documentDate].
type Hit = {
  sessionId?: string;
  content?: string;
};

export function buildAricordAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string,
): string {
  const hits = context as Hit[];

  // Reference time -- see header. Only used when the consumer supplies it;
  // no fallback heuristic.
  const referenceDate =
    questionDate && questionDate !== 'Not specified' ? questionDate : undefined;
  const todayLine = referenceDate
    ? 'Today is ' + referenceDate + '.'
    : 'Today: unknown -- use the latest [documentDate] as a proxy for "now".';
  const refLine = '[Reference time]\n' + todayLine + '\n\n';

  const aricordPrompt = hits.find((h) => h.sessionId === '__aricord_answer_prompt__')?.content;
  if (typeof aricordPrompt !== 'string' || aricordPrompt.trim().length === 0) {
    // No sentinel. Two very different reasons we can get here:
    //
    //   1. `hits.length === 0` — memorybench's orchestrator (phases/answer.ts)
    //      calls this builder TWICE per question:
    //          basePrompt = buildAnswerPrompt(q, [], ...);  // ← empty hits
    //          prompt     = buildAnswerPrompt(q, realHits, ...);
    //      Then `contextTokens = countTokens(prompt) - countTokens(basePrompt)`.
    //      The first call is *only* used to size the prompt envelope without
    //      context — it never reaches an LLM, never affects scoring; the value
    //      goes into the run report as a token-breakdown stat. Throwing here
    //      kills the whole bench on what is, structurally, a measurement call.
    //      Return a minimal but real envelope (`refLine + "Question: " + q`)
    //      so countTokens has something to tokenize and the harness proceeds.
    //      The reported `contextTokens` ends up slightly over-counted (the
    //      "ground every claim" etc instructions inside ARICORD's answer_prompt
    //      get attributed to context, not template) — cosmetic stat skew, not
    //      a correctness issue. Same shape as memorybench's own
    //      `buildDefaultAnswerPrompt`, which also returns a context-less
    //      envelope when called with [].
    //
    //   2. `hits` is non-empty but no entry has sessionId === '__aricord_answer_prompt__'.
    //      That means ARICORD returned search results without an `answer_prompt`
    //      field — a real bug: an out-of-date ARICORD deployment, or
    //      AricordProvider.search() fell through to the /search 503 fallback
    //      (which maps raw /search hits without the sentinel). Fail loud so
    //      the bug surfaces — we *don't* silently answer from a worse prompt.
    if (hits.length === 0) {
      return refLine + 'Question: ' + question;
    }
    throw new Error(
      'AricordProvider: /context/shape did not return an answer_prompt ' +
        '(expected the __aricord_answer_prompt__ entry in the search results). ' +
        'ARICORD is out of date, or this question went through the /search 503 fallback path. ' +
        'Re-run against a healthy, up-to-date ARICORD.',
    );
  }
  return refLine + aricordPrompt;
}
