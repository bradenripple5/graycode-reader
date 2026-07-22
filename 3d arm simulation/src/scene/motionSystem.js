export function createMotionSystem() {
  return {
    createBlend(start, end, durationSec = 0.25) {
      return {
        start: [...start],
        end: [...end],
        durationSec: Math.max(0.001, Number(durationSec) || 0.25),
        startedAtMs: Date.now(),
      };
    },
    sampleBlend(blend, nowMs = Date.now()) {
      if (!blend) return null;
      const t = Math.min(1, Math.max(0, (nowMs - blend.startedAtMs) / (blend.durationSec * 1000)));
      const values = blend.start.map((v, i) => v + (blend.end[i] - v) * t);
      return { values, done: t >= 1 };
    },
  };
}
