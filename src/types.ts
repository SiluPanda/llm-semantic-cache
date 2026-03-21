export type EmbedderFn = (text: string) => Promise<number[]>
export type PromptInput = string | Array<{ role: string; content: string }>

export interface CacheEntry {
  id: string
  embedding: Float32Array
  response: string
  model: string
  createdAt: number
  accessedAt: number
  hitCount: number
  inputTokens: number
  outputTokens: number
}

export interface CacheHit {
  response: string
  similarity: number
  entryId: string
}

export interface SearchResult {
  id: string
  similarity: number
  response: string
}

export interface SemanticCacheOptions {
  embedFn: EmbedderFn
  threshold?: number           // default 0.92
  maxEntries?: number          // default 1000
  ttlMs?: number               // default 0 (no TTL)
  normalizer?: (text: string) => string
  pricePerMTokInput?: number   // default 2.50
  pricePerMTokOutput?: number  // default 10.00
}

export interface SemanticCache {
  get(prompt: PromptInput, model?: string): Promise<CacheHit | null>
  set(
    prompt: PromptInput,
    response: string,
    model?: string,
    usage?: { inputTokens?: number; outputTokens?: number }
  ): Promise<void>
  wrap<T extends object>(client: T): T
  search(prompt: PromptInput, topK?: number): Promise<SearchResult[]>
  stats(): {
    hits: number
    misses: number
    hitRate: number
    totalEntries: number
    tokensSaved: number
    estimatedCostSaved: number
  }
  delete(id: string): boolean
  clear(): void
  serialize(): string
  readonly size: number
}
