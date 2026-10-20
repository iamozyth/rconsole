'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cron = require('../lib/cron');

const at = (...a) => new Date(...a);
const fmt = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

test('every 15 minutes', () => {
  assert.equal(fmt(cron.next('*/15 * * * *', at(2026, 9, 20, 10, 7))), '2026-10-20 10:15');
  assert.equal(fmt(cron.next('*/15 * * * *', at(2026, 9, 20, 10, 45))), '2026-10-20 11:00');
});

test('weekdays at 04:30 skip the weekend', () => {
  // 2026-10-23 is a Friday
  assert.equal(fmt(cron.next('30 4 * * 1-5', at(2026, 9, 23, 5, 0))), '2026-10-26 4:30');
  assert.equal(fmt(cron.next('30 4 * * mon-fri', at(2026, 9, 23, 3, 0))), '2026-10-23 4:30');
});

test('lists, ranges with steps, names and 7 for Sunday', () => {
  assert.equal(fmt(cron.next('0 6,18 * * *', at(2026, 9, 20, 7, 0))), '2026-10-20 18:00');
  assert.equal(fmt(cron.next('0 0-12/6 * * *', at(2026, 9, 20, 7, 0))), '2026-10-20 12:00');
  assert.equal(fmt(cron.next('0 3 * * 7', at(2026, 9, 20, 7, 0))), '2026-10-25 3:00');
  assert.equal(fmt(cron.next('0 0 1 jan *', at(2026, 9, 20))), '2027-1-1 0:00');
  assert.equal(fmt(cron.next('@daily', at(2026, 9, 20, 7, 0))), '2026-10-21 0:00');
  assert.equal(fmt(cron.next('5/20 * * * *', at(2026, 9, 20, 7, 30))), '2026-10-20 7:45');
});

test('day of month and day of week both set: either matches', () => {
  // the 1st of the month or any Monday; 2026-10-26 is a Monday
  assert.equal(fmt(cron.next('0 12 1 * 1', at(2026, 9, 21))), '2026-10-26 12:00');
  assert.equal(fmt(cron.next('0 12 1 * 1', at(2026, 9, 27))), '2026-11-1 12:00');
});

test('never-matching and invalid expressions', () => {
  assert.equal(cron.next('0 0 31 2 *', at(2026, 0, 1)), null);
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '5-1 * * * *', '*/0 * * * *', 'a b c d e']) {
    assert.throws(() => cron.parse(bad), Error, bad);
  }
});
