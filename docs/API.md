# HTTP API

Все ответы — JSON (`application/json`), кроме SSE и `204`. Ошибки всегда в формате:

```json
{ "error": { "code": "validation_failed", "message": "человекочитаемое описание" } }
```

Коды ошибок: `validation_failed` (400), `unauthorized` (401), `invalid_credentials` (401),
`forbidden` (403), `not_found` (404), `username_taken` (409), `unsupported_media_type` (415),
`rate_limited` (429), `internal` (500).

Аутентификация — HTTP-only cookie `sid` (SameSite=Lax), её выставляют `register`/`login`.
Все изменяющие запросы (`POST`, `PATCH`, `DELETE`) **обязаны** иметь
`Content-Type: application/json` (тело может быть `{}`), иначе `415`. Это часть CSRF-защиты.

Все id сериализуются строками. Время — ISO-8601 UTC.

## Общие типы

```ts
type User = { id: string; username: string; displayName: string; createdAt: string };

type ChannelPublic = {
  slug: string;          // == username, используется в URL /:slug
  displayName: string;
  title: string;         // название текущей/следующей трансляции
  category: string;      // свободный тег, напр. "Just Chatting"
};

type SourceInfo = {
  protocol: 'rtmp' | 'srt' | 'webrtc' | 'rtsp' | 'unknown';
  videoCodec: 'H264' | 'H265' | 'AV1' | 'VP9' | 'VP8' | string | null;
  audioCodec: 'AAC' | 'Opus' | string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
};

type Rendition = {
  name: string;          // совпадает с NAME в master.m3u8 и с hls.js level.name: "source", "1080p60", "720p", ...
  label: string;         // для UI: "1080p60 · AV1 (источник)", "720p"
  codec: 'H264' | 'H265' | 'AV1';
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  passthrough: boolean;  // true = исходный поток без перекодирования
};

type LiveInfo = {
  broadcastId: string;
  status: 'live' | 'reconnecting';   // reconnecting: стример отвалился, ждём до 30 с
  startedAt: string;
  viewers: number;
  playbackUrl: string | null;        // master.m3u8; null пока не готовы первые сегменты
  thumbnailUrl: string | null;       // jpeg, обновляется ~каждые 10 с (добавляйте ?t=Date.now())
  source: SourceInfo;
  renditions: Rendition[];           // пусто пока playbackUrl === null
};

type StreamCard = { channel: ChannelPublic; live: LiveInfo };
```

## Публичные

### `GET /api/streams`
Живые трансляции, отсортированы по зрителям (desc).
```json
{ "streams": [StreamCard, ...] }
```

### `GET /api/channels/:slug`
```json
{
  "channel": ChannelPublic,
  "live": LiveInfo | null,
  "lastBroadcast": { "title": "…", "startedAt": "…", "endedAt": "…" } | null
}
```
`404 not_found` если канала нет.

### `GET /api/channels/:slug/events` — Server-Sent Events
Сразу после подключения и при каждом изменении (старт/стоп/reconnecting/готовность плейлиста/
число зрителей ~ каждые 5 с) приходит:
```
event: state
data: {"live": LiveInfo | null, "channel": ChannelPublic}
```
`channel` приходит и при смене названия/категории во время эфира.
Каждые 15 с — `event: ping` (`data: {}`): если событий нет > 40 с, соединение считается
мёртвым и клиент переподключается. Клиент просто заменяет своё состояние.

### `POST /api/channels/:slug/heartbeat`
Тело: `{ "viewerId": "<uuid, 8-64 символа [A-Za-z0-9-]>" }`. Ответ `204`.
Клиент шлёт раз в 20 с, пока вкладка видима и канал live. Зритель считается активным 45 с.

## Аутентификация

### `POST /api/auth/register`
Тело: `{ "username": "^[A-Za-z0-9_]{3,25}$", "password": "8..128 символов", "displayName"?: "1..40" }`
Ответ `201 { "user": User }` + cookie. Автоматически создаётся канал `slug = username`
и ключ трансляции. Логины, совпадающие с маршрутами сайта (`login`, `signup`, `dashboard`,
`api`, `hls`, `admin`…), зарезервированы (`400`). Ошибки: `400`, `409 username_taken`, `429`.

