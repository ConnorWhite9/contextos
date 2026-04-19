/**
 * Token estimation.
 *
 * We deliberately avoid a tokenizer dependency (tiktoken et al.) to keep
 * the extension local-first and install-light. The ~4 chars/token heuristic
 * is within ~10% of real tokenizer counts for English + code, which is
 * sufficient for budgeting. If a user needs exact counts, the provider
 * adapter can swap this out behind the same interface.
 */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncate `text` so that `estimateTokens(result) <= maxTokens`, appending
 * a marker so the model (and reader) know the slice was cut.
 */
export function clampToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return "";
  }
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return text;
  }
  const marker = "\n/* …truncated by ContextOS… */";
  const headroom = maxChars - marker.length;
  if (headroom <= 0) {
    return marker.trimStart();
  }
  return text.slice(0, headroom) + marker;
}
