import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessVerification,
  compactLedger,
  limitStopResult,
  normalizeCommandKey,
  reportLedger,
  resolveClaimedCompletion,
  splitProseAndLedger,
  unresolvedFailedCommands,
  type CommandRecord,
  type ProgressSnapshot
} from '../src/main/agent/progress.ts'
import { conversationFromTranscript, splitAssistantReport } from '../src/renderer/src/conversation.ts'
import { buildFinalResult, buildTimeline } from '../src/renderer/src/agent/timeline.ts'
import type { AgentMissionSummary, AgentOperationSummary, AgentToolRecord, AgentTranscript } from '../src/shared/agent.ts'

function mission(patch: Partial<AgentMissionSummary> = {}): AgentMissionSummary {
  return {
    id: 'm-current',
    chatId: 'chat-1',
    title: 'Mission',
    prompt: 'fix types',
    status: 'completed',
    iteration: 4,
    toolCalls: 6,
    summary: 'Typecheck is green.',
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
    ...patch
  }
}

function tool(
  callId: string,
  name: string,
  state: AgentToolRecord['state'],
  argumentsText: string,
  output: string,
  createdAt?: string
): AgentToolRecord {
  return { callId, name, state, argumentsText, output, createdAt }
}

function run(
  callId: string,
  args: string[],
  exitCode: number | null,
  state: AgentToolRecord['state'],
  createdAt: string,
  extra: Record<string, unknown> = {}
): AgentToolRecord {
  const status = exitCode === 0 ? 'completed' : exitCode === null && state === 'rejected' ? undefined : 'failed'
  const output =
    state === 'rejected' && exitCode === null
      ? JSON.stringify({
          ok: false,
          outcome: 'rejected',
          error: 'Tool arguments were rejected. executable: unrecognized key.'
        })
      : JSON.stringify({
          ok: exitCode === 0,
          outcome: exitCode === 0 ? 'success' : 'failed',
          status,
          command: 'pnpm',
          args,
          workingDirectory: '.',
          exitCode,
          stderr: exitCode === 0 ? '' : 'error TS',
          ...extra
        })
  return tool(
    callId,
    'run_command',
    state,
    JSON.stringify({ command: 'pnpm', args, working_directory: '.', explanation: 'check' }),
    output,
    createdAt
  )
}

function op(
  patch: Partial<AgentOperationSummary> & Pick<AgentOperationSummary, 'id' | 'kind' | 'path' | 'status'>
): AgentOperationSummary {
  return {
    missionId: 'm-current',
    callId: patch.id,
    toPath: null,
    explanation: 'x',
    unifiedDiff: '@@\n-old\n+new\n',
    destructive: false,
    error: null,
    contentFingerprint: 'a',
    sourceOperationId: null,
    createdAt: '2026-01-01T00:01:00.000Z',
    resolvedAt: '2026-01-01T00:01:01.000Z',
    ...patch
  }
}

/** Fixture A: invalid call, tsc fail, edit, tsc fail, edit, tsc pass. */
const fixtureA = {
  mission: mission({ summary: 'All type errors fixed.' }),
  tools: [
    run('bad', ['exec', 'tsc', '--noEmit'], null, 'rejected', '2026-01-01T00:00:10.000Z'),
    run('t1', ['exec', 'tsc', '--noEmit'], 2, 'failed', '2026-01-01T00:00:20.000Z'),
    tool(
      'e1',
      'edit_file',
      'success',
      JSON.stringify({ path: 'expo-env.d.ts', content: 'x', explanation: 'fix' }),
      JSON.stringify({ applied: true }),
      '2026-01-01T00:00:30.000Z'
    ),
    run('t2', ['exec', 'tsc', '--noEmit'], 2, 'failed', '2026-01-01T00:00:40.000Z'),
    tool(
      'e2',
      'edit_file',
      'success',
      JSON.stringify({ path: 'expo-env.d.ts', content: 'y', explanation: 'Fix again' }),
      JSON.stringify({ applied: true }),
      '2026-01-01T00:00:50.000Z'
    ),
    run('t3', ['exec', 'tsc', '--noEmit'], 0, 'success', '2026-01-01T00:01:00.000Z')
  ],
  operations: [
    op({ id: 'e1', kind: 'edit', path: 'expo-env.d.ts', status: 'applied', callId: 'e1', resolvedAt: '2026-01-01T00:00:31.000Z' }),
    op({ id: 'e2', kind: 'edit', path: 'expo-env.d.ts', status: 'applied', callId: 'e2', resolvedAt: '2026-01-01T00:00:51.000Z' })
  ]
}

