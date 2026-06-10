import { ZodError } from 'zod';

import { redactSensitiveText, redactValue } from './security/redaction.js';

export interface ErrorSuggestion {
  label?: string;
  command?: string;
  details?: string;
}

export interface UserFacingErrorInput {
  code: string;
  message: string;
  command?: string;
  tool?: string;
  parameter?: string;
  received?: unknown;
  expected?: string;
  examples?: readonly string[];
  suggestions?: readonly ErrorSuggestion[];
  nextAction?: string;
  cause?: unknown;
}

export class UserFacingError extends Error {
  readonly code: string;
  readonly command: string | undefined;
  readonly tool: string | undefined;
  readonly parameter: string | undefined;
  readonly received?: unknown;
  readonly expected: string | undefined;
  readonly examples: readonly string[];
  readonly suggestions: readonly ErrorSuggestion[];
  readonly nextAction: string | undefined;

  constructor(input: UserFacingErrorInput) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'UserFacingError';
    this.code = input.code;
    this.command = input.command;
    this.tool = input.tool;
    this.parameter = input.parameter;
    this.received = input.received;
    this.expected = input.expected;
    this.examples = input.examples ?? [];
    this.suggestions = input.suggestions ?? [];
    this.nextAction = input.nextAction;
  }
}

export function userError(input: UserFacingErrorInput): UserFacingError {
  return new UserFacingError(input);
}

export function isUserFacingError(error: unknown): error is UserFacingError {
  return error instanceof UserFacingError;
}

function redactedText(value: unknown): string {
  return redactSensitiveText(String(value ?? ''));
}

function addDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function sanitizedSuggestions(suggestions: readonly ErrorSuggestion[]): ErrorSuggestion[] {
  return suggestions.map((suggestion) => {
    const sanitized: ErrorSuggestion = {};
    if (suggestion.label !== undefined) sanitized.label = redactedText(suggestion.label);
    if (suggestion.command !== undefined) sanitized.command = redactedText(suggestion.command);
    if (suggestion.details !== undefined) sanitized.details = redactedText(suggestion.details);
    return sanitized;
  });
}

function zodParameter(error: ZodError): string | undefined {
  const path = error.issues[0]?.path ?? [];
  return path.length > 0 ? path.map((part) => String(part)).join('.') : undefined;
}

function zodMessage(error: ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return 'Tool input failed validation.';
  const parameter = zodParameter(error);
  const prefix = parameter === undefined ? 'Tool input' : `Parameter ${parameter}`;
  return `${prefix} failed validation: ${first.message}`;
}

function zodIssues(error: ZodError): Array<Record<string, unknown>> {
  return error.issues.slice(0, 5).map((issue) => {
    const item: Record<string, unknown> = {
      code: issue.code,
      message: redactedText(issue.message),
    };
    if (issue.path.length > 0) item.parameter = issue.path.map((part) => String(part)).join('.');
    return item;
  });
}

export function errorPayload(
  error: unknown,
  context: {
    command?: string;
    tool?: string;
    nextAction?: string;
  } = {},
): Record<string, unknown> {
  if (error instanceof ZodError) {
    const errorObject: Record<string, unknown> = {
      code: 'invalid_tool_input',
      message: zodMessage(error),
    };
    addDefined(errorObject, 'command', context.command);
    addDefined(errorObject, 'tool', context.tool);
    addDefined(errorObject, 'parameter', zodParameter(error));
    errorObject.expected = 'Input matching the tool or command schema.';
    errorObject.issues = zodIssues(error);
    return {
      ok: false,
      error: errorObject,
      nextAction: context.nextAction ?? 'Fix the invalid input parameter and retry. Use the tool description or command help for the expected schema.',
    };
  }

  if (isUserFacingError(error)) {
    const errorObject: Record<string, unknown> = {
      code: error.code,
      message: redactedText(error.message),
    };
    addDefined(errorObject, 'command', context.command ?? error.command);
    addDefined(errorObject, 'tool', context.tool ?? error.tool);
    addDefined(errorObject, 'parameter', error.parameter);
    addDefined(errorObject, 'received', error.received === undefined ? undefined : redactValue(error.received));
    addDefined(errorObject, 'expected', error.expected);
    if (error.examples.length > 0) errorObject.examples = error.examples.map(redactedText);
    if (error.suggestions.length > 0) errorObject.suggestions = sanitizedSuggestions(error.suggestions);
    return {
      ok: false,
      error: errorObject,
      nextAction: context.nextAction ?? error.nextAction ?? 'Fix the reported parameter and retry.',
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const errorObject: Record<string, unknown> = {
    code: 'unexpected_error',
    message: redactedText(message),
  };
  addDefined(errorObject, 'command', context.command);
  addDefined(errorObject, 'tool', context.tool);
  return {
    ok: false,
    error: errorObject,
    nextAction: context.nextAction ?? 'Inspect the command/tool inputs, retry with dry-run when available, and use codex_session_manager_help if the correct workflow is unclear.',
  };
}

export function formatCliError(
  error: unknown,
  context: {
    command?: string;
    json?: boolean;
    nextAction?: string;
  } = {},
): string {
  const payloadContext: { command?: string; nextAction?: string } = {};
  if (context.command !== undefined) payloadContext.command = context.command;
  if (context.nextAction !== undefined) payloadContext.nextAction = context.nextAction;
  const payload = errorPayload(error, payloadContext);
  if (context.json === true) return JSON.stringify(payload, null, 2);

  const errorObject = payload.error as Record<string, unknown> | undefined;
  const code = String(errorObject?.code ?? 'error');
  const message = String(errorObject?.message ?? 'Command failed.');
  const lines = [`Error [${code}]: ${message}`];

  for (const key of ['command', 'tool', 'parameter', 'received', 'expected']) {
    const value = errorObject?.[key];
    if (value !== undefined) lines.push(`${key[0]?.toUpperCase()}${key.slice(1)}: ${redactedText(value)}`);
  }

  const examples = errorObject?.examples;
  if (Array.isArray(examples) && examples.length > 0) {
    lines.push('Examples:');
    for (const example of examples) lines.push(`  ${redactedText(example)}`);
  }

  const suggestions = errorObject?.suggestions;
  if (Array.isArray(suggestions) && suggestions.length > 0) {
    lines.push('Suggestions:');
    for (const suggestion of suggestions) {
      if (!suggestion || typeof suggestion !== 'object') continue;
      const record = suggestion as Record<string, unknown>;
      const label = record.label === undefined ? 'Try' : redactedText(record.label);
      const command = record.command === undefined ? '' : `: ${redactedText(record.command)}`;
      const details = record.details === undefined ? '' : ` (${redactedText(record.details)})`;
      lines.push(`  - ${label}${command}${details}`);
    }
  }

  const nextAction = payload.nextAction;
  if (nextAction !== undefined) lines.push(`Next action: ${redactedText(nextAction)}`);
  return lines.join('\n');
}
