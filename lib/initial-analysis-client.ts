import { csrfFetch } from '@/lib/csrf-client';

/** Invoked only by deliberate actions. A stored handoff is consumed once, never read from a URL. */
export async function requestAnalysisIntent(videoId: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const response = await csrfFetch.post('/api/analysis-intents', { videoId }, { signal });
  const data = await response.json();
  signal?.throwIfAborted();
  if (!response.ok || typeof data.flowId !== 'string') {
    throw new Error(data.error || 'Unable to start analysis. Please try again.');
  }
  return data.flowId;
}

export function storeAnalysisIntent(videoId: string, flowId: string): void {
  sessionStorage.setItem(`analysis-intent:${videoId}`, flowId);
}

export function takeAnalysisIntent(videoId: string): string | null {
  const key = `analysis-intent:${videoId}`;
  const flowId = sessionStorage.getItem(key);
  sessionStorage.removeItem(key);
  return flowId;
}
