import { Server } from 'lucide-react';
import type { RestreamService } from '../api/types';

export const SERVICE_LABEL: Record<RestreamService, string> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  kick: 'Kick',
  custom: 'Свой сервер',
};

/** Monochrome service marks (no brand colours: colour is reserved for signal state). */
export function ServiceGlyph({ service, size = 20 }: { service: RestreamService; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true as const };
  switch (service) {
    case 'twitch':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          <path d="M4 3h16v11l-4 4h-4l-3 3v-3H5l-1-1z" />
          <path d="M11 8v4M15 8v4" strokeLinecap="round" />
        </svg>
      );
    case 'youtube':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          <rect x="2.5" y="5" width="19" height="14" rx="4" />
          <path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor" />
        </svg>
      );
    case 'kick':
      return (
        <svg {...common} fill="currentColor">
          <path d="M4 3h5v5h2V6h2V3h5v6h-2v2h-2v2h2v2h2v6h-5v-3h-2v-2H9v5H4z" />
        </svg>
      );
    default:
      return <Server width={size} height={size} aria-hidden="true" />;
  }
}
