import type { ErrorRequestHandler } from "express";
import { AppError } from "../errors.js";

// The only place an error becomes an HTTP response 
// Express recognises an error handler by its four parameters, so `_next` must stay in the list.
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
    // If the response has already started, Express's default handler has to close the connection.
    if (res.headersSent) {
        next(err);
        return;
    }

    // Expected errors carry a message that is safe to show the client.
    if (err instanceof AppError) {
        res.status(err.status).json({
            error: { code: err.code, message: err.message, ...(err.field && { field: err.field }) },
        });
        return;
    }

    // express.json() throws these before any route runs; map them to the documented statuses.
    if (err?.type === "entity.too.large") {
        res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" } });
        return;
    }
    if (err?.type === "entity.parse.failed") {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Malformed JSON body" } });
        return;
    }

    // Anything else is a bug or an infrastructure failure. Log the detail here, server-side only,
    // and never put the message, stack or SQL text in the response. Method and path only: no
    // headers or body, which can hold tokens or personal data (SEC-019).
    console.error("unhandled error", { method: req.method, path: req.path, err });
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
};
