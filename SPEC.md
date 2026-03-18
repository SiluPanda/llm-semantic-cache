# llm-semantic-cache -- Specification

## 1. Overview

`llm-semantic-cache` is a self-hosted semantic cache for LLM responses that uses local embeddings and cosine similarity to match semantically equivalent prompts -- no cloud dependency, no external vector database, pluggable storage backends. It accepts a prompt, generates an embedding via a caller-provided embedding function, searches the cache for the nearest neighbor above a configurable similarity threshold, and returns the cached response on a hit or delegates to the LLM on a miss. The entire pipeline -- embedding generation, similarity search, cache storage, eviction -- runs locally in the same Node.js process, with optional persistence and distribution through pluggable backends.

The gap this package fills is specific and well-defined. Traditional LLM response caches use exact key matching: they hash the prompt string and look up the hash. "What is the capital of France?" and "Tell me France's capital city" are different strings that produce different hashes, resulting in two separate LLM API calls for the same answer. Semantic caching solves this by comparing prompt meanings rather than prompt bytes. If a new prompt's embedding is sufficiently similar (cosine similarity above a threshold) to a cached prompt's embedding, the cached response is returned without calling the LLM. This dramatically increases cache hit rates for applications that receive natural-language queries with high semantic overlap but low string overlap.

The closest existing tools address this problem but not in a self-hosted JavaScript package. GPTCache is the primary semantic cache library, but it is Python-only, tightly coupled to the Python ecosystem, and requires heavy dependencies (FAISS for vector search, ONNX Runtime for local embeddings, Redis or SQLite for storage). It cannot be used in Node.js applications. Upstash Semantic Cache provides semantic caching as a cloud service backed by Upstash Vector -- it requires an Upstash account, sends prompts and embeddings to their cloud infrastructure, and charges per request. For teams that cannot send prompt data to third-party cloud services (compliance, privacy, cost), Upstash is not viable. In the npm ecosystem, `lru-cache`, `keyv`, and `node-cache` provide exact-key caching primitives with no concept of semantic similarity. `llm-response-cache` in this monorepo provides hash-keyed LLM response caching -- exact string matching with normalization. `prompt-dedup` provides text-level normalization and hashing to increase cache hit rates for textually similar prompts, but it cannot detect that "What's the weather in Paris?" and "Tell me the current weather conditions in Paris, France" are semantically equivalent because they differ at the text level, not just the formatting level. `embed-cache` in this monorepo caches embedding vectors to avoid redundant embedding API calls, but it does not cache LLM responses and does not perform similarity search.

`llm-semantic-cache` combines the semantic matching capability of GPTCache with the self-hosted simplicity of a zero-dependency npm package. It provides a TypeScript/JavaScript API with a `createCache(options)` factory, a `cache.get(prompt)` / `cache.set(prompt, response)` interface for direct use, a `cache.wrap(client)` cache-through wrapper that transparently intercepts LLM client calls, and a CLI for cache inspection and management. The cache supports multiple storage backends (in-memory, SQLite, Redis, filesystem), configurable eviction policies (TTL, LRU, max entries), model-aware namespacing (same prompt with different models produces separate cache entries), streaming response caching, and cost tracking with integration into `model-price-registry`.

---

## 2. Goals and Non-Goals

### Goals

- Provide a `createCache(options)` factory that returns a `SemanticCache` instance configured with an embedding function, similarity threshold, storage backend, and eviction policy.
- Provide a `cache.get(prompt, options?)` method that embeds the prompt, searches the cache for the nearest neighbor above the similarity threshold, and returns the cached response on a hit or `null` on a miss.
- Provide a `cache.set(prompt, response, options?)` method that embeds the prompt and stores the prompt embedding alongside the LLM response in the cache.
- Provide a `cache.wrap(client, options?)` method that returns a proxy LLM client where all chat/completion calls are transparently intercepted by the cache -- cache hits return immediately, cache misses call the underlying client and cache the response.
- Provide a `cache.search(prompt, options?)` method that returns the top-K nearest cached entries with their similarity scores, enabling inspection of what the cache contains and how close new prompts are to existing entries.
- Implement cosine similarity as the default similarity metric for comparing prompt embeddings. Cosine similarity is the standard metric for embedding comparison because it measures directional similarity independent of vector magnitude, which is exactly what text embedding models are trained to produce.
- Support a configurable similarity threshold (default: 0.92) that controls the cache hit/miss boundary. Prompts with cosine similarity at or above the threshold are cache hits; below the threshold are cache misses. The threshold is tunable per use case.
- Implement brute-force nearest-neighbor search as the default search strategy, suitable for caches with up to approximately 10,000 entries. Brute-force search computes cosine similarity between the query embedding and every cached embedding, returning the maximum. For typical cache sizes in LLM applications, this completes in under 1ms.
- Support model-aware caching: the same prompt sent to different models produces separate cache entries. The cache key is the combination of the prompt embedding and the model identifier. A response from GPT-4o is never returned for a GPT-3.5-turbo query, even if the prompt is identical.
- Support pluggable embedding functions via a simple `(text: string) => Promise<number[]>` interface. The cache does not generate embeddings itself -- it delegates to the caller's embedding function. Adapters for OpenAI embeddings, local ONNX models, and other providers are provided as convenience utilities but are not required.
- Support multiple storage backends via a `StorageBackend` interface: in-memory (default, `Map` for entries plus flat `Float32Array` for vectors), SQLite (persistent, single-file), Redis (distributed, shared across processes), filesystem (JSON files), and custom adapters.
- Support eviction policies: TTL (entries expire after a configurable duration), LRU (least recently used entries evicted when max size is reached), max entries (hard limit on cache size), and manual eviction via `cache.delete(id)` and `cache.clear()`.
- Support streaming response caching: on a cache miss with a streaming LLM call, the stream is forwarded to the caller in real time while the full response is buffered; when the stream completes, the full response is cached. On a cache hit, the cached response is replayed as a stream.
- Track cache performance metrics: total hits, total misses, hit rate, estimated tokens saved, estimated cost saved (integrating with `model-price-registry` for model pricing).
- Provide cache serialization and deserialization (`cache.serialize()` / `SemanticCache.deserialize()`) for exporting and importing cache state across environments.
- Provide a CLI (`llm-semantic-cache`) for inspecting cache stats, searching the cache, clearing entries, and exporting/importing cache state.
- Integrate with `embed-cache` (for caching the embedding function itself, avoiding redundant embedding API calls), `llm-response-cache` (as a semantic upgrade path for exact-key caches), `llm-dedup` (for coalescing in-flight requests before they reach the cache), `prompt-dedup` (for normalizing prompts before embedding to improve cache hit rates), and `model-price-registry` (for cost tracking).
- Zero runtime dependencies for the core in-memory mode. Optional peer dependencies for storage backends (`better-sqlite3`, `ioredis`).
- Target Node.js 18+. Use `node:crypto` for hashing, `Float32Array` for vector storage, built-in `node:util` for CLI argument parsing.

### Non-Goals

- **Not an embedding provider.** This package does not call any embedding API directly. It wraps a caller-provided embedding function. The caller chooses the model and provides the function -- bring your own OpenAI client, Cohere client, local ONNX model, or any other embedding source. If no embedding function is provided, construction fails with an error.
- **Not a vector database.** This package stores embedding vectors for cache lookup via nearest-neighbor search over a bounded set of cache entries. It does not provide metadata filtering, multi-index queries, hybrid search, or the full query language of a vector database. For large-scale vector storage and retrieval, use Pinecone, Weaviate, Qdrant, or Milvus. `llm-semantic-cache` is a cache, not a database -- entries are evicted, the total size is bounded, and the purpose is fast lookup, not long-term storage.
- **Not an LLM provider or proxy.** This package intercepts LLM calls to check the cache but does not implement any LLM API. The `cache.wrap(client)` method delegates to the caller's client on cache misses. It does not route requests, load balance, or implement retries. Use `llm-failover`, `llm-retry`, or a dedicated LLM gateway for those concerns.
- **Not a general-purpose similarity search engine.** The cache searches for the single nearest neighbor above a threshold. It is not designed for top-K retrieval across millions of documents, approximate nearest neighbor at web scale, or similarity-based recommendation. The search is brute-force over a bounded cache and is optimized for cache-sized datasets (hundreds to low thousands of entries), not retrieval-sized datasets.
- **Not an exact-key response cache.** For exact prompt matching with hash-based keys, use `llm-response-cache`. Semantic caching adds embedding overhead on every cache lookup -- if your prompts are always exactly identical strings, exact-key caching is faster and cheaper. Semantic caching is for applications where prompts vary in wording but not meaning.
- **Not a prompt normalization tool.** While the cache benefits from normalized prompts (normalizing before embedding reduces the embedding space and improves cache hit rates), prompt normalization itself is the responsibility of `prompt-dedup`. `llm-semantic-cache` accepts an optional `normalizer` function in its configuration to plug in `prompt-dedup` normalization, but it does not implement normalization logic.
- **Not a distributed cache coordinator.** The Redis backend enables shared caching across multiple processes, but `llm-semantic-cache` does not implement distributed locking, cache invalidation protocols, or write conflict resolution. Two processes may simultaneously miss the same prompt and both call the LLM, with both writing the same response. This is safe (idempotent writes) but wastes an LLM call. For high-concurrency deduplication of in-flight requests, combine with `llm-dedup`.

---

## 3. Target Users and Use Cases

### FAQ and Customer Support Systems

Teams operating FAQ bots, customer support chatbots, and knowledge-base query systems. These systems receive a high volume of semantically similar questions: "How do I reset my password?", "I need to change my password", "Where can I reset my login password?", "Can you help me with a password reset?". All four questions have the same answer, but each is a different string producing a different hash under exact-key caching. With semantic caching, the first question is answered by the LLM and cached. The subsequent three questions match the first via embedding similarity and receive the cached answer without calling the LLM. A customer support system handling 50,000 queries per day at an average of 800 tokens per response using GPT-4o ($2.50/MTok output) spends $100/day. If 60% of queries are semantic duplicates of previously answered questions, semantic caching reduces that to $40/day -- $21,900/year in savings from a single cache layer.

### Search and Query Interfaces

Teams building natural-language search interfaces over structured data, documentation, or knowledge bases. Users phrase the same search intent in many different ways: "latest quarterly revenue", "what was revenue last quarter", "Q3 revenue numbers", "show me the most recent quarterly revenue figures". An exact-key cache misses all of these because the strings differ. A semantic cache recognizes them as the same query and returns the cached response. Search interfaces typically have a smaller universe of unique intents than customer support (hundreds to low thousands), making brute-force nearest-neighbor search over the cache efficient.

### Cost Optimization Engineers

Engineers tasked with reducing LLM API spend across applications. Semantic caching is the highest-leverage cost reduction technique for applications with repetitive query patterns. The cache's `stats()` method returns `{ hits, misses, hitRate, tokensSaved, costSaved }`, giving a concrete dollar figure for the cache's value. Combined with `model-price-registry` for accurate per-model pricing, this enables data-driven cost optimization decisions.

