import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel } from '../server/codex.js';

test('model selection uses the catalog default, including later pages', async () => {
  const calls = [];
  const client = { async call(method, params) {
    calls.push({ method, params });
    return params.cursor
      ? { data: [{ id: 'picker-id', model: 'supported-default', isDefault: true, defaultReasoningEffort: 'medium' }], nextCursor: null }
      : { data: [{ model: 'first-model' }], nextCursor: 'page-2' };
  } };
  const selection = await resolveModel(client, '');
  assert.equal(selection.model, 'supported-default');
  assert.equal(selection.effort, 'medium');
  assert.deepEqual(calls.map(c => c.method), ['model/list', 'model/list']);
  assert.equal(calls[1].params.cursor, 'page-2');
});

test('explicit model override resolves to the protocol model name', async () => {
  const client = { call: async () => ({ data: [{ id: 'picker-id', model: 'model-for-inference' }, { model: 'default', isDefault: true }] }) };
  assert.equal((await resolveModel(client, ' picker-id ')).model, 'model-for-inference');
  await assert.rejects(resolveModel(client, 'unsupported-model'), /Remove CODEX_MODEL/);
});

test('empty or malformed catalogs fail rather than inheriting a global model', async () => {
  for (const data of [[], [{ model: 'hidden', hidden: true }], [{ id: 'missing-model' }]]) {
    await assert.rejects(resolveModel({ call: async () => ({ data }) }, ''), /no available models/);
  }
  await assert.rejects(resolveModel({ call: async () => ({}) }, ''), /did not return a model list/);
});

test('catalog without a default uses its first visible model', async () => {
  const selection = await resolveModel({ call: async () => ({ data: [{ model: 'hidden', hidden: true }, { model: 'visible' }] }) }, '');
  assert.equal(selection.model, 'visible');
});

test('repeated pagination cursor fails instead of hanging planning', async () => {
  await assert.rejects(resolveModel({ call: async () => ({ data: [], nextCursor: 'same' }) }, ''), /incomplete model list/);
});
