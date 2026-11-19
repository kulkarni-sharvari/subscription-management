import { z } from "zod";
import { ValidationError } from "./errors.js";

// generic validation helper using Zod. Validates input with zod schema.
// Parses a request body, query or other input against a schema. On failure it throws the 400 with the first problem and, when there is one, the field it belongs to.
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
    const result = schema.safeParse(input);
    if (!result.success) {
        const issue = result.error.issues[0];
        throw new ValidationError(issue.message, issue.path.join(".") || undefined);
    }
    return result.data;
}
