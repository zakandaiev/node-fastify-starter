import {
  addToDate,
  convertStringToSeconds,
  differenceInDays,
  getEndOfDay,
  getStartOfDay,
  isExpired,
  isFuture,
  isPast,
  parseStrictUtc,
  toDate,
  toTimestamp,
  toUtcIso,
} from '#utils/date.js';
import { stdout } from 'node:process';

stdout.write(JSON.stringify({
  // The control of the experiment: local midnight differs from zone to zone, so it shows that TZ took effect here.
  localMidnight: new Date(2026, 2, 8).toISOString(),
  results: {
    dateOnly: toDate('2026-03-08'),
    zoneLess: toDate('2026-03-08T02:30:00'),
    freeForm: toDate('Mar 8 2026'),
    offset: toDate('2026-03-08T02:30:00+05:30'),
    timestamp: toTimestamp('2026-03-08'),
    iso: toUtcIso(1772953199999),
    strict: parseStrictUtc('2026-03-08T06:59:59.999+00:00'),
    nextDay: addToDate('2026-03-08T00:00:00Z', '1d'),
    startOfDay: getStartOfDay('2026-03-08T23:30:00Z'),
    endOfDay: getEndOfDay('2026-03-08T00:30:00Z'),
    days: differenceInDays('2026-03-09T00:30:00Z', '2026-03-07T23:30:00Z'),
    seconds: convertStringToSeconds('1d'),
    isPast: isPast('2026-03-08', '2026-03-08T00:00:00.001Z'),
    isFuture: isFuture('2026-03-08', '2026-03-07T23:59:59.999Z'),
    isExpired: isExpired('2026-03-07', '1d', '2026-03-08T00:00:00Z'),
  },
}));
