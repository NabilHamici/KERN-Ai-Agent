import { spawn } from 'node:child_process'
import os from 'node:os'
import {
  ema,
  estimateTokensFromChars,
  metricsSampleSchema,
  normalizeCpuPercent,
  type MetricsSample
} from '../../shared/metrics.ts'

export type MetricsGroupName = 'ui' | 'agent' | 'commands' | 'terminals' | 'other'

const GROUP_ORDER: MetricsGroupName[] = ['ui', 'agent', 'commands', 'terminals', 'other']

export type ProcessCpuRam = {
  cpuPct: number | null
  ramBytes: number | null
}

export type GroupTotals = Record<MetricsGroupName, ProcessCpuRam>

export type CpuTimesSnapshot = {
  idle: number
  total: number
}

export type ElectronProcessMetric = {
  pid: number
  type: string
  cpu: { percentCPUUsage: number }
  memory: { workingSetSize: number }
}

export function emptyGroupTotals(): GroupTotals {
  return {
    ui: { cpuPct: 0, ramBytes: 0 },
    agent: { cpuPct: 0, ramBytes: 0 },
    commands: { cpuPct: 0, ramBytes: 0 },
    terminals: { cpuPct: 0, ramBytes: 0 },
    other: { cpuPct: 0, ramBytes: 0 }
  }
}

export function sumCpuTimes(cpus: os.CpuInfo[]): CpuTimesSnapshot {
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const times = cpu.times
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

/** System-wide CPU% from consecutive `os.cpus()` snapshots (handles counter reset). */
export function computeSystemCpuPercent(
  previous: CpuTimesSnapshot | null,
  current: CpuTimesSnapshot
): number | null {
  if (!previous) return null
  const idleDelta = current.idle - previous.idle
  const totalDelta = current.total - previous.total
  if (totalDelta <= 0 || idleDelta < 0) return null
  const busy = 1 - idleDelta / totalDelta
  return Math.max(0, Math.min(100, busy * 100))
}

export function classifyElectronProcess(processType: string, pid: number, mainPid: number): MetricsGroupName {
  if (pid === mainPid) return 'agent'
  const type = processType.toLowerCase()
  if (type === 'browser' || type === 'gpu' || type === 'tab') return 'ui'
  if (type === 'utility') return 'agent'
  return 'other'
}

function addProcessCpuRam(target: ProcessCpuRam, cpuPct: number | null, ramBytes: number | null): void {
  if (cpuPct !== null && Number.isFinite(cpuPct)) {
    const next = (target.cpuPct ?? 0) + cpuPct
    target.cpuPct = Math.min(100, next)
  }
  if (ramBytes !== null && Number.isFinite(ramBytes)) {
    target.ramBytes = (target.ramBytes ?? 0) + Math.max(0, ramBytes)
  }
}

export function aggregateElectronProcessMetrics(
  metrics: ElectronProcessMetric[],
  mainPid: number,
  coreCount: number
): { tree: ProcessCpuRam; groups: GroupTotals } {
  const groups = emptyGroupTotals()
  const tree: ProcessCpuRam = { cpuPct: 0, ramBytes: 0 }
  for (const item of metrics) {
    const cpuRaw = item.cpu?.percentCPUUsage
    const cpuPct =
      cpuRaw !== undefined && Number.isFinite(cpuRaw) ? normalizeCpuPercent(cpuRaw, coreCount) : null
    const wsKb = item.memory?.workingSetSize
    const ramBytes =
      wsKb !== undefined && Number.isFinite(wsKb) ? Math.max(0, Math.round(wsKb * 1024)) : null
    const group = classifyElectronProcess(item.type ?? '', item.pid, mainPid)
    addProcessCpuRam(tree, cpuPct, ramBytes)
    addProcessCpuRam(groups[group], cpuPct, ramBytes)
  }
  return { tree, groups }
}

export function parseUnixPsOutput(output: string, coreCount: number): Map<number, ProcessCpuRam> {
  const byPid = new Map<number, ProcessCpuRam>()
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const pcpu = Number(parts[1])
    const rssKb = Number(parts[2])
    if (!Number.isFinite(pid)) continue
    byPid.set(pid, {
      cpuPct: Number.isFinite(pcpu) ? normalizeCpuPercent(pcpu, coreCount) : null,
      ramBytes: Number.isFinite(rssKb) ? Math.max(0, Math.round(rssKb * 1024)) : null
    })
  }
  return byPid
}

export function parseWindowsPsOutput(output: string, coreCount: number): Map<number, ProcessCpuRam> {
  const byPid = new Map<number, ProcessCpuRam>()
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const pcpu = Number(parts[1])
    const workingSet = Number(parts[2])
    if (!Number.isFinite(pid)) continue
    byPid.set(pid, {
      cpuPct: Number.isFinite(pcpu) ? normalizeCpuPercent(pcpu, coreCount) : null,
      ramBytes: Number.isFinite(workingSet) ? Math.max(0, Math.round(workingSet)) : null
    })
  }
  return byPid
}

