import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export class ExternalServiceError extends Data.TaggedError("ExternalServiceError")<{
  readonly cause: unknown;
  readonly operation: string;
  readonly retryable: boolean;
  readonly service: string;
}> {}

export interface TransientRetryOptions {
  readonly baseDelay?: Duration.Input;
  readonly maxRetries?: number;
}

export const retryTransient = <A, R>(
  program: Effect.Effect<A, ExternalServiceError, R>,
  options: TransientRetryOptions = {}
): Effect.Effect<A, ExternalServiceError, R> =>
  program.pipe(
    Effect.retry({
      schedule: Schedule.exponential(options.baseDelay ?? "100 millis").pipe(Schedule.jittered),
      times: options.maxRetries ?? 2,
      while: (error) => error.retryable,
    })
  );

export const runEffect = <A, E>(
  program: Effect.Effect<A, E>,
  options: Readonly<{ signal?: AbortSignal }> = {}
): Promise<A> => Effect.runPromise(program, options);

export const runEffectExit = <A, E>(
  program: Effect.Effect<A, E>,
  options: Readonly<{ signal?: AbortSignal }> = {}
) => Effect.runPromiseExit(program, options);