### Rate Limit Mitigation

Teams hitting LLM API rate limits during peak traffic. Semantic caching reduces the number of API calls by serving repeated queries from cache, effectively multiplying the application's throughput without increasing the rate limit. A system rate-limited to 1,000 requests per minute that achieves a 50% semantic cache hit rate effectively handles 2,000 user requests per minute.

### Latency-Sensitive Applications

Applications where LLM response latency is a critical UX factor. An LLM API call takes 500ms-5s depending on model and response length. A semantic cache hit returns in under 5ms (embedding generation + similarity search + cache lookup). For a chatbot where users expect sub-second responses, serving 60% of queries from cache reduces the p50 latency from seconds to milliseconds.

### Development and Testing Environments

Developers iterating on LLM-powered applications during development. Every code change triggers a test run that calls the LLM with similar prompts. Without caching, each test run accumulates API cost and is gated by API latency. With a persistent semantic cache (SQLite backend), test prompts that are semantically similar to previously cached prompts return instantly with zero API cost, even across process restarts. The cache serves as a development accelerator.

### Multi-Tenant SaaS Platforms

Platforms serving multiple tenants who independently query the same underlying LLM. Different tenants ask similar questions about the same product or domain. A shared semantic cache (Redis backend) ensures that a question answered for one tenant is available to all tenants with semantically similar questions. Tenant isolation, if required, is achieved via model-aware namespacing with a tenant prefix.

---

## 4. Core Concepts

### Semantic Similarity vs. Exact Matching

Traditional caching systems use exact key matching. The cache key is a hash of the prompt string, and two prompts match only if their hashes are identical -- meaning their strings are identical (or identical after normalization). This works well when prompts are generated by templates with consistent formatting. It fails when prompts are natural-language queries authored by humans, because humans express the same intent in many different ways.

Semantic similarity measures meaning rather than text. Two prompts are semantically similar if they express the same intent, regardless of their surface-level wording. "What is the capital of France?" and "Tell me France's capital city" are semantically equivalent but textually different. Semantic similarity is computed by comparing embedding vectors: numerical representations of text meaning produced by embedding models. If the cosine similarity between two prompt embeddings exceeds a threshold, the prompts are considered semantically equivalent for caching purposes.

The tradeoff is cost. Exact matching requires only a hash computation (sub-microsecond). Semantic matching requires embedding generation (1-50ms for local models, 50-500ms for API-based models) and similarity search (sub-1ms for brute-force over a small cache). This overhead is justified when the alternative is calling the LLM (500ms-5s, $0.001-$0.06 per call depending on model and token count).

### Embeddings

An embedding is a dense numerical vector (typically 384 to 3072 floating-point numbers) that represents the semantic content of a piece of text. Embedding models are trained so that texts with similar meanings produce vectors that are close together in the embedding space, as measured by cosine similarity. "What is the capital of France?" and "Tell me France's capital city" produce embedding vectors with cosine similarity of approximately 0.95, while "What is the capital of France?" and "How do I bake a cake?" produce vectors with cosine similarity of approximately 0.15.

`llm-semantic-cache` does not generate embeddings itself. It accepts a caller-provided embedding function with the signature `(text: string) => Promise<number[]>`. This function can wrap any embedding source: OpenAI's `text-embedding-3-small` (1536 dimensions, $0.02/MTok), a local ONNX model like `all-MiniLM-L6-v2` (384 dimensions, free), Cohere's Embed API, or any custom embedding model. The cache is agnostic to the embedding source -- it only requires that the function returns a consistent-dimensionality number array.

### Cosine Similarity

Cosine similarity measures the cosine of the angle between two vectors, producing a value between -1 and 1 (for normalized embedding vectors, typically between 0 and 1). A value of 1.0 means the vectors point in exactly the same direction (identical meaning). A value of 0.0 means the vectors are orthogonal (unrelated meaning). A value of -1.0 means the vectors point in opposite directions (opposite meaning, rare in practice for text embeddings).

The formula is:

```
cosine_similarity(A, B) = (A . B) / (||A|| * ||B||)
```

Where `A . B` is the dot product of the two vectors, and `||A||` and `||B||` are their L2 norms (Euclidean lengths). For pre-normalized vectors (which most embedding models produce), this simplifies to just the dot product: `cosine_similarity(A, B) = A . B`.

Cosine similarity is the standard metric for text embedding comparison because embedding models are trained to optimize for cosine similarity between semantically related texts. Euclidean distance and dot product are alternatives, but cosine similarity is invariant to vector magnitude, making it robust to minor scaling differences across embedding API calls.

### Similarity Threshold

The similarity threshold is the minimum cosine similarity required for a cache hit. If the most similar cached prompt has cosine similarity at or above the threshold with the query prompt, the cache returns the associated response. If the most similar cached prompt is below the threshold, the cache reports a miss, and the query is forwarded to the LLM.

The threshold controls the precision-recall tradeoff of the cache:

- **Too high (0.99)**: Only near-identical rephrasings match. Very few false positives, but very few cache hits. The cache rarely activates.
- **Too low (0.70)**: Loosely related prompts match. Many cache hits, but some are wrong -- a question about French geography might return a cached answer about French cuisine because the embeddings share "France" context. False positives degrade user experience.
- **Sweet spot (0.88-0.95)**: Depends on the use case. FAQ systems with well-defined question categories can use lower thresholds (0.85-0.90) because semantically similar questions genuinely have the same answer. Creative or open-ended applications need higher thresholds (0.95+) because subtle prompt differences produce meaningfully different responses.

The default threshold is 0.92, which provides a conservative balance: high enough to avoid false positives for most use cases, low enough to catch common rephrasings. The threshold is configurable per cache instance and per individual `get` call.

Recommended thresholds by use case:

| Use Case | Recommended Threshold |
|---|---|
| FAQ bot / knowledge base | 0.88 - 0.92 |
| Customer support | 0.90 - 0.93 |
| Search query dedup | 0.88 - 0.92 |
| Code generation | 0.95 - 0.98 |
| Creative writing | 0.96 - 0.99 |
| Translation | 0.93 - 0.96 |

### Cache-Through Pattern

The cache-through pattern means the cache sits between the application and the LLM API, transparently intercepting all calls. The application code calls the cached client exactly as it would call the original LLM client. The cache handles the hit/miss logic internally:

```
Application → cachedClient.chat(messages)
                  ↓
              embed(prompt) → queryEmbedding
                  ↓
              search(queryEmbedding, threshold) → nearestEntry
                  ↓
              similarity ≥ threshold?
              ├── YES → return nearestEntry.response (cache hit, <5ms)
              └── NO  → client.chat(messages) → response
                            ↓
                        cache.set(prompt, queryEmbedding, response)
                            ↓
                        return response
```

The cache-through wrapper is created via `cache.wrap(client)`, which returns a proxy object with the same interface as the original client. The application does not need to know whether a response came from the cache or the LLM.

### Cache Entry

A cache entry is the unit of storage in the semantic cache. Each entry contains:

- **`id`**: A unique identifier for the entry (UUID v4 or content-derived hash).
- **`prompt`**: The original prompt text or message array that was sent to the LLM.
- **`embedding`**: The embedding vector of the prompt, used for similarity search.
- **`response`**: The full LLM response (completion text, message object, or structured output).
- **`model`**: The model identifier that produced the response (e.g., `gpt-4o`, `claude-sonnet-4-20250514`).
- **`createdAt`**: Timestamp of when the entry was created.
- **`accessedAt`**: Timestamp of the most recent cache hit on this entry (for LRU eviction).
- **`hitCount`**: Number of times this entry has been returned as a cache hit.
- **`ttl`**: Optional time-to-live in milliseconds, after which the entry expires.
- **`metadata`**: Optional caller-provided metadata (tags, categories, source info).

### Model-Aware Namespacing

The same prompt sent to different models should produce different cache entries because different models produce different responses. "Explain quantum computing" sent to GPT-4o produces a different answer than the same prompt sent to GPT-3.5-turbo. If the cache returned a GPT-3.5-turbo response for a GPT-4o query, the user would receive a lower-quality answer than expected.

Model-aware namespacing ensures this does not happen. Each cache entry is tagged with the model identifier, and similarity search is scoped to entries with a matching model. Internally, this is implemented as a namespace partition: entries are grouped by model, and search only examines entries in the matching namespace. The cache key is effectively `(embedding, model)`, not just `embedding`.

---

## 5. How Semantic Caching Works

### Full Pipeline

The semantic caching pipeline executes five steps on every prompt:

**Step 1: Receive prompt.** The application calls `cache.get(prompt, { model })` or the cache-through wrapper intercepts a `client.chat(messages)` call. The prompt may be a plain string, an OpenAI-style message array (`{role, content}[]`), or an Anthropic-style prompt object. The cache normalizes structured formats into a canonical string representation for embedding: system message content is prepended, user/assistant messages are concatenated with role markers, and the final user message is the primary embedding target.

**Step 2: Generate embedding.** The cache calls the configured embedding function with the canonical prompt string: `const embedding = await embedder(promptText)`. This produces a number array (e.g., 1536-dimensional `number[]` for `text-embedding-3-small`). If the cache is configured with an `embed-cache` integration, the embedding function is wrapped so that identical prompts do not re-embed.

**Step 3: Search cache for nearest neighbor.** The cache searches all entries in the matching model namespace for the entry whose embedding has the highest cosine similarity to the query embedding. For brute-force search (default), this is a linear scan over all cached embeddings, computing cosine similarity for each. The search returns the best match and its similarity score.

**Step 4: Evaluate threshold.** If the best match's similarity score is at or above the configured threshold, the cache declares a hit. It updates the entry's `accessedAt` timestamp and `hitCount`, increments the global hit counter, and returns the cached response. If the best match is below the threshold (or the cache is empty for this model namespace), the cache declares a miss and increments the global miss counter.

**Step 5: On miss -- call LLM and cache response.** The application (or cache-through wrapper) calls the LLM with the original prompt. When the response is received, the cache stores a new entry with the prompt, embedding, response, model identifier, and timestamp. The entry is subject to the configured eviction policy.

### Pipeline Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Application                                  │
│                                                                     │
│   const answer = await cachedClient.chat({ messages, model })       │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Step 1: Normalize Prompt                                           │
│                                                                     │
│  messages → canonical prompt string                                 │
│  (optional: apply prompt-dedup normalization)                       │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Step 2: Generate Embedding                                         │
│                                                                     │
│  embedder(promptText) → number[] (e.g., 1536-dim vector)            │
│  (optional: embed-cache wraps embedder to avoid re-embedding)       │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Step 3: Search Cache (model-scoped)                                │
│                                                                     │
│  for each entry in cache[model]:                                    │
│    score = cosineSimilarity(queryEmbedding, entry.embedding)        │
│  bestMatch = entry with highest score                               │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Step 4: Evaluate Threshold                                         │
│                                                                     │
│  bestMatch.score >= threshold ?                                     │
│  ├── YES (HIT)  → return bestMatch.response    (< 5ms total)       │
│  └── NO  (MISS) → continue to Step 5                               │
└──────────┬────────────────────────────┬─────────────────────────────┘
           │ HIT                        │ MISS
           ▼                            ▼
