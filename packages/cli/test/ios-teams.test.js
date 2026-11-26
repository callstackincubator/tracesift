import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { detectDevelopmentTeam, plistValue, profilesForDevice, projectDevelopmentTeam, readProfile, sameDevice, teamsForDevice } from '../src/ios-teams.js';

/** A .mobileprovision as Xcode writes it: a CMS envelope around a plain plist. */
function profile({ team = '256PKG3W2C', name = 'Hur Ali', expires = '2099-01-01T00:00:00Z', devices = ['00008150-000A5C3421B8C01C'] } = {}) {
  return `0\u0082\u0010signature bytes\n<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>TeamIdentifier</key><array>${devices.length ? '' : ''}<string>${team}</string></array>
  <key>TeamName</key><string>${name}</string>
  <key>ExpirationDate</key><date>${expires}</date>
  ${devices.length ? `<key>ProvisionedDevices</key><array>${devices.map((d) => `<string>${d}</string>`).join('')}</array>` : ''}
</dict></plist>\nmore signature bytes`;
}

async function directory(profiles) {
  const dir = await mkdtemp(join(tmpdir(), 'tracesift-profiles-'));
  let index = 0;
  for (const text of profiles) await writeFile(join(dir, `${index++}.mobileprovision`), text, 'latin1');
  return dir;
}

test('a profile yields its team, expiry and devices', () => {
  const read = readProfile(profile());
  assert.equal(read.teamId, '256PKG3W2C');
  assert.equal(read.teamName, 'Hur Ali');
  assert.deepEqual(read.devices, ['00008150-000A5C3421B8C01C']);
  assert.equal(read.expires.toISOString(), '2099-01-01T00:00:00.000Z');
});

test('plistValue reads only the tag that follows its key', () => {
  const xml = '<key>A</key><string>first</string><key>B</key><array><string>x</string><string>y</string></array>';
  assert.equal(plistValue(xml, 'A'), 'first');
  assert.deepEqual(plistValue(xml, 'B'), ['x', 'y']);
  assert.equal(plistValue(xml, 'Missing'), null);
});

test('non-plist bytes yield nothing rather than throwing', () => {
  assert.equal(readProfile('not a profile at all'), null);
  assert.equal(readProfile(profile({ team: '' })), null);
});

test('a phone is matched by its ECID form or the serial half of it', () => {
  assert.ok(sameDevice('00008150-000A5C3421B8C01C', '000A5C3421B8C01C'));
  assert.ok(sameDevice('000A5C3421B8C01C', '00008150-000A5C3421B8C01C'));
  assert.ok(sameDevice('abc', 'abc'));
  assert.ok(!sameDevice('00008150-000A5C3421B8C01C', '000A5C3421B8C01D'));
  // Too short to be anything but a collision.
  assert.ok(!sameDevice('00008150-000A5C3421B8C01C', 'B8C01C'));
});

test('the team is the one whose profile covers that phone', async () => {
  const dir = await directory([
    profile({ team: 'PJL7DA2X5F', name: 'Callstack', devices: ['00008101-001808341E08801E'] }),
    profile(),
  ]);
  assert.deepEqual(await detectDevelopmentTeam('000A5C3421B8C01C', { directory: dir }), { teamId: '256PKG3W2C', teamName: 'Hur Ali' });
});

test('an expired profile does not decide anything', async () => {
  const dir = await directory([profile({ expires: '2020-01-01T00:00:00Z' })]);
  assert.deepEqual(await teamsForDevice('000A5C3421B8C01C', { directory: dir }), []);
  assert.equal(await detectDevelopmentTeam('000A5C3421B8C01C', { directory: dir }), null);
});

test('a phone no profile covers gives no team, rather than a guess', async () => {
  const dir = await directory([profile({ devices: ['00008101-001808341E08801E'] })]);
  assert.equal(await detectDevelopmentTeam('000A5C3421B8C01C', { directory: dir }), null);
  assert.equal(await detectDevelopmentTeam('000A5C3421B8C01C', { directory: join(dir, 'nope') }), null);
});

test('two teams for one phone is asked about, not decided', async () => {
  const dir = await directory([profile(), profile({ team: 'PJL7DA2X5F', name: 'Callstack' })]);
  await assert.rejects(
    detectDevelopmentTeam('000A5C3421B8C01C', { directory: dir }),
    /More than one Apple Development Team.*256PKG3W2C \(Hur Ali\).*PJL7DA2X5F \(Callstack\).*--team/s,
  );
});

test('lapsed profiles are kept apart from current ones, with the latest expiry', async () => {
  const dir = await directory([
    profile({ expires: '2020-01-01T00:00:00Z' }),
    profile({ expires: '2021-06-01T00:00:00Z' }),
    profile({ team: 'PJL7DA2X5F', name: 'Callstack' }),
  ]);
  const { current, expired } = await profilesForDevice('000A5C3421B8C01C', { directory: dir });
  assert.deepEqual(current.map((team) => team.teamId), ['PJL7DA2X5F']);
  assert.deepEqual(expired.map((team) => team.teamId), ['256PKG3W2C']);
  assert.equal(expired[0].expires.toISOString(), '2021-06-01T00:00:00.000Z');
});

test('the project\'s own DEVELOPMENT_TEAM is read, and an empty one is none', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tracesift-ios-'));
  assert.equal(await projectDevelopmentTeam(dir), null, 'no xcodeproj at all');

  await mkdir(join(dir, 'Spike.xcodeproj'), { recursive: true });
  await writeFile(join(dir, 'Spike.xcodeproj', 'project.pbxproj'), '\t\t\t\tDEVELOPMENT_TEAM = "";\n');
  assert.equal(await projectDevelopmentTeam(dir), null, 'what expo prebuild writes');

  await writeFile(join(dir, 'Spike.xcodeproj', 'project.pbxproj'), '\t\t\t\tDEVELOPMENT_TEAM = 256PKG3W2C;\n');
  assert.equal(await projectDevelopmentTeam(dir), '256PKG3W2C');
});
