// Which Apple Development Team to sign a device build with.
//
// `expo prebuild` writes an Xcode project with no DEVELOPMENT_TEAM, so a
// device build fails until one is named. Asking the developer for a ten
// character string they have to go and look up is the kind of manual setup
// this command exists to remove — and the answer is already on the machine.
//
// Every provisioning profile Xcode has installed names its team and the
// devices it covers. The target UDID is known by the time we build, so the
// profile that already covers that phone decides the team, and a phone no
// profile covers is better left to xcodebuild's own error than to a guess.
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where Xcode keeps the profiles it has downloaded. */
export function provisioningProfileDirectory(home = homedir()) {
  return join(home, 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles');
}

/**
 * The first value for `key` in an XML plist, as a string or an array of them.
 *
 * A .mobileprovision is CMS-signed, but the plist inside it is plain text, so
 * the four fields wanted here are read without shelling out to `security`.
 * Deliberately not a plist parser: it reads the tag that follows the key and
 * nothing else, and returns null for anything it does not recognise.
 */
export function plistValue(xml, key) {
  const at = xml.indexOf(`<key>${key}</key>`);
  if (at < 0) return null;
  const rest = xml.slice(at + key.length + 11);
  const array = /^\s*<array>([\s\S]*?)<\/array>/.exec(rest);
  if (array) return [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => match[1].trim());
  const scalar = /^\s*<(string|date)>([\s\S]*?)<\/\1>/.exec(rest);
  return scalar ? scalar[2].trim() : null;
}

/**
 * `{ teamId, teamName, expires, devices }` from one profile's bytes, or null
 * when it names no team. Read as latin1 so the signature's bytes cannot throw.
 */
export function readProfile(bytes) {
  const xml = Buffer.from(bytes).toString('latin1');
  const start = xml.indexOf('<?xml');
  const end = xml.lastIndexOf('</plist>');
  if (start < 0 || end < 0) return null;
  const plist = xml.slice(start, end);
  const teams = plistValue(plist, 'TeamIdentifier');
  const teamId = Array.isArray(teams) ? teams[0] : teams;
  if (!teamId) return null;
  const expires = plistValue(plist, 'ExpirationDate');
  const devices = plistValue(plist, 'ProvisionedDevices');
  return {
    teamId,
    teamName: plistValue(plist, 'TeamName') ?? teamId,
    expires: typeof expires === 'string' ? new Date(expires) : null,
    devices: Array.isArray(devices) ? devices : [],
  };
}

/**
 * Do two UDIDs name the same phone? A profile lists an iPhone by its full
 * ECID form, `00008150-000A5C3421B8C01C`, while devicectl may report only the
 * serial half of it, so one being the tail of the other is a match. Guarded on
 * length, since a short tail could collide.
 */
export function sameDevice(a, b) {
  const left = String(a).toLowerCase();
  const right = String(b).toLowerCase();
  if (left === right) return true;
  const [short, long] = left.length < right.length ? [left, right] : [right, left];
  return short.length >= 16 && long.endsWith(`-${short}`);
}

/**
 * The teams whose installed profiles cover `udid`, split into those still
 * valid and those that have lapsed. The lapsed ones are kept because "your
 * profiles expired" and "this Mac has never seen this phone" need different
 * answers, and a free Personal Team's profiles last a week.
 */
export async function profilesForDevice(udid, { directory = provisioningProfileDirectory(), now = new Date() } = {}) {
  let names;
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.mobileprovision'));
  } catch {
    return { current: [], expired: [] }; // no profiles installed: nothing to conclude
  }
  const wanted = String(udid);
  const current = new Map();
  const expired = new Map();
  for (const name of names) {
    let profile;
    try {
      profile = readProfile(await readFile(join(directory, name)));
    } catch {
      continue; // unreadable or not a profile: the others still count
    }
    if (!profile) continue;
    if (!profile.devices.some((device) => sameDevice(device, wanted))) continue;
    const lapsed = Boolean(profile.expires && profile.expires <= now);
    const into = lapsed ? expired : current;
    const seen = into.get(profile.teamId);
    // For a lapsed team, the latest expiry is the one worth reporting.
    if (!seen || (lapsed && profile.expires > seen.expires)) {
      into.set(profile.teamId, { teamId: profile.teamId, teamName: profile.teamName, expires: profile.expires });
    }
  }
  return { current: [...current.values()], expired: [...expired.values()] };
}

/** Teams whose installed, unexpired profiles cover `udid`. */
export async function teamsForDevice(udid, options = {}) {
  return (await profilesForDevice(udid, options)).current.map(({ teamId, teamName }) => ({ teamId, teamName }));
}

/**
 * The team to sign for `udid`, or null when the machine does not say.
 * Throws when more than one team covers the phone: picking one would decide
 * whose certificate the developer ships under, which is not ours to guess.
 */
export async function detectDevelopmentTeam(udid, options = {}) {
  const teams = await teamsForDevice(udid, options);
  if (teams.length === 1) return teams[0];
  if (teams.length > 1) {
    const list = teams.map((team) => `${team.teamId} (${team.teamName})`).join(', ');
    throw new Error(`More than one Apple Development Team can sign for this device: ${list}. Pass --team <id> to choose.`);
  }
  return null;
}

/**
 * The DEVELOPMENT_TEAM the Xcode project itself sets, if any. An empty value
 * is what `expo prebuild` writes and means no team. Checked so a project that
 * signs itself is never second-guessed.
 */
export async function projectDevelopmentTeam(iosRoot) {
  let entries;
  try {
    entries = (await readdir(iosRoot)).filter((name) => name.endsWith('.xcodeproj'));
  } catch {
    return null;
  }
  for (const entry of entries) {
    let text;
    try {
      text = await readFile(join(iosRoot, entry, 'project.pbxproj'), 'utf8');
    } catch {
      continue;
    }
    const match = /DEVELOPMENT_TEAM\s*=\s*"?([A-Z0-9]{6,})"?\s*;/.exec(text);
    if (match) return match[1];
  }
  return null;
}
