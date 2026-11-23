export class AppError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly field?: string,
    ) {
        super(message);
    }
}

export class ValidationError extends AppError {
    constructor(message: string, field?:string){
        super(400, "VALIDATION_ERROR", message, field)
    }
}

export class UnauthorizedError extends AppError {
    constructor(){
        super(401, "UNAUTHORIZED", "Authentication required")
    }
}

export class NotFoundError extends AppError {
    constructor(){
        super(404, "NOT_FOUND", "Not found")
    }
}

// The request is valid, but the resource's current state does not allow it (for example renewing
// a cancelled subscription).
export class ConflictError extends AppError {
    constructor(message: string) {
        super(409, "CONFLICT", message)
    }
}

export class ForbiddenError extends AppError {
    constructor(){
        super(403, "FORBIDDEN", "Forbidden")
    }
}

export class RateLimitedError extends AppError {
    constructor(){
        super(429, "RATE_LIMITED", "Too many requests. Try again later")
    }
}

// The API is healthy but cannot get a database connection in time (the pool is exhausted).
export class ServiceUnavailableError extends AppError {
    constructor(){
        super(503, "SERVICE_UNAVAILABLE", "The service is busy. Try again in a moment")
    }
}
