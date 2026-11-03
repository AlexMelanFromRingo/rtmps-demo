// Local HTTP sink for ffmpeg's HLS output (ffmpeg PUTs every segment and
// playlist here). Bodies are buffered and handed to the job's sink, which
// uploads them to object storage asynchronously — ffmpeg is never blocked by
// S3 latency.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { log } from '../lib/log.ts';

export type FileEvent = { variant: string | null; file: string; body: Buffer };

export interface JobSink {
  onFile(ev: FileEvent): void;
  onDelete(variant: string | null, file: string): void;
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_BODY = 64 * 1024 * 1024;

export class SegmentReceiver {
  private readonly sinks = new Map<string, JobSink>();
  private server: http.Server | null = null;
  private port = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.keepAliveTimeout = 65_000;
    this.server.requestTimeout = 60_000;
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    log.info({ port: this.port }, 'segment receiver listening');
  }

  baseUrl(token: string): string {
    return `http://127.0.0.1:${this.port}/j/${token}`;
  }

  register(token: string, sink: JobSink): void {
    this.sinks.set(token, sink);
  }

  unregister(token: string): void {
    this.sinks.delete(token);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    // /j/<token>/<file>  or  /j/<token>/<variant>/<file>
    const parts = (req.url ?? '').split('?')[0]!.split('/').filter(Boolean);
    const [j, token, a, b] = parts;
    const sink = token ? this.sinks.get(token) : undefined;
    const variant = parts.length === 4 ? a! : null;
    const file = parts.length === 4 ? b : a;
    if (j !== 'j' || !sink || !file || (parts.length !== 3 && parts.length !== 4) || !SAFE.test(file) || (variant !== null && !SAFE.test(variant))) {
      req.resume();
      res.writeHead(404).end();
      return;
    }

    if (req.method === 'DELETE') {
      req.resume();
      sink.onDelete(variant, file);
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'PUT' && req.method !== 'POST') {
      req.resume();
      res.writeHead(405).end();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      try {
        sink.onFile({ variant, file, body: Buffer.concat(chunks, size) });
        res.writeHead(201).end();
      } catch (err) {
        log.error({ err }, 'sink failed');
        res.writeHead(500).end();
      }
    });
    req.on('error', () => res.destroy());
  }
}
