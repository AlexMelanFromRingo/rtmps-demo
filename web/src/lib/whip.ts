/**
 * Minimal WHIP publisher (RFC 9725): POST an SDP offer, apply the answer,
 * DELETE the session resource (`Location`) on stop.
 */

export type WhipCodecId = 'AV1' | 'VP9' | 'VP8' | 'H264' | 'H265';

export type WhipCodec = { id: WhipCodecId; label: string; mimeType: string };

const CODECS: WhipCodec[] = [
  { id: 'AV1', label: 'AV1', mimeType: 'video/AV1' },
  { id: 'H265', label: 'H.265 (HEVC)', mimeType: 'video/H265' },
  { id: 'VP9', label: 'VP9', mimeType: 'video/VP9' },
  { id: 'H264', label: 'H.264', mimeType: 'video/H264' },
  { id: 'VP8', label: 'VP8', mimeType: 'video/VP8' },
];

const AUX_CODECS = new Set(['video/rtx', 'video/red', 'video/ulpfec', 'video/flexfec-03']);

/** Video codecs this browser can *send*, limited to what the server accepts. */
export function sendableVideoCodecs(serverCodecs: string[]): WhipCodec[] {
  if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
    return [];
  }
  const caps = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
  const supported = new Set(caps.map((c) => c.mimeType.toLowerCase()));
  const server = new Set(serverCodecs.map((c) => c.toUpperCase()));
  return CODECS.filter(
    (c) => supported.has(c.mimeType.toLowerCase()) && (server.size === 0 || server.has(c.id)),
  );
}

export function canPublishFromBrowser(): { ok: true } | { ok: false; reason: string } {
  if (typeof RTCPeerConnection === 'undefined') {
    return { ok: false, reason: 'Этот браузер не поддерживает WebRTC.' };
  }
  if (!window.isSecureContext || !navigator.mediaDevices) {
    return {
      ok: false,
      reason:
        'Браузер даёт доступ к камере и экрану только на защищённых страницах — откройте StreamHub по HTTPS или через localhost.',
    };
  }
  return { ok: true };
}

function preferCodec(transceiver: RTCRtpTransceiver, mimeType: string): boolean {
  if (typeof transceiver.setCodecPreferences !== 'function') return false;
  const caps = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
  const wanted = mimeType.toLowerCase();
  const preferred = caps
    .filter((c) => c.mimeType.toLowerCase() === wanted)
    // H.264: packetization-mode=1 first (what every SFU/ingest expects).
    .sort(
      (a, b) =>
        Number((b.sdpFmtpLine ?? '').includes('packetization-mode=1')) -
        Number((a.sdpFmtpLine ?? '').includes('packetization-mode=1')),
    );
  if (preferred.length === 0) return false;
  const aux = caps.filter((c) => AUX_CODECS.has(c.mimeType.toLowerCase()));
  try {
    transceiver.setCodecPreferences([...preferred, ...aux]);
    return true;
  } catch {
    return false;
  }
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = window.setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

export class WhipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhipError';
  }
}

function describeHttpFailure(status: number, body: string): string {
  const detail = body.trim().slice(0, 200);
  switch (status) {
    case 400:
      return `Сервер отклонил предложение WebRTC${detail ? `: ${detail}` : '.'} Попробуйте другой кодек.`;
    case 401:
    case 403:
      return 'Сервер не принял ключ трансляции. Обновите страницу — возможно, ключ был сброшен.';
    case 404:
      return 'WHIP-адрес не найден. Обновите страницу и попробуйте снова.';
    case 409:
      return 'На этот ключ уже идёт трансляция. Остановите её в OBS или другой вкладке.';
    default:
      return `WHIP-сервер ответил ошибкой ${status}${detail ? `: ${detail}` : ''}.`;
  }
}

export type OutboundStats = {
  kbps: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  limitedBy: string | null;
};

export type WhipStartOptions = {
  url: string;
  stream: MediaStream;
  videoMimeType: string;
  maxBitrateKbps: number;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
};

export class WhipSession {
  readonly pc: RTCPeerConnection;
  private resourceUrl: string | null = null;
  private lastSample: { bytes: number; ts: number } | null = null;
  readonly codecForced: boolean;
  private closed = false;

  private constructor(pc: RTCPeerConnection, codecForced: boolean) {
    this.pc = pc;
    this.codecForced = codecForced;
  }