/** Fixture B: scaffold-ish, install, tsc fail, invalid create, limit. */
const fixtureB = {
  mission: mission({
    id: 'm-limit',
    status: 'partially_completed',
    summary: 'Mission iteration limit reached'
  }),
  tools: [
    run('inst', ['install'], 0, 'success', '2026-01-01T00:00:10.000Z'),
    run('tsc', ['exec', 'tsc', '--noEmit'], 2, 'failed', '2026-01-01T00:00:20.000Z'),
    tool(
      'bad-create',
      'create_file',
      'rejected',
      JSON.stringify({ path: 'x.ts', content: '1' }),
      JSON.stringify({ ok: false, error: 'Tool arguments were rejected. explanation is required.' }),
      '2026-01-01T00:00:30.000Z'
    )
  ],
  operations: [] as AgentOperationSummary[]
}

test('Fixture A: resolved failures yield Completed · Verified with clean not-done', () => {
  const result = buildFinalResult(fixtureA.mission, fixtureA.tools, fixtureA.operations)
  assert.equal(result.status, 'completed_verified')
  assert.equal(result.title, 'Completed · Verified')
  assert.equal(result.notDone.length, 0)
  assert.equal(result.verificationLines.length, 3)
  assert.match(result.verificationLines.join('\n'), /exit 2/)
  assert.match(result.verificationLines.join('\n'), /exit 0/)
  assert.doesNotMatch(result.verification, /exit \?/)
  assert.match(result.done.join(' '), /edited/)
  assert.equal(result.done.some((line) => /2 edited|edited/.test(line)), true)
})

test('Fixture B: limit stop, unresolved tsc once, invalid create not a failed command', () => {
  const result = buildFinalResult(fixtureB.mission, fixtureB.tools, fixtureB.operations)
  assert.equal(result.status, 'stopped_limit')
  assert.equal(result.verified, false)
  assert.equal(result.notDone.length, 1)
  assert.match(result.notDone[0]!, /tsc/)
  assert.equal(result.notDone.some((line) => /explanation is required|create_file/i.test(line)), false)
})

test('Fixture C: mutation after passing verification is Completed (unverified) stale', () => {
  const tools = [
    run('t', ['test'], 0, 'success', '2026-01-01T00:00:10.000Z'),
    tool(
      'e',
      'edit_file',
      'success',
      JSON.stringify({ path: 'a.ts', content: 'z' }),
      JSON.stringify({ applied: true }),
      '2026-01-01T00:00:20.000Z'
    )
  ]
  const operations = [
    op({
      id: 'e',
      kind: 'edit',
      path: 'a.ts',
      status: 'applied',
      callId: 'e',
      resolvedAt: '2026-01-01T00:00:21.000Z'
    })
  ]
  const result = buildFinalResult(mission({ summary: 'Done.' }), tools, operations)
  assert.equal(result.status, 'completed_unverified')
  assert.equal(result.staleVerification, true)
  assert.match(result.verification, /stale/i)
})

