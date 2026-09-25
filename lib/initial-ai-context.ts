import { AsyncLocalStorage } from 'node:async_hooks';

/** Only initial-analysis routes install this context. Other explicit capabilities retain their policy. */
export const initialAIContext = new AsyncLocalStorage<{
  attempt: <T>(dispatch: () => Promise<T>) => Promise<T>;
  assertHealthy: () => void;
}>();

export function initialAIAttempt<T>(dispatch: () => Promise<T>): Promise<T> {
  const context = initialAIContext.getStore();
  return context ? context.attempt(dispatch) : dispatch();
}

/** Check before customer persistence/charging when legacy processing may have caught provider errors. */
export function assertInitialAIAdmission(): void {
  initialAIContext.getStore()?.assertHealthy();
}
