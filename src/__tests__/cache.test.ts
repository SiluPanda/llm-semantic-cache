import { describe, it, expect, beforeEach } from 'vitest'
import { createCache } from '../cache.js'
import type { SemanticCache } from '../types.js'

// Deterministic mock embedder: returns 8-dim vector derived from text hash
const mockEmbed = async (text: string): Promise<number[]> => {
  const hash = text.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xfffffff, 0)
  return Array.from({ length: 8 }, (_, i) => Math.sin(hash + i))
}

describe('SemanticCache', () => {
  let cache: SemanticCache

  beforeEach(async () => {
    cache = await createCache({ embedFn: mockEmbed, threshold: 0.92 })
  })

  it('returns null for empty cache', async () => {
    const result = await cache.get('What is the capital of France?')
    expect(result).toBeNull()
  })

  it('returns a hit after set() with the same prompt', async () => {
    const prompt = 'What is the capital of France?'
    await cache.set(prompt, 'Paris')
    const hit = await cache.get(prompt)
    expect(hit).not.toBeNull()
    expect(hit!.response).toBe('Paris')
    expect(hit!.similarity).toBeGreaterThanOrEqual(0.92)
  })

  it('returns null for a semantically different prompt', async () => {
    await cache.set('What is the capital of France?', 'Paris')
    // Completely different text → different hash → very different embedding
    const hit = await cache.get('Explain quantum entanglement in detail please')
    expect(hit).toBeNull()
  })

  it('tracks hits, misses, and hitRate in stats()', async () => {
    await cache.set('hello world', 'response1')

    // miss
    await cache.get('completely unrelated question about astronomy')
    // hit
    await cache.get('hello world')

    const s = cache.stats()
    expect(s.hits).toBe(1)
    expect(s.misses).toBe(1)
    expect(s.hitRate).toBe(0.5)
    expect(s.totalEntries).toBe(1)
  })

  it('clear() resets entries and counters', async () => {
    await cache.set('prompt', 'response')
    await cache.get('prompt')
    cache.clear()

    const s = cache.stats()
    expect(s.hits).toBe(0)
    expect(s.misses).toBe(0)
    expect(s.totalEntries).toBe(0)
    expect(cache.size).toBe(0)
  })

  it('search() returns topK results sorted by similarity', async () => {
    await cache.set('hello world', 'r1')
    await cache.set('foo bar baz', 'r2')
    await cache.set('test query example', 'r3')

    const results = await cache.search('hello world', 2)
    expect(results).toHaveLength(2)
    // First result should be most similar
    expect(results[0].similarity).toBeGreaterThanOrEqual(results[1].similarity)
    expect(results[0].response).toBe('r1')
  })

  it('size property reflects actual store size', async () => {
    expect(cache.size).toBe(0)
    await cache.set('a', 'resp-a')
    expect(cache.size).toBe(1)
    await cache.set('b', 'resp-b')
    expect(cache.size).toBe(2)
  })

  it('delete() removes an entry by id', async () => {
    await cache.set('deletable prompt', 'response')
    const hit = await cache.get('deletable prompt')
    expect(hit).not.toBeNull()

    const deleted = cache.delete(hit!.entryId)
    expect(deleted).toBe(true)
    expect(cache.size).toBe(0)
  })

  it('LRU eviction: maxEntries=2 evicts oldest entry on third insert', async () => {
    const smallCache = await createCache({ embedFn: mockEmbed, threshold: 0.92, maxEntries: 2 })

    await smallCache.set('entry one', 'r1')
    await smallCache.set('entry two', 'r2')
    // Access entry one to make entry two the LRU
    await smallCache.get('entry one')
    // Third entry should evict entry two (LRU)
    await smallCache.set('entry three', 'r3')

    expect(smallCache.size).toBe(2)
    // entry one should still be present (was recently accessed)
    const hit1 = await smallCache.get('entry one')
    expect(hit1).not.toBeNull()
    // entry three should be present (just added)
    const hit3 = await smallCache.get('entry three')
    expect(hit3).not.toBeNull()
  })

  it('serialize() returns valid JSON with entries and stats', async () => {
    await cache.set('serialize me', 'my response', 'gpt-4', { inputTokens: 10, outputTokens: 20 })
    const json = cache.serialize()
    const parsed = JSON.parse(json) as { entries: unknown[]; stats: { hits: number; misses: number } }
    expect(parsed.entries).toHaveLength(1)
    expect(Array.isArray((parsed.entries[0] as { embedding: unknown }).embedding)).toBe(true)
    expect(parsed.stats.hits).toBe(0)
    expect(parsed.stats.misses).toBe(0)
  })

  it('tracks tokensSaved and estimatedCostSaved after hits', async () => {
    await cache.set('tokens test', 'response text', 'gpt-4', { inputTokens: 100, outputTokens: 200 })
    // Two hits against the same model
    await cache.get('tokens test', 'gpt-4')
    await cache.get('tokens test', 'gpt-4')

    const s = cache.stats()
    // hitCount=2, tokens = 2 * (100+200) = 600
    expect(s.tokensSaved).toBe(600)
    // cost = 2 * (100/1e6*2.5 + 200/1e6*10) = 2 * (0.00025 + 0.002) = 0.00450
    expect(s.estimatedCostSaved).toBeCloseTo(0.0045, 6)
  })

  it('model isolation: same prompt for different models does not cross-hit', async () => {
    await cache.set('model test prompt', 'resp-a', 'gpt-4')
    const hit = await cache.get('model test prompt', 'gpt-3.5')
    expect(hit).toBeNull()
  })

  it('ttl: expired entries are not returned', async () => {
    const ttlCache = await createCache({ embedFn: mockEmbed, threshold: 0.92, ttlMs: 1 })
    await ttlCache.set('ttl prompt', 'ttl response')
    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 10))
    const hit = await ttlCache.get('ttl prompt')
    expect(hit).toBeNull()
  })
})
