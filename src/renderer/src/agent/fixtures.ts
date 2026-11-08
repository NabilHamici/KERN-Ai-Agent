import type { AgentMissionSummary, AgentOperationSummary, AgentToolRecord } from '../../../shared/agent.ts'
import type { ConversationEntry } from '../conversation.ts'

function mission(patch: Partial<AgentMissionSummary>): AgentMissionSummary {
  return {
    id: 'm1',
    chatId: 'c1',
    title: 'Mission',
    prompt: 'Do the work',
    status: 'completed',
    iteration: 3,
    toolCalls: 4,
    summary: 'Done.',
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    ...patch
  }
}

function tool(
  callId: string,
  name: string,
  state: AgentToolRecord['state'],
  argumentsText: string,
  output = ''
): AgentToolRecord {
  return {
    callId,
    name,
    state,
    argumentsText,
    output,
    createdAt: '2026-01-01T00:00:10.000Z'
  }
}

export const fixtureExpoPartial = {
  messages: [
    { key: 'u1', role: 'user' as const, content: 'generate a new react native project', streaming: false, activities: [] },
    {
      key: 'a1',
      role: 'assistant' as const,
      content: 'Scaffolding the project.',
      streaming: false,
      activities: [
        { key: 't1', callId: 'list', name: 'list_files', detail: '.', state: 'completed' as const },
        { key: 't2', callId: 'create-reject', name: 'create_file', detail: 'app.json', state: 'rejected' as const },
        { key: 't3', callId: 'create-ok', name: 'create_file', detail: 'app.json', state: 'completed' as const },
        { key: 't4', callId: 'cmd-help', name: 'run_command', detail: 'npx create-expo --help', state: 'completed' as const },
        { key: 't5', callId: 'cmd-scaffold', name: 'run_command', detail: 'npx create-expo-app', state: 'completed' as const },
        { key: 't6', callId: 'cmd-install', name: 'run_command', detail: 'pnpm install', state: 'completed' as const },
        { key: 't7', callId: 'cmd-tsc', name: 'run_command', detail: 'pnpm exec tsc --noEmit', state: 'failed' as const }
      ]
    }
  ] satisfies ConversationEntry[],
  tools: [
    tool('list', 'list_files', 'success', '{"path":"."}', '{"ok":true,"entries":[{"path":"src"}]}'),
    tool(
      'create-reject',
      'create_file',
      'rejected',
      '{"path":"app.json","content":"{}","explanation":"x"}',
      '{"ok":false,"error":"Tool arguments were rejected."}'
    ),
    tool(
      'create-ok',
      'create_file',
      'success',
      '{"path":"app.json","content":"{}","explanation":"x"}',
      '{"ok":true,"applied":true}'
    ),
    tool(
      'cmd-help',
      'run_command',
      'success',
      '{"command":"npx","args":["create-expo","--help"],"explanation":"help","working_directory":"."}',
      '{"status":"completed","exitCode":0,"command":"npx","args":["create-expo","--help"],"stdout":"Usage"}'
    ),
    tool(
      'cmd-scaffold',
      'run_command',
      'success',
      '{"command":"npx","args":["create-expo-app@latest",".","--yes"],"explanation":"scaffold","working_directory":"."}',
      '{"status":"completed","exitCode":0,"command":"npx","args":["create-expo-app@latest",".","--yes"]}'
    ),
    tool(
      'cmd-install',
      'run_command',
      'success',
      '{"command":"pnpm","args":["install"],"explanation":"install","working_directory":"."}',
      '{"status":"completed","exitCode":0,"command":"pnpm","args":["install"]}'
    ),
    tool(
      'cmd-tsc',
      'run_command',
      'failed',
      '{"command":"pnpm","args":["exec","tsc","--noEmit"],"explanation":"typecheck","working_directory":"."}',
      '{"status":"failed","exitCode":2,"command":"pnpm","args":["exec","tsc","--noEmit"],"stderr":"error TS2304: Cannot find name"}'
    )
  ],
  operations: [
    {
      id: 'op1',
      missionId: 'm1',
      callId: 'create-ok',
      kind: 'create' as const,
      path: 'app.json',
      toPath: null,
      explanation: 'x',
      status: 'applied' as const,
      unifiedDiff: '',
      destructive: false,
      error: null,
      contentFingerprint: 'a',
      sourceOperationId: null,
      createdAt: '',
      resolvedAt: ''
    }
  ] satisfies AgentOperationSummary[],
  mission: mission({
    status: 'partially_completed',
    summary: 'Project created and dependencies installed.\nTypecheck still fails.',
    title: 'Expo scaffold'
  })
}

