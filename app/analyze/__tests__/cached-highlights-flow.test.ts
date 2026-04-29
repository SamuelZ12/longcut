import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const pageSource = readFileSync(
  join(process.cwd(), 'app/analyze/[videoId]/page.tsx'),
  'utf8'
);

function getHandleGenerateHighlightsSource(): string {
  const start = pageSource.indexOf('const handleGenerateHighlights = useCallback');
  assert.notEqual(start, -1, 'Expected handleGenerateHighlights callback to exist');

  const end = pageSource.indexOf('const handleThemeSelect = useCallback', start);
  assert.notEqual(end, -1, 'Expected handleThemeSelect callback after handleGenerateHighlights');

  return pageSource.slice(start, end);
}

test('cached highlight payload is stored without displaying topics on cached load', () => {
  assert.match(pageSource, /const cachedHighlightPayloadRef = useRef<CachedHighlightPayload \| null>\(null\)/);
  assert.doesNotMatch(pageSource, /const \[cachedHighlightPayload, setCachedHighlightPayload\] = useState/);

  const cachedLoadStart = pageSource.indexOf('if (cacheData.cached)');
  assert.notEqual(cachedLoadStart, -1, 'Expected cached-video load branch to exist');

  const cachedLoadSource = pageSource.slice(cachedLoadStart, cachedLoadStart + 8000);
  assert.match(cachedLoadSource, /cachedHighlightPayloadRef\.current =/);

  const storeIndex = cachedLoadSource.indexOf('cachedHighlightPayloadRef.current =');
  const returnIndex = cachedLoadSource.indexOf('return; // Exit early - no need to fetch anything else');
  assert.ok(storeIndex > -1 && returnIndex > -1 && storeIndex < returnIndex);

  const beforeReturnSource = cachedLoadSource.slice(0, returnIndex);
  assert.doesNotMatch(beforeReturnSource, /setTopics\(cacheData\.topics\)/);
  assert.doesNotMatch(beforeReturnSource, /setBaseTopics\(cacheData\.topics\)/);
});

test('generate highlights reveals cached topics locally before calling video-analysis', () => {
  const handleSource = getHandleGenerateHighlightsSource();

  assert.match(handleSource, /const cachedHighlightPayload = cachedHighlightPayloadRef\.current/);
  assert.match(handleSource, /applyHighlightResponse\(cachedHighlightPayload/);
  assert.match(handleSource, /cachedHighlightPayloadRef\.current = null/);

  const cachedRevealIndex = handleSource.indexOf('applyHighlightResponse(cachedHighlightPayload');
  const fetchIndex = handleSource.indexOf('fetch("/api/video-analysis"');
  assert.ok(cachedRevealIndex > -1 && fetchIndex > -1 && cachedRevealIndex < fetchIndex);
});

test('cached reveal skips suggested question generation when cached questions exist', () => {
  const handleSource = getHandleGenerateHighlightsSource();
  const cachedRevealIndex = handleSource.indexOf('applyHighlightResponse(cachedHighlightPayload');
  assert.notEqual(cachedRevealIndex, -1, 'Expected cached reveal branch to apply cached highlights');

  const cachedRevealSource = handleSource.slice(cachedRevealIndex, handleSource.indexOf('const requestKey', cachedRevealIndex));
  assert.match(cachedRevealSource, /cachedSuggestedQuestions\?\.length/);
  assert.match(cachedRevealSource, /generateSuggestedQuestionsForTopics\(generatedTopics, transcript, videoInfo\)/);

  const guardIndex = cachedRevealSource.indexOf('cachedSuggestedQuestions?.length');
  const generateIndex = cachedRevealSource.indexOf('generateSuggestedQuestionsForTopics(generatedTopics, transcript, videoInfo)');
  assert.ok(guardIndex > -1 && generateIndex > -1 && guardIndex < generateIndex);
});
