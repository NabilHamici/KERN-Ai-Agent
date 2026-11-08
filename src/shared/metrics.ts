import { z } from 'zod'

export const metricsSampleSchema = z.strictObject({
  type: z.literal('metrics.sample'),
  ts: z.number().int().nonnegative(),
  cpuPct: z.number().nullable(),
  ramBytes: z.number().nullable(),
  system: z.strictObject({
    cpuPct: z.number().nullable(),
    usedBytes: z.number().nullable(),
    totalBytes: z.number().nullable()
  }),
  groups: z.array(
    z.strictObject({
      name: z.enum(['ui', 'agent', 'commands', 'terminals', 'other']),
      cpuPct: z.number().nullable(),
      ramBytes: z.number().nullable()
    })
  ),
  tokens: z.strictObject({
    tps: z.number().nullable(),
    inTotal: z.number().nullable(),
    outTotal: z.number().nullable(),
    estimated: z.boolean(),
    model: z.string().nullable().optional()
  }),
  unavailableReason: z.string().nullable().optional()
})

export type MetricsSample = z.infer<typeof metricsSampleSchema>

export const metricsSubscribeSchema = z.strictObject({
  visible: z.boolean()
})

/** Exponential moving average for token rate smoothing. */
export function ema(previous: number | null, next: number, alpha = 0.35): number {
  if (previous === null || Number.isNaN(previous)) return next
  return previous * (1 - alpha) + next * alpha
}

/** Rough token estimate from streamed characters when provider usage is absent. */
export function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.round(chars / 4))
}

export function normalizeCpuPercent(rawPercent: number, coreCount: number): number {
  if (!Number.isFinite(rawPercent) || coreCount <= 0) return 0
  // Electron getAppMetrics cpu.percentCPUUsage is already % of one core-ish; clamp to 0–100 of machine.
  return Math.max(0, Math.min(100, rawPercent / coreCount))
}
