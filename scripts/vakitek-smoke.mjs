#!/usr/bin/env node

// Dependency-free smoke test for the Vakitek transcript API. Mirrors the single
// GET /v1/youtube/transcript request lib/vakitek-transcript-provider.ts makes:
// same endpoint, same query params, same X-API-Key header. Never logs the key.

const VAKITEK_API_KEY = process.env.VAKITEK_API_KEY;

if (!VAKITEK_API_KEY) {
  console.error('VAKITEK_API_KEY is not set. Export it (or add it to .env.local and load it into your shell) before running this script.');
  process.exit(1);
}

const DEFAULT_CASES = [
  { video: 'dQw4w9WgXcQ', expect: 'transcript' },
  { video: 'jNQXAC9IVRw', expect: 'transcript' },
  { video: 'aaaaaaaaaaa', expect: 'NOT_FOUND' },
  { video: 'dQw4w9WgXcQ', lang: 'fr', expect: 'LANGUAGE_NOT_AVAILABLE' },
];

function extractVideoId(input) {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const v = url.searchParams.get('v');
    if (v) return v;
    if (url.hostname === 'youtu.be') return url.pathname.slice(1);
  } catch {
    // not a URL; fall through
  }
  return trimmed;
}

function parseExtraCases(argv) {
  const cases = [];
  for (const arg of argv) {
    if (!arg.startsWith('--video=')) continue;
    const raw = arg.slice('--video='.length);
    cases.push({ video: extractVideoId(raw), expect: null });
  }
  return cases;
}

async function runCase(testCase) {
  const url = new URL('https://api.vakitek.co.uk/v1/youtube/transcript');
  url.searchParams.set('video', testCase.video);
  url.searchParams.set('format', 'json');
  if (testCase.lang) url.searchParams.set('target_language', testCase.lang);

  const started = Date.now();
  const label = testCase.lang ? `${testCase.video} (target_language=${testCase.lang})` : testCase.video;

  let response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'error',
      headers: { 'X-API-Key': VAKITEK_API_KEY },
    });
  } catch (error) {
    const latencyMs = Date.now() - started;
    return {
      label, testCase, latencyMs, pass: false,
      outcome: `NETWORK_ERROR (${error instanceof Error ? error.message : String(error)})`,
      segmentCount: 0, language: 'n/a', billed: 0,
    };
  }

  const latencyMs = Date.now() - started;

  if (response.status !== 200) {
    return {
      label, testCase, latencyMs, pass: false,
      outcome: `HTTP_${response.status}`,
      segmentCount: 0, language: 'n/a', billed: 0,
    };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return {
      label, testCase, latencyMs, pass: false,
      outcome: 'MALFORMED_JSON',
      segmentCount: 0, language: 'n/a', billed: 0,
    };
  }

  const billed = typeof body?.billing?.events?.transcript === 'number'
    ? body.billing.events.transcript
    : 0;

  const item = Array.isArray(body?.data) ? body.data[0] : undefined;
  if (!item) {
    return { label, testCase, latencyMs, pass: false, outcome: 'NO_DATA_ITEM', segmentCount: 0, language: 'n/a', billed };
  }

  if (typeof item.error === 'string') {
    const outcome = item.error;
    const pass = testCase.expect ? testCase.expect === outcome : true;
    return { label, testCase, latencyMs, pass, outcome, segmentCount: 0, language: 'n/a', billed };
  }

  const transcript = Array.isArray(item.transcript) ? item.transcript : [];
  const outcome = transcript.length > 0 ? 'transcript' : 'EMPTY_TRANSCRIPT';
  const pass = testCase.expect ? testCase.expect === outcome : true;
  return {
    label, testCase, latencyMs, pass, outcome,
    segmentCount: transcript.length,
    language: typeof item.language === 'string' ? item.language : 'n/a',
    billed,
  };
}

(async () => {
  const extraCases = parseExtraCases(process.argv.slice(2));
  const cases = [...DEFAULT_CASES, ...extraCases];

  console.log('Vakitek transcript API smoke test');
  console.log('----------------------------------');

  const results = [];
  for (const testCase of cases) {
    const result = await runCase(testCase);
    results.push(result);
    const status = result.pass ? 'PASS' : 'FAIL';
    console.log(
      `[${status}] video=${result.label} outcome=${result.outcome} segments=${result.segmentCount} ` +
      `language=${result.language} latencyMs=${result.latencyMs} billed=${result.billed}`
    );
  }

  console.log('----------------------------------');
  const failed = results.filter((r) => !r.pass);
  if (failed.length === 0) {
    console.log(`PASS: all ${results.length} case(s) succeeded.`);
    process.exit(0);
  } else {
    console.log(`FAIL: ${failed.length} of ${results.length} case(s) did not match the expected outcome.`);
    process.exit(1);
  }
})();
