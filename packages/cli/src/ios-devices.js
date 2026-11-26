// Physical iOS devices, as CoreDevice reports them.
//
// iOS has no `adb reverse`, and a phone cannot dial the Mac's loopback. What a
// wired iPhone does have is a CoreDevice tunnel: a point-to-point IPv6 link
// (a utun interface carrying a ULA /64) between this Mac and that phone only.
// A profiling build therefore *listens* on the phone's tunnel address and the
// CLI dials it. The address is per-session, so it is re-read on every look.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

/**
 * Run a command and capture stdout, for the ones we read rather than show.
 * `includeStderr` appends stderr, for tools like codesign that report there.
 */
export function capture(command, args, { includeStderr = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => reject(new Error(`Could not run ${command}: ${error.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolvePromise(includeStderr ? out + err : out);
      else reject(new Error(`${command} ${args[0] ?? ''} failed: ${err.trim() || out.trim() || `exit code ${code}`}`));
    });
  });
}

/**
 * Physical iOS devices CoreDevice knows about, as
 * `{ id, udid, name, platform, wired, available, tunnelAddress }`.
 * `tunnelAddress` is set only while the tunnel is up.
 *
 * Returns [] rather than throwing when devicectl is missing (Xcode < 15) or
 * prints something unexpected: callers then treat the target as a simulator.
 */
export async function listPhysicalIosDevices(execCapture = capture) {
  let parsed;
  try {
    parsed = JSON.parse(await execCapture('xcrun', ['devicectl', 'list', 'devices', '--json-output', '-', '--quiet']));
  } catch {
    return [];
  }
  const devices = Array.isArray(parsed?.result?.devices) ? parsed.result.devices : [];
  return devices
    .filter((entry) => (entry.properties?.hardware ?? entry.hardwareProperties)?.reality === 'physical')
    .map((entry) => {
      const hardware = entry.properties?.hardware ?? entry.hardwareProperties ?? {};
      const device = entry.properties?.device ?? entry.deviceProperties ?? {};
      const connection = entry.properties?.connection ?? entry.connectionProperties ?? {};
      const address = connection.tunnelIPAddressString ?? connection.tunnelIPAddress;
      const up = (connection.state ?? connection.tunnelState) === 'connected';
      return {
        id: entry.identifier,
        udid: hardware.udid ?? entry.hardwareProperties?.udid ?? entry.identifier,
        name: device.name ?? entry.deviceProperties?.name ?? 'iOS device',
        platform: hardware.platform ?? 'iOS',
        wired: connection.transportType === 'wired',
        available: connection.pairingState === 'paired',
        tunnelAddress: up && typeof address === 'string' && address ? address : null,
      };
    })
    .filter((device) => device.platform === 'iOS');
}

/** Match --device against a device's CoreDevice id, UDID or name. Names must be unambiguous. */
export function matchPhysicalDevice(devices, selector) {
  if (!selector) return null;
  const exact = devices.filter((device) => device.id === selector || device.udid === selector);
  if (exact.length === 1) return exact[0];
  const named = devices.filter((device) => device.name === selector);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    throw new Error(`${named.length} devices are named ${JSON.stringify(selector)}. Pass a UDID instead:\n${named.map((d) => `  ${d.udid}`).join('\n')}`);
  }
  return null;
}

let waking = null;

/**
 * CoreDevice drops an idle tunnel (`tunnelState: disconnected`, no address)
 * even though the phone is still plugged in, and brings it back the first time
 * anything addresses the device. A read-only `devicectl device info details`
 * is that something. It fails quietly when the phone is locked or unplugged;
 * the caller re-lists and sees the tunnel is still down.
 */
async function wakeTunnels(devices, execCapture) {
  const sleeping = devices.filter((device) => device.wired && device.available && !device.tunnelAddress);
  if (!sleeping.length) return;
  // The poller calls this every few seconds; one wake at a time is plenty.
  waking ??= Promise.all(sleeping.map((device) =>
    execCapture('xcrun', ['devicectl', 'device', 'info', 'details', '--device', device.id, '--quiet']).catch(() => '')))
    .finally(() => { waking = null; });
  await waking;
}

/** Physical devices, with a down tunnel given one chance to come back. */
export async function listPhysicalIosDevicesAwake(execCapture) {
  const devices = await listPhysicalIosDevices(execCapture);
  if (!devices.some((device) => device.wired && device.available && !device.tunnelAddress)) return devices;
  await wakeTunnels(devices, execCapture ?? capture);
  return listPhysicalIosDevices(execCapture);
}

/**
 * How often to touch a device so CoreDevice keeps its tunnel.
 *
 * Measured: the tunnel goes to `disconnected` between twelve and fifteen
 * seconds after the last `devicectl device info details`, whatever is crossing
 * it. Five seconds leaves room for a slow call without ever reaching that.
 */
const TUNNEL_HOLD_MS = 5_000;

/**
 * Keep a device's tunnel alive for as long as the returned function is not
 * called.
 *
 * CoreDevice reaps a tunnel no CoreDevice client is holding. A plain TCP
 * socket riding the interface is not one — a recording could sit there sending
 * a heartbeat every two seconds and still lose the tunnel under it, which is
 * exactly how a long recording used to die with EHOSTUNREACH at `stop`.
 * Addressing the device through CoreDevice is what counts, so that is what
 * this does. `list devices` is not enough; `info details` is.
 *
 * The address stays put while the tunnel is held, so a socket already open
 * over it keeps working. Calls never overlap and failures are ignored: if the
 * phone has gone, the recording's own error is the one worth reporting.
 *
 * @param {string} deviceId a CoreDevice identifier or UDID
 * @returns {() => void} stop holding
 */
export function holdTunnel(deviceId, { intervalMs = TUNNEL_HOLD_MS, execCapture = capture } = {}) {
  if (!deviceId) return () => {};
  let stopped = false;
  let inFlight = false;
  const touch = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    execCapture('xcrun', ['devicectl', 'device', 'info', 'details', '--device', deviceId, '--quiet'])
      .catch(() => '')
      .finally(() => { inFlight = false; });
  };
  const timer = setInterval(touch, intervalMs);
  timer.unref?.();
  touch();
  return () => { stopped = true; clearInterval(timer); };
}

/** Devices whose tunnel is up right now, ready to dial. */
export async function listTunnelDevices(execCapture) {
  return (await listPhysicalIosDevicesAwake(execCapture)).filter((device) => device.tunnelAddress);
}

/**
 * What to tell someone whose iPhone is plugged in but cannot be reached, so a
 * missing tunnel never looks like "no device". One line per phone.
 * `reachable` says whether any phone is dialable, for callers that also want
 * to say "open the app".
 */
export async function iosDeviceHints(execCapture) {
  const devices = await listPhysicalIosDevicesAwake(execCapture);
  const hints = [];
  for (const device of devices) {
    if (!device.available && device.wired) {
      hints.push(`${device.name} is plugged in but not paired. Unlock it and tap Trust, then enable Developer Mode.`);
    } else if (device.wired && !device.tunnelAddress) {
      hints.push(`${device.name} is plugged in but has no CoreDevice tunnel, so TraceSift cannot reach an app on it. Unlock the phone and keep it unlocked, re-plug the cable, then refresh. \`xcrun devicectl list devices\` should show it as connected.`);
    }
  }
  return { hints, reachable: devices.filter((device) => device.tunnelAddress) };
}

/**
 * Dial `port` on a device's tunnel address. Rejects while nothing listens
 * there (the normal state until the app is running); the caller retries.
 * The socket comes back paused so no byte is read before a listener exists.
 */
export function connectTunnel(host, port, { timeoutMs = 2_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host, port, });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Timed out dialling [${host}]:${port}.`)); }, timeoutMs);
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.once('connect', () => { clearTimeout(timer); socket.removeAllListeners('error'); socket.pause(); resolvePromise(socket); });
  });
}

/** Booted simulators as `{ id, name }`; [] when simctl is missing or says nothing useful. */
export async function listBootedSimulators(execCapture = capture) {
  try {
    const booted = JSON.parse(await execCapture('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']));
    return Object.values(booted.devices ?? {}).flat().map((entry) => ({ id: entry.udid, name: entry.name }));
  } catch {
    return [];
  }
}
