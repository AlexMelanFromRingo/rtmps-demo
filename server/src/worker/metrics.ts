import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'streamhub_worker_' });

export const metrics = {
  activeJobs: new client.Gauge({ name: 'streamhub_worker_active_jobs', help: 'Transcodes running on this worker', registers: [registry] }),
  slots: new client.Gauge({ name: 'streamhub_worker_slots', help: 'Configured transcode slots', registers: [registry] }),
  ffmpegExits: new client.Counter({ name: 'streamhub_worker_ffmpeg_exits_total', help: 'ffmpeg exits by reason', labelNames: ['reason'], registers: [registry] }),
  uploadSeconds: new client.Histogram({
    name: 'streamhub_worker_upload_seconds', help: 'Object storage PUT latency',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers: [registry],
  }),
  claims: new client.Counter({ name: 'streamhub_worker_job_claims_total', help: 'Jobs claimed', registers: [registry] }),
};