### `POST /api/auth/login`
Тело: `{ "username", "password" }` → `200 { "user": User }` + cookie, или `401 invalid_credentials`.

### `POST /api/auth/logout` → `204`

### `GET /api/auth/me`
`200 { "user": User, "channel": ChannelPublic }` или `401 unauthorized`.

## Кабинет стримера (нужна cookie)

### `GET /api/dashboard`
```json
{
  "channel": { ...ChannelPublic, "transcodeMode": "abr" | "passthrough" },
  "streamKey": "live_xxxxxxxx",
  "ingest": {
    "rtmp": { "server": "rtmp://host:1935/live", "streamKey": "live_xxx", "codecs": ["H264","H265","AV1","VP9"] },
    "srt":  { "url": "srt://host:8890?streamid=publish:live/live_xxx&pkt_size=1316", "codecs": ["H264","H265"] },
    "srtAny": { "url": "srt://host:8891?streamid=publish:live/live_xxx",
                "codecs": ["AV1","VP9","VP8","H265","H264"], "containers": ["Matroska/WebM","FLV","MPEG-TS"] },
    "whip": { "url": "http://host:8889/live/live_xxx/whip", "codecs": ["H264","H265","AV1","VP9","VP8"] }
  },
  "live": null | {
    ...LiveInfo,
    "stats": {
      "ingestKbps": number | null,      // входной битрейт с ingest-узла
      "ingestNode": string | null,
      "transcoder": null | {
        "state": "pending" | "running" | "failed",
        "worker": string | null,
        "encoder": string | null,       // libx264 | h264_nvenc | ...
        "fps": number | null,           // скорость кодирования, кадров/с
        "speed": number | null,         // 1.0 = реальное время
        "degraded": boolean,            // нет свободных мощностей: только исходник (+H.264 ≤480p)
        "error": string | null          // почему транскод не идёт (напр. «нет видео» для AV1 в MPEG-TS)
      }
    }
  },
  "recent": [
    { "id": "uuid", "title": "…", "category": "…", "startedAt": "…", "endedAt": "…" | null,
      "peakViewers": 0, "protocol": "rtmp", "videoCodec": "AV1", "width": 1920, "height": 1080 }
  ]
}
```
`transcodeMode`:
- `abr` — исходник (если кодек H.264/HEVC/AV1) + лестница H.264 ниже разрешения источника;
- `passthrough` — только исходник без перекодирования (если кодек не воспроизводим в браузере —
  одна H.264-копия в исходном разрешении).

### `PATCH /api/channel`
Тело (все поля опциональны): `{ "title": "0..140", "category": "0..40", "transcodeMode": "abr"|"passthrough" }`
→ `200 { "channel": { ...ChannelPublic, "transcodeMode" } }`.
Режим перекодирования применяется со следующего запуска трансляции.

### `POST /api/channel/stream-key`
Перевыпуск ключа → `200 { "streamKey": "live_…" }`. Текущая трансляция по старому ключу
продолжается до разрыва, новые подключения со старым ключом отклоняются.

## Публикация из браузера (WHIP)

`ingest.whip.url` принимает стандартный WHIP: `POST` SDP offer (`Content-Type: application/sdp`)
→ `201` с SDP answer и заголовком `Location` (ресурс сессии; `DELETE` на него завершает эфир).
CORS разрешён для любых origin. Кодек выбирается браузером/клиентом
(`RTCRtpTransceiver.setCodecPreferences`): AV1, VP9, VP8, H.264, H.265.

## Служебные (не проксируются наружу edge-ом)

| Метод | Путь | Кто вызывает |
|---|---|---|
| `POST` | `/internal/mediamtx/auth` | MediaMTX (authMethod: http) |
| `POST` | `/internal/ingest/heartbeat` | ingest-узлы, регистрация каждые 5 с |
| `POST` | `/internal/ingest/online` | хук `runOnOnline` |
| `POST` | `/internal/ingest/offline` | хук `runOnOffline` |

`/internal/*` требуют `Authorization: Bearer <INTERNAL_SECRET>` (или Basic с секретом в
качестве пароля — так его передаёт MediaMTX из URL `http://mediamtx:<secret>@api/...`).
| `GET` | `/healthz`, `/readyz` | оркестратор |
| `GET` | `/metrics` | Prometheus |

---

