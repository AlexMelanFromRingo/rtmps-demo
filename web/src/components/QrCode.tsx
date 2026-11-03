import { encode } from 'uqr';
import { useMemo } from 'react';

/** QR code drawn as one SVG path: dark modules on a white card (what scanners expect). */
export function QrCode({ value, size = 200, label }: { value: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 0 });
    let d = '';
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { path: d, n: qr.size };
  }, [value]);
  return (
    <span className="qr" style={{ width: size + 32 }}>
      <svg
        role="img"
        aria-label={label}
        width={size}
        height={size}
        viewBox={`0 0 ${n} ${n}`}
        shapeRendering="crispEdges"
      >
        <path d={path} fill="#0b161c" />
      </svg>
    </span>
  );
}
