import { randomUUID } from 'node:crypto'

export function createCorrelationId(): string {
  return randomUUID()
}

export function createPagination(query: { cursor?: string; limit?: number }): { cursor: string | null; limit: number } {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100)
  return {
    cursor: query.cursor ?? null,
    limit
  }
}