# v2: сообщество, записи, мультистрим, оверлеи, безопасность

Все правила выше (JSON, CSRF, формат ошибок) действуют и здесь. Новые коды ошибок:
`totp_required` (401), `totp_invalid` (401), `conflict` (409), `payload_too_large` (413).

## Расширения типов

```ts
type ChannelPublic = {
  slug: string; displayName: string; title: string; category: string;
  // v2:
  avatarUrl: string | null;              // /media/avatars/…  (null → монограмма)
  bio: string;                           // до 300 символов
  links: { label: string; url: string }[]; // до 5, только https://
  followers: number;
  mature: boolean;                       // 18+: зритель подтверждает перед просмотром
};

type LiveInfo = { /* … как выше … */ latencyMode: 'normal' | 'low' };

type User = { /* … */ twoFactorEnabled: boolean };

type Video = {                           // запись прошедшего эфира (VOD)
  id: string;                            // == broadcastId
  channel: ChannelPublic;
  title: string; category: string;
  startedAt: string; endedAt: string;
  durationSec: number;
  thumbnailUrl: string | null;
  playbackUrl: string;                   // VOD master.m3u8 (EXT-X-ENDLIST, перемотка)
  views: number;
  expiresAt: string;                     // когда запись будет удалена
  renditions: Rendition[];
};

type Category = { name: string; liveCount: number; viewers: number; thumbnailUrl: string | null };

type RestreamDestination = {
  id: string;
  name: string;
  service: 'twitch' | 'youtube' | 'kick' | 'custom';
  url: string;                           // rtmp:// | rtmps:// | srt://  (без ключа)
  keyMasked: string;                     // "••••••3f9a" — ключ целиком не возвращается никогда
  enabled: boolean;
  transcode: 'auto' | 'copy' | 'h264';   // auto: копия для H.264-источника, иначе перекодирование в H.264
};

type RestreamStatus = {
  id: string;                            // == destination id
  state: 'connecting' | 'live' | 'error';
  error: string | null;
  since: string;
};
```

`GET /api/channels/:slug` дополнительно возвращает `"viewer": { "following": boolean } | null`
(`null` для анонима).

## Подписки (follows)

| Метод | Путь | Ответ |
|---|---|---|
| `POST` | `/api/channels/:slug/follow` | `{ "following": true, "followers": n }` (нужна cookie; на свой канал — `400`) |
| `DELETE` | `/api/channels/:slug/follow` | `{ "following": false, "followers": n }` |
| `GET` | `/api/me/following` | `{ "channels": [{ "channel": ChannelPublic, "live": LiveInfo \| null }] }` — сначала живые (по зрителям), потом остальные |

## Каталог и поиск

- `GET /api/streams?category=<имя>` — фильтр по категории (без учёта регистра). Без параметра — как раньше.
- `GET /api/categories` → `{ "categories": Category[] }`: категории с живыми эфирами (по зрителям) +
  популярные за 30 дней (`liveCount: 0`), максимум 48.
- `GET /api/search?q=<≥2 символов>` → `{ "channels": [{ "channel": ChannelPublic, "live": LiveInfo | null }], "categories": Category[] }`
  (до 20 каналов: живые первыми; поиск по логину, имени, названию эфира).

## Записи эфиров (VOD)

Каждый эфир записывается (все качества, без перекодирования сверх ABR) и после окончания доступен
как видео с перемоткой. Хранится `VOD_RETENTION_DAYS` (по умолчанию 7 дней). Стример может
отключить запись (`saveVods: false`) или удалить видео.

| Метод | Путь | Ответ |
|---|---|---|
| `GET` | `/api/channels/:slug/videos?limit=20` | `{ "videos": Video[] }` (новые первыми) |
| `GET` | `/api/videos/:id` | `{ "video": Video }` или `404` |
| `POST` | `/api/videos/:id/view` | `{ viewerId }` → `204` (считается раз на зрителя за 6 ч) |
| `DELETE` | `/api/videos/:id` | `204` (только владелец) |

## Мультистрим (ретрансляция на Twitch / YouTube / Kick / свой сервер)

Включённые направления запускаются автоматически, когда канал выходит в эфир, и останавливаются
вместе с ним. Видео копируется без потерь, если направление принимает кодек (`auto`), звук всегда
приводится к AAC. Максимум 5 направлений.

