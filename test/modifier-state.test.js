const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeModifier,
  isModifierPressed
} = require('../src/modifier-state');

test('normalizes modifier config', () => {
  assert.deepEqual(normalizeModifier('option'), ['option']);
  assert.deepEqual(normalizeModifier('cmd+shift'), ['cmd', 'shift']);
  assert.deepEqual(normalizeModifier('control,option'), ['control', 'option']);
  assert.deepEqual(normalizeModifier('none'), []);
});

test('none modifier is always treated as pressed', () => {
  assert.equal(isModifierPressed('none'), true);
});
