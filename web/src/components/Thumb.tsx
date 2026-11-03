import { useEffect, useState, type ReactNode } from 'react';

/**
 * Image that preloads each new URL and swaps only once it has loaded, so periodic
 * thumbnail refreshes (?t=…) never flash an empty frame.
 */
export function Thumb({
  src,
  alt = '',
  className,
  fallback = null,
}: {
  src: string | null;
  alt?: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setShown(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (!cancelled) setShown(src);
    };
    // On error keep the previous frame (if any).
    img.src = src;
    return () => {
      cancelled = true;
      img.onload = null;
    };
  }, [src]);

  if (!shown) return <>{fallback}</>;
  return <img src={shown} alt={alt} className={className} draggable={false} />;
}
