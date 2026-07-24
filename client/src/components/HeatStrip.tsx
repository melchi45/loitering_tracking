const STRIP_W = 120; // viewBox units — scales to 100% width via preserveAspectRatio=none

/**
 * Extremely low-height timeline indicator — encodes magnitude as color
 * opacity across a row of thin bars instead of line position (2026-07-22,
 * replacing MultiSparkline's log-scale lines). Line-position encoding needs
 * real vertical room to show movement; squeezed down to fit a compact panel,
 * several overlaid lines become unreadable regardless of axis scale — a
 * small-magnitude series (Rate↑, RTT on LAN) still looks flat next to a
 * large one. Opacity has no such floor: one 4-6px row stays legible, and
 * three stacked rows for a combined metric group are still shorter than a
 * single line chart tall enough to actually read. Self-normalizes per
 * series against its own min/max in the visible window, same as
 * Sparkline.tsx — so scale never has to be chosen or shared across series.
 */
export default function HeatStrip({ values, colorClass, height = 5 }: { values: number[]; colorClass: string; height?: number }) {
  if (values.length < 2) {
    return <svg viewBox={`0 0 ${STRIP_W} ${height}`} className="w-full block" style={{ height }} />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values, min + 1e-6);
  const stepX = STRIP_W / values.length;

  return (
    <svg viewBox={`0 0 ${STRIP_W} ${height}`} preserveAspectRatio="none" className={`w-full block ${colorClass}`} style={{ height }}>
      {values.map((v, i) => {
        const t = (v - min) / (max - min);
        const opacity = 0.12 + t * 0.88; // floor so even the lowest sample stays visible, not invisible-at-0
        return (
          <rect
            key={i}
            x={(i * stepX).toFixed(1)}
            y={0}
            width={(stepX + 0.4).toFixed(1)}
            height={height}
            fill="currentColor"
            fillOpacity={opacity.toFixed(2)}
          />
        );
      })}
    </svg>
  );
}
