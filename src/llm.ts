import OpenAI from 'openai';
import type { SessionRecord } from './storage.ts';

// Single OpenAI client instance. Reads OPENAI_API_KEY from env (loaded by
// `import 'dotenv/config'` in server.ts). If the key is missing or the call
// fails, explainSession() returns a human-readable fallback string — the
// detail page renders fine without the LLM block.
const openai = new OpenAI();

// The grounding rules. These are not suggestions — they're the honesty
// contract between the product and the user reading the explainer. If the
// LLM violates them, V2's thesis ("evidence, not interpretation") breaks.
const SYSTEM_PROMPT = `You are Providence V2's session explainer. You receive a list of structured signals extracted from a browser session and must write a short, honest explanation of what happened.

Rules — you must follow all of these:
- Only reference signals that appear in the input. Do not invent causes or events.
- Acknowledge uncertainty. If the evidence is ambiguous, say so.
- Do not use narrative polish ("unfortunately", "the user was frustrated"). Be clinical.
- Do not speculate about the user's emotional state beyond what the evidence directly shows.
- Output 1–3 short paragraphs, plain prose, no markdown headings or lists.
- Do not make recommendations unless asked.`;

export async function explainSession(record: SessionRecord): Promise<string> {
  if (record.signals.length === 0) {
    // Short-circuit: nothing to explain. Saves an API call and is more
    // honest than having the LLM invent a "nothing happened" sentence.
    return 'No signals were extracted from this session. There is no evidence of errors, failed requests, or user-frustration patterns.';
  }
  const user = JSON.stringify(
    {
      url: record.url,
      durationMs: record.durationMs,
      score: record.score,
      signals: record.signals,
    },
    null,
    2,
  );
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-5-nano',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
    });
    return res.choices[0]?.message?.content?.trim() ?? '(no explanation produced)';
  } catch (err) {
    console.error('LLM call failed', err);
    return '(Explainer unavailable — LLM call failed. Check OPENAI_API_KEY or network. The evidence above is complete without it.)';
  }
}
