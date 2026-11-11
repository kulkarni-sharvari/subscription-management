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

export class ForbiddenError extends AppError {
    constructor(){
        super(403, "FORBIDDEN", "Forbidden")
    }
}