┌──────────────────────┐  ┌───────────────────────────────────────────┐
│  Return cached        │  │  Step 5: Call LLM, Cache Response         │
│  response             │  │                                           │
│                       │  │  response = await client.chat(messages)    │
│  Update accessedAt    │  │  cache.set(prompt, embedding, response)    │
│  Increment hitCount   │  │  return response                          │
│  Increment stats.hits │  │  Increment stats.misses                   │
└──────────────────────┘  └───────────────────────────────────────────┘
```

### Cache Hit Example

```
User prompt: "Tell me France's capital city"
  → Embedding: [0.021, -0.087, 0.153, ..., 0.044]  (1536 dims)
  → Search cache (model: gpt-4o):
      Entry 1: "What is the capital of France?" → similarity: 0.96  ✓ HIT
      Entry 2: "What is the population of France?" → similarity: 0.82
      Entry 3: "What is the capital of Germany?" → similarity: 0.78
  → Best match: Entry 1 (0.96 ≥ 0.92 threshold)
  → Return cached response: "The capital of France is Paris."
  → Total latency: ~3ms (embedding: 2ms local, search: <1ms, lookup: <1ms)
  → LLM API calls: 0
  → Cost: $0 (embedding cost only, if using API-based embeddings)
```

### Cache Miss Example

```
User prompt: "How do I bake sourdough bread?"
  → Embedding: [0.098, 0.041, -0.203, ..., 0.017]  (1536 dims)
  → Search cache (model: gpt-4o):
      Entry 1: "What is the capital of France?" → similarity: 0.12
      Entry 2: "What is the population of France?" → similarity: 0.14
      Entry 3: "What is the capital of Germany?" → similarity: 0.11
  → Best match: Entry 2 (0.14 < 0.92 threshold)
  → Cache miss → call LLM
  → LLM response: "To bake sourdough bread, start by creating a starter..."
  → Cache new entry: prompt + embedding + response + model
  → Return response to user
  → Total latency: ~2500ms (embedding: 2ms, search: <1ms, LLM call: ~2500ms)
```

---

## 6. Similarity Search

### Brute-Force Cosine Similarity (Default)

The default search strategy is brute-force linear scan. For each query, the cache computes cosine similarity between the query embedding and every cached embedding in the matching model namespace, returning the entry with the highest similarity score.

The implementation uses `Float32Array` for vector storage, which enables efficient SIMD-optimized dot product computation on modern JavaScript engines (V8's TurboFan JIT compiler auto-vectorizes simple loops over typed arrays). For pre-normalized embeddings (which most embedding models produce), cosine similarity reduces to the dot product, eliminating the norm computation.

```typescript
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot; // For pre-normalized vectors, dot product = cosine similarity
}
```

**Performance characteristics:**

| Cache Size | Dimensions | Search Time |
|---|---|---|
| 100 entries | 1536 | < 0.1ms |
| 1,000 entries | 1536 | < 0.5ms |
| 5,000 entries | 1536 | ~ 2ms |
| 10,000 entries | 1536 | ~ 4ms |
| 100 entries | 384 | < 0.05ms |
| 1,000 entries | 384 | < 0.1ms |
| 10,000 entries | 384 | ~ 1ms |

Brute-force search is O(n * d) where n is the number of cached entries and d is the embedding dimensionality. For typical LLM semantic caches (hundreds to low thousands of entries), this is sub-millisecond and dominates no part of the total pipeline latency.

### Why Brute-Force Is Sufficient for Semantic Caching

LLM semantic caches are fundamentally different from vector databases in scale. A vector database indexes millions to billions of document embeddings for retrieval. An LLM semantic cache indexes hundreds to thousands of unique prompt-response pairs for deduplication. The difference is three to six orders of magnitude.

At 10,000 entries with 1536-dimensional embeddings, brute-force search takes approximately 4ms. The embedding generation step takes 1-50ms (local model) or 50-500ms (API call). The LLM call on a miss takes 500-5000ms. Even at the upper bound of brute-force search latency, it is less than 1% of the total pipeline latency on a miss and negligible compared to the latency savings on a hit.

Approximate nearest neighbor (ANN) algorithms like HNSW (Hierarchical Navigable Small World) provide sub-linear search time but add complexity: index construction cost, memory overhead for the graph structure, and tuning parameters (ef_construction, M) that affect recall-precision tradeoffs. For cache-sized datasets, the complexity is not justified.

### Approximate Nearest Neighbor (Optional, for Large Caches)

For caches that grow beyond 10,000 entries (unusual for LLM semantic caching but possible for aggregated multi-application caches), the cache supports an optional HNSW index. When `searchStrategy: 'hnsw'` is configured, the cache builds an HNSW graph over the cached embeddings and uses it for approximate nearest-neighbor search.

**HNSW characteristics:**

- Search time: O(log n) amortized, approximately 0.1ms for 100,000 entries.
- Recall: > 0.99 with default parameters (ef_search: 200).
- Memory overhead: approximately 2x the raw vector storage (for the graph structure).
- Index build cost: O(n * log n), incremental (each new entry is inserted into the graph).

The HNSW implementation is a built-in pure TypeScript implementation with no external dependencies. It is not enabled by default because brute-force is sufficient for typical cache sizes and has zero overhead.

### Vector Normalization

Before storing an embedding in the cache, the vector is L2-normalized (divided by its Euclidean norm) so that all cached vectors have unit length. This ensures cosine similarity equals the dot product, simplifying and accelerating the similarity computation. If the embedding function already produces normalized vectors (as most modern embedding models do), the normalization is a no-op detected by checking if the L2 norm is within epsilon of 1.0.

```typescript
function normalizeVector(v: number[]): Float32Array {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  const out = new Float32Array(v.length);
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) {
      out[i] = v[i] / norm;
    }
  }
  return out;
}
```

### Dimensionality Handling

All embeddings in a single cache instance must have the same dimensionality. The dimensionality is inferred from the first embedding stored and validated on all subsequent stores. If a caller attempts to store an embedding with a different dimensionality, the cache throws an error. This prevents bugs caused by mixing embeddings from different models in the same cache namespace.

The dimensionality constraint is enforced per model namespace. Different model namespaces may have different dimensionalities: a `text-embedding-3-small` namespace stores 1536-dimensional vectors while an `all-MiniLM-L6-v2` namespace stores 384-dimensional vectors. The cache tracks dimensionality per namespace.

---

## 7. Cache-Through Wrapper

### `cache.wrap(client, options?)`

The cache-through wrapper is the primary integration mechanism. It accepts an LLM client object and returns a proxy object with the same interface where all chat/completion calls are intercepted by the cache.

```typescript
import { createCache } from 'llm-semantic-cache';
import OpenAI from 'openai';

const openai = new OpenAI();
const cache = createCache({
  embedder: async (text) => {
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return res.data[0].embedding;
  },
  threshold: 0.92,
});

const cachedClient = cache.wrap(openai);

// This call goes through the cache transparently
const response = await cachedClient.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});
// First call: cache miss → calls OpenAI → caches response → returns
// Second call with similar prompt: cache hit → returns cached response
```

### How Wrapping Works

The wrapper uses a JavaScript `Proxy` to intercept method calls on the client object. When `chat.completions.create` (OpenAI-style) or `messages.create` (Anthropic-style) is called, the wrapper:

1. Extracts the prompt from the request parameters (messages array, system message, etc.).
2. Extracts the model identifier from the request parameters.
3. Calls `cache.get(prompt, { model })` to check for a cache hit.
4. On hit: constructs a response object matching the original client's response format and returns it.
5. On miss: delegates to the original client method, caches the response, and returns it.

The wrapper handles both the OpenAI client interface (`openai.chat.completions.create`) and the Anthropic client interface (`anthropic.messages.create`). Custom client interfaces are supported via a `clientAdapter` option that maps the client's method structure to the cache's internal representation.

### Model Extraction

The model identifier is extracted from the request parameters automatically. For OpenAI clients, it comes from `params.model`. For Anthropic clients, from `params.model`. The model identifier is used for namespace-scoped cache lookup.

### Response Format Reconstruction

When returning a cached response, the wrapper must construct a response object that matches the format the original client would return. For OpenAI, this means a `ChatCompletion` object with `id`, `object`, `created`, `model`, `choices`, and `usage` fields. For Anthropic, a `Message` object with `id`, `type`, `role`, `content`, and `usage` fields.

The cached entry stores the essential response data (content text, role, finish reason). On a cache hit, the wrapper reconstructs the full response object with:
- A synthetic `id` prefixed with `cache-` to indicate a cached response.
- The original `model` from the cached entry.
- `usage` fields set to `{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }` since no tokens were consumed.
- A `_cached: true` property added to the response for consumers that want to detect cache hits programmatically.

### Streaming Support

The cache-through wrapper handles streaming responses (`stream: true` in the request parameters).

**On a cache miss with streaming:**

1. The wrapper delegates to the original client with `stream: true`.
2. It returns an async iterable to the caller that yields chunks as they arrive from the LLM.
3. Internally, it buffers the full response content as chunks arrive.
4. When the stream completes (final chunk received), the wrapper caches the full buffered response.
5. The caller receives the stream in real time -- there is no added latency.

**On a cache hit with streaming:**

1. The wrapper finds the cached response.
2. It returns an async iterable that yields the cached response as synthetic chunks.
3. The chunks are emitted with configurable timing: `immediate` (all chunks at once, minimizing latency), `simulated` (chunks emitted with realistic delays to simulate streaming), or `throttled` (chunks emitted at a specified tokens-per-second rate).
4. The default is `immediate`, which returns the full cached response as a single chunk followed by a `[DONE]` signal. This is the fastest option. Applications that depend on real-time streaming behavior for UX (e.g., typing animations) should use `simulated`.

```typescript
const cachedClient = cache.wrap(openai, {
  streamReplay: 'simulated', // or 'immediate' (default), 'throttled'
  streamReplaySpeed: 50,     // tokens per second for 'throttled' mode
});

const stream = await cachedClient.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

---

## 8. Embedding Interface

### Embedder Function Signature

The cache requires a single embedding function with the signature:

```typescript
type EmbedderFn = (text: string) => Promise<number[]>;
```

This function accepts a text string and returns a promise resolving to a number array (the embedding vector). The cache calls this function on every cache miss and on every cache lookup (to embed the query prompt). The caller is responsible for implementing this function using their preferred embedding source.

### OpenAI Adapter

A convenience adapter for OpenAI embeddings:

```typescript
import { createOpenAIEmbedder } from 'llm-semantic-cache/adapters';
import OpenAI from 'openai';

const openai = new OpenAI();
const embedder = createOpenAIEmbedder(openai, {
  model: 'text-embedding-3-small', // default
  dimensions: 1536,                // optional, for models that support it
});

const cache = createCache({ embedder });
```

