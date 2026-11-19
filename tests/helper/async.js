import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const CHECKS = 250;
const CHECK_INTERVAL_MS = 20;

function isAbsent(value) {
  return value === undefined || value === null || value === false;
}

// Resolves with the first value "read" gives that is not undefined, null or false, and rejects when none came
// within the deadline: for what a server does a moment later, such as a session that shows up in its list.
export async function waitFor(read, what, checksLeft = CHECKS) {
  const value = await read();

  if (!isAbsent(value)) {
    return value;
  }

  if (checksLeft === 0) {
    throw new Error(`Timed out waiting for ${what}`);
  }

  await sleep(CHECK_INTERVAL_MS);

  return waitFor(read, what, checksLeft - 1);
}

// What fn gives and how long it took, by the monotonic clock.
export async function timeIt(fn) {
  const startedAt = performance.now();
  const result = await fn();

  return { result, durationMs: performance.now() - startedAt };
}

// The error a promise rejects with, for a test that looks at more of it than assert.rejects() compares.
export async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  return assert.fail('The promise was expected to reject');
}
