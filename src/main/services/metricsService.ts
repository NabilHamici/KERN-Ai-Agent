import { app } from 'electron'
import os from 'node:os'
import {
  MetricsServiceCore,
  spawnBatchProcessStats,
  type ElectronProcessMetric,
  type MetricsServiceDeps
} from './metricsSampling.ts'

export {
  aggregateElectronProcessMetrics,
  buildGroupsPayload,
  classifyElectronProcess,
  computeInstantTokenRate,
  computeSystemCpuPercent,
  emptyGroupTotals,
  mergeExternalPids,
  parseUnixPsOutput,
  parseWindowsPsOutput,
  smoothTokenRate,
  spawnBatchProcessStats,
  sumCpuTimes,
  type CpuTimesSnapshot,
  type ElectronProcessMetric,
  type GroupTotals,
  type MetricsGroupName,
  type MetricsServiceDeps,
  type ProcessCpuRam
} from './metricsSampling.ts'

export class MetricsService extends MetricsServiceCore {
  constructor(emit: (sample: import('../../shared/metrics.ts').MetricsSample) => void, deps?: Partial<MetricsServiceDeps>) {
    const defaults: MetricsServiceDeps = {
      getAppMetrics: () => app.getAppMetrics() as ElectronProcessMetric[],
      getSystemMemoryInfo: () => process.getSystemMemoryInfo(),
      readCpus: () => os.cpus(),
      mainPid: () => process.pid,
      spawnBatchPs: (pids) => spawnBatchProcessStats(pids)
    }
    super(emit, { ...defaults, ...deps })
  }
}
