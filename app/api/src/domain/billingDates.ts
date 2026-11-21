export type BillingPeriod = "monthly" | "6_months" | "annually";

const MONTHS_PER_PERIOD: Record<BillingPeriod, number> = {
    monthly: 1,
    "6_months": 6,
    annually: 12,
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// True only for a real calendar date written YYYY-MM-DD ("2026-02-30" is not one).
export function isValidIsoDate(value: string): boolean {
    const match = ISO_DATE.exec(value);
    if (!match) return false;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

// The next due date: start date plus one billing period (BR-003). Dates are plain YYYY-MM-DD strings
// and the arithmetic is on the calendar, not on timestamps, so time zones and daylight saving
// cannot shift the day. When the target month is shorter, the date clamps to its last day
// (31 Jan + 1 month = 28 Feb), which is how most billing systems behave.
export function addBillingPeriod(date: string, period: BillingPeriod): string {
    if (!isValidIsoDate(date)) throw new Error("invalid date");
    const [year, month, day] = date.split("-").map(Number);

    const monthIndex = year * 12 + (month - 1) + MONTHS_PER_PERIOD[period];
    const targetYear = Math.floor(monthIndex / 12);
    const targetMonth = (monthIndex % 12) + 1;
    const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));

    return [targetYear, targetMonth, targetDay].map((n, i) => String(n).padStart(i === 0 ? 4 : 2, "0")).join("-");
}

const DAY_MS = 24 * 60 * 60 * 1000;
const toUtcMs = (date: string) => {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
};
const fromUtcMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Calendar days from one date to another (negative if `to` is earlier). Whole days on the calendar,
// so daylight-saving changes never make a day 23 or 25 hours long here.
export function daysBetween(from: string, to: string): number {
    return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

export function addDays(date: string, days: number): string {
    return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}
