/**
 * HTTP-mapped errors. A handler throws one of these; the RPC/route layer turns
 * it into `{ message }` with the matching status. Anything else is a 500.
 */
export class HttpError extends Error {
  constructor(public readonly status: number, message?: string) { super(message); this.name = new.target.name }
}
export class BadRequestError extends HttpError { constructor(message = 'Bad request') { super(400, message) } }
export class UnauthorizedError extends HttpError { constructor(message = 'Unauthorized') { super(401, message) } }
export class ForbiddenError extends HttpError { constructor(message = 'Forbidden') { super(403, message) } }
export class NotFoundError extends HttpError { constructor(message = 'Not found') { super(404, message) } }
export class ConflictError extends HttpError { constructor(message = 'Conflict') { super(409, message) } }
export class UnprocessableContentError extends HttpError { constructor(message = 'Unprocessable content') { super(422, message) } }
export class TooManyRequestsError extends HttpError { constructor(message = 'Too many requests') { super(429, message) } }
export class InternalServerError extends HttpError { constructor(message = 'Internal server error') { super(500, message) } }
export class ServiceUnavailableError extends HttpError { constructor(message = 'Service unavailable') { super(503, message) } }
/** The RPC registry has no function by this name. */
export class RpcNotFoundError extends HttpError { constructor(name: string) { super(404, `RPC '${name}' not found`) } }
/** Refused because the surface exists only in the local Learning runtime. */
export class LocalEnvironmentOnlyError extends HttpError { constructor(message = 'Available only in the local runtime') { super(403, message) } }
