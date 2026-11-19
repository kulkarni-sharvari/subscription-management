import { Resend } from "resend";

export interface EmailMessage {
    // One recipient, never a list: a message cannot reach more than one person (SEC-045).
    to: string;
    subject: string;
    html: string;
    text: string;
}

export interface EmailService {
    send(message: EmailMessage): Promise<void>;
}

export function createEmailService(config: { apiKey: string; from: string }): EmailService {
    const resend = new Resend(config.apiKey);
    return {
        async send({ to, subject, html, text }) {
            const { error } = await resend.emails.send({ from: config.from, to, subject, html, text });
            // Only the error's name goes into the message: the provider's text can include the
            // recipient's address, and addresses must not reach the logs (SEC-019).
            if (error) throw new Error(`email provider rejected the message (${error.name})`);
        },
    };
}
