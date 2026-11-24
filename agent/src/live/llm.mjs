// OpenAI-compatible chat client (OpenAI, OpenRouter, Groq, DeepSeek, Together, local Ollama, ...).
// Returns null when not configured: the council then runs on its deterministic quant models.

export function extractJson(text) {
  if (!text) throw new Error('empty LLM reply');
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in LLM reply');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function createLLM({ baseUrl, apiKey, model, timeoutMs = 15_000, log = () => {} }) {
  if (!model || (!apiKey && !/localhost|127\.0\.0\.1/.test(baseUrl ?? ''))) return null;
  const url = `${String(baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
  return {
    model,
    async json(messages, { maxTokens = 300 } = {}) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: maxTokens }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        return extractJson(data?.choices?.[0]?.message?.content);
      } catch (e) {
        log('llm error:', e.message);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
