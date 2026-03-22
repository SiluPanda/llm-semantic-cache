# llm-semantic-cache — Task Breakdown

This file tracks all implementation tasks derived from SPEC.md. Tasks are grouped by phase and ordered by dependency.

---

## Phase 1: Project Scaffolding and Type Definitions

- [ ] **Install dev dependencies** — Add `typescript`, `vitest`, `eslint`, and `@types/better-sqlite3` to devDependencies in package.json. Add `better-sqlite3`, `ioredis`, and `onnxruntime-node` as optional peerDependencies. | Status: not_done

- [ ] **Configure package.json bin field** — Add `"bin": { "llm-semantic-cache": "dist/cli.js" }` to package.json for CLI support. Add `"exports"` field with subpath exports for `llm-semantic-cache/adapters`. | Status: not_done

- [ ] **Define all TypeScript types** — Create `src/types.ts` with all type definitions: `EmbedderFn`, `PromptInput`, `SemanticCacheOptions`, `CacheEntry`, `CacheHit`, `GetOptions`, `SetOptions`, `WrapOptions`, `SearchOptions`, `SearchResult`, `CacheStats`, `StorageBackend` interface, eviction policy types, HNSW options, and model price types. | Status: not_done

- [x] **Set up public API exports** — Update `src/index.ts` to export `createCache`, all public types from `types.ts`, and the `SemanticCache` class. | Status: done

---

## Phase 2: Core Math — Similarity and Vector Operations

- [x] **Implement cosine similarity function** — Create `src/similarity.ts` with a `cosineSimilarity(a: Float32Array, b: Float32Array): number` function that computes the dot product of two vectors. For pre-normalized vectors, the dot product equals cosine similarity. Include the full formula with L2 norm computation as a fallback for non-normalized vectors. | Status: done

- [ ] **Implement vector normalization** — In `src/similarity.ts`, add `normalizeVector(v: number[]): Float32Array` that L2-normalizes a vector to unit length. Detect already-normalized vectors (L2 norm within epsilon of 1.0) and skip normalization. Handle zero vector gracefully (return zero Float32Array). | Status: not_done

- [ ] **Implement dimensionality validation** — In `src/similarity.ts`, add a helper that validates two vectors have the same dimensionality. Throw a descriptive error on mismatch. Validate dimensionality is > 0. | Status: not_done

- [ ] **Write similarity.test.ts** — Create `src/__tests__/similarity.test.ts`. Test cases: identical vectors produce 1.0, orthogonal vectors produce 0.0, anti-parallel vectors produce -1.0, known angle vectors produce known cosine value, normalization produces unit-length vectors, zero vector handling, dimensionality mismatch throws error, zero-dimensional embedding throws error. | Status: not_done

---

## Phase 3: Prompt Serialization

- [ ] **Implement prompt normalization and serialization** — Create `src/prompt.ts` with a `serializePrompt(input: PromptInput): string` function that converts all supported prompt formats to a canonical string. Handle: plain string passthrough, OpenAI-style message arrays (concatenate role-prefixed content), Anthropic-style objects with system and messages fields (prepend system message). | Status: not_done

- [x] **Support optional normalizer function** — In `src/prompt.ts`, add support for an optional `normalizer` function that is applied to the serialized prompt string before embedding (e.g., `prompt-dedup` normalize). | Status: done

- [ ] **Write prompt.test.ts** — Create `src/__tests__/prompt.test.ts`. Test cases: plain string passthrough, OpenAI message array serialization, Anthropic format serialization, system message prepending, empty messages array, single user message, multi-turn conversation serialization, normalizer function is applied when provided. | Status: not_done

---

## Phase 4: Search Strategies

- [x] **Implement brute-force nearest-neighbor search** — Create `src/search/brute-force.ts` with a function that takes a query embedding (Float32Array), a packed vectors matrix (Float32Array), corresponding entry IDs (string[]), dimensions (number), and returns the best match (id, similarity score) or null if no entries exist. Iterate all vectors computing cosine similarity, track the maximum. | Status: done

- [x] **Implement top-K brute-force search** — Extend brute-force search to support returning top-K results with their similarity scores, sorted descending by similarity. Support an optional `minSimilarity` floor. | Status: done

