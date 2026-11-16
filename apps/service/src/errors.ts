export class ApiError extends Error {
  readonly params: Record<string, string | number | boolean | null>;
  readonly retryable: boolean;
  readonly currentRevision: number | undefined;

  constructor(
    readonly status: number,
    code: string,
    params: Record<string, string | number | boolean | null> = {},
    retryable = false,
    currentRevision?: number,
  ) {
    super(code);
    this.params = params;
    this.retryable = retryable;
    this.currentRevision = currentRevision;
  }
}

export function errorBody(error: unknown): { status: number; body: Record<string, unknown> } {
  const correlationId = crypto.randomUUID();
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: {
        code: error.message,
        params: error.params,
        retryable: error.retryable,
        correlation_id: correlationId,
        ...(error.currentRevision !== undefined ? { current_revision: error.currentRevision } : {}),
      },
    };
  }
  console.error(error);
  return {
    status: 503,
    body: {
      code: 'UNAVAILABLE',
      params: {},
      retryable: true,
      correlation_id: correlationId,
    },
  };
}
