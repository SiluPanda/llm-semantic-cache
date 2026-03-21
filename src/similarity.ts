import type { PromptInput } from './types.js'

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export function l2Normalize(vec: number[]): Float32Array {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
  return new Float32Array(norm === 0 ? vec : vec.map(v => v / norm))
}

export function promptToString(prompt: PromptInput): string {
  if (typeof prompt === 'string') return prompt
  return prompt
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')
}
