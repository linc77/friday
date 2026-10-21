export class SourceControlHTTPError extends Error {
  readonly retryAt?: number; readonly rateLimited?: boolean;
  constructor(readonly status: number, message: string, options: { retryAt?: number; rateLimited?: boolean } = {}) { super(message); this.retryAt = options.retryAt; this.rateLimited = options.rateLimited; }
}
export class SourceControlResponseTooLarge extends Error { constructor() { super('Source Control 返回内容过大'); } }
