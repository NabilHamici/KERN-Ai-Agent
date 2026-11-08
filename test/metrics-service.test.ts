import assert from 'node:assert/strict'
import test from 'node:test'
import { ema, estimateTokensFromChars, metricsSampleSchema, normalizeCpuPercent } from '../src/shared/metrics.ts'
import {
  aggregateElectronProcessMetrics,
  buildGroupsPayload,
  classifyElectronProcess,
  computeInstantTokenRate,
  computeSystemCpuPercent,
  emptyGroupTotals,
  mergeExternalPids,
  MetricsServiceCore,
  parseUnixPsOutput,
  smoothTokenRate,
  sumCpuTimes,
  type ElectronProcessMetric
} from '../src/main/services/metricsSampling.ts'

test('classifyElectronProcess maps ui, agent host, and other', () => {
  const mainPid = 100
  assert.equal(classifyElectronProcess('Browser', 200, mainPid), 'ui')
  assert.equal(classifyElectronProcess('GPU', 201, mainPid), 'ui')
  assert.equal(classifyElectronProcess('Tab', 202, mainPid), 'ui')
  assert.equal(classifyElectronProcess('Browser', mainPid, mainPid), 'agent')
  assert.equal(classifyElectronProcess('Utility', 203, mainPid), 'agent')
  assert.equal(classifyElectronProcess('Sandbox helper', 204, mainPid), 'other')
})

test('normalizeCpuPercent divides by core count and clamps', () => {
  assert.equal(normalizeCpuPercent(200, 4), 50)
  assert.equal(normalizeCpuPercent(400, 4), 100)
  assert.equal(normalizeCpuPercent(-1, 4), 0)
})

test('aggregateElectronProcessMetrics groups and sums tree totals', () => {
  const metrics: ElectronProcessMetric[] = [
    {
      pid: 10,
      type: 'Browser',
      cpu: { percentCPUUsage: 40 },
      memory: { workingSetSize: 1024 }
    },
    {
      pid: 11,
      type: 'GPU',
      cpu: { percentCPUUsage: 20 },
      memory: { workingSetSize: 512 }
    },
    {
      pid: 12,
      type: 'Utility',
      cpu: { percentCPUUsage: 20 },
      memory: { workingSetSize: 256 }
    }
  ]
  const { tree, groups } = aggregateElectronProcessMetrics(metrics, 10, 2)
  assert.equal(tree.cpuPct, 40)
  assert.equal(tree.ramBytes, (1024 + 512 + 256) * 1024)
  assert.equal(groups.ui.cpuPct, 10)
  assert.equal(groups.agent.cpuPct, 30)
  assert.equal(groups.commands.cpuPct, 0)
})

test('parseUnixPsOutput normalizes per process', () => {
  const map = parseUnixPsOutput('  42  80.0  2048\n  43  40.0  1024\n', 4)
  assert.equal(map.get(42)?.cpuPct, 20)
  assert.equal(map.get(42)?.ramBytes, 2048 * 1024)
  assert.equal(map.get(43)?.cpuPct, 10)
})

test('mergeExternalPids adds command and terminal buckets', () => {
  const groups = emptyGroupTotals()
  const tree = { cpuPct: 0, ramBytes: 0 }
  const byPid = new Map([
    [900, { cpuPct: 5, ramBytes: 1000 }],
    [901, { cpuPct: 3, ramBytes: 500 }]
  ])
  mergeExternalPids(groups, tree, byPid, [900], [901])
  assert.equal(groups.commands.cpuPct, 5)
  assert.equal(groups.terminals.cpuPct, 3)
  assert.equal(tree.cpuPct, 8)
})

test('computeSystemCpuPercent uses cpu time deltas and rejects wrap', () => {
  const prev = { idle: 40, total: 100 }
  const next = { idle: 50, total: 200 }
  assert.equal(computeSystemCpuPercent(prev, next), 90)
  assert.equal(computeSystemCpuPercent(next, prev), null)
})