The adapter wraps `openai.embeddings.create`, extracts the embedding vector from the response, and handles error mapping.

### Local Model Adapter

A convenience adapter for local ONNX-based embedding models (e.g., `all-MiniLM-L6-v2`, `bge-small-en-v1.5`):

```typescript
import { createLocalEmbedder } from 'llm-semantic-cache/adapters';

const embedder = await createLocalEmbedder({
  model: 'all-MiniLM-L6-v2', // downloaded and cached on first use
});

const cache = createCache({ embedder });
```

The local adapter uses `onnxruntime-node` (peer dependency) to run embedding inference locally with zero API cost. Model files are downloaded on first use and cached in `~/.cache/llm-semantic-cache/models/`. Inference takes 1-10ms per prompt on modern hardware.

### Custom Embedder

Any function matching the `EmbedderFn` signature works:

```typescript
const cache = createCache({
  embedder: async (text) => {
    const response = await fetch('https://my-embedding-service/embed', {
      method: 'POST',
      body: JSON.stringify({ text }),
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return data.embedding;
  },
});
```

### Embedding Caching with embed-cache

Embedding generation is the most expensive step in the semantic cache pipeline. If the same prompt is queried multiple times (even on a cache hit, the query prompt must be embedded to perform similarity search), the embedding function is called each time. Wrapping the embedder with `embed-cache` avoids redundant embedding API calls:

```typescript
import { createCache } from 'llm-semantic-cache';
import { createCache as createEmbedCache } from 'embed-cache';

const embedCache = createEmbedCache({
  embedder: async (texts) => { /* batch embed via OpenAI */ },
  model: 'text-embedding-3-small',
});

const semanticCache = createCache({
  embedder: async (text) => embedCache.embed(text),
  threshold: 0.92,
});
```

This layered approach means: the first time a prompt is queried, both the embedding and the LLM response are generated. On subsequent queries with the same prompt text, the embedding is served from `embed-cache` (sub-1ms) and the LLM response is served from `llm-semantic-cache` if a similar prompt exists (sub-5ms total). On queries with similar but not identical prompt text, the embedding is generated (cache miss in `embed-cache`), but the LLM response may still hit the semantic cache.

### Dimensionality Considerations

Different embedding models produce vectors of different dimensionalities:

| Model | Dimensions | Provider |
|---|---|---|
| `text-embedding-3-small` | 1536 | OpenAI |
| `text-embedding-3-large` | 3072 | OpenAI |
| `text-embedding-ada-002` | 1536 | OpenAI |
| `all-MiniLM-L6-v2` | 384 | Local (ONNX) |
| `bge-small-en-v1.5` | 384 | Local (ONNX) |
| `bge-base-en-v1.5` | 768 | Local (ONNX) |
| `embed-english-v3.0` | 1024 | Cohere |
| `embed-multilingual-v3.0` | 1024 | Cohere |

Lower dimensionality means faster similarity search (fewer multiplications per comparison) and lower memory usage per entry. Higher dimensionality generally means better semantic discrimination (fewer false positives/negatives). For semantic caching, 384-dimensional local models often provide sufficient discrimination at zero API cost and 4x faster search than 1536-dimensional models.

The cache validates dimensionality consistency: all embeddings in a model namespace must have the same number of dimensions. Mixing dimensionalities within a namespace throws an error.

---

## 9. Storage Backends

### In-Memory (Default)

The default backend stores cache entries in a JavaScript `Map` (keyed by entry ID) and embedding vectors in a contiguous `Float32Array` matrix. The `Map` provides O(1) entry lookup by ID. The `Float32Array` matrix enables cache-friendly sequential access during brute-force similarity search.

**Characteristics:**
- Data is lost when the process exits.
- Memory usage: each cache entry takes approximately `(dimensions * 4) + 500` bytes. A cache with 1,000 entries at 1536 dimensions uses approximately `1000 * (1536 * 4 + 500) ≈ 6.6 MB`. A cache with 10,000 entries at 1536 dimensions uses approximately 66 MB.
- Read/write latency: sub-microsecond for individual operations.
- Suitable for: development, testing, short-lived processes, applications where cache persistence is not needed.

**Configuration:**
```typescript
createCache({ storage: 'memory' }) // default
createCache({ storage: { type: 'memory' } })
```

### SQLite

The SQLite backend stores cache entries in a single-file SQLite database using `better-sqlite3` (peer dependency). Embedding vectors are stored as BLOBs (packed little-endian 32-bit floats). The schema:

```sql
CREATE TABLE IF NOT EXISTS cache_entries (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  embedding BLOB NOT NULL,
  response TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  ttl INTEGER,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_model ON cache_entries(model);
CREATE INDEX IF NOT EXISTS idx_accessed_at ON cache_entries(accessed_at);
CREATE INDEX IF NOT EXISTS idx_created_at ON cache_entries(created_at);
```

**Characteristics:**
- Persists across process restarts. Data survives crashes (ACID with WAL mode).
- Supports concurrent reads (WAL mode enabled by default).
- Write latency: approximately 0.5-2ms per entry.
- Read latency: approximately 0.1-0.5ms per entry.
- Similarity search: all embeddings for the queried model namespace are loaded into memory on search. For frequently accessed namespaces, the cache maintains an in-memory vector index that is refreshed on writes.
- Suitable for: single-machine production deployments, persistent development caches, moderate-scale caches (up to ~50,000 entries).
- Peer dependency: `better-sqlite3`.

**Configuration:**
```typescript
createCache({
  storage: {
    type: 'sqlite',
    path: './cache/semantic-cache.db',
    walMode: true, // default: true
  },
})
```

### Redis

The Redis backend stores cache entries in Redis using `ioredis` (peer dependency). Each entry is stored as a Redis hash with fields for prompt, response, model, timestamps, and metadata. Embedding vectors are stored as binary buffers (packed 32-bit floats) in a separate key with a `vec:` prefix.

**Characteristics:**
- Shared across multiple processes and machines.
- Redis TTL support (entries expire automatically via Redis `PEXPIRE`).
- Write latency: 1-5ms (network round trip).
- Read latency: 1-5ms (network round trip).
- Similarity search: requires loading all vectors for the queried namespace from Redis into memory for comparison. For large caches, this is a significant network operation. The cache maintains a local in-memory vector index that is refreshed periodically (configurable interval, default: 5 seconds) or on demand.
- Suitable for: distributed deployments, multi-process applications, shared caches.
- Peer dependency: `ioredis`.

**Configuration:**
```typescript
createCache({
  storage: {
    type: 'redis',
    url: 'redis://localhost:6379',
    keyPrefix: 'sem-cache:', // default
    syncInterval: 5000,      // ms between vector index refreshes, default: 5000
  },
})
```

**Multi-process behavior:** Multiple processes sharing the same Redis instance share the semantic cache. When one process caches a response, other processes see it after the next sync interval. The sync interval is a tradeoff between cache freshness and Redis load. For low-latency requirements, set `syncInterval: 0` to sync on every lookup (at the cost of a Redis round trip on every cache check).

### Filesystem (JSON)

The filesystem backend stores cache entries as a JSON file on disk. On initialization, the full file is loaded into memory. Writes are debounced (default: 1 second) to avoid excessive disk I/O.

**Characteristics:**
- Persists across process restarts.
- JSON serialization is verbose: embedding vectors as JSON arrays are approximately 5x larger than binary representation.
- Startup latency: depends on file size (approximately 2-5 seconds for a 100 MB file).
- Not suitable for multi-process environments (no write locking).
- Suitable for: development, CI, simple single-process deployments.

**Configuration:**
```typescript
createCache({
  storage: {
    type: 'filesystem',
    path: './cache/semantic-cache.json',
    debounceMs: 1000, // default: 1000
  },
})
```

### Custom Backend

Any object implementing the `StorageBackend` interface can be used:

```typescript
interface StorageBackend {
  /** Get a cache entry by ID. Returns undefined if not found or expired. */
  get(id: string): Promise<CacheEntry | undefined>;

  /** Store a cache entry. */
  set(entry: CacheEntry): Promise<void>;

  /** Delete an entry by ID. Returns true if the entry existed. */
  delete(id: string): Promise<boolean>;

  /** Clear all entries, optionally filtered by model. */
  clear(options?: { model?: string }): Promise<void>;

  /** Return all entries for a given model namespace. */
  getByModel(model: string): Promise<CacheEntry[]>;

  /** Return all embedding vectors for a given model namespace as a flat Float32Array
   *  and the corresponding entry IDs. Used for similarity search. */
  getVectors(model: string): Promise<{ ids: string[]; vectors: Float32Array; dimensions: number }>;

  /** Return the total number of entries. */
  size(): Promise<number>;

  /** Return the number of entries per model. */
  sizeByModel(): Promise<Map<string, number>>;

  /** Optional: flush any pending writes to durable storage. */
  flush?(): Promise<void>;

  /** Optional: close any open connections or file handles. */
  close?(): Promise<void>;
}
```

The `getVectors` method is critical for search performance. Backends that can return a pre-packed `Float32Array` enable zero-copy similarity search. Backends that store vectors in other formats (JSON arrays, individual entries) must deserialize and pack vectors in this method.

---

## 10. Eviction Policies

### TTL (Time-to-Live)

Entries expire after a configurable duration. Expired entries are not returned on cache hits and are lazily removed during search (or eagerly removed by a background sweep).

```typescript
createCache({
  ttl: 3600_000, // 1 hour in milliseconds
})
```

TTL is checked on every cache hit. If an entry's `createdAt + ttl < now`, the entry is treated as expired: the cache returns a miss and schedules the entry for deletion.

TTL can be set globally (all entries share the same TTL) or per entry (via `cache.set(prompt, response, { ttl: 1800_000 })`). Per-entry TTL overrides the global TTL.

**When to use TTL:** When LLM responses become stale over time. A cache of weather questions should expire after 30 minutes. A cache of factual questions (capitals, mathematical constants) can have a long TTL or no TTL at all. A cache of news-related questions should expire frequently.

### LRU (Least Recently Used)

When the cache reaches its maximum size (`maxEntries`), the least recently used entry is evicted to make room for new entries. "Recently used" is determined by the `accessedAt` timestamp, which is updated on every cache hit.

```typescript
createCache({
  maxEntries: 5000,
  evictionPolicy: 'lru', // default when maxEntries is set
})
```

LRU eviction is implemented differently by backend:

- **In-memory:** A doubly-linked list maintains access order. Hit promotion and eviction are O(1). The entry at the tail of the list is evicted.
- **SQLite:** Eviction queries `DELETE FROM cache_entries WHERE model = ? ORDER BY accessed_at ASC LIMIT ?` to remove the oldest-accessed entries.
- **Redis:** Entries are tracked in a Redis sorted set keyed by access timestamp. Eviction removes entries with the lowest scores.

### Max Entries

A hard limit on the total number of cache entries. When the limit is reached, the eviction policy determines which entry to remove. If no eviction policy is explicitly configured, `lru` is used by default when `maxEntries` is set.

