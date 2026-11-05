const test = require('node:test');
const assert = require('node:assert/strict');
const TPLink = require('../dist/api/TPLink').default;
const axios = require('axios').default;

const log = { info() {}, warn() {}, debug() {}, error() {} };
class Offline extends Error { constructor() { super('offline'); this.hapStatus = -70402; } }
const make = () => new TPLink('192.0.2.1', 'fixture', 'fixture', log, () => new Offline());
const info = { device_id: 'fixture', device_on: true, brightness: 42 };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('five simultaneous HomeKit reads share one request and a short cache', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const p = make(); let calls = 0;
  p.sendCommand = async () => { calls++; return info; };
  const values = await Promise.all(Array.from({ length: 5 }, () => p.getInfo()));
  assert.equal(calls, 1);
  assert.ok(values.every(v => v === info));
  await p.getInfo();
  assert.equal(calls, 1);
  t.mock.timers.tick(501);
  await p.getInfo();
  assert.equal(calls, 2);
});

test('offline requests return HomeKit communication errors at 1.5s without accumulating queued reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const p = make(); let finish; let calls = 0;
  p.sendCommand = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const results = Promise.allSettled(Array.from({ length: 5 }, () => p.getInfo()));
  t.mock.timers.tick(1500);
  const settled = await results;
  assert.ok(settled.every(r => r.status === 'rejected' && r.reason.hapStatus === -70402));
  assert.equal(calls, 1);
  t.mock.timers.tick(60000);
  await assert.rejects(p.getInfo(), e => e.hapStatus === -70402);
  assert.equal(calls, 1); // Even a truly stuck I/O operation cannot grow the lock queue.
  finish(info);
  await flush();
  assert.equal(p.infoCache, undefined); // A late success is not reported as fresh data.
  p.sendCommand = async () => { calls++; return info; };
  assert.equal(await p.getInfo(), info);
  assert.equal(calls, 2);
});

test('empty failed responses are not converted into fabricated off/100% readings and recover after cooldown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const value of [null, {}, true]) {
    const p = make(); let calls = 0;
    p.sendCommand = async () => { calls++; return value; };
    await assert.rejects(p.getInfo(), e => e.hapStatus === -70402);
    await flush();
    await assert.rejects(p.getInfo(), e => e.hapStatus === -70402);
    assert.equal(calls, 1);
    t.mock.timers.tick(30001);
    p.sendCommand = async () => info;
    assert.equal(await p.getInfo(), info);
  }
});

test('late transport rejections are consumed and never reported as unhandled promises', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const p = make(); let reject;
  p.sendCommand = () => new Promise((_resolve, fail) => { reject = fail; });
  const result = assert.rejects(p.getInfo(), e => e.hapStatus === -70402);
  t.mock.timers.tick(1500);
  await result;
  reject(Error('late timeout'));
  await flush();
  assert.equal(p.infoInFlight, undefined);
});

test('legacy and KLAP HTTP calls have finite 2.5s transport timeouts', async () => {
  const original = axios.post;
  const options = [];
  axios.post = async (_url, _body, config) => { options.push(config); return { data: { error_code: 0 }, headers: {} }; };
  try {
    const Legacy = require('../dist/api/LegacyAPI').default;
    const Klap = require('../dist/api/KlapAPI').default;
    await new Legacy('192.0.2.1', 'fixture', 'fixture', log).sendRequest('get_device_info', {});
    await new Klap('192.0.2.1', 'fixture', 'fixture', log).sessionPost('/handshake1', Buffer.from('test'), 'arraybuffer');
    assert.equal(options.length, 2);
    assert.ok(options.every(o => o.timeout === 2500));
  } finally { axios.post = original; }
});