test('sumCpuTimes aggregates os cpu counters', () => {
  const snapshot = sumCpuTimes([
    {
      model: 'x',
      speed: 0,
      times: { user: 10, nice: 0, sys: 5, idle: 20, irq: 1 }
    },
    {
      model: 'x',
      speed: 0,
      times: { user: 8, nice: 0, sys: 4, idle: 12, irq: 0 }
    }
  ])
  assert.equal(snapshot.idle, 32)
  assert.equal(snapshot.total, 60)
})

test('token rate EMA smooths bursts', () => {
  assert.equal(ema(null, 100), 100)
  const smoothed = ema(100, 0, 0.5)
  assert.equal(smoothed, 50)
  const instant = computeInstantTokenRate(0, 0, 10, 1000)
  assert.equal(instant, 10)
  const rate = smoothTokenRate(null, instant)
  assert.equal(rate, 10)
  const next = smoothTokenRate(rate, 20)
  assert.ok(next !== null && next > 10 && next < 20)
})

test('estimateTokensFromChars uses chars/4 rounding', () => {
  assert.equal(estimateTokensFromChars(0), 0)
  assert.equal(estimateTokensFromChars(7), 2)
  assert.equal(estimateTokensFromChars(100), 25)
})

test('buildGroupsPayload matches schema group order', () => {
  const groups = emptyGroupTotals()
  groups.ui.cpuPct = 1
  const payload = buildGroupsPayload(groups)
  assert.deepEqual(
    payload.map((g) => g.name),
    ['ui', 'agent', 'commands', 'terminals', 'other']
  )
})

test('metrics sample from MetricsService validates against zod schema', async () => {
  let captured: unknown = null
  const service = new MetricsServiceCore((sample) => {
    captured = sample
  }, {
    getAppMetrics: () => [
      {
        pid: 1,
        type: 'Browser',
        cpu: { percentCPUUsage: 10 },
        memory: { workingSetSize: 128 }
      }
    ],
    getSystemMemoryInfo: () => ({ total: 16_384, free: 4096 }),
    readCpus: () => [
      {
        model: 'cpu',
        speed: 2400,
        times: { user: 1, nice: 0, sys: 1, idle: 8, irq: 0 }
      }
    ],
    mainPid: () => 1,
    spawnBatchPs: async () => new Map()
  })

  service.recordTokenUsage({ input: 5, output: 12, model: 'test-model' })
  service.subscribe({ visible: true })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  service.dispose()

  assert.notEqual(captured, null)
  const parsed = metricsSampleSchema.parse(captured)
  assert.equal(parsed.type, 'metrics.sample')
  assert.equal(parsed.tokens.model, 'test-model')
  assert.equal(parsed.tokens.inTotal, 5)
  assert.equal(parsed.tokens.outTotal, 12)
  assert.equal(parsed.tokens.estimated, false)
})

test('hidden subscription does not sample until visible', async () => {
  let count = 0
  const service = new MetricsServiceCore(() => {
    count += 1
  }, {
    getAppMetrics: () => [],
    getSystemMemoryInfo: () => ({ total: 1024, free: 512 }),
    readCpus: () => [
      {
        model: 'cpu',
        speed: 0,
        times: { user: 0, nice: 0, sys: 0, idle: 1, irq: 0 }
      }
    ],
    mainPid: () => process.pid,
    spawnBatchPs: async () => new Map()
  })

  service.subscribe({ visible: false })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.equal(count, 0)
  service.dispose()
})

test('recordStreamChars marks estimated output tokens', async () => {
  let captured: unknown = null
  const service = new MetricsServiceCore((sample) => {
    captured = sample
  }, {
    getAppMetrics: () => [],
    getSystemMemoryInfo: () => ({ total: 1024, free: 512 }),
    readCpus: () => [
      {
        model: 'cpu',
        speed: 0,
        times: { user: 0, nice: 0, sys: 0, idle: 1, irq: 0 }
      }
    ],
    mainPid: () => process.pid,
    spawnBatchPs: async () => new Map()
  })

  service.recordStreamChars(40)
  service.recordStreamChars(40)
  service.subscribe({ visible: true })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  service.dispose()

  const parsed = metricsSampleSchema.parse(captured)
  assert.equal(parsed.tokens.estimated, true)
  assert.equal(parsed.tokens.outTotal, estimateTokensFromChars(80))
})
