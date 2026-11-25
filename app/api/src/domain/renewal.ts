import { addBillingPeriod, addDays, daysBetween, type BillingPeriod } from "./billingDates.js";

// An active subscription may be renewed early only this close to its renewal date: the window
// in which the digest reminds the user (FR-050). Earlier, a stray click would move the date on.
export const EARLY_RENEWAL_DAYS = 5;
// "I kept paying" records one payment per missed renewal, at most this many in one action. A longer gap is recorded as a restart.
export const MAX_PAYMENTS_PER_RENEWAL = 24;

export type RenewalInfo =
    | { allowed: false; reason: "inactive" | "one_time" | "too_early"; opensOn?: string }
    | {
          allowed: true;
          // Renewal dates already passed with nothing recorded, oldest first (empty for an early
          // renewal). More than one means the user must say what happened (`missed`).
          missedDates: string[];
          // The next renewal date if the user kept paying through every missed date.
          nextDueIfPaidAll: string;
      };

export interface RenewalState {
    status: "active" | "active-unknown" | "inactive";
    subscriptionType: "recurring" | "one_time";
    billingPeriod: BillingPeriod | null;
    // The current (newest) cycle's due date: the renewal date it runs until.
    currentDue: string;
    // The user's local date.
    today: string;
}

// The renewal dates from `from` onwards that are on or before today.
function datesUpTo(from: string, period: BillingPeriod, today: string): string[] {
    const dates: string[] = [];
    // The cap is a loop guard; the planner refuses more than MAX_PAYMENTS_PER_RENEWAL anyway.
    for (let d = from; d <= today && dates.length <= MAX_PAYMENTS_PER_RENEWAL; d = addBillingPeriod(d, period)) dates.push(d);
    return dates;
}

// What the user may do now; shown on the detail page and checked again by the planner.
export function renewalInfo(s: RenewalState): RenewalInfo {
    if (s.status === "inactive") return { allowed: false, reason: "inactive" };
    if (s.subscriptionType === "one_time" || !s.billingPeriod) return { allowed: false, reason: "one_time" };
    if (daysBetween(s.today, s.currentDue) > EARLY_RENEWAL_DAYS) {
        return { allowed: false, reason: "too_early", opensOn: addDays(s.currentDue, -EARLY_RENEWAL_DAYS) };
    }
    const missedDates = datesUpTo(s.currentDue, s.billingPeriod, s.today);
    const last = missedDates.at(-1) ?? s.currentDue;
    return { allowed: true, missedDates, nextDueIfPaidAll: addBillingPeriod(last, s.billingPeriod) };
}

export type RenewalChoice = { missed?: undefined } | { missed: "paid_all" } | { missed: "restarted"; restartDate: string };

export interface RenewalPlan {
    // The new paid cycles, oldest first; the last one is the next renewal. `catchUp` cycles pay
    // for renewals missed in between: they keep the old cost, payment method and period. Only the
    // newest cycle uses what the user changed (it applies going forward).
    // `paidOn` is the day the payment was made (the renewal date it paid on).
    cycles: Array<{ paidOn: string; dueDate: string; catchUp: boolean }>;
    // Set when the user restarted: the new active streak's start (BR-013).
    newStartDate?: string;
}

export class RenewalRefused extends Error {
    constructor(
        readonly kind: "conflict" | "invalid",
        message: string,
        readonly field?: string,
    ) {
        super(message);
    }
}

// The cycles one "I renewed" creates. `newPeriod` is the billing period from now on (the current
// one if unchanged). Throws RenewalRefused when the action does not apply.
export function planRenewal(s: RenewalState, choice: RenewalChoice, newPeriod?: BillingPeriod): RenewalPlan {
    const info = renewalInfo(s);
    if (!info.allowed) {
        const message = {
            inactive: "This subscription is cancelled. Reactivate it instead.",
            one_time: "A one-time purchase does not renew.",
            too_early: `It can be marked renewed from ${info.opensOn}, ${EARLY_RENEWAL_DAYS} days before its renewal date.`,
        }[info.reason];
        throw new RenewalRefused("conflict", message);
    }
    const period = s.billingPeriod as BillingPeriod;
    const next = newPeriod ?? period;

    if (choice.missed === "restarted") {
        // Only for a renewal date that has passed: the old cycle stays unpaid (due) and a new
        // streak starts on the restart date, paid continuously since then.
        if (info.missedDates.length === 0) throw new RenewalRefused("invalid", "Nothing was missed, so there is no restart to record", "missed");
        if (!(choice.restartDate > s.currentDue && choice.restartDate <= s.today)) {
            throw new RenewalRefused("invalid", `The restart date must be after ${s.currentDue} and not in the future`, "restartDate");
        }
        // The restart is the new plan: every cycle since then uses the new values and period.
        const paid = datesUpTo(choice.restartDate, next, s.today);
        if (paid.length > MAX_PAYMENTS_PER_RENEWAL) throw new RenewalRefused("invalid", "The restart date is too long ago", "restartDate");
        return { cycles: paid.map((d) => ({ paidOn: d, dueDate: addBillingPeriod(d, next), catchUp: false })), newStartDate: choice.restartDate };
    }

    if (info.missedDates.length > 1 && choice.missed !== "paid_all") {
        throw new RenewalRefused("invalid", `${info.missedDates.length} renewal dates have passed. Say whether you kept paying or restarted.`, "missed");
    }
    if (info.missedDates.length > MAX_PAYMENTS_PER_RENEWAL) {
        throw new RenewalRefused("invalid", `More than ${MAX_PAYMENTS_PER_RENEWAL} renewals were missed. Record it as a restart.`, "missed");
    }
    // One payment per missed renewal date (or, early, for the current one). Each pays until the
    // next renewal date; the payment on the newest date runs one new period from it.
    const paidOn = info.missedDates.length > 0 ? info.missedDates : [s.currentDue];
    return {
        cycles: paidOn.map((d, i) =>
            i < paidOn.length - 1 ? { paidOn: d, dueDate: addBillingPeriod(d, period), catchUp: true } : { paidOn: d, dueDate: addBillingPeriod(d, next), catchUp: false },
        ),
    };
}
