/**
 * Cloud API base URL used by the Electron main process for auth/session.
 * Cloned developer builds hit production by default.
 * Override locally with KERN_API_URL=http://127.0.0.1:4000 when running the server yourself.
 */
export const DEFAULT_KERN_API_URL = 'https://backup.shedrive-app.com'
