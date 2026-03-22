import { randomUUID } from 'crypto'
import type { SemanticCache, SemanticCacheOptions, PromptInput } from './types.js'
import { LRUSemanticStore } from './store.js'
import { cosineSimilarity, l2Normalize, promptToString } from './similarity.js'

export async function createCache(options: SemanticCacheOptions): Promise<SemanticCache> {
  const threshold = options.threshold ?? 0.92
  const store = new LRUSemanticStore(options.maxEntries ?? 1000, options.ttlMs ?? 0)
  const normalizer = options.normalizer ?? ((s: string) => s.trim())
  let hits = 0
  let misses = 0

  async function getEmbedding(prompt: PromptInput): Promise<Float32Array> {
    const text = normalizer(promptToString(prompt))
    const vec = await options.embedFn(text)
    return l2Normalize(vec)
  }

  const cache: SemanticCache = {
    async get(prompt, model = 'default') {
      const embedding = await getEmbedding(prompt)
      const entry = store.findBestMatch(embedding, model, threshold)
      if (entry) {
        hits++
        return {
          response: entry.response,
          similarity: cosineSimilarity(embedding, entry.embedding),
          entryId: entry.id,
        }
      }
      misses++
      return null
    },

    async set(prompt, response, model = 'default', usage) {
      const embedding = await getEmbedding(prompt)
      store.add({
        id: randomUUID(),
        embedding,
        response,
        model,
        createdAt: Date.now(),
        accessedAt: Date.now(),
        hitCount: 0,
        inputTokens: usage?.inputTokens ?? Math.ceil(promptToString(prompt).length / 4),
        outputTokens: usage?.outputTokens ?? Math.ceil(response.length / 4),
      })
    },

    wrap<T extends object>(client: T): T {
      return new Proxy(client, {
        get(target, prop) {
          const val = (target as Record<string | symbol, unknown>)[prop]
          // Only intercept the `chat` property; pass everything else through unchanged
          if (prop !== 'chat' || typeof val !== 'object' || val === null) return val
          return new Proxy(val as object, {
            get(t2, p2) {
              const v2 = (t2 as Record<string | symbol, unknown>)[p2]
              // Only intercept the `completions` property; pass everything else through unchanged
              if (p2 !== 'completions' || typeof v2 !== 'object' || v2 === null) return v2
              return new Proxy(v2 as object, {
                get(t3, p3) {
                  if (p3 === 'create') {
                    return async (...args: unknown[]) => {
                      const params = (args[0] ?? {}) as Record<string, unknown>
                      const promptArg = (params['messages'] ?? params['prompt'] ?? '') as PromptInput
                      const modelArg = (params['model'] as string | undefined) ?? 'default'
                      const hit = await cache.get(promptArg, modelArg)
                      if (hit) {
                        return {
                          choices: [{ message: { content: hit.response }, finish_reason: 'cache' }],
                          _cached: true,
                        }
                      }
                      const result = await (t3 as Record<string, (...a: unknown[]) => unknown>)['create'](...args)
                      const r = result as Record<string, unknown> | null
                      const content =
                        (r?.['choices'] as Array<{ message: { content: string } }> | undefined)?.[0]?.message?.content ?? ''
                      if (content) {
                        const usage = r?.['usage'] as { prompt_tokens?: number; completion_tokens?: number } | undefined
                        await cache.set(promptArg, content, modelArg, {
                          inputTokens: usage?.['prompt_tokens'],
                          outputTokens: usage?.['completion_tokens'],
                        })
                      }
                      return result
                    }
                  }
                  return (t3 as Record<string | symbol, unknown>)[p3]
                },
              })
            },
          })
        },
      }) as T
    },

    async search(prompt, topK = 5) {
      const embedding = await getEmbedding(prompt)
      return store.search(embedding, topK).map(r => ({
        id: r.entry.id,
        similarity: r.similarity,
        response: r.entry.response,
      }))
    },

    stats() {
      const total = hits + misses
      const all = store.all()
      const tokensSaved = all.reduce(
        (s, e) => s + e.hitCount * (e.inputTokens + e.outputTokens),
        0
      )
      const estimatedCostSaved = all.reduce((s, e) => {
        return (
          s +
          e.hitCount *
            (e.inputTokens / 1_000_000 * (options.pricePerMTokInput ?? 2.5) +
              e.outputTokens / 1_000_000 * (options.pricePerMTokOutput ?? 10.0))
        )
      }, 0)
      return {
        hits,
        misses,
        hitRate: total > 0 ? hits / total : 0,
        totalEntries: store.size(),
        tokensSaved,
        estimatedCostSaved,
      }
    },

    delete(id) {
      return store.delete(id)
    },

    clear() {
      store.clear()
      hits = 0
      misses = 0
    },

    serialize() {
      return JSON.stringify({
        entries: store.all().map(e => ({ ...e, embedding: Array.from(e.embedding) })),
        stats: { hits, misses },
      })
    },

    get size() {
      return store.size()
    },
  }

  return cache
}