  static async start(opts: WhipStartOptions): Promise<WhipSession> {
    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
    let codecForced = false;

    for (const track of opts.stream.getTracks()) {
      const init: RTCRtpTransceiverInit = { direction: 'sendonly', streams: [opts.stream] };
      if (track.kind === 'video') {
        // Keep the full resolution from the first frame: the server plans the
        // quality ladder from the source resolution, so a low-res BWE ramp-up
        // would cost quality. Under congestion, drop frame rate instead.
        init.sendEncodings = [{ maxBitrate: opts.maxBitrateKbps * 1000, scaleResolutionDownBy: 1 }];
      }
      const transceiver = pc.addTransceiver(track, init);
      if (track.kind === 'video') codecForced = preferCodec(transceiver, opts.videoMimeType);
    }

    const session = new WhipSession(pc, codecForced);
    if (opts.onConnectionState) {
      const cb = opts.onConnectionState;
      pc.addEventListener('connectionstatechange', () => cb(pc.connectionState));
    }

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc, 3000);
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new WhipError('Браузер не смог подготовить WebRTC-соединение.');

      let res: Response;
      try {
        res = await fetch(opts.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: sdp,
        });
      } catch {
        throw new WhipError(
          'Не удалось связаться с WHIP-сервером. Проверьте, что он доступен с этого компьютера (и что страница и WHIP-адрес оба на HTTP или оба на HTTPS).',
        );
      }
      const body = await res.text();
      if (res.status !== 201 && !res.ok) throw new WhipError(describeHttpFailure(res.status, body));

      const location = res.headers.get('Location');
      if (location) session.resourceUrl = new URL(location, opts.url).href;

      await pc.setRemoteDescription({ type: 'answer', sdp: body });
      await session.setMaxBitrate(opts.maxBitrateKbps);
      return session;
    } catch (err) {
      await session.stop();
      if (err instanceof WhipError) throw err;
      throw new WhipError(
        err instanceof Error ? `Ошибка WebRTC: ${err.message}` : 'Ошибка WebRTC.',
      );
    }
  }

  async setMaxBitrate(kbps: number): Promise<void> {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    for (const enc of params.encodings) enc.maxBitrate = kbps * 1000;
    (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'maintain-resolution';
    try {
      await sender.setParameters(params);
    } catch {
      /* some browsers reject setParameters before negotiation settles — the initial sendEncodings still apply */
    }
  }

  async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    await sender?.replaceTrack(track);
  }

  async stats(): Promise<OutboundStats> {
    const report = await this.pc.getStats();
    let out: OutboundStats = { kbps: null, fps: null, width: null, height: null, codec: null, limitedBy: null };
    let codecId: string | undefined;
    report.forEach((s: Record<string, unknown> & { type: string }) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') {
        const bytes = Number(s.bytesSent ?? 0);
        const ts = Number(s.timestamp ?? performance.now());
        let kbps: number | null = null;
        if (this.lastSample && ts > this.lastSample.ts) {
          kbps = ((bytes - this.lastSample.bytes) * 8) / (ts - this.lastSample.ts);
        }
        this.lastSample = { bytes, ts };
        out = {
          kbps,
          fps: typeof s.framesPerSecond === 'number' ? s.framesPerSecond : null,
          width: typeof s.frameWidth === 'number' ? s.frameWidth : null,
          height: typeof s.frameHeight === 'number' ? s.frameHeight : null,
          codec: null,
          limitedBy:
            typeof s.qualityLimitationReason === 'string' && s.qualityLimitationReason !== 'none'
              ? s.qualityLimitationReason
              : null,
        };
        codecId = typeof s.codecId === 'string' ? s.codecId : undefined;
      }
    });
    if (codecId) {
      const codec = report.get(codecId) as { mimeType?: string } | undefined;
      if (codec?.mimeType) out.codec = codec.mimeType.replace(/^video\//i, '');
    }
    return out;
  }

  /** Ends the WHIP session (DELETE on the resource) and closes the peer connection. */
  async stop(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const url = this.resourceUrl;
    this.resourceUrl = null;
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
    if (url) {
      try {
        await fetch(url, { method: 'DELETE', keepalive: opts.keepalive ?? false });
      } catch {
        /* the server will time the session out on its own */
      }
    }
  }
}

/**
 * Mix several audio tracks (e.g. tab/system audio + microphone) into one,
 * because the ingest expects a single audio track.
 */
export function mixAudioTracks(tracks: MediaStreamTrack[]): {
  track: MediaStreamTrack;
  close: () => void;
} {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  for (const t of tracks) ctx.createMediaStreamSource(new MediaStream([t])).connect(dest);
  const track = dest.stream.getAudioTracks()[0];
  if (!track) throw new Error('audio mix failed');
  return {
    track,
    close: () => {
      track.stop();
      void ctx.close();
    },
  };
}
