import type { SubscriptionDetail } from "../repositories/subscriptionRepository.js";

// Makes text safe to place inside HTML. Every value that came from a user goes through this
// before it enters an email body (SEC-047): a name like <img onerror=...> must arrive as text.
export function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

const PERIOD_LABEL = { monthly: "Monthly", "6_months": "Every 6 months", annually: "Annually" } as const;
const METHOD_LABEL = { credit_card: "Credit card", debit_card: "Debit card", apple_pay: "Apple Pay" } as const;

export interface EmailContent {
    subject: string;
    html: string;
    text: string;
}

export const MAX_LISTED = 20;

// The rows describing one subscription.
function detailRows(sub: SubscriptionDetail): Array<[string, string]> {
    const period = sub.billingPeriod ? PERIOD_LABEL[sub.billingPeriod] : "One-time purchase";
    const rows: Array<[string, string]> = [
        ["Name", sub.name],
        ["Category", sub.category],
        ["Cost", sub.cost.toFixed(2)],
        ["Billing", period],
        ["Start date", sub.startDate],
        [sub.billingPeriod ? "Next renewal" : "Due", sub.currentCycle?.dueDate ?? ""],
        ["Payment method", METHOD_LABEL[sub.paymentMethod.type]],
    ];
    if (sub.renewalLink) rows.push(["Renewal link", sub.renewalLink]);
    if (sub.cancellationLink) rows.push(["Cancellation link", sub.cancellationLink]);
    return rows;
}

const htmlTable = (rows: Array<[string, string]>) =>
    `<table>` +
    rows.map(([label, value]) => `<tr><td><strong>${escapeHtml(label)}</strong></td><td>${escapeHtml(value)}</td></tr>`).join("") +
    `</table>`;

// The "subscription added" email (FR-013): one email per user action, however many subscriptions
// that action created. A manual add sends one subscription; an import sends many in one message.
export function subscriptionsAddedEmail(subs: SubscriptionDetail[]): EmailContent {
    if (subs.length === 0) throw new Error("no subscriptions to describe");
    const listed = subs.slice(0, MAX_LISTED);
    const omitted = subs.length - listed.length;

    // The subject has no line breaks to inject: names are validated to contain no control characters.
    const subject = subs.length === 1 ? `Subscription added: ${subs[0].name}` : `${subs.length} subscriptions added`;
    const intro = subs.length === 1 ? "Your subscription was added." : `${subs.length} subscriptions were added.`;
    const more = omitted > 0 ? `...and ${omitted} more. Open the app to see them all.` : "";

    const html = `<p>${intro}</p>` + listed.map((sub) => htmlTable(detailRows(sub))).join("<br>") + (more ? `<p>${escapeHtml(more)}</p>` : "");
    const text = [
        intro,
        ...listed.flatMap((sub) => ["", ...detailRows(sub).map(([label, value]) => `${label}: ${value}`)]),
        ...(more ? ["", more] : []),
    ].join("\n");
    return { subject, html, text };
}

// One subscription in a renewal digest.
export interface DigestItem {
    name: string;
    cost: number;
    billingPeriod: keyof typeof PERIOD_LABEL;
    dueDate: string;
    daysLeft: number;
    paymentMethodType: keyof typeof METHOD_LABEL;
    renewalLink: string | null;
}

const inDays = (days: number) => (days === 1 ? "tomorrow" : `in ${days} days`);
const daysAgo = (days: number) => (days === 1 ? "1 day ago" : `${days} days ago`);
const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

// One subscription in the "Needs action" section: its renewal date passed with no renewal or
// cancellation recorded, so it is active-unknown (Story 5).
export interface OverdueItem {
    name: string;
    cost: number;
    billingPeriod: keyof typeof PERIOD_LABEL;
    dueDate: string;
    daysOverdue: number;
    paymentMethodType: keyof typeof METHOD_LABEL;
    renewalLink: string | null;
}