- [ ] **Write search.test.ts** — Create `src/__tests__/search.test.ts`. Test cases: empty vectors returns null, single entry returns it with correct similarity, multiple entries returns the best match, top-K returns correct number of results sorted by similarity, minSimilarity filters out low-similarity results, large entry sets (1000+) return correct results. | Status: not_done

---

## Phase 5: Storage Backends — In-Memory

- [ ] **Define StorageBackend interface** — Create `src/storage/backend.ts` exporting the `StorageBackend` interface with methods: `get(id)`, `set(entry)`, `delete(id)`, `clear(options?)`, `getByModel(model)`, `getVectors(model)`, `size()`, `sizeByModel()`, optional `flush()`, optional `close()`. | Status: not_done

- [ ] **Implement in-memory storage backend** — Create `src/storage/memory.ts` implementing `StorageBackend`. Use a `Map<string, CacheEntry>` for entry storage. Maintain a packed `Float32Array` matrix per model namespace for vector storage. Implement `getVectors` to return the pre-packed matrix for zero-copy search. | Status: not_done

- [x] **Implement LRU tracking in memory backend** — Add a doubly-linked list to the in-memory backend for LRU eviction. On cache hit (via `get`), promote the entry to the head. On eviction, remove from the tail. O(1) promotion and eviction. | Status: done

- [ ] **Implement storage factory** — Create a factory function (in `src/storage/` or `src/cache.ts`) that takes the `storage` option from `SemanticCacheOptions` and returns the appropriate `StorageBackend` instance. Handle string `'memory'`, object `{ type: 'memory' }`, object `{ type: 'sqlite', ... }`, object `{ type: 'redis', ... }`, object `{ type: 'filesystem', ... }`, and custom `StorageBackend` instances. | Status: not_done

- [ ] **Write memory storage tests** — Create `src/__tests__/storage.test.ts` (or a dedicated memory storage test file). Test cases: set and get entry by ID, delete entry, clear all entries, clear by model, getByModel returns only matching entries, getVectors returns correct Float32Array and IDs, size and sizeByModel return correct counts, LRU eviction removes least recently accessed entry when maxEntries is reached. | Status: not_done

---

## Phase 6: Eviction Policies

- [x] **Implement TTL eviction** — Create `src/eviction.ts` with TTL checking logic. On cache get, check if `entry.createdAt + entry.ttl < Date.now()` (using per-entry TTL or global TTL). Return null and schedule deletion for expired entries. Support lazy eviction (check on access) and optional background sweep. | Status: done

- [x] **Implement LRU eviction** — In `src/eviction.ts`, add LRU eviction logic. When a new entry is added and `maxEntries` is reached, identify and remove the least recently accessed entry (lowest `accessedAt`). Delegate actual removal to the storage backend. | Status: done

- [x] **Implement combined TTL + LRU eviction** — Ensure TTL and LRU policies can be combined. An entry is evicted if either condition is met: TTL expired, or size limit reached (LRU). Both conditions are checked on access. | Status: done

- [ ] **Write eviction.test.ts** — Create `src/__tests__/eviction.test.ts`. Test cases: TTL expiry removes entry after duration, per-entry TTL overrides global TTL, LRU eviction removes least recently accessed when max reached, combined TTL+LRU works correctly, accessing an entry updates its accessedAt for LRU, TTL boundary condition (exactly at expiry time). | Status: not_done

---

## Phase 7: Core Cache Logic

- [ ] **Implement SemanticCache class** — Create `src/cache.ts` with the `SemanticCache` class. Constructor accepts `SemanticCacheOptions`, validates required `embedder` option (throw if missing), initializes storage backend, sets defaults for threshold (0.92), eviction policy, search strategy. | Status: not_done

- [x] **Implement createCache factory** — In `src/cache.ts`, export `createCache(options: SemanticCacheOptions): SemanticCache` factory function that constructs and returns a `SemanticCache` instance. | Status: done

- [x] **Implement cache.get()** — Implement `get(prompt: PromptInput, options?: GetOptions): Promise<CacheHit | null>`. Steps: serialize prompt, apply normalizer, call embedder, normalize vector, determine model namespace (default or from options), search storage for nearest neighbor, evaluate threshold (use per-call threshold override if provided), on hit update accessedAt/hitCount/stats, on miss increment miss counter. Check TTL on the matched entry. | Status: done