export function mergeExternalPids(
  groups: GroupTotals,
  tree: ProcessCpuRam,
  byPid: Map<number, ProcessCpuRam>,
  commandPids: Iterable<number>,
  terminalPids: Iterable<number>
): void {
  for (const pid of commandPids) {
    const sample = byPid.get(pid)
    if (!sample) continue
    addProcessCpuRam(tree, sample.cpuPct, sample.ramBytes)
    addProcessCpuRam(groups.commands, sample.cpuPct, sample.ramBytes)
  }
  for (const pid of terminalPids) {
    const sample = byPid.get(pid)
    if (!sample) continue
    addProcessCpuRam(tree, sample.cpuPct, sample.ramBytes)
    addProcessCpuRam(groups.terminals, sample.cpuPct, sample.ramBytes)
  }
}

export function buildGroupsPayload(groups: GroupTotals): MetricsSample['groups'] {
  return GROUP_ORDER.map((name) => ({
    name,
    cpuPct: groups[name].cpuPct,
    ramBytes: groups[name].ramBytes
  }))
}

export function computeInstantTokenRate(
  previousTotal: number,
  previousTs: number,
  nextTotal: number,
  nextTs: number
): number | null {
  const deltaMs = nextTs - previousTs
  if (deltaMs <= 0) return null
  const deltaTokens = nextTotal - previousTotal
  if (deltaTokens < 0) return null
  return (deltaTokens * 1000) / deltaMs
}

export function smoothTokenRate(previousEma: number | null, instant: number | null, alpha = 0.35): number | null {
  if (instant === null || !Number.isFinite(instant)) return previousEma
  return ema(previousEma, instant, alpha)
}

export type MetricsServiceDeps = {
  getAppMetrics: () => ElectronProcessMetric[]
  getSystemMemoryInfo: () => { total: number; free: number }
  readCpus: () => os.CpuInfo[]
  mainPid: () => number
  spawnBatchPs: (pids: number[]) => Promise<Map<number, ProcessCpuRam>>
}

const FAST_MS = 1000
const SLOW_MS = 5000

export class MetricsServiceCore {
  private readonly emit: (sample: MetricsSample) => void
  private readonly deps: MetricsServiceDeps
  private readonly commandPids = new Set<number>()
  private readonly terminalPids = new Set<number>()
  private subscribed = false
  private visible = false
  private focused = true
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private lastCpuSnapshot: CpuTimesSnapshot | null = null
  private inTotal: number | null = null
  private outTotal: number | null = null
  private estimated = false
  private model: string | null = null
  private tpsEma: number | null = null
  private lastTokenTotal: number | null = null
  private lastTokenTs: number | null = null
  private unavailableReason: string | null = null

  constructor(emit: (sample: MetricsSample) => void, deps: MetricsServiceDeps) {
    this.emit = emit
    this.deps = deps
  }

  subscribe(input: { visible: boolean }): void {
    this.subscribed = true
    this.visible = input.visible
    this.reschedule()
  }

  unsubscribe(): void {
    this.subscribed = false
    this.stopTimer()
  }

  setFocused(focused: boolean): void {
    this.focused = focused
    if (this.subscribed) {
      this.reschedule()
    }
  }

  trackCommandPid(pid: number): void {
    if (Number.isFinite(pid) && pid > 0) {
      this.commandPids.add(pid)
    }
  }

  untrackCommandPid(pid: number): void {
    this.commandPids.delete(pid)
  }

  trackTerminalPid(pid: number): void {
    if (Number.isFinite(pid) && pid > 0) {
      this.terminalPids.add(pid)
    }
  }

  untrackTerminalPid(pid: number): void {
    this.terminalPids.delete(pid)
  }

  recordTokenUsage(usage: { input?: number; output?: number; model?: string | null }): void {
    const ts = Date.now()
    let bumped = false
    if (usage.input !== undefined && Number.isFinite(usage.input)) {
      this.inTotal = Math.max(0, Math.round(usage.input))
      this.estimated = false
    }
    if (usage.output !== undefined && Number.isFinite(usage.output)) {
      this.outTotal = Math.max(0, Math.round(usage.output))
      this.estimated = false
      bumped = true
    }
    if (usage.model) {
      this.model = usage.model
    }
    if (bumped) {
      this.applyTokenRateBump(this.totalOutTokens(), ts)
    }
  }

  recordStreamChars(chars: number): void {
    if (!Number.isFinite(chars) || chars <= 0) return
    const ts = Date.now()
    if (this.outTotal === null || this.estimated) {
      const add = estimateTokensFromChars(chars)
      this.outTotal = (this.outTotal ?? 0) + add
      this.estimated = true
      this.applyTokenRateBump(this.totalOutTokens(), ts)
    }
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.commandPids.clear()
    this.terminalPids.clear()
  }

  private totalOutTokens(): number {
    return this.outTotal ?? 0
  }