| Метод | Путь | Тело / ответ |
|---|---|---|
| `GET` | `/api/channel/restreams` | `{ "destinations": RestreamDestination[] }` |
| `POST` | `/api/channel/restreams` | `{ name, service, url, streamKey, enabled?, transcode? }` → `201 { "destination" }` |
| `PATCH` | `/api/channel/restreams/:id` | любые поля из POST (пустой `streamKey` = не менять) → `{ "destination" }` |
| `DELETE` | `/api/channel/restreams/:id` | `204` |

Пресеты URL (их подставляет UI): Twitch `rtmp://live.twitch.tv/app`, YouTube
`rtmp://a.rtmp.youtube.com/live2`, Kick `rtmps://fa723fc1b171.global-contribute.live-video.net/app`.

## Оверлей для OBS (Browser Source)

У канала есть секретная ссылка оверлея `/overlay/<token>` (прозрачная страница для OBS «Браузер»):
всплывающие оповещения о новых подписчиках и счётчик зрителей.

- `GET /api/overlay/:token/events` — SSE: `event: alert` `{"type":"follow","displayName":"…","at":"…"}`,
  `event: stats` `{"live":bool,"viewers":n}` (при подключении и при изменениях), `event: ping` каждые 15 с.
  Неверный токен → `404`.
- `POST /api/channel/overlay/test` → `204` (тестовое оповещение).
- `POST /api/channel/overlay/reset` → `{ "overlayUrl" }` (старая ссылка перестаёт работать).
- Параметры страницы: `?alerts=0|1&viewers=0|1&sound=0|1` (по умолчанию все `1`).

## Профиль и настройки канала

`PATCH /api/channel` дополнительно принимает:
`{ bio?, links?, mature?, saveVods?, lowLatency? }`.
- `lowLatency: true` — сегменты 1 с и агрессивная синхронизация плеера (задержка ≈ 3–4 с вместо 6–10 с;
  применяется со следующего запуска эфира).

Аватар: `POST /api/channel/avatar` с телом
`{ "contentType": "image/png" | "image/jpeg" | "image/webp", "data": "<base64, ≤ 2 МБ>" }`
→ `{ "avatarUrl" }`; `DELETE /api/channel/avatar` → `204`.

## Студия (дополнения к `GET /api/dashboard`)

```ts
channel: ChannelPublic & {
  transcodeMode; bio; links; mature: boolean; saveVods: boolean; lowLatency: boolean;
  overlayUrl: string;                    // относительный путь /overlay/<token>
}
live.stats.restreams: RestreamStatus[]   // по включённым направлениям
```

`GET /api/dashboard/health?broadcastId=<id>` (по умолчанию — текущий/последний эфир) →
`{ "samples": [{ "ts": "…", "viewers": n, "ingestKbps": n | null }] }` — точки каждые 10 с
(для графиков «битрейт» и «зрители»).

## Аккаунт и безопасность

| Метод | Путь | Тело / ответ |
|---|---|---|
| `POST` | `/api/me/password` | `{ currentPassword, newPassword }` → `204`, все остальные сессии завершаются |
| `GET` | `/api/me/sessions` | `{ "sessions": [{ id, createdAt, lastSeenAt, userAgent, ip, current }] }` |
| `DELETE` | `/api/me/sessions/:id` | `204` |
| `POST` | `/api/me/sessions/revoke-others` | `204` |
| `GET` | `/api/me/2fa` | `{ "enabled": bool }` |
| `POST` | `/api/me/2fa/setup` | → `{ "secret": "BASE32", "otpauthUrl": "otpauth://totp/StreamHub:user?…" }` (QR рисует клиент) |
| `POST` | `/api/me/2fa/enable` | `{ code }` → `{ "recoveryCodes": ["xxxx-xxxx", … ×8] }` (показываются один раз) |
| `POST` | `/api/me/2fa/disable` | `{ password, code }` → `204` |

Двухфакторный вход (TOTP, RFC 6238: 6 цифр, шаг 30 с): если у пользователя включена 2FA,
`POST /api/auth/login` без поля `totp` отвечает `401 totp_required`; клиент повторяет запрос
с `{ username, password, totp }`, где `totp` — код из приложения или резервный код. Неверный код →
`401 totp_invalid`.
