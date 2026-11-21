// A user's time zone decides which calendar day it is for them, and when their morning is.
// Zones are IANA names (America/New_York, Asia/Kolkata), the form browsers report.

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

// True only for a zone the runtime knows. The name is checked for shape first, so a value such as
// "../etc" or a long string never reaches the Intl API.
export function isValidTimeZone(value: string): boolean {
    if (value.length > 64 || !ZONE_NAME.test(value)) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

// The calendar date (YYYY-MM-DD) and hour (0-23) at `moment` in the given zone.
export function localDateAndHour(moment: Date, timeZone: string): { date: string; hour: number } {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
    }).formatToParts(moment);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}
