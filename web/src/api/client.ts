import type {
  AuthUserResponse,
  AvatarContentType,
  AvatarResponse,
  CategoriesResponse,
  ChannelPatch,
  ChannelPatchResponse,
  ChannelResponse,
  DashboardResponse,
  FollowResponse,
  FollowingResponse,
  HealthResponse,
  LoginBody,
  MeResponse,
  OverlayResetResponse,
  RestreamCreate,
  RestreamDestinationResponse,
  RestreamPatch,
  RestreamsResponse,
  SearchResponse,
  SessionsResponse,
  StreamKeyResponse,
  StreamsResponse,
  TwoFactorEnableResponse,
  TwoFactorSetup,
  TwoFactorStatus,
  VideoResponse,
  VideosResponse,
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
  413: 'Файл слишком большой.',
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

/** Error codes the UI branches on (see docs/API.md). */
export const ErrorCodes = {
  totpRequired: 'totp_required',
  totpInvalid: 'totp_invalid',
  invalidCredentials: 'invalid_credentials',
  conflict: 'conflict',
  payloadTooLarge: 'payload_too_large',
  validationFailed: 'validation_failed',
} as const;

export function isApiError(err: unknown, code: string): err is ApiError {
  return err instanceof ApiError && err.code === code;
}

export const api = {
  streams: (signal?: AbortSignal, category?: string) =>
    request<StreamsResponse>(category ? `/api/streams?category=${enc(category)}` : '/api/streams', { signal }),
  channel: (slug: string, signal?: AbortSignal) =>
    request<ChannelResponse>(`/api/channels/${enc(slug)}`, { signal }),
  channelEventsUrl: (slug: string) => `/api/channels/${enc(slug)}/events`,
  heartbeat: (slug: string, viewerId: string) =>
    request<void>(`/api/channels/${enc(slug)}/heartbeat`, { method: 'POST', body: { viewerId } }),

  register: (body: { username: string; password: string; displayName?: string }) =>
    request<AuthUserResponse>('/api/auth/register', { method: 'POST', body }),
  login: (body: LoginBody) => request<AuthUserResponse>('/api/auth/login', { method: 'POST', body }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST', body: {} }),
  me: (signal?: AbortSignal) => request<MeResponse>('/api/auth/me', { signal }),

  dashboard: (signal?: AbortSignal) => request<DashboardResponse>('/api/dashboard', { signal }),
  patchChannel: (body: ChannelPatch) =>
    request<ChannelPatchResponse>('/api/channel', { method: 'PATCH', body }),
  resetStreamKey: () =>
    request<StreamKeyResponse>('/api/channel/stream-key', { method: 'POST', body: {} }),

  // ---- v2: follows
  follow: (slug: string) =>
    request<FollowResponse>(`/api/channels/${enc(slug)}/follow`, { method: 'POST', body: {} }),
  unfollow: (slug: string) =>
    request<FollowResponse>(`/api/channels/${enc(slug)}/follow`, { method: 'DELETE', body: {} }),
  following: (signal?: AbortSignal) => request<FollowingResponse>('/api/me/following', { signal }),

  // ---- v2: browse & search
  categories: (signal?: AbortSignal) => request<CategoriesResponse>('/api/categories', { signal }),
  search: (q: string, signal?: AbortSignal) =>
    request<SearchResponse>(`/api/search?q=${enc(q)}`, { signal }),

  // ---- v2: VOD
  channelVideos: (slug: string, signal?: AbortSignal, limit = 20) =>
    request<VideosResponse>(`/api/channels/${enc(slug)}/videos?limit=${limit}`, { signal }),
  video: (id: string, signal?: AbortSignal) => request<VideoResponse>(`/api/videos/${enc(id)}`, { signal }),
  videoView: (id: string, viewerId: string) =>
    request<void>(`/api/videos/${enc(id)}/view`, { method: 'POST', body: { viewerId } }),
  deleteVideo: (id: string) => request<void>(`/api/videos/${enc(id)}`, { method: 'DELETE', body: {} }),

  // ---- v2: multistream
  restreams: (signal?: AbortSignal) => request<RestreamsResponse>('/api/channel/restreams', { signal }),
  createRestream: (body: RestreamCreate) =>
    request<RestreamDestinationResponse>('/api/channel/restreams', { method: 'POST', body }),
  updateRestream: (id: string, body: RestreamPatch) =>
    request<RestreamDestinationResponse>(`/api/channel/restreams/${enc(id)}`, { method: 'PATCH', body }),
  deleteRestream: (id: string) =>
    request<void>(`/api/channel/restreams/${enc(id)}`, { method: 'DELETE', body: {} }),

  // ---- v2: OBS overlay
  overlayEventsUrl: (token: string) => `/api/overlay/${enc(token)}/events`,
  overlayTest: () => request<void>('/api/channel/overlay/test', { method: 'POST', body: {} }),
  overlayReset: () => request<OverlayResetResponse>('/api/channel/overlay/reset', { method: 'POST', body: {} }),

  // ---- v2: profile
  uploadAvatar: (contentType: AvatarContentType, data: string) =>
    request<AvatarResponse>('/api/channel/avatar', { method: 'POST', body: { contentType, data } }),
  deleteAvatar: () => request<void>('/api/channel/avatar', { method: 'DELETE', body: {} }),

  // ---- v2: studio health
  health: (broadcastId?: string, signal?: AbortSignal) =>
    request<HealthResponse>(
      broadcastId ? `/api/dashboard/health?broadcastId=${enc(broadcastId)}` : '/api/dashboard/health',
      { signal },
    ),

  // ---- v2: account security
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    request<void>('/api/me/password', { method: 'POST', body }),
  sessions: (signal?: AbortSignal) => request<SessionsResponse>('/api/me/sessions', { signal }),
  revokeSession: (id: string) => request<void>(`/api/me/sessions/${enc(id)}`, { method: 'DELETE', body: {} }),
  revokeOtherSessions: () => request<void>('/api/me/sessions/revoke-others', { method: 'POST', body: {} }),
  twoFactor: (signal?: AbortSignal) => request<TwoFactorStatus>('/api/me/2fa', { signal }),
  twoFactorSetup: () => request<TwoFactorSetup>('/api/me/2fa/setup', { method: 'POST', body: {} }),
  twoFactorEnable: (code: string) =>
    request<TwoFactorEnableResponse>('/api/me/2fa/enable', { method: 'POST', body: { code } }),
  twoFactorDisable: (body: { password: string; code: string }) =>
    request<void>('/api/me/2fa/disable', { method: 'POST', body }),
};