```typescript
createCache({
  maxEntries: 10_000,
})
```

Max entries is enforced per cache instance (across all model namespaces), not per namespace. To set per-model limits, create separate cache instances per model.

### Manual Eviction

Entries can be manually removed via `cache.delete(id)` (remove a specific entry) or `cache.clear()` (remove all entries). `cache.clear({ model: 'gpt-3.5-turbo' })` removes all entries for a specific model namespace.

### Combined Policies

TTL and LRU/max entries can be combined. An entry is evicted if either condition is met: TTL expired, or LRU eviction is triggered by the size limit. Both conditions are checked on access.

```typescript
createCache({
  ttl: 3600_000,       // expire after 1 hour
  maxEntries: 5000,    // also limit to 5000 entries
  evictionPolicy: 'lru',
})
```

---

## 11. Model-Aware Caching

### Why Model Matters

The same prompt sent to different LLM models produces different responses. GPT-4o may give a detailed, nuanced explanation. GPT-3.5-turbo may give a shorter, less precise answer. Claude Sonnet may give a differently structured response. If the cache is not model-aware, a query to GPT-4o could return a cached GPT-3.5-turbo response, which violates user expectations about response quality and characteristics.

### How Model-Awareness Is Implemented

The model identifier is a first-class component of the cache key. Cache entries are partitioned by model, and similarity search is scoped to the queried model's partition. Two separate data structures are maintained:

1. **Entry storage:** All entries are stored in the same backend (Map, SQLite table, Redis keyspace), each tagged with a `model` field.
2. **Vector index:** A separate vector index is maintained per model namespace. When searching, only vectors in the matching namespace are compared.

This means the same prompt can have multiple cache entries -- one per model. "What is the capital of France?" may have a cached GPT-4o response and a cached GPT-3.5-turbo response. A query with `model: 'gpt-4o'` only searches the GPT-4o index.

### Model Identifier Normalization

Model identifiers are normalized to lowercase canonical forms:

| Input | Canonical |
|---|---|
| `gpt-4o` | `gpt-4o` |
| `GPT-4o` | `gpt-4o` |
| `gpt-4o-2024-08-06` | `gpt-4o-2024-08-06` |
| `claude-sonnet-4-20250514` | `claude-sonnet-4-20250514` |
| `claude-3-5-sonnet-20241022` | `claude-3-5-sonnet-20241022` |

Model versioning is preserved: `gpt-4o` and `gpt-4o-2024-08-06` are treated as separate models with separate cache namespaces. If the caller wants version-agnostic caching (all GPT-4o variants share a cache), they can configure a `modelNormalizer` function:

```typescript
createCache({
  modelNormalizer: (model) => model.replace(/-\d{4}-\d{2}-\d{2}$/, ''),
  // 'gpt-4o-2024-08-06' → 'gpt-4o'
})
```

### Namespace Isolation

Model namespaces are fully isolated. Operations scoped to a model never affect other models:

- `cache.get(prompt, { model: 'gpt-4o' })` searches only the GPT-4o index.
- `cache.clear({ model: 'gpt-3.5-turbo' })` removes only GPT-3.5-turbo entries.
- `cache.stats({ model: 'gpt-4o' })` returns hit/miss counts for GPT-4o only.
- `cache.stats()` (no model filter) returns aggregate stats across all models.

---

## 12. API Surface

### Installation

```bash
npm install llm-semantic-cache
```

For SQLite backend:
```bash
npm install llm-semantic-cache better-sqlite3
```

For Redis backend:
```bash
npm install llm-semantic-cache ioredis
```

For local ONNX embeddings:
```bash
npm install llm-semantic-cache onnxruntime-node
```

### No Runtime Dependencies (Core)

The core `llm-semantic-cache` package has zero runtime dependencies. All core functionality (in-memory storage, brute-force search, cosine similarity, cache-through wrapping, eviction policies) is implemented using Node.js built-in modules and standard JavaScript. Storage backend adapters (`better-sqlite3`, `ioredis`) and embedding adapters (`onnxruntime-node`) are optional peer dependencies.

### Factory: `createCache`

Creates a new `SemanticCache` instance.

```typescript
import { createCache } from 'llm-semantic-cache';

const cache = createCache({
  embedder: async (text) => { /* return number[] */ },
  threshold: 0.92,
  maxEntries: 5000,
  ttl: 3600_000,
  storage: 'memory',
});
```

**Signature:**

```typescript
function createCache(options: SemanticCacheOptions): SemanticCache;
```

### `cache.get(prompt, options?)`

Checks the cache for a semantically similar prompt. Returns the cached response on a hit, or `null` on a miss.

```typescript
const result = await cache.get('What is the capital of France?', {
  model: 'gpt-4o',
});

if (result) {
  console.log(result.response);   // "The capital of France is Paris."
  console.log(result.similarity);  // 0.96
  console.log(result.entryId);     // "a1b2c3d4-..."
  console.log(result.cached);      // true
}
```

**Signature:**

```typescript
interface SemanticCache {
  get(
    prompt: PromptInput,
    options?: GetOptions,
  ): Promise<CacheHit | null>;
}

interface GetOptions {
  model?: string;
  threshold?: number;  // override instance threshold for this lookup
}

interface CacheHit {
  response: string;
  similarity: number;
  entryId: string;
  model: string;
  cached: true;
  createdAt: number;
  hitCount: number;
}
```

### `cache.set(prompt, response, options?)`

Stores a prompt-response pair in the cache. Generates the embedding for the prompt and stores the entry.

```typescript
await cache.set(
  'What is the capital of France?',
  'The capital of France is Paris.',
  { model: 'gpt-4o' },
);
```

**Signature:**

```typescript
interface SemanticCache {
  set(
    prompt: PromptInput,
    response: string,
    options?: SetOptions,
  ): Promise<string>; // returns entry ID
}

interface SetOptions {
  model?: string;
  ttl?: number;       // override instance TTL for this entry
  metadata?: Record<string, unknown>;
}
```

### `cache.wrap(client, options?)`

Returns a proxy LLM client where all chat/completion calls are intercepted by the cache.

```typescript
const cachedClient = cache.wrap(openai, {
  streamReplay: 'immediate',
});

// Use exactly like the original client
const response = await cachedClient.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});
```

**Signature:**

```typescript
interface SemanticCache {
  wrap<T>(
    client: T,
    options?: WrapOptions,
  ): T;
}

interface WrapOptions {
  streamReplay?: 'immediate' | 'simulated' | 'throttled';
  streamReplaySpeed?: number;  // tokens per second for 'throttled' mode
  clientType?: 'openai' | 'anthropic' | 'custom';
  extractPrompt?: (params: unknown) => string;
  extractModel?: (params: unknown) => string;
  buildResponse?: (cached: CacheHit, params: unknown) => unknown;
}
```

### `cache.search(prompt, options?)`

Returns the top-K nearest cached entries with their similarity scores. Useful for debugging cache behavior and inspecting what the cache contains.

```typescript
const results = await cache.search('capital of France', {
  model: 'gpt-4o',
  topK: 5,
  minSimilarity: 0.5,
});

for (const result of results) {
  console.log(`${result.similarity.toFixed(3)}: ${result.prompt}`);
}
// 0.961: What is the capital of France?
// 0.823: What is the population of France?
// 0.791: What is the capital of Germany?
// 0.654: Tell me about France.
// 0.512: What European capitals have you visited?
```

**Signature:**

```typescript
interface SemanticCache {
  search(
    prompt: PromptInput,
    options?: SearchOptions,
  ): Promise<SearchResult[]>;
}

interface SearchOptions {
  model?: string;
  topK?: number;           // default: 5
  minSimilarity?: number;  // default: 0.0
}

interface SearchResult {
  entryId: string;
  prompt: string;
  response: string;
  similarity: number;
  model: string;
  createdAt: number;
  hitCount: number;
}
```

### `cache.delete(id)`

Removes a specific cache entry by its ID.

```typescript
const deleted = await cache.delete('a1b2c3d4-...');
// true if entry existed and was deleted, false otherwise
```

### `cache.clear(options?)`

Removes all cache entries, optionally filtered by model.

```typescript
await cache.clear();                           // clear everything
await cache.clear({ model: 'gpt-3.5-turbo' }); // clear only gpt-3.5-turbo entries
```

### `cache.stats(options?)`

Returns cache performance statistics.

```typescript
const stats = await cache.stats();

console.log(stats.hits);           // 4521
console.log(stats.misses);         // 892
console.log(stats.hitRate);        // 0.835
console.log(stats.entries);        // 743
console.log(stats.tokensSaved);    // 2_841_500
console.log(stats.costSaved);      // 7.10 (USD)
console.log(stats.models);         // ['gpt-4o', 'gpt-3.5-turbo']
console.log(stats.avgSimilarity);  // 0.948 (average similarity of cache hits)
```

**Signature:**

```typescript
interface SemanticCache {
  stats(options?: { model?: string }): Promise<CacheStats>;
}

interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  entries: number;
  tokensSaved: number;
  costSaved: number;
  models: string[];
  avgSimilarity: number;
  entriesByModel: Record<string, number>;
}
```

### `cache.serialize()` / `SemanticCache.deserialize()`

Serializes the cache state to a portable buffer for export/import across environments.

```typescript
// Export
const buffer = await cache.serialize();
await fs.writeFile('./cache-snapshot.bin', buffer);

// Import
const buffer = await fs.readFile('./cache-snapshot.bin');
const restoredCache = SemanticCache.deserialize(buffer, {
  embedder: myEmbedder,
});
```

The serialized format is a binary buffer containing:
- Header: magic bytes, version, entry count, dimensions.
- Entry table: for each entry, prompt (UTF-8), response (UTF-8), model (UTF-8), timestamps, metadata (JSON).
- Vector block: contiguous `Float32Array` of all embeddings.

### `cache.close()`

Closes the cache, flushing any pending writes and closing backend connections.

```typescript
await cache.close();
```

Should be called in process shutdown handlers to avoid data loss with persistent backends.

### Types

