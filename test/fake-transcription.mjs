import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(readFileSync(process.argv[2], 'utf8'), 'fake-audio');
assert.equal(process.argv[3], 'en-US');
process.stdout.write(`recognized ${process.argv[3]}`);
