import type {
  AuthUserResponse,
  ChannelPatch,
  ChannelPatchResponse,
  ChannelResponse,
  DashboardResponse,
  MeResponse,
  StreamKeyResponse,
  StreamsResponse,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const FALLBACK_MESSAGES: Record<number, string> = {
  400: 'Проверьте введённые данные.',
  401: 'Нужно войти в аккаунт.',
  403: 'Недостаточно прав.',
  404: 'Не найдено.',
  409: 'Конфликт данных.',
  415: 'Сервер не принял формат запроса.',
  429: 'Слишком много запросов. Подождите немного и повторите.',
  500: 'Ошибка на сервере. Повторите попытку позже.',
};

function isErrorBody(value: unknown): value is { error: { code?: unknown; message?: unknown } } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error: unknown }).error === 'object' &&
    (value as { error: unknown }).error !== null
  );
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
};

/**
 * Same-origin JSON request. Mutating methods always send `Content-Type: application/json`
 * (with `{}` when there is no body) — the backend rejects anything else with 415 (CSRF guard).
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' };
  if (opts.signal) init.signal = opts.signal;
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body ?? {});
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Нет связи с сервером. Проверьте подключение.');
  }

  if (res.status === 204) return undefined as T;

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    if (isErrorBody(data)) {
      const code = typeof data.error.code === 'string' ? data.error.code : `http_${res.status}`;
      const message =
        typeof data.error.message === 'string' && data.error.message
          ? data.error.message
          : (FALLBACK_MESSAGES[res.status] ?? `Ошибка ${res.status}`);
      throw new ApiError(res.status, code, message);
    }
    throw new ApiError(
      res.status,
      `http_${res.status}`,
      FALLBACK_MESSAGES[res.status] ?? `Ошибка ${res.status}`,
    );
  }
  return data as T;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return 'Что-то пошло не так.';
}

const enc = encodeURIComponent;

export const api = {
  streams: (signal?: AbortSignal) => request<StreamsResponse>('/api/streams', { signal }),
  channel: (slug: string, signal?: AbortSignal) =>
    request<ChannelResponse>(`/api/channels/${enc(slug)}`, { signal }),
  channelEventsUrl: (slug: string) => `/api/channels/${enc(slug)}/events`,
  heartbeat: (slug: string, viewerId: string) =>
    request<void>(`/api/channels/${enc(slug)}/heartbeat`, { method: 'POST', body: { viewerId } }),

  register: (body: { username: string; password: string; displayName?: string }) =>
    request<AuthUserResponse>('/api/auth/register', { method: 'POST', body }),
  login: (body: { username: string; password: string }) =>
    request<AuthUserResponse>('/api/auth/login', { method: 'POST', body }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST', body: {} }),
  me: (signal?: AbortSignal) => request<MeResponse>('/api/auth/me', { signal }),

  dashboard: (signal?: AbortSignal) => request<DashboardResponse>('/api/dashboard', { signal }),
  patchChannel: (body: ChannelPatch) =>
    request<ChannelPatchResponse>('/api/channel', { method: 'PATCH', body }),
  resetStreamKey: () =>
    request<StreamKeyResponse>('/api/channel/stream-key', { method: 'POST', body: {} }),
};
