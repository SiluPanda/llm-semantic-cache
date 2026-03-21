# llm-semantic-cache

Self-hosted semantic cache for LLM responses using cosine similarity search and an LRU in-memory store. Zero external runtime dependencies — the caller provides the embedding function.

## Install

```bash
npm install llm-semantic-cache
```

## Quick start

```typescript
import { createCache } from 'llm-semantic-cache'

// Provide your own embedding function
const embedFn = async (text: string): Promise<number[]> => {
  // Use any embedding model (OpenAI, local, etc.)
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
  return res.data[0].embedding
}

const cache = await createCache({
  embedFn,
  threshold: 0.92,    // cosine similarity threshold (default: 0.92)
  maxEntries: 1000,   // LRU cap (default: 1000)
  ttlMs: 3_600_000,  // 1 hour TTL (default: 0 = no TTL)
})
```

## get / set

```typescript
// Check cache before calling LLM
const hit = await cache.get('What is the capital of France?')
if (hit) {
  console.log(hit.response)    // 'Paris'
  console.log(hit.similarity)  // e.g. 0.9978
} else {
  const response = await callLLM('What is the capital of France?')
  await cache.set('What is the capital of France?', response, 'gpt-4', {
    inputTokens: 12,
    outputTokens: 5,
  })
}
```

## wrap

Automatically intercepts `client.chat.completions.create` calls:

```typescript
import OpenAI from 'openai'

const openai = new OpenAI()
const cachedClient = cache.wrap(openai)

// Subsequent identical/similar prompts are served from cache
const res = await cachedClient.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
})
```

## search

Find the topK most similar cached responses without applying the threshold filter:

```typescript
const results = await cache.search('capital of France', 3)
// [{ id, similarity, response }, ...]
```

## stats

```typescript
const s = cache.stats()
// {
//   hits: 42,
//   misses: 8,
//   hitRate: 0.84,
//   totalEntries: 15,
//   tokensSaved: 12400,
//   estimatedCostSaved: 0.156   // USD
// }
```

## Other methods

```typescript
cache.delete(entryId)  // Remove a specific entry, returns boolean
cache.clear()          // Reset cache and counters
cache.serialize()      // JSON snapshot of all entries + stats
cache.size             // Current number of entries
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `embedFn` | `(text: string) => Promise<number[]>` | required | Embedding function |
| `threshold` | `number` | `0.92` | Minimum cosine similarity for a cache hit |
| `maxEntries` | `number` | `1000` | Maximum entries before LRU eviction |
| `ttlMs` | `number` | `0` | TTL in ms (0 = no expiry) |
| `normalizer` | `(text: string) => string` | `s => s.trim()` | Text pre-processing before embedding |
| `pricePerMTokInput` | `number` | `2.50` | USD per million input tokens (for cost tracking) |
| `pricePerMTokOutput` | `number` | `10.00` | USD per million output tokens (for cost tracking) |

## License

MIT