- [x] **Implement cache.set()** — Implement `set(prompt: PromptInput, response: string, options?: SetOptions): Promise<string>`. Steps: serialize prompt, call embedder, normalize vector, validate dimensionality against existing entries in namespace, generate UUID for entry ID, create CacheEntry with all fields, enforce maxEntries eviction, store in backend, return entry ID. | Status: done

- [x] **Implement cache.search()** — Implement `search(prompt: PromptInput, options?: SearchOptions): Promise<SearchResult[]>`. Steps: serialize and embed the prompt, search the specified model namespace using top-K brute-force (or HNSW), filter by minSimilarity, return results sorted descending by similarity. | Status: done

- [x] **Implement cache.delete()** — Implement `delete(id: string): Promise<boolean>`. Delegate to storage backend. Return true if entry existed and was deleted. | Status: done

- [x] **Implement cache.clear()** — Implement `clear(options?: { model?: string }): Promise<void>`. Clear all entries, or only entries matching the specified model. Delegate to storage backend. Reset relevant stats if clearing all. | Status: done

- [ ] **Implement cache.close()** — Implement `close(): Promise<void>`. Flush any pending writes via storage backend's `flush()`, then close connections via `close()`. | Status: not_done

- [x] **Implement model-aware namespacing** — Ensure all cache operations (get, set, search, clear, stats) scope entries by model identifier. Model identifiers are normalized to lowercase by default. Support custom `modelNormalizer` function. | Status: done

- [ ] **Implement model identifier normalization** — Normalize model strings to lowercase. Preserve version suffixes (e.g., `gpt-4o-2024-08-06` stays as-is after lowercasing). Support custom `modelNormalizer` function for version-agnostic caching. | Status: not_done

- [x] **Implement default model handling** — When `model` is not specified in `get`/`set`/`search` options, use a default namespace (e.g., `'default'`). Document this behavior. | Status: done

- [x] **Write cache.test.ts** — Create `src/__tests__/cache.test.ts`. Test cases: createCache with valid options succeeds, createCache without embedder throws, cache.get on empty cache returns null, cache.set stores entry and returns ID, cache.get finds semantically similar entry (cache hit), cache.get returns null for dissimilar entry (cache miss), threshold boundary conditions (at threshold = hit, below threshold = miss), per-call threshold override works, model namespacing isolates entries, cache.delete removes entry, cache.clear removes all entries, cache.clear with model filter removes only matching entries, cache.close flushes and closes, multiple set/get operations maintain consistency. | Status: done

---

## Phase 8: Statistics and Cost Tracking

- [ ] **Implement stats tracking** — Create `src/stats.ts` with a `CacheStatsTracker` class that maintains running counters: hits, misses, tokensSaved, costSaved, totalSimilarity (for computing average), per-model breakdowns. Provide methods: `recordHit(entry, model)`, `recordMiss(model)`, `getStats(options?)`, `resetStats()`. | Status: not_done

- [x] **Implement token estimation** — In `src/stats.ts`, add a default token estimator: `text.length / 4` (configurable via `tokenEstimator` option). Use this to estimate tokens saved per cache hit. | Status: done

- [x] **Implement cost calculation** — In `src/stats.ts`, compute cost saved per hit using model prices: `(promptTokens / 1M * input_price) + (responseTokens / 1M * output_price)`. Use built-in default prices for common models. Fall back to `{ input: 1.00, output: 2.00 }` for unknown models. Support `modelPrices` option override. | Status: done

- [ ] **Add built-in model prices** — In `src/stats.ts`, define built-in prices for: gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo, claude-sonnet-4-20250514, claude-3-5-sonnet-20241022, claude-3-haiku-20240307. Match the values from the spec. | Status: not_done

- [x] **Implement cache.stats()** — Wire up `cache.stats(options?: { model?: string }): Promise<CacheStats>` to return the current stats. Include: hits, misses, hitRate, entries count (from storage.size()), tokensSaved, costSaved, models list, avgSimilarity, entriesByModel. Support model-scoped stats. | Status: done

- [ ] **Implement cache.resetStats()** — Wire up `cache.resetStats()` to reset all counters without clearing cache entries. | Status: not_done

