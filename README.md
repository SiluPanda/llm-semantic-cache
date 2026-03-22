# llm-semantic-cache

Self-hosted semantic cache for LLM responses using cosine similarity search and LRU eviction. Zero runtime dependencies -- bring your own embedding function.

[![npm version](https://img.shields.io/npm/v/llm-semantic-cache.svg)](https://www.npmjs.com/package/llm-semantic-cache)
[![license](https://img.shields.io/npm/l/llm-semantic-cache.svg)](https://github.com/SiluPanda/llm-semantic-cache/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/llm-semantic-cache.svg)](https://nodejs.org/)

---

## Description

`llm-semantic-cache` intercepts LLM calls and returns cached responses when a new prompt is semantically similar to a previously cached one, even if the wording differs. Traditional caches use exact string matching -- "What is the capital of France?" and "Tell me France's capital city" produce different hashes and result in two separate API calls for the same answer. Semantic caching compares prompt meanings via embedding vectors and cosine similarity, dramatically increasing hit rates for natural-language queries.

The cache runs entirely in-process with no external services required. The caller provides an embedding function (OpenAI, Cohere, a local ONNX model, or any source that returns `number[]`), and the cache handles similarity search, LRU eviction, TTL expiry, model-aware namespacing, and cost tracking.

Key characteristics:

- **Zero runtime dependencies.** Only dev dependencies for build and test tooling.
- **Bring your own embeddings.** Any function with the signature `(text: string) => Promise<number[]>` works.
- **Model-aware namespacing.** The same prompt cached under `gpt-4` is never returned for a `gpt-3.5-turbo` query.
- **LRU eviction with configurable cap.** Bounded memory usage with automatic eviction of least-recently-used entries.
- **TTL support.** Entries expire after a configurable duration.
- **Cost tracking.** Built-in hit/miss counters, tokens-saved calculation, and estimated dollar savings.
- **OpenAI-compatible `wrap()` proxy.** Drop-in transparent caching for `client.chat.completions.create` calls.

---

## Installation

```bash
npm install llm-semantic-cache
```

Requires Node.js >= 18.

---

## Quick Start

```typescript
import { createCache } from 'llm-semantic-cache';

// Provide any embedding function
const embedFn = async (text: string): Promise<number[]> => {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return res.data[0].embedding;
};

const cache = await createCache({
  embedFn,
  threshold: 0.92,
  maxEntries: 1000,
  ttlMs: 3_600_000, // 1 hour
});

// Check cache before calling the LLM
const hit = await cache.get('What is the capital of France?');
if (hit) {
  console.log(hit.response);   // 'Paris'
  console.log(hit.similarity);  // e.g. 0.9978
} else {
  const response = await callLLM('What is the capital of France?');
  await cache.set('What is the capital of France?', response, 'gpt-4', {
    inputTokens: 12,
    outputTokens: 5,
  });
}
```

---

## Features

### Semantic Matching

Prompts are compared by embedding similarity rather than string equality. Two prompts that express the same intent but use different wording will produce a cache hit if their cosine similarity meets the configured threshold.

### LRU Eviction

The in-memory store uses a doubly-linked list to track access order. When the number of entries exceeds `maxEntries`, the least-recently-used entry is evicted. Accessing an entry via `get()` promotes it to the front of the list.

### TTL Expiry

When `ttlMs` is set to a value greater than zero, entries older than the TTL are skipped during similarity search. This ensures stale data is never returned even if it remains in the store until eviction.

### Model-Aware Namespacing

Cache lookups are scoped by model identifier. A response cached under `gpt-4` is never returned for a query specifying `gpt-3.5-turbo`, even if the prompt is identical. The model defaults to `'default'` when not specified.

### Cost Tracking

The `stats()` method returns the total tokens saved and estimated dollar cost saved based on configurable per-million-token prices. This enables data-driven decisions about cache tuning.

### OpenAI-Compatible Proxy

The `wrap()` method returns a Proxy around any OpenAI-compatible client. Calls to `client.chat.completions.create` are transparently intercepted -- cache hits return immediately, cache misses call the underlying client and cache the response.

### Serialization

`serialize()` exports the full cache state (entries and stats) as a JSON string. Embedding vectors are converted to plain arrays for portability.

---

## API Reference

### `createCache(options: SemanticCacheOptions): Promise<SemanticCache>`

Factory function that creates and returns a configured `SemanticCache` instance.

```typescript
import { createCache } from 'llm-semantic-cache';

const cache = await createCache({
  embedFn: myEmbeddingFunction,
  threshold: 0.92,
  maxEntries: 1000,
  ttlMs: 0,
  normalizer: (text) => text.trim().toLowerCase(),
  pricePerMTokInput: 2.50,
  pricePerMTokOutput: 10.00,
});
```

---

### `cache.get(prompt, model?): Promise<CacheHit | null>`

Looks up the cache for a semantically similar prompt. Returns a `CacheHit` if a match is found above the similarity threshold, or `null` on a miss.

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `prompt` | `PromptInput` | -- | A plain string or an array of `{ role, content }` message objects. |
| `model` | `string` | `'default'` | Model identifier for namespace scoping. |

**Returns:** `Promise<CacheHit | null>`

```typescript
const hit = await cache.get('What is the capital of France?', 'gpt-4');
if (hit) {
  console.log(hit.response);   // cached response string
  console.log(hit.similarity);  // cosine similarity score
  console.log(hit.entryId);     // unique ID of the matched entry
}
```

---

### `cache.set(prompt, response, model?, usage?): Promise<void>`

Stores a prompt-response pair in the cache. The prompt is embedded, L2-normalized, and stored alongside the response and metadata.

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `prompt` | `PromptInput` | -- | The prompt that produced the response. |
| `response` | `string` | -- | The LLM response to cache. |
| `model` | `string` | `'default'` | Model identifier for namespace scoping. |
| `usage` | `{ inputTokens?: number; outputTokens?: number }` | -- | Token counts for cost tracking. If omitted, tokens are estimated from string length. |

```typescript
await cache.set(
  'What is the capital of France?',
  'Paris',
  'gpt-4',
  { inputTokens: 12, outputTokens: 5 }
);
```

---

### `cache.wrap<T>(client: T): T`

Returns a Proxy that transparently intercepts `client.chat.completions.create` calls. On a cache hit, the proxy returns a synthetic response object with `_cached: true`. On a cache miss, the proxy calls the original method, caches the response, and returns it.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `client` | `T extends object` | An OpenAI-compatible client instance. |

**Returns:** `T` -- A proxied version of the client.

```typescript
import OpenAI from 'openai';

const openai = new OpenAI();
const cachedClient = cache.wrap(openai);

const res = await cachedClient.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});

// On a cache hit, res._cached === true
// On a cache miss, res is the original OpenAI response (and is now cached)
```

The proxy reads `messages` or `prompt` from the call parameters and `model` for namespace scoping. Token usage is extracted from the response's `usage.prompt_tokens` and `usage.completion_tokens` fields.

---

### `cache.search(prompt, topK?): Promise<SearchResult[]>`

Returns the top-K most similar cached entries sorted by descending similarity, without applying the threshold filter. Useful for inspecting cache contents and debugging similarity scores.

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `prompt` | `PromptInput` | -- | The query prompt to compare against cached entries. |
| `topK` | `number` | `5` | Maximum number of results to return. |

**Returns:** `Promise<SearchResult[]>`

```typescript
const results = await cache.search('capital of France', 3);
// [
//   { id: '...', similarity: 0.9978, response: 'Paris' },
//   { id: '...', similarity: 0.7123, response: '...' },
//   ...
// ]
```

---

### `cache.stats(): CacheStats`

Returns current cache performance metrics.

**Returns:**

```typescript
{
  hits: number;            // total cache hits
  misses: number;          // total cache misses
  hitRate: number;         // hits / (hits + misses), or 0 if no lookups
  totalEntries: number;    // current number of entries in the store
  tokensSaved: number;     // cumulative tokens saved across all hits
  estimatedCostSaved: number; // estimated USD saved based on token prices
}
```

```typescript
const s = cache.stats();
console.log(`Hit rate: ${(s.hitRate * 100).toFixed(1)}%`);
console.log(`Cost saved: $${s.estimatedCostSaved.toFixed(4)}`);
```

Token savings are computed as `hitCount * (inputTokens + outputTokens)` per entry. Cost savings use the configured `pricePerMTokInput` and `pricePerMTokOutput` rates.

---

### `cache.delete(id: string): boolean`

Removes a specific entry by its unique ID. Returns `true` if the entry existed and was removed, `false` otherwise.

```typescript
const hit = await cache.get('some prompt');
if (hit) {
  cache.delete(hit.entryId); // remove this specific entry
}
```

---

### `cache.clear(): void`

Removes all entries from the cache and resets hit/miss counters to zero.

```typescript
cache.clear();
console.log(cache.size); // 0
```

---

### `cache.serialize(): string`

Exports the full cache state as a JSON string. The output includes all entries (with embeddings converted from `Float32Array` to plain arrays) and current hit/miss stats.

```typescript
const json = cache.serialize();
// Persist to disk, transfer to another environment, etc.
fs.writeFileSync('cache-snapshot.json', json);
```

**JSON structure:**

```json
{
  "entries": [
    {
      "id": "uuid",
      "embedding": [0.1, 0.2, ...],
      "response": "Paris",
      "model": "gpt-4",
      "createdAt": 1711152000000,
      "accessedAt": 1711152000000,
      "hitCount": 3,
      "inputTokens": 12,
      "outputTokens": 5
    }
  ],
  "stats": { "hits": 10, "misses": 3 }
}
```

---

### `cache.size: number` (readonly)

Returns the current number of entries in the cache.

```typescript
console.log(cache.size); // 42
```

---

## Types

All types are exported from the package entry point.

### `EmbedderFn`

```typescript
type EmbedderFn = (text: string) => Promise<number[]>;
```

The embedding function signature. Accepts a text string and returns a vector of numbers. The vector dimensionality must be consistent across all calls.

### `PromptInput`

```typescript
type PromptInput = string | Array<{ role: string; content: string }>;
```

Accepted prompt formats. A plain string or an OpenAI-style array of message objects. Message arrays are serialized as `"role: content"` lines joined by newlines before embedding.

### `CacheEntry`

```typescript
interface CacheEntry {
  id: string;
  embedding: Float32Array;
  response: string;
  model: string;
  createdAt: number;
  accessedAt: number;
  hitCount: number;
  inputTokens: number;
  outputTokens: number;
}
```

Internal representation of a cached prompt-response pair.

### `CacheHit`

```typescript
interface CacheHit {
  response: string;
  similarity: number;
  entryId: string;
}
```

Returned by `cache.get()` on a successful match.

### `SearchResult`

```typescript
interface SearchResult {
  id: string;
  similarity: number;
  response: string;
}
```

Returned by `cache.search()` for each matching entry.

### `SemanticCacheOptions`

```typescript
interface SemanticCacheOptions {
  embedFn: EmbedderFn;
  threshold?: number;
  maxEntries?: number;
  ttlMs?: number;
  normalizer?: (text: string) => string;
  pricePerMTokInput?: number;
  pricePerMTokOutput?: number;
}
```

### `SemanticCache`

```typescript
interface SemanticCache {
  get(prompt: PromptInput, model?: string): Promise<CacheHit | null>;
  set(
    prompt: PromptInput,
    response: string,
    model?: string,
    usage?: { inputTokens?: number; outputTokens?: number }
  ): Promise<void>;
  wrap<T extends object>(client: T): T;
  search(prompt: PromptInput, topK?: number): Promise<SearchResult[]>;
  stats(): {
    hits: number;
    misses: number;
    hitRate: number;
    totalEntries: number;
    tokensSaved: number;
    estimatedCostSaved: number;
  };
  delete(id: string): boolean;
  clear(): void;
  serialize(): string;
  readonly size: number;
}
```

---

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embedFn` | `(text: string) => Promise<number[]>` | **required** | Embedding function that converts text to a vector. |
| `threshold` | `number` | `0.92` | Minimum cosine similarity for a cache hit. Range: 0 to 1. Higher values require closer matches. |
| `maxEntries` | `number` | `1000` | Maximum number of entries before LRU eviction begins. |
| `ttlMs` | `number` | `0` | Time-to-live in milliseconds. `0` disables TTL expiry. |
| `normalizer` | `(text: string) => string` | `s => s.trim()` | Pre-processing function applied to prompt text before embedding. |
| `pricePerMTokInput` | `number` | `2.50` | USD per million input tokens, used for cost savings estimation. |
| `pricePerMTokOutput` | `number` | `10.00` | USD per million output tokens, used for cost savings estimation. |

### Threshold Tuning

The `threshold` parameter controls the sensitivity of semantic matching:

- **0.95 -- 1.00**: Very strict. Only near-identical phrasings match. Low false-positive rate, lower hit rate.
- **0.90 -- 0.95**: Balanced. Catches most paraphrases while avoiding unrelated matches. Recommended starting point.
- **0.80 -- 0.90**: Permissive. Broader matching, higher hit rate, increased risk of returning responses for prompts that are only loosely related.

The optimal threshold depends on the embedding model and the application's tolerance for approximate matches. Start with `0.92` and adjust based on observed hit quality.

---

## Error Handling

`llm-semantic-cache` propagates errors from the caller-provided embedding function without wrapping them. If `embedFn` throws or rejects, the error surfaces directly from `get()`, `set()`, `search()`, or `wrap()` calls.

Common error scenarios:

- **Embedding function failure.** Network errors, rate limits, or model loading failures in the embedding function propagate as-is. Callers should handle these at the call site.
- **Mismatched embedding dimensions.** If the embedding function returns vectors of inconsistent lengths across calls, cosine similarity computation may produce incorrect results. Ensure the embedding function always returns the same dimensionality.
- **Zero vector.** If the embedding function returns a zero vector, L2 normalization produces a zero `Float32Array`. Cosine similarity with a zero vector returns `0`, so the prompt will never match any cached entry.

The `wrap()` proxy forwards all errors from the underlying client on cache misses. If the proxied `create` call throws, the error propagates to the caller unchanged.

---

## Advanced Usage

### Custom Normalizer

Use a normalizer to increase hit rates by canonicalizing prompts before embedding:

```typescript
const cache = await createCache({
  embedFn,
  normalizer: (text) => text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?.!]+$/, ''),
});
```

### Message Array Prompts

Pass OpenAI-style message arrays directly. They are serialized as `"role: content"` lines before embedding:

```typescript
const hit = await cache.get([
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is the capital of France?' },
]);
```

### Token Usage Tracking

Provide actual token counts from the LLM response for accurate cost tracking:

```typescript
const llmResponse = await openai.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: prompt }],
});

