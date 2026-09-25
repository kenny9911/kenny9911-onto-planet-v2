import type { BootstrapResponse, EntityRecord, ResourceKind, SessionInfo } from '../../../packages/platform-contracts/src/index.js';

export type { BootstrapResponse, EntityRecord, ResourceKind, SessionInfo };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, method = 'GET', body?: unknown, csrfToken?: string): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' || !csrfToken ? {} : { 'X-CSRF-Token': csrfToken }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const payload: unknown = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const error = data.error && typeof data.error === 'object' ? data.error as Record<string, unknown> : {};
    const message = typeof error.message === 'string' ? error.message : typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error :
      typeof payload === 'string' && payload ? payload : `Request failed (${response.status})`;
    throw new ApiError(response.status, typeof error.code === 'string' ? error.code : typeof data.code === 'string' ? data.code : 'request_failed', message);
  }
  return payload as T;
}

const segment = (value: string) => encodeURIComponent(value);

export const api = {
  session: () => request<SessionInfo>('/api/session'),
  setupStatus: () => request<{ required: boolean; oidcEnabled?: boolean; setupTokenRequired?: boolean }>('/api/setup'),
  setup: (input: { name: string; email: string; password: string; workspace: string; setupToken?: string }) => request<SessionInfo>('/api/setup', 'POST', input),
  login: (input: { email: string; password: string }) => request<SessionInfo>('/api/login', 'POST', input),
  logout: (csrfToken: string) => request<void>('/api/logout', 'POST', {}, csrfToken),
  bootstrap: () => request<BootstrapResponse>('/api/bootstrap'),
  createResource: (kind: ResourceKind, input: { name: string; data: Record<string, unknown>; state?: string }, csrfToken: string) =>
    request<EntityRecord>(`/api/resources/${segment(kind)}`, 'POST', input, csrfToken),
  updateResource: (kind: ResourceKind, id: string, input: { revision: number; name?: string; data?: Record<string, unknown>; state?: string }, csrfToken: string) =>
    request<EntityRecord>(`/api/resources/${segment(kind)}/${segment(id)}`, 'PUT', input, csrfToken),
  deleteResource: (kind: ResourceKind, id: string, revision: number, csrfToken: string) =>
    request<void>(`/api/resources/${segment(kind)}/${segment(id)}`, 'DELETE', { revision }, csrfToken),
  post: <T>(path: string, body: unknown, csrfToken: string) => request<T>(path, 'POST', body, csrfToken),
  get: <T>(path: string) => request<T>(path),
  tokens: () => request<Array<Record<string, unknown>>>('/api/tokens'),
  createToken: (input: { name: string; scopes: string[] }, csrfToken: string) => request<Record<string, unknown>>('/api/tokens', 'POST', input, csrfToken),
  revokeToken: (id: string, csrfToken: string) => request<{ ok: boolean }>(`/api/tokens/${segment(id)}`, 'DELETE', undefined, csrfToken),
  users: () => request<Array<Record<string, unknown>>>('/api/users'),
  createUser: (input: { name: string; email: string; password: string; role: string }, csrfToken: string) =>
    request<Record<string, unknown>>('/api/users', 'POST', input, csrfToken),
  updateUser: (id: string, input: { role?: string; active?: boolean }, csrfToken: string) =>
    request<Record<string, unknown>>(`/api/users/${segment(id)}`, 'PUT', input, csrfToken),
};
