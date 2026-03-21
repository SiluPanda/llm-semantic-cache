import type { CacheEntry } from './types.js'
import { cosineSimilarity } from './similarity.js'

interface ListNode {
  id: string
  prev: ListNode | null
  next: ListNode | null
}

export class LRUSemanticStore {
  private entries = new Map<string, CacheEntry>()
  private nodes = new Map<string, ListNode>()
  private head: ListNode  // MRU sentinel
  private tail: ListNode  // LRU sentinel

  constructor(private maxEntries: number, private ttlMs: number) {
    this.head = { id: 'head', prev: null, next: null }
    this.tail = { id: 'tail', prev: null, next: null }
    this.head.next = this.tail
    this.tail.prev = this.head
  }

  findBestMatch(
    queryEmbedding: Float32Array,
    model: string,
    threshold: number
  ): CacheEntry | null {
    let best: CacheEntry | null = null
    let bestSim = -1
    const now = Date.now()

    for (const entry of this.entries.values()) {
      if (entry.model !== model) continue
      if (this.ttlMs > 0 && now - entry.createdAt > this.ttlMs) continue
      const sim = cosineSimilarity(queryEmbedding, entry.embedding)
      if (sim >= threshold && sim > bestSim) {
        best = entry
        bestSim = sim
      }
    }

    if (best) {
      best.accessedAt = Date.now()
      best.hitCount++
      this.moveToFront(best.id)
    }
    return best
  }

  search(
    queryEmbedding: Float32Array,
    topK: number
  ): Array<{ entry: CacheEntry; similarity: number }> {
    const results: Array<{ entry: CacheEntry; similarity: number }> = []
    for (const entry of this.entries.values()) {
      results.push({ entry, similarity: cosineSimilarity(queryEmbedding, entry.embedding) })
    }
    return results.sort((a, b) => b.similarity - a.similarity).slice(0, topK)
  }

  add(entry: CacheEntry): void {
    this.entries.set(entry.id, entry)
    const node: ListNode = { id: entry.id, prev: null, next: null }
    this.nodes.set(entry.id, node)
    this.addToFront(node)
    while (this.entries.size > this.maxEntries) {
      this.evictLRU()
    }
  }

  get(id: string): CacheEntry | undefined {
    return this.entries.get(id)
  }

  delete(id: string): boolean {
    const node = this.nodes.get(id)
    if (node) {
      this.removeNode(node)
      this.nodes.delete(id)
    }
    return this.entries.delete(id)
  }

  clear(): void {
    this.entries.clear()
    this.nodes.clear()
    this.head.next = this.tail
    this.tail.prev = this.head
  }

  all(): CacheEntry[] {
    return Array.from(this.entries.values())
  }

  size(): number {
    return this.entries.size
  }

  private removeNode(node: ListNode): void {
    if (node.prev) node.prev.next = node.next
    if (node.next) node.next.prev = node.prev
    node.prev = null
    node.next = null
  }

  private addToFront(node: ListNode): void {
    node.prev = this.head
    node.next = this.head.next
    if (this.head.next) this.head.next.prev = node
    this.head.next = node
  }

  private moveToFront(id: string): void {
    const node = this.nodes.get(id)
    if (!node) return
    this.removeNode(node)
    this.addToFront(node)
  }

  private evictLRU(): void {
    const lru = this.tail.prev
    if (!lru || lru === this.head) return
    this.entries.delete(lru.id)
    this.nodes.delete(lru.id)
    lru.prev!.next = this.tail
    this.tail.prev = lru.prev
  }
}