test('status table: resolved / unresolved / cancelled / limit', () => {
  const cases: Array<{
    name: string
    commands: CommandRecord[]
    lastMutationSequence?: number
    claimed?: 'completed'
    expectStatus: string
  }> = [
    {
      name: 'resolved failure then pass',
      commands: [
        { label: 'pnpm exec tsc --noEmit', status: 'failed', kind: 'executed', exitCode: 2, sequence: 1, cwd: '.' },
        { label: 'pnpm exec tsc --noEmit', status: 'completed', kind: 'executed', exitCode: 0, sequence: 3, cwd: '.' }
      ],
      lastMutationSequence: 2,
      expectStatus: 'completed'
    },
    {
      name: 'unresolved failure',
      commands: [{ label: 'pnpm exec tsc --noEmit', status: 'failed', kind: 'executed', exitCode: 2, sequence: 1, cwd: '.' }],
      expectStatus: 'partially_completed'
    },
    {
      name: 'stale verification',
      commands: [{ label: 'npm test', status: 'completed', kind: 'executed', exitCode: 0, sequence: 1, cwd: '.' }],
      lastMutationSequence: 5,
      expectStatus: 'completed'
    },
    {
      name: 'invalid calls ignored',
      commands: [
        { label: 'command', status: 'invalid_call', kind: 'invalid_call', sequence: 1 },
        { label: 'npm test', status: 'completed', kind: 'executed', exitCode: 0, sequence: 2, cwd: '.' }
      ],
      expectStatus: 'completed'
    }
  ]

  for (const item of cases) {
    const snapshot: ProgressSnapshot = {
      proposed: [],
      approvedOrApplied: [],
      applied: item.name.includes('stale') ? ['a.ts'] : [],
      failed: [],
      rejected: [],
      awaitingApproval: [],
      pendingDeletions: [],
      cancelled: [],
      verifiedReads: item.name.includes('stale') ? ['a.ts'] : [],
      commands: item.commands,
      lastMutationSequence: item.lastMutationSequence
    }
    if (item.expectStatus === 'partially_completed') {
      const resolved = resolveClaimedCompletion({ outcome: 'completed', summary: 'Done.' }, snapshot)
      assert.equal(resolved.status, 'partially_completed', item.name)
      assert.equal(unresolvedFailedCommands(item.commands).length > 0, true, item.name)
    } else {
      const resolved = resolveClaimedCompletion({ outcome: 'completed', summary: 'Done.' }, snapshot)
      assert.equal(resolved.status, 'completed', item.name)
      const assessment = assessVerification(item.commands, item.lastMutationSequence)
      if (item.name.includes('stale')) {
        assert.equal(assessment.stale, true, item.name)
        assert.equal(assessment.verified, false, item.name)
      }
    }
  }

  const limit = limitStopResult(
    {
      proposed: [],
      approvedOrApplied: [],
      applied: [],
      failed: [],
      rejected: [],
      awaitingApproval: [],
      pendingDeletions: [],
      cancelled: [],
      verifiedReads: [],
      commands: [{ label: 'pnpm exec tsc --noEmit', status: 'failed', kind: 'executed', exitCode: 2, sequence: 1 }],
      exploredPaths: []
    },
    'Mission iteration limit reached'
  )
  assert.equal(limit.status, 'partially_completed')
  assert.doesNotMatch(limit.summary, /Discovered during exploration/)
})

test('Chat rendering strips ledger headers; legacy dump goes to report details', () => {
  const dump = [
    'Scaffold finished.',
    'Proposed this mission: (none)',
    'Applied this mission: app.json',
    'Discovered during exploration: a, b, c',
    'Note: reading a file after writing confirms the write only.'
  ].join('\n')
  const split = splitAssistantReport(dump)
  assert.equal(split.prose, 'Scaffold finished.')
  assert.ok(split.ledger)
  assert.match(split.ledger!, /Discovered during exploration/)

  const transcript: AgentTranscript = {
    mission: mission({ summary: dump }),
    messages: [{ role: 'assistant', content: dump }],
    tools: [],
    operations: []
  }
  const entries = conversationFromTranscript(transcript)
  const assistant = entries.find((entry) => entry.role === 'assistant')
  assert.ok(assistant)
  assert.doesNotMatch(assistant!.content, /Discovered during exploration/)
  assert.doesNotMatch(assistant!.content, /Proposed this mission/)
  assert.match(assistant!.content, /Scaffold finished/)
})

