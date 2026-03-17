import crypto from 'node:crypto';

export const EMPTY_FILE_REVISION = `sha256:${crypto
  .createHash('sha256')
  .update('', 'utf8')
  .digest('hex')}`;

function normalizePatchOps(patchOps) {
  return Array.isArray(patchOps) ? patchOps : [];
}

export function hashContent(content) {
  return `sha256:${crypto.createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

export function validatePatchOperations(patchOps, contentLength) {
  const normalizedPatchOps = normalizePatchOps(patchOps);
  let previousTo = 0;

  for (const patchOp of normalizedPatchOps) {
    if (
      patchOp?.type !== 'replace' ||
      !Number.isInteger(patchOp.from) ||
      !Number.isInteger(patchOp.to) ||
      typeof patchOp.text !== 'string'
    ) {
      throw new Error('Patch ops must contain replace operations with integer from/to and string text values.');
    }

    if (
      patchOp.from < 0 ||
      patchOp.to < patchOp.from ||
      patchOp.to > contentLength
    ) {
      throw new Error('Patch replace ranges must stay within the base file content.');
    }

    if (patchOp.from < previousTo) {
      throw new Error('Patch replace ranges must be ordered and non-overlapping.');
    }

    previousTo = patchOp.to;
  }

  return normalizedPatchOps;
}

export function applyPatchOperations(content, patchOps) {
  const normalizedPatchOps = validatePatchOperations(patchOps, content.length);
  let cursor = 0;
  let nextContent = '';

  for (const patchOp of normalizedPatchOps) {
    nextContent += content.slice(cursor, patchOp.from);
    nextContent += patchOp.text;
    cursor = patchOp.to;
  }

  nextContent += content.slice(cursor);
  return nextContent;
}
