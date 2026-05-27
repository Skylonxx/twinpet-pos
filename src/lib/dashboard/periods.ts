import type { DashboardPeriod, PeriodBounds } from './types';

export const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  today: 'วันนี้',
  week: '7 วันล่าสุด',
  month: '30 วันล่าสุด',
};

export const PERIOD_COMPARE_LABELS: Record<DashboardPeriod, string> = {
  today: 'vs เมื่อวาน',
  week: 'vs 7 วันก่อนหน้า',
  month: 'vs 30 วันก่อนหน้า',
};

export const TREND_TITLES: Record<DashboardPeriod, string> = {
  today: 'ยอดขาย vs กำไร รายชั่วโมง',
  week: 'ยอดขาย vs กำไร รายวัน (7 วัน)',
  month: 'ยอดขาย vs กำไร รายวัน (30 วัน)',
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Compute current/previous period windows in local time.
 * - today: calendar day vs yesterday
 * - week: rolling 7 days (inclusive) vs prior 7 days
 * - month: rolling 30 days (inclusive) vs prior 30 days
 */
export function getPeriodBounds(period: DashboardPeriod, now = new Date()): PeriodBounds {
  const end = endOfDay(now);

  if (period === 'today') {
    const start = startOfDay(now);
    const prevEnd = new Date(start.getTime() - 1);
    const prevStart = startOfDay(prevEnd);
    return { start, end, prevStart, prevEnd, fetchStart: prevStart };
  }

  if (period === 'week') {
    const start = startOfDay(addDays(now, -6));
    const prevEnd = endOfDay(addDays(start, -1));
    const prevStart = startOfDay(addDays(prevEnd, -6));
    return { start, end, prevStart, prevEnd, fetchStart: prevStart };
  }

  const start = startOfDay(addDays(now, -29));
  const prevEnd = endOfDay(addDays(start, -1));
  const prevStart = startOfDay(addDays(prevEnd, -29));
  return { start, end, prevStart, prevEnd, fetchStart: prevStart };
}

export function isWithinRange(date: Date, start: Date, end: Date): boolean {
  return date >= start && date <= end;
}

/** Iterate each calendar day between start and end (inclusive), local time */
export function eachCalendarDay(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const cursor = startOfDay(start);
  const last = startOfDay(end);
  while (cursor <= last) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}
