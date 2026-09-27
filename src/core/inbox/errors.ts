/** Identifies a failed Inbox operation without naming accounts or amounts. */
export interface InboxErrorContext {
  taskId?: string | null;
  itemKey?: string | null;
  accountId?: string | null;
}

function describeContext(context: InboxErrorContext): string {
  const parts = [
    context.taskId ? `task ${context.taskId}` : null,
    context.itemKey ? `item ${context.itemKey}` : null,
    context.accountId ? `account ${context.accountId}` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

abstract class InboxError extends Error {
  readonly context: InboxErrorContext;
  /** The message without identifiers, safe to show the owner. */
  readonly reason: string;

  constructor(
    message: string,
    context: InboxErrorContext,
    options?: ErrorOptions,
  ) {
    super(`${message}${describeContext(context)}`, options);
    this.context = context;
    this.reason = message;
  }
}

export function isInboxError(error: unknown): error is InboxError {
  return error instanceof InboxError;
}

/** The request no longer matches current state, or is not allowed for it. */
export class InboxConflictError extends InboxError {
  constructor(
    message: string,
    context: InboxErrorContext,
    options?: ErrorOptions,
  ) {
    super(message, context, options);
    this.name = "InboxConflictError";
  }
}

/** The request names a task or account that does not exist. */
export class InboxReferenceError extends InboxError {
  constructor(
    message: string,
    context: InboxErrorContext,
    options?: ErrorOptions,
  ) {
    super(message, context, options);
    this.name = "InboxReferenceError";
  }
}

export class InboxPersistenceError extends InboxError {
  constructor(
    operation: string,
    context: InboxErrorContext,
    options?: ErrorOptions,
  ) {
    super(`Inbox operation failed: ${operation}`, context, options);
    this.name = "InboxPersistenceError";
  }
}

/** A value the owner entered is not allowed, beyond what the schema checks. */
export class InboxValidationError extends InboxError {
  constructor(message: string, context: InboxErrorContext = {}) {
    super(message, context);
    this.name = "InboxValidationError";
  }
}