await cache.set(prompt, llmResponse.choices[0].message.content, 'gpt-4', {
  inputTokens: llmResponse.usage.prompt_tokens,
  outputTokens: llmResponse.usage.completion_tokens,
});
```

When `usage` is omitted, token counts are estimated as `Math.ceil(text.length / 4)`.

### Persisting Cache State

Export and re-import cache state across process restarts:

```typescript
import fs from 'node:fs';

// Export
const snapshot = cache.serialize();
fs.writeFileSync('cache.json', snapshot);

// Import on next startup: parse and re-populate
const data = JSON.parse(fs.readFileSync('cache.json', 'utf-8'));
const cache = await createCache({ embedFn });
for (const entry of data.entries) {
  await cache.set(entry.response, entry.response, entry.model, {
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
  });
}
```

### Monitoring Cache Effectiveness

Periodically log cache stats to measure ROI:

```typescript
setInterval(() => {
  const s = cache.stats();
  console.log(
    `Cache: ${s.totalEntries} entries, ` +
    `${(s.hitRate * 100).toFixed(1)}% hit rate, ` +
    `${s.tokensSaved} tokens saved, ` +
    `$${s.estimatedCostSaved.toFixed(4)} estimated savings`
  );
}, 60_000);
```

---

## TypeScript

This package is written in TypeScript and ships with declaration files. All public types are exported from the package entry point:

```typescript
import { createCache } from 'llm-semantic-cache';
import type {
  EmbedderFn,
  PromptInput,
  CacheEntry,
  CacheHit,
  SearchResult,
  SemanticCacheOptions,
  SemanticCache,
} from 'llm-semantic-cache';
```

The package targets ES2022 and uses CommonJS module output. TypeScript 5.4+ is recommended.

---

## License

MIT