- [ ] **Write stats.test.ts** — Create `src/__tests__/stats.test.ts`. Test cases: initial stats are all zeros, recording a hit increments hit count and tokensSaved/costSaved, recording a miss increments miss count, hitRate is computed correctly, per-model stats are correct, resetStats zeros counters but does not clear cache, avgSimilarity is computed correctly, token estimation with default estimator, token estimation with custom estimator, cost calculation with built-in prices, cost calculation with custom prices, cost fallback for unknown models. | Status: not_done

---

## Phase 9: Cache-Through Wrapper

- [x] **Implement Proxy-based wrapper** — Create `src/wrapper/wrap.ts` with the `wrap<T>(client: T, options?: WrapOptions): T` method. Use JavaScript `Proxy` to intercept method calls. Detect client type (OpenAI vs Anthropic) automatically or via `clientType` option. Delegate to appropriate adapter. | Status: done

- [x] **Implement OpenAI client adapter** — Create `src/wrapper/openai.ts`. Intercept `client.chat.completions.create(params)`. Extract prompt from `params.messages`, extract model from `params.model`. On cache hit, reconstruct OpenAI `ChatCompletion` response format with synthetic `id` (prefixed `cache-`), `usage` zeroed out, and `_cached: true`. On cache miss, call original method, cache the response, return it. | Status: done

- [ ] **Implement Anthropic client adapter** — Create `src/wrapper/anthropic.ts`. Intercept `client.messages.create(params)`. Extract prompt from `params.messages` and `params.system`, extract model from `params.model`. On cache hit, reconstruct Anthropic `Message` response format. On cache miss, call original method, cache the response, return it. | Status: not_done

- [ ] **Support custom client adapters** — In `src/wrapper/wrap.ts`, support `extractPrompt`, `extractModel`, and `buildResponse` functions in `WrapOptions` for wrapping arbitrary LLM clients. | Status: not_done

- [ ] **Write wrapper.test.ts** — Create `src/__tests__/wrapper.test.ts`. Test cases: wrapping OpenAI client intercepts chat.completions.create, first call is a miss and delegates to original client, second similar call is a hit and returns cached response, response format matches OpenAI ChatCompletion structure, cached response has `_cached: true` and `cache-` prefixed ID, usage is zeroed on cache hit, wrapping Anthropic client intercepts messages.create, custom extractPrompt/extractModel/buildResponse work correctly, non-intercepted methods pass through to original client. | Status: not_done

---

## Phase 10: Streaming Support

- [ ] **Implement streaming cache miss handling** — Create `src/wrapper/stream.ts`. On a streaming cache miss (`stream: true` in params), call the original client with streaming, create a pass-through async iterable that yields chunks to the caller in real time while buffering the full response. When the stream completes, assemble the full response and store it in the cache. If the stream is interrupted before completion, do not cache anything. | Status: not_done

- [ ] **Implement streaming cache hit replay** — In `src/wrapper/stream.ts`, implement three replay modes for cache hits with `stream: true`: `immediate` (emit full response as a single chunk + done signal), `simulated` (split into token-sized chunks with 5-20ms delays), `throttled` (emit at configurable tokens-per-second rate via `streamReplaySpeed`). Default mode is `immediate`. | Status: not_done

- [ ] **Implement OpenAI streaming chunk format** — In `src/wrapper/stream.ts`, construct synthetic `ChatCompletionChunk` objects matching the OpenAI streaming format: `{ id, object, created, model, choices: [{ index, delta: { content }, finish_reason }] }`. Final chunk has `finish_reason: 'stop'` and empty delta content. | Status: not_done

- [ ] **Implement Anthropic streaming event format** — In `src/wrapper/stream.ts`, construct synthetic `MessageStreamEvent` objects matching the Anthropic streaming format for cache hit replay. | Status: not_done

- [ ] **Write stream.test.ts** — Create `src/__tests__/stream.test.ts`. Test cases: streaming cache miss forwards chunks in real time and caches full response, streaming cache hit with `immediate` mode returns single chunk, streaming cache hit with `simulated` mode returns multiple chunks with delays, streaming cache hit with `throttled` mode respects tokens-per-second rate, interrupted stream does not cache partial response, stream chunks match expected format (OpenAI), stream chunks match expected format (Anthropic), async iterable interface works with `for await...of`. | Status: not_done

