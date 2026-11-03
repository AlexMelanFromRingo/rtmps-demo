import { config } from '../config.ts';

/**
 * Removes credentials and stream keys from text that may end up in logs or in
 * the database (ffmpeg/ffprobe errors echo their full input URL).
 */
export function redact(text: string): string {
  let out = text;
  if (config.internalSecret) out = out.split(config.internalSecret).join('***');
  return out
    .replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@')                 // scheme://user:pass@
    .replace(/(streamid=[^:\s]+:[^:\s]+):[^:\s]+:[^\s&]+/g, '$1:***') // streamid=read:path:user:pass
    .replace(/live_[A-Za-z0-9]{32}/g, 'live_***');             // stream keys
}
