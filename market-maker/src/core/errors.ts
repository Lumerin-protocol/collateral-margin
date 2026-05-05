export class NotImplementedError extends Error {
  constructor(message = "not implemented") {
    super(message);
    this.name = "NotImplementedError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Structured error payload used in /health and risk halt reasons. */
export interface ErrorInfo {
  message: string;
  [key: string]: unknown;
}