```typescript
/** Input prompt format — accepts strings, OpenAI message arrays, or Anthropic-style objects. */
type PromptInput =
  | string
  | Array<{ role: string; content: string }>
  | { system?: string; messages: Array<{ role: string; content: string }> };

/** The embedding function signature. */
type EmbedderFn = (text: string) => Promise<number[]>;

/** Full configuration for createCache. */
interface SemanticCacheOptions {
  /** Required. The function that generates embeddings from text. */
  embedder: EmbedderFn;

  /** Minimum cosine similarity for a cache hit. Default: 0.92. */
  threshold?: number;

  /** Maximum number of cache entries. Default: Infinity (no limit). */
  maxEntries?: number;

  /** Time-to-live in milliseconds. Default: undefined (no expiry). */
  ttl?: number;

  /** Eviction policy when maxEntries is reached. Default: 'lru'. */
  evictionPolicy?: 'lru' | 'lfu';

  /** Storage backend configuration. Default: 'memory'. */
  storage?:
    | 'memory'
    | { type: 'memory' }
    | { type: 'sqlite'; path: string; walMode?: boolean }
    | { type: 'redis'; url: string; keyPrefix?: string; syncInterval?: number }
    | { type: 'filesystem'; path: string; debounceMs?: number }
    | StorageBackend;

  /** Search strategy. Default: 'brute-force'. */
  searchStrategy?: 'brute-force' | 'hnsw';

  /** Optional prompt normalizer applied before embedding. */
  normalizer?: (prompt: string) => string;

  /** Optional model normalizer for version-agnostic caching. */
  modelNormalizer?: (model: string) => string;

  /** Model price per million tokens for cost tracking. */
  modelPrices?: Record<string, { input: number; output: number }>;

  /** HNSW parameters (only used when searchStrategy is 'hnsw'). */
  hnswOptions?: {
    efConstruction?: number;  // default: 200
    efSearch?: number;        // default: 200
    m?: number;               // default: 16
  };
}

/** A single cache entry as stored. */
interface CacheEntry {
  id: string;
  prompt: string;
  embedding: Float32Array;
  response: string;
  model: string;
  createdAt: number;
  accessedAt: number;
  hitCount: number;
  ttl?: number;
  metadata?: Record<string, unknown>;
}
```

---

## 13. Streaming Support

### Why Streaming Needs Special Handling

Many LLM applications use streaming responses (`stream: true`) for better UX -- text appears incrementally as the model generates it. The cache must handle streaming transparently: on a miss, the stream flows through to the caller in real time while the cache buffers the full response. On a hit, the cached response must be replayed as a stream that the caller can consume with the same async iterable interface.

### Cache Miss with Streaming

When the cache-through wrapper intercepts a streaming request and the cache does not have a hit:

1. The wrapper calls the original client with `stream: true`.
2. The wrapper creates a `TransformStream` that passes through chunks to the caller while accumulating the full response text.
3. As each chunk arrives from the LLM, it is immediately yielded to the caller (zero added latency) and appended to an internal buffer.
4. When the LLM signals stream completion (final chunk with `finish_reason`), the wrapper assembles the full response from the buffer.
5. The full response is stored in the cache with `cache.set(prompt, fullResponse, { model })`.
6. The caller has already received all chunks in real time -- caching is transparent.

### Cache Hit with Streaming

When the cache has a hit for a streaming request:

1. The cached response text is retrieved.
2. The wrapper constructs a synthetic stream (async iterable) that yields the cached response.
3. The stream format matches the original client's chunk format (OpenAI `ChatCompletionChunk`, Anthropic `MessageStreamEvent`).

Three replay modes are available:

**`immediate` (default):** The full response is emitted as a single chunk, followed by a completion signal. Total replay time: sub-1ms. Best for applications where streaming is used for API compatibility but UX does not depend on incremental rendering.

**`simulated`:** The response is split into token-sized chunks (approximately 4 characters each) and emitted with small delays (5-20ms per chunk) to simulate natural LLM generation speed. Total replay time: roughly proportional to response length. Best for chatbot UIs where the typing animation is part of the user experience.

**`throttled`:** The response is emitted at a configurable tokens-per-second rate. For example, `streamReplaySpeed: 50` emits approximately 50 tokens per second. This provides consistent perceived speed regardless of response length.

### Response Integrity

The cache stores the complete, fully assembled response -- not individual chunks. This ensures response integrity: partial responses from interrupted streams are never cached. If the stream is interrupted before completion (client disconnect, timeout, network error), nothing is written to the cache, and the next request for the same prompt results in a cache miss.

---

## 14. Cost Tracking

### What Is Tracked

The cache maintains running counters for cost-related metrics:

- **`hits`**: Number of cache lookups that returned a cached response.
- **`misses`**: Number of cache lookups that resulted in an LLM call.
- **`tokensSaved`**: Estimated total tokens saved by cache hits. For each hit, the token count is estimated from the cached response length using a character-to-token approximation (4 characters per token for English text, configurable).
- **`costSaved`**: Estimated total USD saved by cache hits. Computed as `tokensSaved / 1_000_000 * pricePerMillionTokens`. The price per million tokens is configurable per model.

### Integration with model-price-registry

`llm-semantic-cache` integrates with `model-price-registry` from this monorepo for accurate, up-to-date model pricing. When `model-price-registry` is installed, the cache automatically looks up the input and output token prices for each model:

```typescript
import { createCache } from 'llm-semantic-cache';
import { getPrice } from 'model-price-registry';

const cache = createCache({
  embedder: myEmbedder,
  modelPrices: {
    'gpt-4o': getPrice('gpt-4o'),        // { input: 2.50, output: 10.00 }
    'gpt-3.5-turbo': getPrice('gpt-3.5-turbo'), // { input: 0.50, output: 1.50 }
  },
});
```

If `model-price-registry` is not installed, the cache uses built-in default prices for common models and falls back to `{ input: 1.00, output: 2.00 }` for unknown models.

### Cost Savings Calculation

For each cache hit, the cost saved is:

```
promptTokens = estimateTokens(cachedEntry.prompt)
responseTokens = estimateTokens(cachedEntry.response)
inputCostSaved = promptTokens / 1_000_000 * modelPrices[model].input
outputCostSaved = responseTokens / 1_000_000 * modelPrices[model].output
totalCostSaved = inputCostSaved + outputCostSaved
```

The embedding cost of the cache lookup is not subtracted from the savings calculation because the embedding call happens regardless of hit/miss (the query must be embedded to perform similarity search). If embedding-level cost tracking is needed, use `embed-cache` for the embedding function.

### Accessing Stats

```typescript
const stats = await cache.stats();
console.log(`Cache hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
console.log(`Tokens saved: ${stats.tokensSaved.toLocaleString()}`);
console.log(`Cost saved: $${stats.costSaved.toFixed(2)}`);
console.log(`Entries: ${stats.entries}`);
```

Stats can be filtered by model:

```typescript
const gpt4Stats = await cache.stats({ model: 'gpt-4o' });
```

Stats are reset by `cache.resetStats()` without clearing cache entries.

---

## 15. Configuration

### All Options with Defaults

| Option | Type | Default | Description |
|---|---|---|---|
| `embedder` | `EmbedderFn` | (required) | Function that generates embeddings from text |
| `threshold` | `number` | `0.92` | Minimum cosine similarity for a cache hit |
| `maxEntries` | `number` | `Infinity` | Maximum number of cache entries |
| `ttl` | `number` | `undefined` | Time-to-live in milliseconds (no expiry by default) |
| `evictionPolicy` | `'lru' \| 'lfu'` | `'lru'` | Eviction policy when maxEntries is reached |
| `storage` | `string \| object \| StorageBackend` | `'memory'` | Storage backend configuration |
| `searchStrategy` | `'brute-force' \| 'hnsw'` | `'brute-force'` | Vector search strategy |
| `normalizer` | `(prompt: string) => string` | `undefined` | Prompt normalizer (e.g., from `prompt-dedup`) |
| `modelNormalizer` | `(model: string) => string` | lowercase | Model identifier normalizer |
| `modelPrices` | `Record<string, { input: number; output: number }>` | built-in defaults | Per-model token prices in USD per million tokens |
| `hnswOptions.efConstruction` | `number` | `200` | HNSW build-time quality parameter |
| `hnswOptions.efSearch` | `number` | `200` | HNSW search-time quality parameter |
| `hnswOptions.m` | `number` | `16` | HNSW number of connections per node |
| `tokenEstimator` | `(text: string) => number` | `text.length / 4` | Function to estimate token count from text |

### Built-In Model Prices

The following model prices are built into the cache for cost tracking. These are approximations and can be overridden via the `modelPrices` option:

| Model | Input ($/MTok) | Output ($/MTok) |
|---|---|---|
| `gpt-4o` | 2.50 | 10.00 |
| `gpt-4o-mini` | 0.15 | 0.60 |
| `gpt-4-turbo` | 10.00 | 30.00 |
| `gpt-3.5-turbo` | 0.50 | 1.50 |
| `claude-sonnet-4-20250514` | 3.00 | 15.00 |
| `claude-3-5-sonnet-20241022` | 3.00 | 15.00 |
| `claude-3-haiku-20240307` | 0.25 | 1.25 |

---

## 16. CLI

### `llm-semantic-cache stats`

Prints cache statistics.

```bash
$ llm-semantic-cache stats --storage sqlite --path ./cache/semantic-cache.db

Cache Statistics
────────────────
  Entries:        743
  Models:         gpt-4o, gpt-3.5-turbo
  Hits:           4,521
  Misses:         892
  Hit Rate:       83.5%
  Tokens Saved:   2,841,500
  Cost Saved:     $7.10
  Avg Similarity: 0.948

  Per Model:
    gpt-4o:         612 entries, 3,891 hits, 91.2% hit rate
    gpt-3.5-turbo:  131 entries, 630 hits, 68.4% hit rate
```

### `llm-semantic-cache search`

Searches the cache for entries similar to a query prompt.

```bash
$ llm-semantic-cache search "capital of France" \
    --model gpt-4o \
    --top-k 5 \
    --storage sqlite \
    --path ./cache/semantic-cache.db

Results (model: gpt-4o, threshold: 0.0):
────────────────────────────────────────
  0.961  "What is the capital of France?"
         → "The capital of France is Paris."

  0.823  "What is the population of France?"
         → "The population of France is approximately 67.75 million..."

  0.791  "What is the capital of Germany?"
         → "The capital of Germany is Berlin."
```

Note: the CLI `search` command requires an embedder configuration. It reads the embedding function from a config file (`llm-semantic-cache.config.js`) or accepts an `--embedder` flag pointing to a module that exports an embedder function.

### `llm-semantic-cache clear`

Clears cache entries.

```bash
$ llm-semantic-cache clear --storage sqlite --path ./cache/semantic-cache.db
Cleared 743 entries.

$ llm-semantic-cache clear --model gpt-3.5-turbo --storage sqlite --path ./cache/semantic-cache.db
Cleared 131 entries (model: gpt-3.5-turbo).
```

### `llm-semantic-cache export`

Exports the cache to a binary snapshot file.

```bash
$ llm-semantic-cache export --storage sqlite --path ./cache/semantic-cache.db --output ./snapshot.bin
Exported 743 entries (12.4 MB).
```

### `llm-semantic-cache import`

Imports a cache snapshot.

```bash
$ llm-semantic-cache import --storage sqlite --path ./cache/semantic-cache.db --input ./snapshot.bin
Imported 743 entries.
```

### CLI Flags

| Flag | Short | Description |
|---|---|---|
| `--storage` | `-s` | Storage backend type: `memory`, `sqlite`, `redis`, `filesystem` |
| `--path` | `-p` | Path to storage file (SQLite, filesystem) |
| `--url` | `-u` | Redis URL (Redis backend) |
| `--model` | `-m` | Filter by model namespace |
| `--top-k` | `-k` | Number of results for `search` command (default: 5) |
| `--threshold` | `-t` | Similarity threshold for `search` command (default: 0.0) |
| `--output` | `-o` | Output file path for `export` command |
| `--input` | `-i` | Input file path for `import` command |
| `--json` | | Output as JSON (for all commands) |
| `--help` | `-h` | Show help |

---

## 17. Integration with Monorepo Packages

### embed-cache

`embed-cache` provides content-addressable embedding caching. `llm-semantic-cache` can wrap its embedder function with `embed-cache` to avoid redundant embedding API calls. The two caches operate at different levels: `embed-cache` caches the embedding vector (input: text, output: vector), while `llm-semantic-cache` caches the LLM response (input: prompt embedding, output: response text).

```typescript
import { createCache as createEmbedCache } from 'embed-cache';
import { createCache as createSemanticCache } from 'llm-semantic-cache';

