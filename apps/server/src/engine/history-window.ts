/**
 * History windowing for models with bounded context windows.
 *
 * oMLX caches prefill across requests (boundary-cache snapshots, GDN SSD
 * split), so replaying a STABLE, append-only history is cheap — each turn
 * only processes the new suffix. Windowing therefore uses hysteresis:
 * history is passed through untouched while it fits under the high
 * watermark, and only when it overflows is it cut once, back to the low
 * watermark. Between cuts the array only grows, so the provider's prefix
 * cache keeps hitting.
 *
 * Cuts land on a user-message boundary so assistant tool-call and
 * tool-result groups are never split (a tool result without its call is a
 * protocol error on every provider).
 */

export interface HistoryMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface WindowedHistory {
  messages: HistoryMessage[];
  /** Messages dropped from the front by the cut (0 when under the watermark). */
  dropped: number;
}

/** ~4 characters per token; deliberately rough — a slight overestimate is safe. */
function estimateTokens(message: HistoryMessage): number {
  return Math.ceil(JSON.stringify(message).length / 4);
}

/**
 * Pass history through while it fits the high watermark; when it overflows,
 * cut at a user boundary back to the low watermark. A tail whose single
 * first message already exceeds the low watermark is kept whole — an
 * oversized turn should fail loudly at the model, not be mangled here.
 * `highWatermarkTokens <= 0` disables windowing entirely.
 */
export function windowHistory(
  messages: HistoryMessage[],
  highWatermarkTokens: number,
  lowWatermarkTokens: number,
): WindowedHistory {
  if (messages.length === 0 || highWatermarkTokens <= 0)
    return { messages, dropped: 0 };
  let total = 0;
  for (const message of messages) total += estimateTokens(message);
  if (total <= highWatermarkTokens) return { messages, dropped: 0 };

  let keepFrom = messages.length;
  let kept = 0;
  while (keepFrom > 0 && kept + estimateTokens(messages[keepFrom - 1]) <= lowWatermarkTokens) {
    keepFrom--;
    kept += estimateTokens(messages[keepFrom]);
  }
  while (keepFrom < messages.length && messages[keepFrom].role !== "user") keepFrom++;
  if (keepFrom >= messages.length) return { messages, dropped: 0 };
  return { messages: messages.slice(keepFrom), dropped: keepFrom };
}
