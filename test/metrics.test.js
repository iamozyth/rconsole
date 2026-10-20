'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Metrics } = require('../lib/metrics');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-metrics-'));

test('metrics: samples from a clock that ran ahead are dropped, on load and when it steps back', () => {
  const stateDir = dir();
  const now = Date.now();
  const at = (minutes) => Math.floor((now + minutes * 60000) / 30000) * 30000;
  fs.writeFileSync(path.join(stateDir, 'metrics.json'), JSON.stringify({
    fine: [{ t: at(-10), tps: 20 }, { t: at(120), tps: 20 }],
    coarse: [{ t: at(-60), tps: 20 }, { t: at(125), tps: 20 }],
  }));
  const m = new Metrics({ stats: {}, power: {}, stateDir });
  assert.deepStrictEqual(m.fine.map((s) => s.t), [at(-10)]);
  assert.deepStrictEqual(m.coarse.map((s) => s.t), [at(-60)]);

  // Running: the clock is 2 h fast, then NTP steps it back.
  m.add({ t: at(118), tps: 20 });
  m.add({ t: at(118.5), tps: 20 });
  m.add({ t: at(-1), tps: 19 });
  assert.deepStrictEqual(m.fine.map((s) => s.t), [at(-10), at(-1)]);
  const s = m.series('1h');
  assert.ok(s.t.every((t) => t <= s.to));
});
