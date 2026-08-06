import * as Data from "effect/Data";

export class PinError extends Data.TaggedError("PinError")<{
  readonly message: string;
}> {}

export class LimitsError extends Data.TaggedError("LimitsError")<{
  readonly message: string;
  readonly limit: string;
}> {}

export class HashError extends Data.TaggedError("HashError")<{
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}> {}

export class TransportError extends Data.TaggedError("TransportError")<{
  readonly message: string;
  readonly code?: string;
  readonly retryable?: boolean;
}> {}

export class TicketError extends Data.TaggedError("TicketError")<{
  readonly message: string;
}> {}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
}> {}

export class RelayCapError extends Data.TaggedError("RelayCapError")<{
  readonly message: string;
  readonly bytesUsed: number;
  readonly capBytes: number;
}> {}

export class FileWriteError extends Data.TaggedError("FileWriteError")<{
  readonly message: string;
  readonly path?: string;
}> {}
