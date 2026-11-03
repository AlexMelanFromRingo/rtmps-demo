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
    "whip": { "url": "http://host:8889/live/live_xxx/whip", "codecs": ["H264","H265","AV1","VP9","VP8"] }
  },
  "live": null | {
    ...LiveInfo,
    "stats": {
      "ingestKbps": number | null,      // входной битрейт с ingest-узла
      "ingestNode": string | null,
      "transcoder": null | {
        "state": "pending" | "running",
        "worker": string | null,
        "encoder": string | null,       // libx264 | h264_nvenc | ...
        "fps": number | null,           // скорость кодирования, кадров/с
        "speed": number | null,         // 1.0 = реальное время
        "degraded": boolean             // нет свободных мощностей: только исходник (+H.264 ≤480p)
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
| `POST` | `/internal/mediamtx/auth?secret=…` | MediaMTX (authMethod: http) |
| `POST` | `/internal/ingest/heartbeat?secret=…` | ingest-узлы, регистрация каждые 5 с |
| `POST` | `/internal/ingest/online?secret=…` | хук `runOnOnline` |
| `POST` | `/internal/ingest/offline?secret=…` | хук `runOnOffline` |
| `GET` | `/healthz`, `/readyz` | оркестратор |
| `GET` | `/metrics` | Prometheus |
