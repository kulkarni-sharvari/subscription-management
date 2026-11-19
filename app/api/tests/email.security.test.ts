// Email safety (SEC-019, SEC-045, SEC-047): escaping, one recipient, and no address in errors.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { escapeHtml, MAX_LISTED, subscriptionsAddedEmail } from "../src/email/templates.js";
import type { SubscriptionDetail } from "../src/repositories/subscriptionRepository.js";
import type { EmailMessage } from "../src/services/emailService.js";
import { createNotificationService } from "../src/services/notificationService.js";

const send = vi.fn();
vi.mock("resend", () => ({ Resend: class { emails = { send }; } }));

const subscription = (over: Partial<SubscriptionDetail> = {}): SubscriptionDetail => ({
    id: "s1", name: "Netflix", category: "Entertainment", cost: 15.49, billingPeriod: "monthly", subscriptionType: "recurring",
    status: "active", autoRenews: true, paymentMethod: { id: "p1", type: "credit_card" },
    currentCycle: { dueDate: "2026-10-08", status: "paid" }, renewalLink: null, cancellationLink: null,
    startDate: "2026-09-08", createdAt: new Date(), updatedAt: new Date(), ...over,
});

describe("SEC-047: user-controlled values are escaped in the email body", () => {
    it.each([
        ["<img src=x onerror=alert(1)>", "&lt;img src=x onerror=alert(1)&gt;"],
        ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
        ['"><a href="https://evil.example">x</a>', "&quot;&gt;&lt;a href=&quot;https://evil.example&quot;&gt;x&lt;/a&gt;"],
        ["Tom & Jerry's", "Tom &amp; Jerry&#39;s"],
    ])("escapes %j", (input, expected) => {
        expect(escapeHtml(input)).toBe(expected);
    });

    it("no markup from the name, category or links survives into the HTML", () => {
        const evil = "<img src=x onerror=alert(1)>";
        const { html } = subscriptionsAddedEmail([
            subscription({ name: evil, category: evil, renewalLink: `https://example.com/"><script>1</script>`, cancellationLink: "https://example.com/?a=1&b=<b>" }),
        ]);
        expect(html).not.toMatch(/<img|<script|<b>|onerror=alert\(1\)>/);
        expect(html).toContain("&lt;img");
    });

    it("the subject has no line break to inject another header", () => {
        expect(subscriptionsAddedEmail([subscription()]).subject).not.toMatch(/[\r\n]/);
    });

    it("a one-time purchase reads as one, with no renewal wording", () => {
        const { text } = subscriptionsAddedEmail([subscription({ subscriptionType: "one_time", billingPeriod: null })]);
        expect(text).toContain("One-time purchase");
        expect(text).not.toContain("Next renewal");
    });
});

describe("one email per user action, however many subscriptions it added", () => {
    it("a single subscription keeps the single-subscription subject", () => {
        expect(subscriptionsAddedEmail([subscription()]).subject).toBe("Subscription added: Netflix");
    });

    it("several subscriptions arrive in one email, each listed, with a count in the subject", () => {
        const { subject, text, html } = subscriptionsAddedEmail([
            subscription({ name: "Netflix" }), subscription({ name: "Spotify" }), subscription({ name: "Gym" }),
        ]);
        expect(subject).toBe("3 subscriptions added");
        for (const name of ["Netflix", "Spotify", "Gym"]) {
            expect(text).toContain(`Name: ${name}`);
            expect(html).toContain(name);
        }
    });

    it("a huge import is capped: the email lists the first ones and counts the rest", () => {
        const many = Array.from({ length: MAX_LISTED + 5 }, (_, i) => subscription({ name: `Sub${i}` }));
        const { text, subject } = subscriptionsAddedEmail(many);
        expect(subject).toBe(`${many.length} subscriptions added`);
        expect(text).toContain(`Name: Sub${MAX_LISTED - 1}`);
        expect(text).not.toContain(`Name: Sub${MAX_LISTED}`);
        expect(text).toContain("and 5 more");
    });

    it("sends exactly one message for a batch, to one recipient", async () => {
        const email = { send: vi.fn(async (_message: EmailMessage) => {}) };
        const profiles = { findById: async (id: string) => ({ id, email: `${id}@example.com`, createdAt: new Date() }) };
        await createNotificationService({ profiles, email }).subscriptionsAdded("user-a", [subscription(), subscription({ name: "Spotify" })]);
        expect(email.send).toHaveBeenCalledTimes(1);
        expect(email.send.mock.calls[0][0].to).toBe("user-a@example.com");
    });

    it("sends nothing for an empty batch", async () => {
        const email = { send: vi.fn(async () => {}) };
        const profiles = { findById: async (id: string) => ({ id, email: "a@example.com", createdAt: new Date() }) };
        await createNotificationService({ profiles, email }).subscriptionsAdded("user-a", []);
        expect(email.send).not.toHaveBeenCalled();
    });

    it("markup in any subscription of a batch is still escaped", () => {
        const { html } = subscriptionsAddedEmail([subscription(), subscription({ name: "<script>1</script>" })]);
        expect(html).not.toContain("<script>");
    });
});

describe("SEC-045: one message, one recipient, resolved from the same user id", () => {
    it("sends to the address of the user the subscription belongs to, and no one else", async () => {
        const email = { send: vi.fn(async (_message: EmailMessage) => {}) };
        const profiles = { findById: vi.fn(async (id: string) => ({ id, email: `${id}@example.com`, createdAt: new Date() })) };
        await createNotificationService({ profiles, email }).subscriptionsAdded("user-a", [subscription()]);
        expect(profiles.findById).toHaveBeenCalledWith("user-a");
        expect(email.send).toHaveBeenCalledTimes(1);
        expect(email.send.mock.calls[0][0].to).toBe("user-a@example.com");
        expect(typeof email.send.mock.calls[0][0].to).toBe("string");
    });

    it("sends nothing when the account no longer exists", async () => {
        const email = { send: vi.fn(async () => {}) };
        await createNotificationService({ profiles: { findById: async () => null }, email }).subscriptionsAdded("gone", [subscription()]);
        expect(email.send).not.toHaveBeenCalled();
    });
});

describe("SEC-019: the provider's error text, which can contain the address, never leaves the email service", () => {
    beforeEach(() => send.mockReset());

    it("throws only the error's name", async () => {
        const { createEmailService } = await import("../src/services/emailService.js");
        send.mockResolvedValue({
            data: null,
            error: { name: "validation_error", message: "You can only send testing emails to your own email address (someone@example.com)." },
        });
        const service = createEmailService({ apiKey: "re_test", from: "App <a@example.com>" });
        const failure = await service.send({ to: "someone@example.com", subject: "s", html: "h", text: "t" }).catch((e: Error) => e);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe("email provider rejected the message (validation_error)");
        expect((failure as Error).message).not.toContain("someone@example.com");
    });

    it("passes a single recipient string to the provider", async () => {
        const { createEmailService } = await import("../src/services/emailService.js");
        send.mockResolvedValue({ data: { id: "1" }, error: null });
        await createEmailService({ apiKey: "re_test", from: "App <a@example.com>" }).send({ to: "me@example.com", subject: "s", html: "h", text: "t" });
        expect(send.mock.calls[0][0].to).toBe("me@example.com");
    });
});
