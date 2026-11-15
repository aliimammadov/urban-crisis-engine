import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../public/dispatcher.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function frameAt('), html.indexOf('function showFrame('));
const frameAt = runInNewContext(source + '; frameAt');
const a = { t: 1000, sosTotal: 2, points: [['p', 20, 1]], alerts: [], brigades: [], closed: [] };
const b = { ...a, t: 5000, sosTotal: 10, points: [['p', 60, 1]] };

test('replay interpolates timestamp, occupancy and SOS counts without mutating history', () => {
  const f = frameAt([a, b], 0.25);
  assert.equal(f.t, 2000);
  assert.equal(f.sosTotal, 4);
  assert.equal(f.points[0][1], 30);
  assert.equal(a.points[0][1], 20);
});

test('single and final history frames remain stable', () => {
  assert.equal(frameAt([a], 0).t, a.t);
  assert.equal(frameAt([a, b], 1).points[0][1], 60);
  assert.equal(frameAt([a, { ...b, points: [] }], 0.5).points[0][1], 20);
});

test('empty history and history request errors do not start replay', async () => {
  const enterSource = html.slice(html.indexOf('async function enterReplay('), html.indexOf('function leaveReplay('));
  for (const api of [async () => ({ frames: [] }), async () => { throw new Error('offline'); }]) {
    const context = { api, replay: null, historyRequest: null, token: 'test', toast() {}, tr: (key) => key };
    const enter = runInNewContext(enterSource + '; enterReplay', context);
    try { assert.equal(await enter(), false); } catch (e) { assert.equal(e.message, 'offline'); }
    assert.equal(context.replay, null);
    assert.equal(context.historyRequest, null);
  }
});
