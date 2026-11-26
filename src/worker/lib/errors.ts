export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly retryable: boolean;

  constructor(message: string, code: string, statusCode: number, retryable = false) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code = 'VALIDATION_ERROR') {
    super(message, code, 400, false);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed', code = 'AUTHENTICATION_ERROR') {
    super(message, code, 401, false);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Permission denied', code = 'AUTHORIZATION_ERROR') {
    super(message, code, 403, false);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code = 'NOT_FOUND') {
    super(message, code, 404, false);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'State conflict detected', code = 'CONFLICT_ERROR', retryable = false) {
    super(message, code, 409, retryable);
  }
}

export class RateLimitError extends AppError {
  public readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds = 15, code = 'RATE_LIMIT_ERROR') {
    super(message, code, 429, true);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ExternalServiceError extends AppError {
  public readonly isUncertainDelivery: boolean;

  constructor(
    message: string,
    options: { retryable?: boolean; isUncertainDelivery?: boolean; code?: string } = {}
  ) {
    super(
      message,
      options.code ?? 'EXTERNAL_SERVICE_ERROR',
      503,
      options.retryable ?? true
    );
    this.isUncertainDelivery = options.isUncertainDelivery ?? false;
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, code = 'DATABASE_ERROR', retryable = true) {
    super(message, code, 503, retryable);
  }
}

export class PermanentProcessingError extends AppError {
  constructor(message: string, code = 'PERMANENT_PROCESSING_ERROR') {
    super(message, code, 200, false);
  }
}
