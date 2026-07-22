const SPARK_W = 120; // viewBox units — scales to 100% width via preserveAspectRatio=none
const SPARK_H = 16;

/**
 * Small inline timeline graph — one line per metric, zero-baseline, optional
 * threshold reference line. Not a full interactive chart (no crosshair/
 * tooltip): designed to sit in a compact stats readout next to the
 * always-visible current-value text, functioning as a sparkline-augmented
 * stat rather than a primary chart. Extracted from WebRtcStatsPanel.tsx
 * (2026-07-21) so IngestDaemonSection.tsx could reuse it without duplicating
 * the SVG path-building logic.
 */
export default function Sparkline({ values, colorClass, thresholdRatio }: { values: number[]; colorClass: string; thresholdRatio?: number }) {
  if (values.length < 2) {
    return <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} className="w-full block" style={{ height: SPARK_H }} />;
  }
  const max = Math.max(...values, 1);
  const stepX = SPARK_W / (values.length - 1);
  const points = values.map((v, i) => [i * stepX, SPARK_H - (v / max) * SPARK_H] as const);
  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z`;
  const thresholdY = thresholdRatio != null ? SPARK_H - Math.min(1, thresholdRatio) * SPARK_H : null;

  return (
    <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" className={`w-full block ${colorClass}`} style={{ height: SPARK_H }}>
      {thresholdY != null && thresholdY >= 0 && (
        <line x1={0} y1={thresholdY} x2={SPARK_W} y2={thresholdY} stroke="currentColor" strokeOpacity={0.25} strokeWidth={1} strokeDasharray="2,2" />
      )}
      <path d={area} fill="currentColor" fillOpacity={0.18} stroke="none" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
