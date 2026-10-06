import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describePiCompatibility,
  evaluatePiCompatibility,
  MAX_EXCLUSIVE_PI_VERSION,
  MIN_SUPPORTED_PI_VERSION,
  piCompatibilityLabel,
  SUPPORTED_PI_RANGE,
  TESTED_PI_VERSION,
} from '../lib/pi-compatibility.js';

test('Pi compatibility uses numeric stable-version bounds', () => {
  assert.equal(TESTED_PI_VERSION, '0.99.2');
  assert.equal(MIN_SUPPORTED_PI_VERSION, TESTED_PI_VERSION);
  assert.equal(MAX_EXCLUSIVE_PI_VERSION, '0.100.0');
  assert.equal(SUPPORTED_PI_RANGE, '>=0.99.2 <0.100.0');

  const cases = [
    ['0.99.1', 'TOO_OLD', false],
    ['0.99.2', 'SUPPORTED', true],
    ['0.99.3', 'SUPPORTED', true],
    ['0.99.99', 'SUPPORTED', true],
    ['0.100.0', 'TOO_NEW_OR_UNVALIDATED', false],
    ['1.0.0', 'TOO_NEW_OR_UNVALIDATED', false],
  ];

  for (const [version, status, supported] of cases) {
    const result = evaluatePiCompatibility(version);
    assert.equal(result.status, status, version);
    assert.equal(result.supported, supported, version);
    assert.equal(result.normalizedVersion, version);
    assert.ok(describePiCompatibility(result).includes(SUPPORTED_PI_RANGE));
  }
});

test('Pi compatibility normalizes supported output and rejects prereleases conservatively', () => {
  const plain = evaluatePiCompatibility('0.99.2');
  const decorated = evaluatePiCompatibility('pi 0.99.2');
  assert.equal(plain.supported, true);
  assert.equal(decorated.supported, true);
  assert.equal(decorated.normalizedVersion, '0.99.2');

  for (const version of ['0.99.3-beta.1', '0.100.0-beta.1', '1.0.0-rc.1']) {
    const result = evaluatePiCompatibility(version);
    assert.notEqual(result.status, 'SUPPORTED', version);
    assert.equal(result.supported, false, version);
    assert.equal(result.status, 'UNVERIFIED', version);
    assert.equal(piCompatibilityLabel(result), 'UNVERIFIED');
  }

  assert.equal(evaluatePiCompatibility('0.99.2+custom-build').supported, true);
});

test('Pi compatibility handles missing and unparseable version output without throwing', () => {
  for (const output of ['invalid', 'unknown', '', '0.99', null]) {
    const result = evaluatePiCompatibility(output);
    assert.doesNotThrow(() => describePiCompatibility(result));
    assert.equal(result.supported, false, String(output));
    assert.equal(result.status, output === null ? 'MISSING' : 'UNPARSEABLE');
  }
});
