import { hueFor, initialOf } from '../lib/format';

/** Channel avatar stand-in: initial on a hue derived from the slug. */
export function Monogram({ name, seed, size = 40 }: { name: string; seed: string; size?: number }) {
  const hue = hueFor(seed);
  return (
    <span
      className="monogram"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `hsl(${hue} 38% 26%)`,
        boxShadow: `inset 0 0 0 1px hsl(${hue} 40% 40%)`,
      }}
    >
      {initialOf(name)}
    </span>
  );
}