---

## Phase 11: Storage Backends — SQLite

- [ ] **Implement SQLite storage backend** — Create `src/storage/sqlite.ts` implementing `StorageBackend`. Use `better-sqlite3` (peer dependency). Create table `cache_entries` with schema from spec (id, prompt, embedding BLOB, response, model, created_at, accessed_at, hit_count, ttl, metadata). Create indexes on model, accessed_at, created_at. Enable WAL mode by default. | Status: not_done

- [ ] **Implement SQLite vector storage as BLOBs** — Store embedding vectors as packed little-endian 32-bit float BLOBs. Implement `getVectors(model)` to load all vectors for a namespace, deserialize BLOBs into a contiguous Float32Array, and return with corresponding IDs. | Status: not_done

- [ ] **Implement SQLite LRU eviction** — For LRU eviction in SQLite, use `DELETE FROM cache_entries WHERE model = ? ORDER BY accessed_at ASC LIMIT ?` to remove the oldest-accessed entries when maxEntries is reached. | Status: not_done

- [ ] **Implement SQLite in-memory vector index cache** — For frequently accessed namespaces, maintain an in-memory vector index that is refreshed on writes. Avoid reloading all vectors from disk on every search. | Status: not_done

- [ ] **Write SQLite storage tests** — Add SQLite-specific tests to `src/__tests__/storage.test.ts` (or a dedicated file). Test cases: create table on initialization, set and get entries, persistence across close/reopen, BLOB vector round-trip (store Float32Array as BLOB, read back, verify identical), WAL mode is enabled, getVectors returns correct packed Float32Array, LRU eviction deletes oldest-accessed entries, clear by model only removes matching entries, concurrent reads work. | Status: not_done

---

## Phase 12: Storage Backends — Filesystem

- [ ] **Implement filesystem storage backend** — Create `src/storage/filesystem.ts` implementing `StorageBackend`. Store all entries as a JSON file on disk. On initialization, load the full file into memory. Maintain an in-memory Map and vector index for fast access. | Status: not_done

- [ ] **Implement debounced writes** — In the filesystem backend, debounce writes to disk (default 1 second, configurable via `debounceMs`). Accumulate changes in memory and flush to disk after the debounce interval. Implement `flush()` to force an immediate write. | Status: not_done

- [ ] **Handle filesystem edge cases** — Handle: file does not exist on first run (create empty), file is corrupted (log warning, start fresh), directory does not exist (create recursively). Serialize embedding vectors as JSON arrays. | Status: not_done

- [ ] **Write filesystem storage tests** — Add filesystem-specific tests. Test cases: creates file on first set, loads existing file on init, debounced writes coalesce multiple sets, flush forces immediate write, persistence across close/reopen, handles missing file gracefully, handles missing directory (creates it), getVectors returns correct data. | Status: not_done

---

## Phase 13: Storage Backends — Redis

- [ ] **Implement Redis storage backend** — Create `src/storage/redis.ts` implementing `StorageBackend`. Use `ioredis` (peer dependency). Store each entry as a Redis hash with fields for prompt, response, model, timestamps, metadata. Store embedding vectors as binary buffers (packed 32-bit floats) in separate keys with `vec:` prefix. Apply configurable key prefix (default `sem-cache:`). | Status: not_done

- [ ] **Implement Redis TTL support** — Use Redis `PEXPIRE` to set TTL on cache entries natively. Expired entries are automatically removed by Redis. | Status: not_done

- [ ] **Implement Redis LRU eviction** — Track entries in a Redis sorted set keyed by access timestamp. On eviction, remove entries with the lowest scores. | Status: not_done

- [ ] **Implement Redis periodic vector sync** — Maintain a local in-memory vector index. Periodically refresh it from Redis (configurable `syncInterval`, default 5 seconds). Support `syncInterval: 0` for on-demand sync on every lookup. | Status: not_done

- [ ] **Write Redis storage tests** — Add Redis-specific tests (may require a running Redis instance or mock). Test cases: set and get entries via Redis, key prefix is applied correctly, TTL is set on entries, expired entries are not returned, getVectors returns correct data after sync, syncInterval controls refresh frequency, LRU eviction works, clear by model removes only matching entries, close disconnects from Redis. | Status: not_done

---

