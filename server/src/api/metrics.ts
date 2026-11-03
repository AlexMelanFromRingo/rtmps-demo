import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'streamhub_api_' });

export const apiMetrics = {
  requests: new client.Histogram({
    name: 'streamhub_api_request_seconds', help: 'HTTP request latency', labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers: [registry],
  }),
  sseClients: new client.Gauge({ name: 'streamhub_api_sse_clients', help: 'Open SSE connections', registers: [registry] }),
  ingestAuth: new client.Counter({ name: 'streamhub_ingest_auth_total', help: 'Ingest auth decisions', labelNames: ['action', 'result'], registers: [registry] }),
};
