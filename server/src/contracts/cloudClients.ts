/**
 * Future Electron main-process integration boundaries.
 * Phase 2E prepares contracts only — no network clients or sync engine.
 *
 * These interfaces must never grant the backend filesystem, terminal, or
 * local SQLite write authority. Local SQLite remains authoritative for
 * execution, snapshots, file changes, and agent operations.
 */

export type CloudResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface AuthenticationClient {
  /** Phase 2F: register / login / logout / refresh / revoke. */
  getAccessToken(): Promise<string | null>
  clearSession(): Promise<void>
}

export interface CloudProjectClient {
  listProjects(): Promise<CloudResult<Array<{ id: string; name: string }>>>
  createProject(input: { name: string; description?: string }): Promise<CloudResult<{ id: string }>>
}

export interface CloudChatClient {
  listChats(projectId: string): Promise<CloudResult<Array<{ id: string; title: string }>>>
  upsertChat(input: {
    id: string
    projectId: string
    title: string
    titleIsManual: boolean
    version: number
  }): Promise<CloudResult<{ id: string; version: number }>>
}

export interface SyncClient {
  /**
   * Phase 2G: push/pull account-owned conversation summaries only.
   * Must never upload source code, absolute paths, snapshots, or secrets.
   */
  pushChanges(): Promise<CloudResult<{ accepted: number }>>
  pullChanges(sinceVersion: number): Promise<CloudResult<{ changes: unknown[] }>>
}

/** Placeholder no-op implementations keep desktop offline-capable. */
export class OfflineAuthenticationClient implements AuthenticationClient {
  async getAccessToken(): Promise<string | null> {
    return null
  }

  async clearSession(): Promise<void> {
    return
  }
}

export class OfflineCloudProjectClient implements CloudProjectClient {
  async listProjects(): Promise<CloudResult<Array<{ id: string; name: string }>>> {
    return { ok: false, error: 'Cloud projects are unavailable offline' }
  }

  async createProject(): Promise<CloudResult<{ id: string }>> {
    return { ok: false, error: 'Cloud projects are unavailable offline' }
  }
}

export class OfflineCloudChatClient implements CloudChatClient {
  async listChats(): Promise<CloudResult<Array<{ id: string; title: string }>>> {
    return { ok: false, error: 'Cloud chats are unavailable offline' }
  }

  async upsertChat(): Promise<CloudResult<{ id: string; version: number }>> {
    return { ok: false, error: 'Cloud chats are unavailable offline' }
  }
}

export class OfflineSyncClient implements SyncClient {
  async pushChanges(): Promise<CloudResult<{ accepted: number }>> {
    return { ok: false, error: 'Cloud sync is not implemented yet' }
  }

  async pullChanges(): Promise<CloudResult<{ changes: unknown[] }>> {
    return { ok: false, error: 'Cloud sync is not implemented yet' }
  }
}