## Phase 14: Embedding Adapters

- [ ] **Implement OpenAI embedder adapter** — Create `src/adapters/openai-embedder.ts` with `createOpenAIEmbedder(client, options?)` that wraps `openai.embeddings.create`, extracts the embedding vector from the response, and handles error mapping. Support configurable model (default `text-embedding-3-small`) and optional dimensions parameter. | Status: not_done

- [ ] **Implement local ONNX embedder adapter** — Create `src/adapters/local-embedder.ts` with `createLocalEmbedder(options)` that downloads and caches a model on first use (to `~/.cache/llm-semantic-cache/models/`), runs inference via `onnxruntime-node` (peer dependency), and returns the embedding vector. Support models: `all-MiniLM-L6-v2`, `bge-small-en-v1.5`, `bge-base-en-v1.5`. | Status: not_done

- [ ] **Set up subpath exports for adapters** — Configure package.json exports so that `import { createOpenAIEmbedder } from 'llm-semantic-cache/adapters'` works. Ensure TypeScript declaration files are generated for the adapters subpath. | Status: not_done

- [ ] **Write adapter tests** — Test OpenAI adapter with a mock OpenAI client (verify it calls embeddings.create with correct parameters, extracts embedding from response, handles errors). Test local embedder setup (mock onnxruntime-node, verify model download and caching, verify inference call). | Status: not_done

---

## Phase 15: HNSW Approximate Nearest-Neighbor Search

- [ ] **Implement HNSW index** — Create `src/search/hnsw.ts` with a pure TypeScript HNSW (Hierarchical Navigable Small World) implementation. Support incremental insertion of new entries. Configurable parameters: `efConstruction` (default 200), `efSearch` (default 200), `m` (default 16). | Status: not_done

- [ ] **Implement HNSW search** — Implement approximate nearest-neighbor search over the HNSW graph. Return the best match with similarity score. Support top-K results. Recall should be > 0.99 with default parameters. | Status: not_done

- [ ] **Integrate HNSW with cache** — When `searchStrategy: 'hnsw'` is configured, use the HNSW index for search instead of brute-force. Build the index incrementally as entries are added. | Status: not_done

- [ ] **Write HNSW tests** — Test cases: insert and search returns correct nearest neighbor, top-K results are correct, recall is > 0.99 compared to brute-force ground truth, incremental insertion maintains index correctness, configurable parameters affect build and search behavior, performance is sub-linear for large datasets. | Status: not_done

---

## Phase 16: Serialization

- [ ] **Implement cache.serialize()** — Create `src/serialization.ts` with serialization logic. Produce a binary buffer containing: header (magic bytes, version, entry count, dimensions), entry table (prompt UTF-8, response UTF-8, model UTF-8, timestamps, hit count, TTL, metadata JSON), vector block (contiguous Float32Array of all embeddings). | Status: not_done

- [ ] **Implement SemanticCache.deserialize()** — In `src/serialization.ts`, implement static deserialization that reads the binary buffer, reconstructs all cache entries, and returns a new `SemanticCache` instance. Accept an `embedder` function in options (required for the restored cache to function). Validate header magic bytes and version. | Status: not_done

- [ ] **Write serialization.test.ts** — Create `src/__tests__/serialization.test.ts`. Test cases: serialize and deserialize round-trip preserves all entries, embeddings are identical after round-trip, metadata is preserved, empty cache serializes/deserializes to empty cache, invalid magic bytes throw error, version mismatch handling, large cache (1000+ entries) round-trip. | Status: not_done

---

## Phase 17: CLI

- [ ] **Implement CLI entry point** — Create `src/cli.ts` with `#!/usr/bin/env node` shebang. Use `node:util` `parseArgs` for argument parsing. Parse command (first positional arg): `stats`, `search`, `clear`, `export`, `import`. Parse shared flags: `--storage`, `--path`, `--url`, `--model`, `--json`, `--help`. | Status: not_done

- [ ] **Implement CLI stats command** — Print cache statistics in formatted human-readable output (entries, models, hits, misses, hit rate, tokens saved, cost saved, avg similarity, per-model breakdown). Support `--json` flag for JSON output. Support `--model` filter. | Status: not_done

