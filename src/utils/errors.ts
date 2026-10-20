/**
 * Every error the API can return, mapped to an HTTP status code.
 * Clients can branch on `error.code` without parsing prose.
 */
export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNPROCESSABLE_ENTITY: "UNPROCESSABLE_ENTITY",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

/**
 * Operational error raised by application code. Anything that is not an ApiError is
 * treated as an unexpected failure: logged with a stack trace and reported to the
 * client as a generic 500.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly isOperational = true;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, ErrorCode.VALIDATION_ERROR, message, details);
  }

  static unprocessableEntity(message: string, details?: unknown): ApiError {
    return new ApiError(422, ErrorCode.UNPROCESSABLE_ENTITY, message, details);
  }

  static unauthorized(message = "Authentication required"): ApiError {
    return new ApiError(401, ErrorCode.UNAUTHORIZED, message);
  }

  static invalidCredentials(message = "Invalid email or password"): ApiError {
    return new ApiError(401, ErrorCode.UNAUTHORIZED, message);
  }

  static forbidden(
    message = "You do not have permission to perform this action",
  ): ApiError {
    return new ApiError(403, ErrorCode.FORBIDDEN, message);
  }

  static notFound(message = "Resource not found"): ApiError {
    return new ApiError(404, ErrorCode.NOT_FOUND, message);
  }

  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError(409, ErrorCode.CONFLICT, message, details);
  }

  static serviceUnavailable(
    message = "Service temporarily unavailable",
    details?: unknown,
  ): ApiError {
    return new ApiError(503, ErrorCode.SERVICE_UNAVAILABLE, message, details);
  }

  static internal(message = "Internal server error"): ApiError {
    return new ApiError(500, ErrorCode.INTERNAL_ERROR, message);
  }
}
