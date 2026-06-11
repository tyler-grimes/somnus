/**
 * OpenAI embeddings (text-embedding-3-small, 1536d — matches HALFVEC(1536)).
 * Returns pgvector literals. Degrades gracefully: no OPENAI_API_KEY → null,
 * callers fall back to FTS/trigram-only retrieval.
 */
export async function embedText(text: string): Promise<string | null> {
  const vecs = await embedBatch([text]);
  return vecs ? vecs[0] : null;
}

export async function embedBatch(texts: string[]): Promise<string[] | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || texts.length === 0) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: texts.map((t) => t.slice(0, 8000)),
      }),
    });
    if (!res.ok) {
      console.error("[embeddings] API error:", res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => `[${d.embedding.join(",")}]`);
  } catch (err) {
    console.error("[embeddings] failed:", err);
    return null;
  }
}