- [ ] **Implement CLI search command** — Accept a query prompt as positional argument. Require an embedder configuration (from config file `llm-semantic-cache.config.js` or `--embedder` flag pointing to a module). Parse `--top-k` (default 5) and `--threshold` (default 0.0) flags. Print results in formatted output with similarity scores, prompts, and response previews. Support `--json` output. | Status: not_done

- [ ] **Implement CLI clear command** — Clear cache entries. Support `--model` filter to clear only a specific model's entries. Print count of cleared entries. Require confirmation unless `--force` or `--json` is used. | Status: not_done

- [ ] **Implement CLI export command** — Serialize cache to a binary snapshot file specified by `--output` flag. Print exported entry count and file size. | Status: not_done

- [ ] **Implement CLI import command** — Deserialize a binary snapshot file specified by `--input` flag into the cache. Print imported entry count. | Status: not_done

- [ ] **Implement CLI help output** — Print usage information, available commands, and all flags with descriptions when `--help` is passed or no command is given. | Status: not_done

- [ ] **Write cli.test.ts** — Create `src/__tests__/cli.test.ts`. Test cases: stats command outputs correct format, search command returns results, clear command removes entries, export command creates file, import command restores entries, --json flag produces valid JSON output, --help flag shows help text, unknown command shows error, missing required flags show error. | Status: not_done

---

## Phase 18: Integration with Monorepo Packages

- [ ] **Document embed-cache integration** — Ensure the embedder function can be wrapped with `embed-cache` to avoid redundant embedding API calls. Test that the layered approach works: embed-cache caches embeddings, llm-semantic-cache caches LLM responses. | Status: not_done

- [ ] **Document llm-response-cache layered caching** — Ensure exact-key cache (llm-response-cache) can be layered in front of semantic cache. Document the pattern: check exact cache first (fast, no embedding cost), then semantic cache on exact miss. | Status: not_done

- [ ] **Document llm-dedup integration** — Ensure `llm-dedup` can be layered on top of the cache-through wrapper for deduplication of concurrent in-flight requests. Document the pattern: dedup -> cache -> LLM. | Status: not_done

- [ ] **Document prompt-dedup integration** — Ensure `prompt-dedup` normalize function works as the `normalizer` option. Document the benefit: normalized prompts produce more similar embeddings, improving hit rates. | Status: not_done

- [ ] **Document model-price-registry integration** — Ensure `model-price-registry` getPrice function works with the `modelPrices` option. Document usage for accurate cost tracking. | Status: not_done

---

## Phase 19: Error Handling and Edge Cases

- [ ] **Handle missing embedder** — Throw a descriptive error if `createCache` is called without an `embedder` function. Error message should explain that the embedder is required and how to provide one. | Status: not_done

- [ ] **Handle embedder errors** — Wrap embedder calls in try/catch. If the embedder throws, propagate the error with context (e.g., "Embedding generation failed for prompt: ..."). Do not cache partial results. | Status: not_done

- [ ] **Handle dimensionality mismatch** — When storing an embedding with a different dimensionality than existing entries in the same model namespace, throw a descriptive error. Track dimensionality per namespace. | Status: not_done

- [ ] **Handle empty cache operations** — Ensure `cache.get` returns null on empty cache, `cache.search` returns empty array, `cache.stats` returns zeros, `cache.clear` is a no-op, `cache.serialize` produces a valid empty buffer. | Status: not_done

- [ ] **Handle concurrent access** — Ensure multiple simultaneous `get` and `set` calls do not corrupt state. For in-memory backend, JavaScript's single-threaded event loop provides this naturally, but async operations must not interleave state mutations unsafely. | Status: not_done

- [ ] **Handle process shutdown gracefully** — Ensure `cache.close()` flushes pending writes for persistent backends (SQLite, filesystem). Document that applications should call `close()` in process shutdown handlers (SIGTERM, SIGINT). | Status: not_done

- [ ] **Handle invalid threshold values** — Validate threshold is between 0 and 1. Throw an error for values outside this range. | Status: not_done

- [ ] **Handle invalid maxEntries values** — Validate maxEntries is a positive integer or Infinity. Throw for negative or zero values. | Status: not_done

---

## Phase 20: Performance Testing

