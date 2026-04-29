import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const pageSource = readFileSync(
  join(process.cwd(), 'app/analyze/[videoId]/page.tsx'),
  'utf8'
);

function getOperationSource(operationName: string): string {
  const marker = `'${operationName}'`;
  const start = pageSource.indexOf(marker);
  assert.notEqual(start, -1, `Expected to find background operation ${operationName}`);

  return pageSource.slice(start, start + 3500);
}

function getSummaryFailureBranch(operationName: string): string {
  const operation = getOperationSource(operationName);
  const start = operation.indexOf('if (!summaryRes.ok)');
  assert.notEqual(start, -1, `Expected ${operationName} to guard failed summary responses`);

  let depth = 0;
  for (let index = start; index < operation.length; index += 1) {
    const char = operation[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return operation.slice(start, index + 1);
      }
    }
  }

  assert.fail(`Expected to find end of failed summary branch in ${operationName}`);
}

test('cached summary failure stays local to takeaways state', () => {
  const failureBranch = getSummaryFailureBranch('generate-cached-takeaways');

  assert.match(failureBranch, /setTakeawaysError\(/);
  assert.match(failureBranch, /return null;/);
  assert.doesNotMatch(failureBranch, /throw new Error/);
});

test('new-video summary failure stays local to takeaways state', () => {
  const failureBranch = getSummaryFailureBranch('generate-takeaways');

  assert.match(failureBranch, /setTakeawaysError\(/);
  assert.match(failureBranch, /return null;/);
  assert.doesNotMatch(failureBranch, /throw new Error/);
});