// The daily digest (Stories 4 and 5, FR-050, BR-008, FR-053): one email per user per day with up
// to two sections, "Needs action" (renewal date passed, nothing recorded) and "Renews soon" (the
// next 1 to 5 days). Same rules as above: one recipient, every value escaped, a listing cap.
export function renewalDigestEmail(items: DigestItem[], overdue: OverdueItem[] = []): EmailContent {
    if (items.length === 0 && overdue.length === 0) throw new Error("no subscriptions to describe");
    // The cap covers both sections together; "Needs action" comes first.
    const listedOverdue = overdue.slice(0, MAX_LISTED);
    const listedSoon = items.slice(0, MAX_LISTED - listedOverdue.length);
    const omitted = overdue.length + items.length - listedOverdue.length - listedSoon.length;

    // The subject has no line breaks to inject: names are validated to contain no control characters.
    let subject: string;
    if (overdue.length === 0) subject = items.length === 1 ? `Renews ${inDays(items[0].daysLeft)}: ${items[0].name}` : `${items.length} subscriptions renew soon`;
    else if (items.length === 0) subject = overdue.length === 1 ? `Did it renew? ${overdue[0].name}` : `${overdue.length} subscriptions need action`;
    else subject = `${count(overdue.length, "subscription needs", "subscriptions need")} action, ${count(items.length, "renews", "renew")} soon`;

    const sections: Array<{ heading: string; intro: string; rows: Array<Array<[string, string]>> }> = [];
    if (listedOverdue.length > 0) {
        sections.push({
            heading: "Needs action",
            intro: "The renewal date passed and you have not recorded whether you renewed or cancelled. Open the app to update them.",
            rows: listedOverdue.map((item) => {
                const list: Array<[string, string]> = [
                    ["Name", item.name],
                    ["Renewal date", `${item.dueDate} (${daysAgo(item.daysOverdue)})`],
                    ["Cost", item.cost.toFixed(2)],
                    ["Billing", PERIOD_LABEL[item.billingPeriod]],
                    ["Payment method", METHOD_LABEL[item.paymentMethodType]],
                ];
                if (item.renewalLink) list.push(["Renewal link", item.renewalLink]);
                return list;
            }),
        });
    }
    if (listedSoon.length > 0) {
        sections.push({
            heading: "Renews soon",
            intro: items.length === 1 ? "One of your subscriptions renews soon. Decide whether to keep it." : `${items.length} of your subscriptions renew soon. Decide which to keep.`,
            rows: listedSoon.map((item) => {
                const list: Array<[string, string]> = [
                    ["Name", item.name],
                    ["Renews", `${item.dueDate} (${inDays(item.daysLeft)})`],
                    ["Cost", item.cost.toFixed(2)],
                    ["Billing", PERIOD_LABEL[item.billingPeriod]],
                    ["Payment method", METHOD_LABEL[item.paymentMethodType]],
                ];
                if (item.renewalLink) list.push(["Renewal link", item.renewalLink]);
                return list;
            }),
        });
    }
    const more = omitted > 0 ? `...and ${omitted} more. Open the app to see them all.` : "";

    const html =
        sections
            .map((s) => `<h2>${escapeHtml(s.heading)}</h2><p>${escapeHtml(s.intro)}</p>` + s.rows.map(htmlTable).join("<br>"))
            .join("") + (more ? `<p>${escapeHtml(more)}</p>` : "");
    const text = [
        ...sections.flatMap((s, i) => [
            ...(i > 0 ? [""] : []),
            s.heading.toUpperCase(),
            s.intro,
            ...s.rows.flatMap((rows) => ["", ...rows.map(([label, value]) => `${label}: ${value}`)]),
        ]),
        ...(more ? ["", more] : []),
    ].join("\n");
    return { subject, html, text };
}

// The status-change email for "I renewed" (Story 6, FR-034): sent once per action, and only when
// the status changed (active-unknown -> active).
export function subscriptionRenewedEmail(sub: SubscriptionDetail, payments: number): EmailContent {
    const subject = `Renewal recorded: ${sub.name}`;
    const intro =
        payments === 1
            ? "You recorded a renewal. The subscription is active again."
            : `You recorded ${payments} payments. The subscription is active again.`;
    const rows: Array<[string, string]> = [
        ["Name", sub.name],
        ["Cost", sub.cost.toFixed(2)],
        ["Billing", sub.billingPeriod ? PERIOD_LABEL[sub.billingPeriod] : "One-time purchase"],
        ["Next renewal", sub.currentCycle?.dueDate ?? ""],
        ["Payment method", METHOD_LABEL[sub.paymentMethod.type]],
    ];
    const html = `<p>${escapeHtml(intro)}</p>` + htmlTable(rows);
    const text = [intro, "", ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n");
    return { subject, html, text };
}

// The status-change email for "I cancelled" (Story 7, FR-034): one per action.
export function subscriptionCancelledEmail(sub: SubscriptionDetail): EmailContent {
    const subject = `Cancellation recorded: ${sub.name}`;
    const intro = "You recorded a cancellation. The subscription is now inactive: no more reminders, and its history is kept.";
    const rows: Array<[string, string]> = [
        ["Name", sub.name],
        ["Cost", sub.cost.toFixed(2)],
        ["Billing", sub.billingPeriod ? PERIOD_LABEL[sub.billingPeriod] : "One-time purchase"],
        ["Cancelled on", sub.cancelledOn ?? ""],
    ];
    const html = `<p>${escapeHtml(intro)}</p>` + htmlTable(rows);
    const text = [intro, "", ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n");
    return { subject, html, text };
}