export const fixtureVerifiedSuccess = {
  messages: [
    { key: 'u1', role: 'user' as const, content: 'Add a hello file', streaming: false, activities: [] },
    {
      key: 'a1',
      role: 'assistant' as const,
      content: 'Created hello.txt',
      streaming: false,
      activities: [{ key: 't1', callId: 'c1', name: 'create_file', detail: 'hello.txt', state: 'completed' as const }]
    }
  ] satisfies ConversationEntry[],
  tools: [
    tool('c1', 'create_file', 'success', '{"path":"hello.txt","content":"hi","explanation":"x"}', '{"applied":true}'),
    tool(
      'v1',
      'run_command',
      'success',
      '{"command":"npm","args":["test"],"explanation":"verify","working_directory":"."}',
      '{"status":"completed","exitCode":0,"command":"npm","args":["test"]}'
    )
  ],
  operations: [] as AgentOperationSummary[],
  mission: mission({ status: 'completed', summary: 'Created hello.txt and verified with npm test.' })
}

export const fixtureFailedInstall = {
  messages: [
    { key: 'u1', role: 'user' as const, content: 'install deps', streaming: false, activities: [] },
    { key: 'a1', role: 'assistant' as const, content: 'Installing.', streaming: false, activities: [] }
  ] satisfies ConversationEntry[],
  tools: [
    tool(
      'i1',
      'run_command',
      'failed',
      '{"command":"npm","args":["install"],"explanation":"install","working_directory":"."}',
      '{"status":"failed","exitCode":1,"command":"npm","args":["install"],"stderr":"npm error ENOSPC: no space left on device","warnings":["Network/registry error text appears in command output."]}'
    )
  ],
  operations: [] as AgentOperationSummary[],
  mission: mission({
    status: 'failed',
    summary: 'npm install failed',
    error: 'Command exited with code 1.'
  })
}

export const fixtureAwaitingApproval = {
  messages: [
    { key: 'u1', role: 'user' as const, content: 'delete notes', streaming: false, activities: [] }
  ] satisfies ConversationEntry[],
  tools: [tool('d1', 'delete_file', 'awaiting_approval', '{"path":"notes.txt","explanation":"remove"}', '{}')],
  operations: [
    {
      id: 'del1',
      missionId: 'm1',
      callId: 'd1',
      kind: 'delete' as const,
      path: 'notes.txt',
      toPath: null,
      explanation: 'remove',
      status: 'pending' as const,
      unifiedDiff: 'Delete proposal: 1 target(s)\nFiles: 1  Directories: 0  Bytes: 4\nTargets:\n- notes.txt (file)',
      destructive: true,
      error: null,
      contentFingerprint: 'x',
      sourceOperationId: null,
      createdAt: '',
      resolvedAt: null
    }
  ] satisfies AgentOperationSummary[],
  mission: mission({ status: 'awaiting_approval', summary: null })
}

export const fixtureCancelled = {
  messages: [{ key: 'u1', role: 'user' as const, content: 'do stuff', streaming: false, activities: [] }],
  tools: [] as AgentToolRecord[],
  operations: [] as AgentOperationSummary[],
  mission: mission({ status: 'cancelled', summary: 'Cancelled by user.' })
}

export function fixtureLargeMission(stepCount = 500): {
  messages: ConversationEntry[]
  tools: AgentToolRecord[]
  operations: AgentOperationSummary[]
  mission: AgentMissionSummary
} {
  const tools = Array.from({ length: stepCount }, (_, index) =>
    tool(`r${index}`, 'read_file', 'success', JSON.stringify({ path: `f${index}.ts` }), '{"ok":true}')
  )
  return {
    messages: [
      { key: 'u1', role: 'user', content: 'inspect everything', streaming: false, activities: [] },
      {
        key: 'a1',
        role: 'assistant',
        content: 'Inspecting.',
        streaming: false,
        activities: tools.map((item, index) => ({
          key: `a-${index}`,
          callId: item.callId,
          name: item.name,
          detail: `f${index}.ts`,
          state: 'completed' as const
        }))
      }
    ],
    tools,
    operations: [],
    mission: mission({ status: 'completed', summary: 'Inspected files.', toolCalls: stepCount })
  }
}

export const fixtureHugeOutput = 'line\n'.repeat(10_000)
