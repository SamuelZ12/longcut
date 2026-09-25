/**
 * Utility functions for handling promises and background operations
 */

/**
 * Wraps a promise to handle errors gracefully without crashing
 * Returns a tuple of [data, error] similar to Go error handling
 */
export async function safePromise<T>(
  promise: Promise<T>
): Promise<[T | null, Error | null]> {
  try {
    const data = await promise;
    return [data, null];
  } catch (error) {
    return [null, error instanceof Error ? error : new Error(String(error))];
  }
}

/**
 * Executes a background operation with proper error handling
 * Logs errors but doesn't throw them to prevent crashes
 */
export async function backgroundOperation<T>(
  name: string,
  operation: () => Promise<T>,
  onError?: (error: Error) => void
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`Background operation '${name}' failed:`, err);
    onError?.(err);
    return null;
  }
}

/**
 * Creates a timeout-wrapped promise with AbortController support
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller?: AbortController
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      controller?.abort();
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

/**
 * Manages multiple AbortControllers with cleanup
 */
export class AbortManager {
  private controllers = new Map<string, AbortController>();
  private timeouts = new Map<string, NodeJS.Timeout>();

  createController(key: string, timeoutMs?: number, timeoutReason?: unknown): AbortController {
    // Cleanup existing controller if any
    this.cleanup(key);

    const controller = new AbortController();
    this.controllers.set(key, controller);

    if (timeoutMs) {
      const timeoutId = setTimeout(() => {
        controller.abort(timeoutReason);
        this.controllers.delete(key);
        this.timeouts.delete(key);
      }, timeoutMs);
      this.timeouts.set(key, timeoutId);
    }

    return controller;
  }

  cleanup(key?: string) {
    if (key) {
      const controller = this.controllers.get(key);
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }
      this.controllers.delete(key);

      const timeoutId = this.timeouts.get(key);
      if (timeoutId) {
        clearTimeout(timeoutId);
        this.timeouts.delete(key);
      }
    } else {
      // Cleanup all
      for (const [k] of this.controllers) {
        this.cleanup(k);
      }
    }
  }

  getSignal(key: string): AbortSignal | undefined {
    return this.controllers.get(key)?.signal;
  }
}
