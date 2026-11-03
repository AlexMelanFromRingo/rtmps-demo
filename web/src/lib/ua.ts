/** Short, human summary of a User-Agent for the sessions list: "Chrome на Windows". */
export type DeviceKind = 'phone' | 'tablet' | 'desktop' | 'unknown';

export type DeviceSummary = { label: string; kind: DeviceKind };

const BROWSERS: [RegExp, string][] = [
  [/YaBrowser\//, 'Яндекс Браузер'],
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Version\/.*Safari\//, 'Safari'],
  [/OBS\//i, 'OBS'],
  [/curl\//, 'curl'],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows NT/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

export function describeUserAgent(ua: string): DeviceSummary {
  const s = ua || '';
  const browser = BROWSERS.find(([re]) => re.test(s))?.[1] ?? null;
  const os = SYSTEMS.find(([re]) => re.test(s))?.[1] ?? null;
  const kind: DeviceKind = /iPad|Tablet|Android(?!.*Mobile)/.test(s)
    ? 'tablet'
    : /iPhone|Mobile|Android/.test(s)
      ? 'phone'
      : browser || os
        ? 'desktop'
        : 'unknown';
  if (browser && os) return { label: `${browser} на ${os}`, kind };
  if (browser || os) return { label: (browser ?? os)!, kind };
  return { label: s ? s.slice(0, 60) : 'Неизвестное устройство', kind };
}
