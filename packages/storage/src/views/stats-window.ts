export type StatsPeriod = '7d' | '30d' | 'all';
const day = 24 * 60 * 60 * 1000;

function formatter(timezone: string) {
  if (typeof timezone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+./-]{0,99}$/u.test(timezone)) throw new Error('STATS_TIMEZONE_INVALID');
  try {
    return new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric' });
  } catch {
    throw new Error('STATS_TIMEZONE_INVALID');
  }
}

function civilDay(format: Intl.DateTimeFormat, instant: number): number {
  const parts = format.formatToParts(instant);
  const get = (type: 'year' | 'month' | 'day') => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'));
}

function startOfDay(format: Intl.DateTimeFormat, localDay: number): string {
  // Match the civil boundary using the zone database. Offsets can change between the two ends of one window.
  let low = localDay - 36 * 60 * 60 * 1000;
  let high = localDay + 36 * 60 * 60 * 1000;
  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (civilDay(format, middle) < localDay) low = middle;
    else high = middle;
  }
  return new Date(high).toISOString();
}

export function statsWindow(period: StatsPeriod, timezone: string, cutoff: string, availableSince: string) {
  if (period !== '7d' && period !== '30d' && period !== 'all') throw new Error('STATS_PERIOD_INVALID');
  const format = formatter(timezone);
  const today = civilDay(format, Date.parse(cutoff));
  return {
    window_start: period === 'all' ? availableSince : startOfDay(format, today - (period === '7d' ? 6 : 29) * day),
    window_end: startOfDay(format, today + day),
    today_start: startOfDay(format, today),
    timezone,
  };
}
