import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_FILE_REVISION,
  applyPatchOperations,
  hashContent,
  validatePatchOperations,
} from '../server/patch-ops.js';

test('hashContent matches EMPTY_FILE_REVISION for empty content', () => {
  assert.equal(hashContent(''), EMPTY_FILE_REVISION);
});

test('applyPatchOperations applies ordered replace spans', () => {
  const nextContent = applyPatchOperations('abcdef', [
    { from: 1, text: 'XY', to: 3, type: 'replace' },
    { from: 5, text: 'Z', to: 6, type: 'replace' },
  ]);

  assert.equal(nextContent, 'aXYdeZ');
});

test('validatePatchOperations rejects overlapping ranges', () => {
  assert.throws(
    () =>
      validatePatchOperations(
        [
          { from: 1, text: 'X', to: 3, type: 'replace' },
          { from: 2, text: 'Y', to: 4, type: 'replace' },
        ],
        6,
      ),
    /ordered and non-overlapping/,
  );
});
