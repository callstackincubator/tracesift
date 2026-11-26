import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { connectTunnel, holdTunnel, iosDeviceHints, listTunnelDevices } from '../src/ios-devices.js';
import { awaitProfilerApp } from '../src/rn-profiler-link.js';

const device = (name, state, address) => ({
  identifier: name,
  properties: {
    hardware: { udid: `U-${name}`, platform: 'iOS', reality: 'physical' },
    device: { name },
    connection: { transportType: 'wired', pairingState: 'paired', state, ...(address ? { tunnelIPAddressString: address } : {}) },
  },
});

test('only devices whose tunnel is up, and which report an address, are dialled', async () => {
  const json = JSON.stringify({ result: { devices: [device('up', 'connected', 'fdf2::1'), device('down', 'disconnected', 'fdf2::9'), device('noaddr', 'connected')] } });
  const devices = await listTunnelDevices(async () => json);
  assert.deepEqual(devices.map((d) => [d.name, d.tunnelAddress]), [['up', 'fdf2::1']]);
});

test('connectTunnel dials IPv6 and hands back a paused socket', async (t) => {
  const server = createServer((peer) => peer.end('hi'));
  await new Promise((resolve) => server.listen(0, '::1', resolve));
  t.after(() => server.close());
  const socket = await connectTunnel('::1', server.address().port);
  assert.equal(socket.isPaused(), true);
  socket.setEncoding('utf8');
  const data = await new Promise((resolve) => { socket.on('data', resolve); socket.resume(); });
  assert.equal(data, 'hi');
  await assert.rejects(connectTunnel('::1', 1), /ECONNREFUSED/);
});

test('awaitProfilerApp dials a device tunnel, retrying until the app listens', async (t) => {
  let attempts = 0;
  const listener = createServer((peer) => { peer.write(`${JSON.stringify({ type: 'hello', app: 'com.spike', platform: 'ios', device: 'iPhone' })}\n`); });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => listener.close());
  const usb = {
    list: async () => [{ udid: 'U1', tunnelAddress: 'fdf2::1' }],
    connect: async (host) => {
      assert.equal(host, 'fdf2::1');
      attempts += 1;
      if (attempts < 2) throw new Error('refused');
      return connectTunnel('127.0.0.1', listener.address().port).catch(() => { throw new Error('unreachable'); });
    },
  };
  const link = await awaitProfilerApp({ port: 0, usb, usbPollMs: 20 });
  assert.equal(link.hello.app, 'com.spike');
  assert.ok(attempts >= 2);
  link.close();
});

test('with device dialling disabled the loopback route is all there is', async () => {
  const controller = new AbortController();
  const pending = awaitProfilerApp({ port: 0, usb: false, signal: controller.signal });
  controller.abort(new Error('stop'));
  await assert.rejects(pending, /stop/);
});

test('a wired phone whose tunnel is down is woken with devicectl, then re-listed', async () => {
  const calls = [];
  const exec = async (_cmd, args) => {
    calls.push(args.slice(0, 3).join(' '));
    const woke = calls.some((c) => c === 'devicectl device info');
    return JSON.stringify({ result: { devices: [woke ? device('phone', 'connected', 'fdbc::1') : device('phone', 'disconnected')] } });
  };
  const devices = await listTunnelDevices(exec);
  assert.deepEqual(devices.map((d) => d.tunnelAddress), ['fdbc::1']);
  assert.ok(calls.includes('devicectl device info'));
});

test('a phone that stays tunnel-less yields a hint saying so and what to do', async () => {
  const exec = async () => JSON.stringify({ result: { devices: [device('phone', 'disconnected')] } });
  const { hints, reachable } = await iosDeviceHints(exec);
  assert.equal(reachable.length, 0);
  assert.equal(hints.length, 1);
  assert.match(hints[0], /phone is plugged in but has no CoreDevice tunnel.*Unlock/);
});

test('holding a tunnel addresses the device through CoreDevice until it is released', async () => {
  // Measured against a real phone: the tunnel drops twelve to fifteen seconds
  // after the last `devicectl device info details`, and nothing on the socket
  // postpones it. Only `info details` counts — `list devices` does not.
  const calls = [];
  const execCapture = async (command, args) => { calls.push([command, ...args].join(' ')); return ''; };
  const unhold = holdTunnel('U-phone', { intervalMs: 20, execCapture });
  await new Promise((resolve) => { setTimeout(resolve, 120); });
  unhold();
  const held = calls.length;

  assert.ok(held >= 3, `expected repeated touches, got ${held}`);
  assert.ok(calls.every((call) => call.includes('devicectl device info details') && call.includes('U-phone')),
    'every touch addresses the device through CoreDevice');

  await new Promise((resolve) => { setTimeout(resolve, 80); });
  assert.equal(calls.length, held, 'releasing stops the touches');
});

test('holding needs a device, and a failing devicectl never escapes', async () => {
  assert.equal(typeof holdTunnel(undefined), 'function');
  const unhold = holdTunnel('U-phone', { intervalMs: 10, execCapture: async () => { throw new Error('phone unplugged'); } });
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  unhold();
});