  private applyTokenRateBump(total: number, ts: number): void {
    if (this.lastTokenTotal !== null && this.lastTokenTs !== null) {
      const instant = computeInstantTokenRate(this.lastTokenTotal, this.lastTokenTs, total, ts)
      this.tpsEma = smoothTokenRate(this.tpsEma, instant)
    }
    this.lastTokenTotal = total
    this.lastTokenTs = ts
  }

  private stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private sampleIntervalMs(): number | null {
    if (!this.subscribed || !this.visible) return null
    return this.focused ? FAST_MS : SLOW_MS
  }

  private reschedule(): void {
    this.stopTimer()
    if (this.disposed) return
    const interval = this.sampleIntervalMs()
    if (interval === null) return
    this.timer = setTimeout(() => void this.tick(), interval)
  }

  private async tick(): Promise<void> {
    if (this.disposed || !this.subscribed) return
    try {
      const sample = await this.collectSample()
      const parsed = metricsSampleSchema.parse(sample)
      this.emit(parsed)
    } catch {
      // Sampling failures are surfaced on the next sample via unavailableReason.
    }
    this.reschedule()
  }

  private async collectSample(): Promise<MetricsSample> {
    const ts = Date.now()
    const coreCount = Math.max(1, this.deps.readCpus().length)
    const cpuNow = sumCpuTimes(this.deps.readCpus())
    const systemCpuPct = computeSystemCpuPercent(this.lastCpuSnapshot, cpuNow)
    this.lastCpuSnapshot = cpuNow

    let tree: ProcessCpuRam = { cpuPct: null, ramBytes: null }
    let groups = emptyGroupTotals()
    this.unavailableReason = null

    try {
      const electronMetrics = this.deps.getAppMetrics()
      const aggregated = aggregateElectronProcessMetrics(electronMetrics, this.deps.mainPid(), coreCount)
      tree = aggregated.tree
      groups = aggregated.groups
    } catch (error) {
      this.unavailableReason = error instanceof Error ? error.message : 'app metrics unavailable'
    }

    const externalPids = [...this.commandPids, ...this.terminalPids]
    if (externalPids.length > 0) {
      try {
        const byPid = await this.deps.spawnBatchPs(externalPids)
        mergeExternalPids(groups, tree, byPid, this.commandPids, this.terminalPids)
      } catch (error) {
        if (!this.unavailableReason) {
          this.unavailableReason = error instanceof Error ? error.message : 'process sampling failed'
        }
      }
    }

    let systemUsedBytes: number | null = null
    let systemTotalBytes: number | null = null
    try {
      const mem = this.deps.getSystemMemoryInfo()
      const totalKb = mem.total
      const freeKb = mem.free
      if (Number.isFinite(totalKb) && Number.isFinite(freeKb)) {
        systemTotalBytes = Math.max(0, Math.round(totalKb * 1024))
        const usedKb = Math.max(0, totalKb - freeKb)
        systemUsedBytes = Math.round(usedKb * 1024)
      }
    } catch (error) {
      if (!this.unavailableReason) {
        this.unavailableReason = error instanceof Error ? error.message : 'system memory unavailable'
      }
    }

    return {
      type: 'metrics.sample',
      ts,
      cpuPct: tree.cpuPct,
      ramBytes: tree.ramBytes,
      system: {
        cpuPct: systemCpuPct,
        usedBytes: systemUsedBytes,
        totalBytes: systemTotalBytes
      },
      groups: buildGroupsPayload(groups),
      tokens: {
        tps: this.tpsEma,
        inTotal: this.inTotal,
        outTotal: this.outTotal,
        estimated: this.estimated,
        model: this.model
      },
      unavailableReason: this.unavailableReason
    }
  }
}

export function spawnBatchProcessStats(pids: number[]): Promise<Map<number, ProcessCpuRam>> {
  const unique = [...new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0))]
  if (unique.length === 0) {
    return Promise.resolve(new Map())
  }
  const coreCount = Math.max(1, os.cpus().length)
  if (process.platform === 'win32') {
    return spawnWindowsBatch(unique, coreCount)
  }
  return spawnUnixBatch(unique, coreCount)
}

function spawnUnixBatch(pids: number[], coreCount: number): Promise<Map<number, ProcessCpuRam>> {
  const list = pids.join(',')
  return new Promise((resolve, reject) => {
    const child = spawn('ps', ['-p', list, '-o', 'pid=', '-o', 'pcpu=', '-o', 'rss='], {
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `ps exited ${code ?? 'unknown'}`))
        return
      }
      resolve(parseUnixPsOutput(stdout, coreCount))
    })
  })
}

function spawnWindowsBatch(pids: number[], coreCount: number): Promise<Map<number, ProcessCpuRam>> {
  const idList = pids.join(',')
  const script = [
    `$ids = @(${idList})`,
    'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |',
    'Where-Object { $ids -contains $_.IDProcess } |',
    'ForEach-Object { "{0} {1} {2}" -f $_.IDProcess, $_.PercentProcessorTime, $_.WorkingSet }'
  ].join(' ')
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `powershell exited ${code ?? 'unknown'}`))
        return
      }
      resolve(parseWindowsPsOutput(stdout, coreCount))
    })
  })
}
