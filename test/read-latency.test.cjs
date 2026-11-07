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
  assert.equal(p.infoCache.data, info); // Late success recovers availability for the next read.
  assert.equal(p.infoRetryAfter, 0);
  t.mock.timers.tick(501);
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

test('Axios deadline errors are throttled without dumping transport objects', async () => {
  const errors = [];
  const p = new TPLink('192.0.2.1', 'fixture', 'fixture', { ...log, error(...args) { errors.push(args); } });
  const timeout = Object.assign(new Error('timeout of 2500ms exceeded'), { code: 'ECONNABORTED' });
  assert.equal(p.isTransientNetworkError(timeout), true);
  p.api.setup = async () => { throw timeout; };
  await p.setup();
  assert.deepEqual(errors, []);
});

test('failed power commands are rejected and identical commands are retried after recovery', async () => {
  const p=make();let calls=0;
  p.sendCommandWithNoLock=async()=>{calls++;return null;};
  await assert.rejects(p.sendCommand('power',false),e=>e.hapStatus===-70402);
  assert.equal(p._prevPowerState,undefined);
  p.sendCommandWithNoLock=async()=>{calls++;return true;};
  await p.sendCommand('power',false);
  assert.equal(calls,2);assert.equal(p._prevPowerState,false);
});
test('failed child and cached commands do not manufacture empty successful data', async () => {
  const p=make();p.sendCommand=async()=>null;
  await assert.rejects(p.getChildInfo('fixture'));
});
test('cached offline live values and writes fail until handlers are registered, without changing static names', () => {
  const Platform=require('../dist/platform').default;
  const types=['On','Brightness','Hue','Saturation','ColorTemperature','CurrentTemperature','CurrentRelativeHumidity','BatteryLevel','OutletInUse'];
  const characteristic={UUID:'On',props:{perms:['pr','pw']},onGet(fn){this.getter=fn;},onSet(fn){this.setter=fn;}};
  const name={UUID:'Name',props:{perms:['pr']},onGet(){throw Error('static name handler must not be replaced')}};
  const p=Object.assign(Object.create(Platform.prototype),{log,accessories:[],api:{hap:{Service:{AccessoryInformation:{UUID:'info'}},Characteristic:Object.fromEntries(types.map(v=>[v,{UUID:v}])),Perms:{PAIRED_READ:'pr',PAIRED_WRITE:'pw'},HapStatusError:Offline,HAPStatus:{SERVICE_COMMUNICATION_FAILURE:-70402}}}});
  p.configureAccessory({displayName:'fixture',services:[{UUID:'switch',characteristics:[characteristic,name]}]});
  assert.throws(()=>characteristic.getter(),e=>e.hapStatus===-70402);
  assert.throws(()=>characteristic.setter(true),e=>e.hapStatus===-70402);
});
