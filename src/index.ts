// llm-semantic-cache - Self-hosted semantic cache using local embeddings
export { createCache } from './cache.js'
export type {
  EmbedderFn,
  PromptInput,
  CacheEntry,
  CacheHit,
  SearchResult,
  SemanticCacheOptions,
  SemanticCache,
} from './types.js'
