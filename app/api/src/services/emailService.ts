import { Resend } from "resend";

export interface EmailMessage {
    // One recipient, never a list: a message cannot reach more than one person (SEC-045).
    to: string;
    subject: string;
    html: string;
    text: string;
    // Extra mail headers, only from our own code (never user input): the unsubscribe headers.
    headers?: Record<string, string>;
    // The provider sends a message with the same key only once (kept for 24 hours), so a retry after
    // a failure between "sent" and "recorded" cannot deliver it twice.
    idempotencyKey?: string;
}

export interface EmailService {
    send(message: EmailMessage): Promise<void>;
}

export function createEmailService(config: { apiKey: string; from: string }): EmailService {
    const resend = new Resend(config.apiKey);
    return {
        async send({ to, subject, html, text, headers, idempotencyKey }) {
            const { error } = await resend.emails.send({ from: config.from, to, subject, html, text, headers }, idempotencyKey ? { idempotencyKey } : undefined);
            // Only the error's name goes into the message: the provider's text can include the
            // recipient's address, and addresses must not reach the logs (SEC-019).
            if (error) throw new Error(`email provider rejected the message (${error.name})`);
        },
    };
}