- [ ] **Benchmark brute-force search latency** — Write a performance benchmark that measures search latency over 100, 1,000, 5,000, and 10,000 entries at both 384 and 1536 dimensions. Assert sub-5ms for 10,000 entries at 1536 dimensions. | Status: not_done

- [ ] **Benchmark cache hit total latency** — Benchmark the full pipeline (embed + search + lookup) for a cache hit using a mock embedder. Assert sub-10ms with a fast embedder. | Status: not_done

- [ ] **Measure memory usage** — Measure the memory footprint for 1,000, 5,000, and 10,000 entries at 1536 dimensions. Assert linear scaling. Document results. | Status: not_done

- [ ] **Benchmark serialization speed** — Benchmark serialize and deserialize for 10,000 entries. Assert sub-1 second for each operation. | Status: not_done

---

## Phase 21: Documentation

- [ ] **Write README.md** — Create a comprehensive README with: package description, installation instructions (including optional peer dependencies), quick-start example, API reference for all public methods (createCache, get, set, search, wrap, delete, clear, stats, serialize, deserialize, close), configuration options table, storage backend descriptions and configuration, eviction policy descriptions, streaming support documentation, CLI usage and commands, integration examples with monorepo packages, performance characteristics, recommended thresholds by use case. | Status: not_done

- [ ] **Add JSDoc comments to all public APIs** — Add JSDoc comments to all exported functions, classes, interfaces, and types in the source code. Include parameter descriptions, return types, examples, and throws clauses. | Status: not_done

---

## Phase 22: Build, Lint, and CI

- [x] **Verify TypeScript compilation** — Ensure `npm run build` (tsc) compiles the entire project without errors. Verify declaration files are generated in `dist/`. Verify source maps are generated. | Status: done

- [x] **Configure ESLint** — Set up ESLint configuration for the project (eslintrc or flat config). Ensure `npm run lint` runs and passes on all source files. | Status: done

- [ ] **Verify all tests pass** — Run `npm run test` (vitest) and ensure all unit, integration, and edge case tests pass. | Status: not_done

- [ ] **Verify package.json is complete** — Ensure package.json has all required fields: name, version (bumped appropriately), description, main, types, files, bin, exports, scripts (build, test, lint, prepublishOnly), keywords, author, license, engines, peerDependencies (optional), peerDependenciesMeta (optional flags), publishConfig. | Status: not_done

---

## Phase 23: Final Integration Testing

- [x] **End-to-end cache hit flow** — Test the complete flow: create cache with mock embedder -> set entry -> get with semantically similar prompt -> verify hit with correct response, similarity score, and entry ID. | Status: done

- [x] **End-to-end cache miss flow** — Test: create cache -> get with unrelated prompt -> verify null return and miss counter incremented. | Status: done

- [ ] **End-to-end cache-through wrapper flow (OpenAI)** — Test: create cache -> wrap mock OpenAI client -> call chat.completions.create -> verify first call delegates to client -> call with similar prompt -> verify second call returns from cache without calling client. | Status: not_done

- [ ] **End-to-end cache-through wrapper flow (Anthropic)** — Same as above with mock Anthropic client and messages.create. | Status: not_done

- [ ] **End-to-end streaming cache miss** — Test: wrap mock streaming client -> call with stream:true -> verify chunks are forwarded to caller in real time -> verify full response is cached after stream completes. | Status: not_done

- [ ] **End-to-end streaming cache hit** — Test: populate cache -> call with stream:true for similar prompt -> verify cached response is replayed as a stream. | Status: not_done

- [ ] **End-to-end SQLite persistence** — Test: create cache with SQLite -> add entries -> close -> create new cache with same SQLite path -> verify entries persist. | Status: not_done

- [ ] **End-to-end serialization round-trip** — Test: create cache -> add entries with various models and metadata -> serialize -> deserialize -> verify all entries restored with correct embeddings, responses, and metadata. | Status: not_done

- [x] **End-to-end eviction** — Test: create cache with maxEntries:3 -> add 4 entries -> verify oldest is evicted and only 3 remain. | Status: done

- [x] **End-to-end TTL expiry** — Test: create cache with TTL:100ms -> set entry -> wait 150ms -> verify get returns null (miss). | Status: done

- [x] **End-to-end cost tracking** — Test: create cache with model prices -> perform hits and misses -> verify stats report correct tokensSaved and costSaved values. | Status: done
