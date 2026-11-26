export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export function formatMyanmarTime(epochMs: number, timeZone = 'Asia/Yangon'): string {
  const resolvedTz = timeZone?.trim() || 'Asia/Yangon';
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: resolvedTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const suffix = resolvedTz === 'Asia/Yangon' ? 'MMT' : resolvedTz;
    return `${formatter.format(new Date(epochMs))} ${suffix}`;
  } catch {
    const mmtMs = epochMs + (6 * 60 + 30) * 60 * 1000;
    return `${new Date(mmtMs).toISOString().replace('T', ' ').slice(0, 19)} MMT`;
  }
}
