export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export function formatMyanmarTime(epochMs: number): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Yangon',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    return `${formatter.format(new Date(epochMs))} MMT`;
  } catch {
    const mmtMs = epochMs + (6 * 60 + 30) * 60 * 1000;
    return `${new Date(mmtMs).toISOString().replace('T', ' ').slice(0, 19)} MMT`;
  }
}