test('model compact ledger never includes discovered paths and stays bounded', () => {
  const explored = Array.from({ length: 70 }, (_, index) => `src/f${index}.ts`)
  const snapshot: ProgressSnapshot = {
    proposed: [],
    approvedOrApplied: [],
    applied: ['expo-env.d.ts'],
    failed: [],
    rejected: [],
    awaitingApproval: [],
    pendingDeletions: [],
    cancelled: [],
    verifiedReads: ['expo-env.d.ts'],
    commands: [{ label: 'pnpm exec tsc --noEmit', status: 'completed', kind: 'executed', exitCode: 0, sequence: 2 }],
    exploredPaths: explored,
    lastMutationSequence: 1
  }
  const compact = compactLedger(snapshot)
  assert.doesNotMatch(compact, /Discovered during exploration:/)
  assert.match(compact, /Exploration covered 70 path/)
  assert.ok(compact.length < 2_000)
  const full = reportLedger(snapshot)
  assert.match(full, /Discovered during exploration:/)
  // Prompt size must not grow linearly with discovered path count in the model-bound compact form.
  const few = compactLedger({ ...snapshot, exploredPaths: explored.slice(0, 5) })
  assert.ok(Math.abs(compact.length - few.length) < 80)
})

test('cross-mission isolation: earlier restore failure never appears in current report', () => {
  const earlier: AgentOperationSummary = op({
    id: 'old',
    missionId: 'm-old',
    kind: 'restore',
    path: 'package.json',
    status: 'failed',
    error: 'The file changed after this operation. Restore refused',
    callId: 'old'
  })
  const currentOps = [
    op({ id: 'e1', kind: 'edit', path: 'expo-env.d.ts', status: 'applied', callId: 'e1' }),
    op({ id: 'e2', kind: 'edit', path: 'expo-env.d.ts', status: 'applied', callId: 'e2' })
  ]
  const mixed = [...currentOps, earlier]
  const result = buildFinalResult(fixtureA.mission, fixtureA.tools, mixed)
  assert.equal(result.notDone.some((line) => /Restore refused|package\.json/i.test(line)), false)
  assert.equal(result.done.some((line) => /10 file|create ×/i.test(line)), false)
  assert.match(result.done.join(' '), /edited/)
})

test('normalizeCommandKey treats whitespace equivalents as the same command', () => {
  assert.equal(
    normalizeCommandKey('pnpm  exec tsc --noEmit', '.'),
    normalizeCommandKey('pnpm exec tsc --noEmit', '.')
  )
})

test('timeline FinalResult for fixture A matches card expectations', () => {
  const items = buildTimeline({
    messages: [
      { key: 'u', role: 'user', content: 'fix types', streaming: false, activities: [] },
      {
        key: 'a',
        role: 'assistant',
        content: 'All type errors fixed.',
        streaming: false,
        activities: fixtureA.tools.map((item, index) => ({
          key: `t${index}`,
          callId: item.callId,
          name: item.name,
          detail: '',
          state: item.state === 'success' ? 'completed' : item.state === 'failed' ? 'failed' : 'rejected'
        }))
      }
    ],
    tools: fixtureA.tools,
    operations: fixtureA.operations,
    mission: fixtureA.mission
  })
  const final = items.find((item) => item.kind === 'final_result')
  assert.ok(final && final.kind === 'final_result')
  assert.equal(final.result.status, 'completed_verified')
  assert.equal(final.result.notDone.length, 0)
})

test('splitProseAndLedger separates claim from dump', () => {
  const text = 'Fixed the types.\nApplied this mission: a.ts\nCommands: tsc (completed)'
  const split = splitProseAndLedger(text)
  assert.equal(split.prose, 'Fixed the types.')
  assert.ok(split.ledger)
})
