# Наблюдаемость: Prometheus и Grafana

Необязательный стек мониторинга поверх основного `docker-compose.yml`. В него входят:

- **Prometheus v3.15.1**: собирает метрики со всех реплик и вычисляет алерты;
- **Grafana 13.3.0**: подключённый источник данных и дашборд **StreamHub overview**.

Конфигурация лежит в `deploy/observability/`. Список метрик по компонентам — в
[OPERATIONS.md](OPERATIONS.md#мониторинг).

## Запуск

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

| Сервис | Адрес | Вход |
|---|---|---|
| Grafana | http://localhost:3001 | `admin` / значение `GRAFANA_ADMIN_PASSWORD` |
| Prometheus | http://127.0.0.1:9090 (алерты — `/alerts`, цели — `/targets`) | без авторизации |

Оба порта по умолчанию слушают **только 127.0.0.1**. Анонимный доступ и самостоятельная
регистрация в Grafana выключены. Дашборд «StreamHub overview» открывается как домашний.

Чтобы не указывать два файла в каждой команде, добавьте в `.env`:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.observability.yml
```

Если запускать `docker compose` только с основным файлом, контейнеры `prometheus` и `grafana` для
Compose станут «сиротами». Тогда `up` покажет предупреждение, а `down` не сможет удалить сеть.
Поэтому используйте одинаковый набор файлов, либо `COMPOSE_FILE`. Остановить только мониторинг:
`docker compose -f docker-compose.yml -f docker-compose.observability.yml rm -sf prometheus grafana`.

### Переменные

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `GRAFANA_ADMIN_PASSWORD` | `streamhub-dev-only` | пароль администратора Grafana. **Значение по умолчанию — только для локальной разработки** |
| `GRAFANA_ADMIN_USER` | `admin` | логин администратора |
| `GRAFANA_BIND` | `127.0.0.1` | адрес публикации Grafana. `0.0.0.0` открывает её в сеть: сначала задайте надёжный пароль и TLS |
| `GRAFANA_PORT` | `3001` | порт Grafana на хосте |
| `PROMETHEUS_PORT` | `9090` | порт Prometheus на хосте (всегда только `127.0.0.1`) |
| `PROMETHEUS_RETENTION` | `15d` | срок хранения метрик |

Пароль из `GRAFANA_ADMIN_PASSWORD` применяется только при первом запуске, пока том `grafana` пуст.
Сменить его позже можно так:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml exec grafana grafana cli admin reset-admin-password '<новый пароль>'
```

Данные хранятся в томах `promdata` и `grafana`. `docker compose … down -v` удаляет и их.

## Как собираются метрики

Prometheus находит цели через встроенный DNS Docker (`dns_sd_configs`, запись типа A). Имя
сервиса compose разрешается во все его реплики, поэтому при изменении `API_REPLICAS` и
`WORKER_REPLICAS` менять конфиг не нужно. Список целей обновляется раз в 15 с, метрики снимаются
раз в 15 с.

| job | Цель | Что даёт |
|---|---|---|
| `api` | `api:3000/metrics` | `streamhub_api_request_seconds{method,route,status}`, `streamhub_api_sse_clients`, `streamhub_ingest_auth_total{action,result}`, метрики Node.js (`streamhub_api_process_*`, `streamhub_api_nodejs_*`) |
| `worker` | `worker:9100/metrics` | `streamhub_worker_active_jobs`, `streamhub_worker_slots`, `streamhub_worker_ffmpeg_exits_total{reason}`, `streamhub_worker_upload_seconds`, `streamhub_worker_job_claims_total`, метрики Node.js |
| `ingest` | `ingest:9998/metrics` | MediaMTX: `paths`, `paths_inbound_bytes`, `paths_outbound_bytes`, `paths_readers`, `rtmp_conns`, `srt_conns`, `webrtc_sessions`, `rtsp_sessions` |
| `srt-gateway` | `srt-gateway:9101/metrics` | `streamhub_srt_gateway_active_sessions`, `_accepted_total`, `_rejected_total`, `_received_bytes_total` |
| `prometheus` | `localhost:9090` | собственные метрики Prometheus |

- Метка `instance` содержит IP:порт контейнера. После пересоздания контейнера она меняется.
- **Ключи трансляции не попадают в Prometheus.** MediaMTX называет пути `live/<ключ>` и
  добавляет к соединениям IP:порт публикующего. Поэтому `metric_relabel_configs` для job `ingest`:
  - оставляет только перечисленные выше метрики;
  - заменяет путь меткой `stream` — необратимым 32-битным хэшем, одинаковым у пути и его соединений;
  - удаляет метки `name`, `path` и `remoteAddr`.
- Ingest-узлы на других хостах (см. [OPERATIONS.md](OPERATIONS.md#несколько-ingest-узлов))
  через Docker DNS не находятся. Для них добавьте в `prometheus.yml` `static_configs` или
  `file_sd_configs` и откройте порт 9998 только для Prometheus.

## Дашборд «StreamHub overview»

Grafana → Dashboards → StreamHub → StreamHub overview. Дашборд создан из файла
`deploy/observability/grafana/dashboards/streamhub-overview.json` и в интерфейсе не
сохраняется: правьте JSON в репозитории, Grafana перечитывает его раз в 30 с.

| Ряд | Панель | Что показывает |
|---|---|---|
| Сводка | Реплики API / Воркеры / Ingest-узлы | число целей с `up=1`. Красный цвет — ни одной |
| | Потоки на ingest | пути MediaMTX в состоянии `ready`, то есть идущие публикации |
| | Загрузка воркеров | `sum(active_jobs) / sum(slots)`. Оранжевый — ≥ 80%, красный — ≥ 100% |
| | SSE-клиенты | открытые подписки на события каналов |
| API | Запросы по маршрутам | запросов/с по шаблону маршрута, без `/metrics`, `/healthz`, `/readyz` |
| | Задержка p95 по маршрутам | без SSE-маршрутов `…/events`: у них «задержка» — это длительность подключения |
| | Ошибки API по статусу | 4xx и 5xx в секунду. 401 и 429 бывают и в нормальной работе |
| | SSE-подключения | по репликам |
| | Авторизация ingest | решения `/internal/mediamtx/auth` по `action`/`result`. `read deny` — норма: RTSP-читатели сначала приходят без пароля |
| | Event loop lag p99 | перегрузка CPU процессов API |
| Транскодирование | Активные транскоды и слоты | всего и по воркерам; пунктир — сумма слотов полного транскода |
| | Выходы ffmpeg и захваты заданий | в минуту, по `reason` (см. ниже) и `claims` |
| | Задержка выгрузки в S3 | p50/p90/p99 одного PUT; пунктир — порог алерта 1 с |
| | Выгрузки в S3 | объектов/с по воркерам |
| Ingest | Входящий трафик MediaMTX | бит/с по узлам; сюда входят и потоки SRT-шлюза |
| | Публикации по протоколам | `rtmp_conns` — RTMP, `srt_conns` — SRT 8890, `webrtc_sessions` — WHIP, `rtsp_sessions` — потоки, переопубликованные SRT-шлюзом |
| | SRT-шлюз: сессии / подключения / битрейт | универсальный SRT-вход 8891 |
| Процессы Node.js | CPU и RSS | процессы api и worker. **Дочерние ffmpeg сюда не входят** |

Как читать некоторые метрики:

- `streamhub_worker_active_jobs` считает **все** задания воркера, в том числе degraded-режим,
  который идёт в дополнительных remux-слотах (`WORKER_REMUX_SLOTS`). `streamhub_worker_slots` —
  это только слоты полного транскода (`WORKER_SLOTS`). Поэтому загрузка может быть выше 100%.
- `streamhub_worker_ffmpeg_exits_total{reason}`:
  - `exit` — ffmpeg завершился сам: источник закончился, процесс упал или его перезапустил
    watchdog (нет сегментов, хранилище не принимает выгрузку);
  - `lease` — воркер потерял аренду. Так бывает штатно, когда эфир закончился и задание закрыто,
    и при сбое: воркер не продлил аренду вовремя или задание забрал другой воркер;
  - `shutdown` — остановка воркера (деплой, `SIGTERM`).

## Алерты

Правила лежат в `deploy/observability/prometheus/rules/streamhub.yml`. Prometheus показывает их на
`/alerts`, Grafana — в Alerting → Alert rules (раздел data source-managed). **Уведомлений нет**:
Alertmanager в стек не входит. Чтобы получать оповещения, добавьте Alertmanager и секцию
`alerting:` в `prometheus.yml`.

| Алерт | Условие | Важность |
|---|---|---|
| `StreamHubNoHealthyAPI` | ни одна реплика api не отдаёт метрики, 1 мин | critical |
| `StreamHubNoWorkers` | ни одного живого воркера, 2 мин | critical |
| `StreamHubIngestNodeDown` | `up{job="ingest"} == 0`, 1 мин | critical |
| `StreamHubNoIngestNodes` | ни одного доступного ingest-узла, 1 мин | critical |
| `StreamHubTargetDown` | реплика api/worker/srt-gateway есть в DNS, но не отвечает, 2 мин | warning |
| `StreamHubSrtGatewayDown` | srt-gateway недоступен, 2 мин | warning |
| `StreamHubWorkerCapacityHigh` | `sum(active_jobs) / sum(slots) > 0.8`, 5 мин | warning |
| `StreamHubFfmpegExitRateHigh` | больше 2 выходов ffmpeg с `reason="exit"` в минуту (окно 10 мин), 10 мин | warning |
| `StreamHubS3UploadSlow` | p99 выгрузки в S3 > 1 с (окно 5 мин), 5 мин | warning |
| `StreamHubAPIErrorRateHigh` | доля 5xx > 5% (без `/metrics`, `/healthz`, `/readyz`), 5 мин | warning |
| `StreamHubPublishDeniedSpike` | больше 0,5 отказов в публикации в секунду, 10 мин | warning |

Остановленный контейнер исчезает из DNS Docker, и его `up` пропадает, а не становится 0.
Поэтому полную недоступность ловят правила вида `absent(up{job="…"} == 1)` (`No…`), а `…Down`
срабатывает на реплику, которая есть в DNS, но не отвечает.

### Что делать

Команды ниже даны для одного хоста с compose. SQL-запросы — в
[OPERATIONS.md](OPERATIONS.md#полезные-запросы), там же runbook.

**StreamHubNoHealthyAPI** — не работают сайт, хуки ingest и авторизация публикаций. Новые эфиры не стартуют.
1. `docker compose ps -a api migrate` и `docker compose logs --tail=100 api migrate`.
2. Частые причины:
   - не прошла миграция (api ждёт успешного `migrate`);
   - недоступен Postgres;
   - API отказался стартовать с `INTERNAL_SECRET` по умолчанию при не-localhost URL
     (в логе `INTERNAL_SECRET must be set for a non-local deployment`).
3. После устранения причины: `docker compose up -d api`.

**StreamHubNoWorkers** — транскодирование стоит: новые эфиры не получают плейлистов.
1. `docker compose logs --tail=100 worker`. Сообщение `object storage not ready, retrying` означает, что недоступен S3.
2. Проверьте Postgres и SeaweedFS (`docker compose ps postgres seaweedfs`), затем `docker compose up -d worker`.

**StreamHubIngestNodeDown / StreamHubNoIngestNodes** — стримеры этого узла (или все) отключены.
1. `docker compose ps -a ingest`, `docker compose logs --tail=100 ingest`.
2. Сообщение `heartbeat to control plane failed` значит, что у узла нет связи с API.
3. Перезапуск: `docker compose up -d ingest`. OBS переподключится сам. Если это случится
   в течение 30 с, эфир продолжится.

**StreamHubTargetDown** — процесс жив в DNS, но не отвечает на `/metrics`.
1. Посмотрите на дашборде «Event loop lag p99» и «CPU процессов Node.js», затем статус healthcheck
   в `docker compose ps`.
2. Зависшую реплику перезапустите: `docker restart <контейнер>`. Воркер по `SIGTERM` сразу
   возвращает задания в очередь.

**StreamHubSrtGatewayDown** — не работает только вход SRT 8891 (AV1/VP9 в Matroska/WebM/FLV).
Посмотрите `docker compose logs --tail=100 srt-gateway` и выполните `docker compose up -d srt-gateway`.

**StreamHubWorkerCapacityHigh** — запас мощностей кончается: новые эфиры уйдут в degraded-режим
(исходник + H.264 ≤480p), а запаса N+1 на падение воркера нет.
1. Добавьте воркеров (`WORKER_REPLICAS`) или GPU (`ENCODER=h264_nvenc`).
2. Временно можно сократить `LADDER`.
3. Какие эфиры уже в degraded, видно по `stats->>'degraded'` в SQL «Живые эфиры».

**StreamHubFfmpegExitRateHigh** — транскод падает и перезапускается по кругу.
1. Найдите задания SQL-запросом «Проблемные задания» (`last_error`, `attempts`). В логах воркера
   ищите `ffmpeg exited` с кодом и `no segments produced`.
2. Частые причины:
   - кодек или контейнер, который нельзя прочитать по выбранному протоколу (например, AV1 в MPEG-TS
     на порт 8890 — его нужно слать на 8891);
   - битый источник;
   - проблемы хранилища: watchdog перезапускает транскод, если S3 не принимает выгрузку.
     Проверьте `StreamHubS3UploadSlow`.
3. Порог рассчитан на небольшую платформу. При сотнях эфиров поднимите его или считайте долю
   от числа активных заданий.

**StreamHubS3UploadSlow** — сегмент длиной 2 с выгружается дольше 1 с (p99). Растёт очередь,
у зрителей появляются 404 и подвисания.
1. В логах воркера ищите `object storage is falling behind` и `object storage not accepting uploads`.
2. Проверьте SeaweedFS (`docker compose logs seaweedfs`, свободное место на диске) или
   сетевую задержку до облачного S3.

**StreamHubAPIErrorRateHigh** — на панели «Ошибки API по статусу» и запросом
`sum by (route, status) (rate(streamhub_api_request_seconds_count{status=~"5.."}[5m]))`
найдите маршрут. В логах API ищите `request failed` и `unhandled error`. `/readyz` с `db:false`
указывает на Postgres. Ошибки, которые nginx отдаёт сам (502 при недоступности всех
реплик), сюда не входят: их покрывает `StreamHubNoHealthyAPI`.

**StreamHubPublishDeniedSpike** — control plane отклоняет много публикаций. Обычно это стример со
сброшенным ключом в цикле переподключения или перебор ключей. Подобрать ключ на 186 бит
нереально, но нагрузка растёт.
1. Найдите источник:
   - srt-gateway пишет `rejected` с `ip` и причиной на уровне info;
   - API пишет `ingest auth denied` с `ip` и причиной только при `LOG_LEVEL=debug`.
2. Заблокируйте адрес на балансировщике или файрволе либо свяжитесь со стримером.

## Проверка и изменение конфигурации

Те же проверки выполняет job `observability` в `.github/workflows/ci.yml`:

```bash
P=deploy/observability/prometheus
docker run --rm -v "$PWD/$P:/etc/prometheus:ro" -w /etc/prometheus --entrypoint promtool prom/prometheus:v3.15.1 check config prometheus.yml
docker run --rm -v "$PWD/$P:/etc/prometheus:ro" -w /etc/prometheus --entrypoint promtool prom/prometheus:v3.15.1 test rules tests/streamhub.test.yml
docker compose -f docker-compose.yml -f docker-compose.observability.yml config --quiet
```

- Новый алерт добавляйте в `rules/streamhub.yml` вместе с тестом в `tests/streamhub.test.yml`
  (`promtool test rules`) и строкой в таблицах выше.
- Новые метрики приложения называйте с префиксом `streamhub_<компонент>_`. Метки — только
  с ограниченным набором значений, без ключей, логинов и IP.
- Изменения конфигурации Prometheus применяются после `docker compose … restart prometheus`.

## Чего здесь нет

- Alertmanager и каналы уведомлений.
- Метрики хоста и контейнеров (node-exporter, cAdvisor), поэтому CPU процессов ffmpeg не виден.
- Экспортёры Postgres, Valkey, SeaweedFS и nginx. Долю попаданий в кэш HLS считайте по
  `X-Cache-Status` в логах edge.
- Проверки `/readyz`: «живость» API здесь означает, что `/metrics` отвечает.
