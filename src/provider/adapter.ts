/**
 * Provider adapter.
 *
 * Local-first means the extension never proxies through our servers —
 * calls go directly from the user's machine to the LLM provider with
 * their own API key (stored in `SecretStorage`, never in settings).
 *
 * We support three modes:
 *   - openai:    standard chat completions API
 *   - anthropic: messages API
 *   - dryrun:    never hits the network; returns the prompt itself.
 *
 * The adapter is intentionally thin — retries, streaming, and
 * tool-calling are all future work. The important property today is that
 * it's a single seam: swapping provider APIs doesn't ripple into the
 * engine or the UI.
 */

export type ProviderKind = "openai" | "anthropic" | "dryrun";

export interface ProviderRequest {
  prompt: string;
  model: string;
  /** Optional API key; dryrun ignores it. */
  apiKey?: string;
}

export interface ProviderResponse {
  text: string;
  provider: ProviderKind;
  model: string;
  /** Raw provider payload for debugging; may be undefined for dryrun. */
  raw?: unknown;
}

export async function send(
  kind: ProviderKind,
  req: ProviderRequest,
): Promise<ProviderResponse> {
  switch (kind) {
    case "dryrun":
      return {
        text:
          "[ContextOS dry-run] No network call was made. " +
          "The assembled prompt is shown in the Preview panel.",
        provider: "dryrun",
        model: req.model,
      };
    case "openai":
      return callOpenAI(req);
    case "anthropic":
      return callAnthropic(req);
    default: {
      const _never: never = kind;
      throw new Error(`Unknown provider: ${String(_never)}`);
    }
  }
}

async function callOpenAI(req: ProviderRequest): Promise<ProviderResponse> {
  if (!req.apiKey) {
    throw new Error("OpenAI API key missing. Run 'ContextOS: Set API Key'.");
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({
      model: req.model,
      messages: [{ role: "user", content: req.prompt }],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  return { text, provider: "openai", model: req.model, raw: data };
}

async function callAnthropic(req: ProviderRequest): Promise<ProviderResponse> {
  if (!req.apiKey) {
    throw new Error("Anthropic API key missing. Run 'ContextOS: Set API Key'.");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": req.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: req.prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text =
    data.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") ?? "";
  return { text, provider: "anthropic", model: req.model, raw: data };
}