const embedCache = createEmbedCache({
  embedder: async (texts) => { /* OpenAI batch embed */ },
  model: 'text-embedding-3-small',
});

const semanticCache = createSemanticCache({
  embedder: (text) => embedCache.embed(text),
});
```

### llm-response-cache

`llm-response-cache` provides exact-key (hash-based) LLM response caching. `llm-semantic-cache` provides semantic (similarity-based) caching. The two are complementary and can be layered: check the exact-key cache first (faster, zero embedding cost), then check the semantic cache on an exact miss (slower, requires embedding, but catches rephrasings).

```typescript
import { createCache as createExactCache } from 'llm-response-cache';
import { createCache as createSemanticCache } from 'llm-semantic-cache';

const exactCache = createExactCache({ /* ... */ });
const semanticCache = createSemanticCache({ /* ... */ });

async function getCachedResponse(prompt: string, model: string) {
  // Fast path: exact match
  const exact = await exactCache.get(prompt, { model });
  if (exact) return exact;

  // Slow path: semantic match
  const semantic = await semanticCache.get(prompt, { model });
  if (semantic) return semantic.response;

  // Miss: call LLM
  const response = await callLLM(prompt, model);
  await exactCache.set(prompt, response, { model });
  await semanticCache.set(prompt, response, { model });
  return response;
}
```

### llm-dedup

`llm-dedup` coalesces semantically similar in-flight LLM requests. `llm-semantic-cache` caches responses for future requests. The two are complementary: `llm-dedup` prevents duplicate concurrent requests, while `llm-semantic-cache` prevents duplicate sequential requests. Layer `llm-dedup` on top of the cache-through wrapper for maximum deduplication:

```typescript
import { createDedup } from 'llm-dedup';
import { createCache } from 'llm-semantic-cache';

const cache = createCache({ embedder });
const cachedClient = cache.wrap(openai);
const dedupedClient = createDedup(cachedClient);

// All calls go through: dedup → cache → LLM
```

### prompt-dedup

`prompt-dedup` normalizes prompts via text-level transformations (whitespace collapse, variable extraction, formatting normalization). Applying `prompt-dedup` normalization before embedding improves semantic cache hit rates because normalized prompts produce more similar embeddings:

```typescript
import { normalize } from 'prompt-dedup';
import { createCache } from 'llm-semantic-cache';

const cache = createCache({
  embedder: myEmbedder,
  normalizer: normalize, // prompts are normalized before embedding
});
```

### model-price-registry

`model-price-registry` provides up-to-date pricing for LLM models. `llm-semantic-cache` uses it for cost tracking:

```typescript
import { getPrice } from 'model-price-registry';
import { createCache } from 'llm-semantic-cache';

const cache = createCache({
  embedder: myEmbedder,
  modelPrices: {
    'gpt-4o': getPrice('gpt-4o'),
  },
});
```

---

## 18. Testing Strategy

### Unit Tests

- **Cosine similarity computation:** Test with known vector pairs (identical vectors → 1.0, orthogonal vectors → 0.0, anti-parallel vectors → -1.0, known angle → known cosine).
- **Vector normalization:** Test that L2 norm of output is 1.0 for various input vectors. Test zero vector handling.
- **Threshold evaluation:** Test boundary conditions (similarity exactly at threshold → hit, below by epsilon → miss).
- **Cache entry lifecycle:** Test create, read, update (access), delete, TTL expiry, LRU eviction.
- **Model namespacing:** Test that entries from model A are invisible to queries for model B. Test cross-model isolation.
- **Prompt normalization:** Test that structured prompts (message arrays, Anthropic format) are correctly serialized to canonical strings.
- **Token estimation:** Test the character-to-token approximation with known prompt-token pairs.
- **Stats tracking:** Test that hits, misses, tokensSaved, costSaved are incremented correctly.

### Integration Tests

- **End-to-end cache hit:** Create cache → set entry → get with similar prompt → verify hit with correct response.
- **End-to-end cache miss:** Create cache → get with unrelated prompt → verify miss (null return).
- **Cache-through wrapper (OpenAI format):** Wrap a mock OpenAI client → call chat.completions.create → verify first call goes to client, second similar call returns from cache.
- **Cache-through wrapper (Anthropic format):** Same as above with Anthropic-style client.
- **Streaming cache miss:** Verify stream is forwarded in real time and response is cached on completion.
- **Streaming cache hit:** Verify cached response is replayed as a stream.
- **SQLite backend:** Create cache with SQLite → set entries → close → reopen → verify entries persist.
- **Redis backend:** Create cache with Redis → set entries from process A → read from process B → verify shared cache.
- **Eviction:** Create cache with maxEntries: 3 → add 4 entries → verify oldest is evicted.
- **TTL expiry:** Create cache with TTL: 100ms → set entry → wait 150ms → verify miss.
- **Serialization round-trip:** Create cache → add entries → serialize → deserialize → verify all entries are restored with correct embeddings and responses.

### Performance Tests

- **Brute-force search latency:** Benchmark search over 100, 1,000, 5,000, 10,000 entries at 384 and 1536 dimensions. Assert sub-5ms for 10,000 entries.
- **Cache hit total latency:** Benchmark full pipeline (embed + search + lookup) for a cache hit. Assert sub-10ms with a local embedding model.
- **Memory usage:** Measure memory footprint for 1,000, 5,000, 10,000 entries. Assert linear scaling.
- **Serialization speed:** Benchmark serialize/deserialize for 10,000 entries. Assert sub-1 second.

### Edge Case Tests

- **Empty cache:** `cache.get` returns null, `cache.search` returns empty array, `cache.stats` returns zeros.
- **Single entry cache:** Search with exact same prompt → similarity 1.0.
- **All entries same embedding:** Degenerate case where all cached prompts have identical embeddings. Verify the first entry (or most recently accessed) is returned.
- **Very high threshold (0.999):** Only near-identical embeddings hit. Verify rephrasings miss.
- **Very low threshold (0.5):** Loosely related prompts hit. Verify correct behavior.
- **Zero-dimensional embedding:** Error on store (dimensionality must be > 0).
- **Mismatched dimensionality:** Error when storing embedding with different dimensions than existing entries.
- **Concurrent access:** Multiple simultaneous `get` and `set` calls do not corrupt state.
- **Process shutdown:** `cache.close()` flushes pending writes for persistent backends.

---

## 19. Performance

### Cache Hit Latency Breakdown

| Step | Latency (local embedder) | Latency (API embedder) |
|---|---|---|
| Prompt normalization | < 0.1ms | < 0.1ms |
| Embedding generation | 1-10ms | 50-500ms |
| Similarity search (1K entries) | < 0.5ms | < 0.5ms |
| Cache entry lookup | < 0.1ms | < 0.1ms |
| **Total cache hit** | **2-11ms** | **51-501ms** |

For comparison, an LLM API call takes 500-5000ms. Even with API-based embeddings, a cache hit is 10-100x faster than an LLM call.

### Cache Miss Latency Overhead

On a cache miss, the semantic cache adds latency for embedding generation and similarity search, on top of the LLM call latency:

| Step | Added Latency |
|---|---|
| Embedding generation | 1-500ms (depends on embedder) |
| Similarity search | < 0.5ms |
| Cache entry storage | < 1ms (memory), 1-5ms (SQLite/Redis) |
| **Total overhead on miss** | **2-502ms** |

With a local embedding model (1-10ms), the miss overhead is negligible (< 2% of total latency for a typical 500ms LLM call). With an API-based embedding model (50-500ms), the overhead is significant (10-100% added latency on misses). For applications where miss latency matters, use local embeddings.

### Memory Usage

| Entries | Dimensions | Vector Memory | Total Memory (with entries) |
|---|---|---|---|
| 1,000 | 384 | 1.5 MB | ~2.5 MB |
| 1,000 | 1536 | 6 MB | ~7 MB |
| 10,000 | 384 | 15 MB | ~25 MB |
| 10,000 | 1536 | 60 MB | ~70 MB |

Total memory includes entry metadata (prompt text, response text, timestamps, model identifiers). Response text is typically the largest component: a 500-token response averages 2 KB, so 10,000 entries consume approximately 20 MB for response text alone.

### Storage Backend Performance

| Backend | Write Latency | Read Latency | Search Latency (1K entries) |
|---|---|---|---|
| In-memory | < 0.01ms | < 0.01ms | < 0.5ms |
| SQLite | 0.5-2ms | 0.1-0.5ms | < 1ms (cached index) |
| Redis | 1-5ms | 1-5ms | < 1ms (local index) + sync |
| Filesystem | debounced | < 0.1ms (in-memory) | < 0.5ms (in-memory) |

---

## 20. Dependencies

### Runtime Dependencies (Core)

None. The core package has zero runtime dependencies. All functionality is implemented using:

- `node:crypto` -- UUID generation for entry IDs.
- `Float32Array` -- Vector storage and computation.
- `node:util` -- `parseArgs` for CLI argument parsing.
- `node:fs/promises` -- Filesystem backend and CLI I/O.
- `node:process` -- Exit codes, stdin/stdout for CLI.

### Peer Dependencies (Optional)

| Package | Version | Purpose |
|---|---|---|
| `better-sqlite3` | `^11.0.0` | SQLite storage backend |
| `ioredis` | `^5.0.0` | Redis storage backend |
| `onnxruntime-node` | `^1.17.0` | Local ONNX embedding models |

### Dev Dependencies

| Package | Purpose |
|---|---|
| `typescript` | TypeScript compiler |
| `vitest` | Test runner |
| `eslint` | Linter |
| `@types/better-sqlite3` | TypeScript types for SQLite |

### Integration Dependencies (Optional, from Monorepo)

| Package | Purpose |
|---|---|
| `embed-cache` | Cache embedding function calls to avoid re-embedding |
| `llm-response-cache` | Layer exact-key cache in front of semantic cache |
| `llm-dedup` | Coalesce in-flight requests before cache layer |
| `prompt-dedup` | Normalize prompts before embedding |
| `model-price-registry` | Up-to-date model pricing for cost tracking |

---

## 21. File Structure

```
llm-semantic-cache/
├── src/
│   ├── index.ts                  # Public API exports
│   ├── cache.ts                  # SemanticCache class — core cache logic
│   ├── similarity.ts             # Cosine similarity, vector normalization
│   ├── search/
│   │   ├── brute-force.ts        # Brute-force nearest-neighbor search
│   │   └── hnsw.ts               # HNSW approximate nearest-neighbor search
│   ├── storage/
│   │   ├── backend.ts            # StorageBackend interface
│   │   ├── memory.ts             # In-memory backend (Map + Float32Array)
│   │   ├── sqlite.ts             # SQLite backend (better-sqlite3)
│   │   ├── redis.ts              # Redis backend (ioredis)
│   │   └── filesystem.ts         # Filesystem backend (JSON)
│   ├── wrapper/
│   │   ├── wrap.ts               # cache.wrap() implementation — Proxy-based
│   │   ├── openai.ts             # OpenAI client adapter
│   │   ├── anthropic.ts          # Anthropic client adapter
│   │   └── stream.ts             # Streaming response caching and replay
│   ├── adapters/
│   │   ├── openai-embedder.ts    # OpenAI embedding adapter
│   │   └── local-embedder.ts     # Local ONNX embedding adapter
│   ├── prompt.ts                 # Prompt normalization and serialization
│   ├── eviction.ts               # LRU, TTL, max-entries eviction logic
│   ├── stats.ts                  # Cost tracking and statistics
│   ├── serialization.ts          # Cache serialize/deserialize
│   ├── types.ts                  # All TypeScript type definitions
│   ├── cli.ts                    # CLI entry point
│   └── __tests__/
│       ├── cache.test.ts         # Core cache logic tests
│       ├── similarity.test.ts    # Cosine similarity tests
│       ├── search.test.ts        # Nearest-neighbor search tests
│       ├── storage.test.ts       # Storage backend tests (all backends)
│       ├── wrapper.test.ts       # Cache-through wrapper tests
│       ├── stream.test.ts        # Streaming tests
│       ├── eviction.test.ts      # Eviction policy tests
│       ├── stats.test.ts         # Cost tracking tests
│       ├── serialization.test.ts # Serialization round-trip tests
│       └── cli.test.ts           # CLI tests
├── package.json
├── tsconfig.json
├── SPEC.md
└── README.md
```

---

## 22. Implementation Roadmap

### Phase 1: Core Cache (MVP)

1. **Cosine similarity and vector normalization** (`similarity.ts`). Pure math operations on `Float32Array`. Extensive unit tests with known vector pairs.
2. **Brute-force search** (`search/brute-force.ts`). Linear scan over vectors, returning best match and score. Benchmark at 100, 1,000, 10,000 entries.
3. **In-memory storage backend** (`storage/memory.ts`). `Map` for entries, `Float32Array` matrix for vectors. LRU via doubly-linked list.
4. **Core cache logic** (`cache.ts`). `createCache`, `get`, `set`, `delete`, `clear`, `stats`. Model-aware namespacing. Threshold evaluation.
5. **Prompt serialization** (`prompt.ts`). Convert string/message-array/Anthropic inputs to canonical string for embedding.
6. **Types** (`types.ts`). All interfaces and type definitions.
7. **Public API exports** (`index.ts`). Export `createCache` and types.
8. **Unit and integration tests** for all above.

### Phase 2: Cache-Through Wrapper

1. **Proxy-based wrapper** (`wrapper/wrap.ts`). `cache.wrap(client)` returning a Proxy that intercepts calls.
2. **OpenAI adapter** (`wrapper/openai.ts`). Intercept `chat.completions.create`. Extract prompt, model. Reconstruct response format on cache hit.
3. **Anthropic adapter** (`wrapper/anthropic.ts`). Same for `messages.create`.
4. **Streaming support** (`wrapper/stream.ts`). Buffer-and-forward on miss. Replay on hit with configurable speed.
5. **Integration tests** with mock clients.

### Phase 3: Persistent Storage

1. **StorageBackend interface** (`storage/backend.ts`). Formalize the interface with `getVectors` for search.
2. **SQLite backend** (`storage/sqlite.ts`). Schema, BLOB vector storage, WAL mode, eviction queries.
3. **Filesystem backend** (`storage/filesystem.ts`). JSON file, debounced writes, in-memory index.
4. **Integration tests** for persistence, restart recovery, eviction.

### Phase 4: Embedding Adapters and Local Models

1. **OpenAI embedder adapter** (`adapters/openai-embedder.ts`). Convenience wrapper around `openai.embeddings.create`.
2. **Local ONNX embedder** (`adapters/local-embedder.ts`). Download and cache model on first use. Run inference via `onnxruntime-node`.
3. **Integration tests** with real embedding models (local ONNX for CI, OpenAI for manual integration tests).

### Phase 5: Advanced Features

1. **Redis backend** (`storage/redis.ts`). Redis hashes for entries, binary buffers for vectors, sorted sets for LRU, periodic sync.
2. **HNSW search** (`search/hnsw.ts`). Pure TypeScript HNSW implementation. Incremental insertion. Configurable parameters.
3. **Serialization** (`serialization.ts`). Binary format for cache export/import.
4. **Cost tracking** (`stats.ts`). Token estimation, model pricing, `model-price-registry` integration.
5. **CLI** (`cli.ts`). `stats`, `search`, `clear`, `export`, `import` commands.

### Phase 6: Polish and Documentation

1. **README.md** with quick-start guide, API reference, and integration examples.
2. **Performance benchmarks** published in README.
3. **Edge case hardening** based on real-world usage patterns.

---

## 23. Example Use Cases

### FAQ Bot with Semantic Caching

A company operates a FAQ chatbot that receives 10,000 queries per day. Without caching, each query costs approximately $0.005 (500-token response at GPT-4o pricing). Annual cost: $18,250. Analysis shows that 70% of queries are semantic duplicates of approximately 200 unique questions.

```typescript
import { createCache } from 'llm-semantic-cache';
import { createLocalEmbedder } from 'llm-semantic-cache/adapters';
import OpenAI from 'openai';

