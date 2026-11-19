import { describe, expect, it } from "vitest";
import { addBillingPeriod, isValidIsoDate } from "../src/domain/billingDates.js";

describe("BR-003: the due date is derived from the start date and the billing period", () => {
    it.each([
        ["2026-01-15", "monthly", "2026-02-15"],
        ["2026-01-15", "6_months", "2026-07-15"],
        ["2026-01-15", "annually", "2027-01-15"],
        // The year rolls over.
        ["2026-12-10", "monthly", "2027-01-10"],
        ["2026-08-20", "6_months", "2027-02-20"],
    ] as const)("%s + %s = %s", (start, period, expected) => {
        expect(addBillingPeriod(start, period)).toBe(expected);
    });

    it.each([
        // A shorter target month clamps to its last day.
        ["2026-01-31", "monthly", "2026-02-28"],
        ["2024-01-31", "monthly", "2024-02-29"], // leap year
        ["2026-03-31", "monthly", "2026-04-30"],
        ["2026-08-31", "6_months", "2027-02-28"],
        ["2024-02-29", "annually", "2025-02-28"], // 29 Feb has no next-year twin
        ["2026-05-31", "6_months", "2026-11-30"],
    ] as const)("clamps month ends: %s + %s = %s", (start, period, expected) => {
        expect(addBillingPeriod(start, period)).toBe(expected);
    });

    it("does not depend on the machine's time zone", () => {
        const original = process.env.TZ;
        try {
            for (const tz of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
                process.env.TZ = tz;
                expect(addBillingPeriod("2026-03-01", "monthly")).toBe("2026-04-01");
                expect(addBillingPeriod("2026-10-31", "monthly")).toBe("2026-11-30");
            }
        } finally {
            process.env.TZ = original;
        }
    });

    it("rejects an invalid date instead of guessing", () => {
        expect(() => addBillingPeriod("2026-02-30", "monthly")).toThrow();
        expect(() => addBillingPeriod("not-a-date", "monthly")).toThrow();
    });
});

describe("isValidIsoDate", () => {
    it.each(["2026-01-01", "2024-02-29", "2000-12-31"])("accepts %s", (value) => expect(isValidIsoDate(value)).toBe(true));
    it.each(["2026-02-30", "2026-13-01", "2026-00-10", "2025-02-29", "26-01-01", "2026-1-1", "2026-01-01T00:00:00Z", "", " 2026-01-01", "2026/01/01"])(
        "rejects %j",
        (value) => expect(isValidIsoDate(value)).toBe(false),
    );
});