const openai = new OpenAI();
const embedder = await createLocalEmbedder({ model: 'all-MiniLM-L6-v2' });

const cache = createCache({
  embedder,
  threshold: 0.88,        // FAQ questions are semantically clear
  maxEntries: 1000,
  storage: { type: 'sqlite', path: './faq-cache.db' },
});

const cachedClient = cache.wrap(openai);

// All FAQ queries go through the cache
app.post('/ask', async (req, res) => {
  const response = await cachedClient.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are a helpful FAQ assistant.' },
      { role: 'user', content: req.body.question },
    ],
  });
  res.json({ answer: response.choices[0].message.content });
});

// With 70% cache hit rate:
// Annual cost: $18,250 * 0.30 = $5,475 (saving $12,775/year)
// Embedding cost: ~$0 (local model)
// Cache storage: ~1 MB for 200 unique entries
```

### Customer Support Cost Reduction

A customer support platform routes queries to an LLM for automated responses. The queries have high semantic overlap -- "I can't log in", "login not working", "unable to access my account", "my password doesn't work" are all the same issue.

```typescript
const cache = createCache({
  embedder: openaiEmbedder,
  threshold: 0.90,
  maxEntries: 5000,
  ttl: 86400_000, // 24-hour TTL (support info changes daily)
  storage: { type: 'redis', url: process.env.REDIS_URL },
  modelPrices: {
    'gpt-4o': { input: 2.50, output: 10.00 },
  },
});

// Shared across all support platform instances via Redis
```

### Search Query Deduplication

A search application translates natural-language queries into SQL. Users phrase the same search intent in many ways: "show me revenue for 2024", "2024 revenue data", "what was our revenue in 2024", "revenue figures from last year".

```typescript
import { normalize } from 'prompt-dedup';
import { createCache } from 'llm-semantic-cache';

const cache = createCache({
  embedder: localEmbedder,
  threshold: 0.90,
  normalizer: normalize, // normalize before embedding for better hit rates
  maxEntries: 2000,
});

async function naturalLanguageSearch(query: string): Promise<string> {
  const hit = await cache.get(query, { model: 'gpt-4o' });
  if (hit) return hit.response; // cached SQL + results

  const sql = await generateSQL(query);
  const results = await executeQuery(sql);
  const response = JSON.stringify({ sql, results });
  await cache.set(query, response, { model: 'gpt-4o' });
  return response;
}
```

### Rate Limit Mitigation

An application is rate-limited to 500 requests per minute by the LLM provider. During peak hours, user demand exceeds 800 requests per minute.

```typescript
const cache = createCache({
  embedder: localEmbedder,
  threshold: 0.92,
  maxEntries: 10_000,
  storage: { type: 'sqlite', path: './rate-limit-cache.db' },
});

// With a 40% cache hit rate during peak:
// Effective capacity: 500 / 0.60 = 833 requests per minute
// Cache hits served at ~5ms (vs 500ms+ for API calls)
// No rate limit errors for users whose queries match cached responses
```

### Multi-Model Cost Optimization

An application uses GPT-4o for complex queries and GPT-4o-mini for simple ones. Semantic caching is model-aware: a cached GPT-4o response is never returned for a GPT-4o-mini query.

```typescript
const cache = createCache({
  embedder: localEmbedder,
  threshold: 0.92,
  maxEntries: 5000,
  modelPrices: {
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
  },
});

// Route queries based on complexity
async function handleQuery(query: string, complexity: 'simple' | 'complex') {
  const model = complexity === 'complex' ? 'gpt-4o' : 'gpt-4o-mini';
  const hit = await cache.get(query, { model });
  if (hit) return hit.response;

  const response = await callLLM(query, model);
  await cache.set(query, response, { model });
  return response;
}

// cache.stats() reports savings separately for each model
const stats = await cache.stats();
// stats.entriesByModel: { 'gpt-4o': 1200, 'gpt-4o-mini': 3800 }
```

### Layered Caching (Exact + Semantic)

For maximum cache hit rates with minimum overhead, layer an exact-key cache in front of a semantic cache. The exact cache handles repeated identical prompts (zero embedding cost). The semantic cache handles rephrasings that the exact cache misses.

```typescript
import { createCache as createExactCache } from 'llm-response-cache';
import { createCache as createSemanticCache } from 'llm-semantic-cache';
import { normalize } from 'prompt-dedup';

const exactCache = createExactCache({
  normalizer: normalize,
  maxEntries: 50_000,
  storage: { type: 'sqlite', path: './exact-cache.db' },
});

const semanticCache = createSemanticCache({
  embedder: localEmbedder,
  threshold: 0.92,
  maxEntries: 10_000,
  storage: { type: 'sqlite', path: './semantic-cache.db' },
});

async function cachedLLM(prompt: string, model: string): Promise<string> {
  // Layer 1: Exact match (sub-1ms, no embedding cost)
  const exact = await exactCache.get(prompt, { model });
  if (exact) return exact;

  // Layer 2: Semantic match (2-10ms with local embedder)
  const semantic = await semanticCache.get(prompt, { model });
  if (semantic) return semantic.response;

  // Layer 3: LLM call (500-5000ms, full cost)
  const response = await callLLM(prompt, model);
  await exactCache.set(prompt, response, { model });
  await semanticCache.set(prompt, response, { model });
  return response;
}
```
