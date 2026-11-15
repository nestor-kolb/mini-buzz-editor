'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
require('./core.js');
require('./mfp.js');
require('./project-zip.js');
require('./usb.js');

function scene() {
  const frames = [defaultFrame(), defaultFrame(), defaultFrame()];
  frames[0].audio = { mode: 'play', id: 'music' };
  frames[0].loop = 130;
  frames[1].loop = 2;
  frames[2].pose[0] = 25;
  return new Project('Тест', frames, [{ start: 0, end: 2, name: 'Вступление' }], {
    music: { path: 'music.mp3', bytes: Uint8Array.of(73, 68, 51, 4) }
  });
}

test('project ZIP keeps the groups, frames and embedded audio', async () => {
  const source = scene();
  const zip = new Uint8Array(await ProjectZip.write(source).arrayBuffer());
  const restored = ProjectZip.read(zip);
  assert.equal(restored.toJson(), source.toJson());
  assert.deepEqual(restored.assets.music.bytes, source.assets.music.bytes);
  zip[zip.length - 22] = 0;
  assert.throws(() => ProjectZip.read(zip), { message: 'invalidArchive' });
});

test('MFP round trip keeps the original frame and audio entries', async () => {
  const exported = await MfpCodec.write(scene());
  const reopened = await MfpCodec.read(exported);
  const reexported = await MfpCodec.write(reopened);
  assert.deepEqual(MfpCodec.readEntries(reexported), MfpCodec.readEntries(exported));
  assert.equal(new Timeline(reopened).segments.length, 5);
});

test('a project edit is reversible and a rejected edit leaves history intact', () => {
  const history = new History(scene());
  history.edit(project => { project.frames[2].pose[0] = 80; });
  history.undo();
  assert.equal(history.current.frames[2].pose[0], 25);
  history.redo();
  assert.equal(history.current.frames[2].pose[0], 80);
  assert.throws(() => history.edit(project => {
    project.splice(1, 2);
    project.loops();
  }), { message: 'invalidLoop' });
  assert.equal(history.current.frames.length, 3);
});

test('USB verifies role, calibrates, sends the requested pose and waits for exit OK', async () => {
  const hid = new EventTarget();
  const device = new EventTarget();
  device.productName = 'MINI-BASE';
  device.open = async () => { device.opened = true; };
  device.close = async () => { device.opened = false; };
  hid.requestDevice = async () => [device];
  Object.defineProperty(navigator, 'hid', { configurable: true, value: hid });
  const commands = [];
  const replies = new Map([[251, Buffer.from('MINI-BUZZ')], [245, new Uint8Array(48).fill(1)], [246, [79, 75]]]);
  device.sendReport = async (report, bytes) => {
    assert.equal(report, 0);
    assert.equal(bytes.at(-1), bytes.subarray(2, -1).reduce((sum, byte) => sum + byte, 0) & 255);
    const command = bytes[3];
    commands.push(command);
    if (command === 1) assert.deepEqual([...bytes.slice(4, 8)], [181, 181, 41, 91]);
    const reply = replies.get(command);
    if (!reply) return;
    const body = [command, ...reply];
    const length = body.length + 1;
    const checksum = body.reduce((sum, byte) => sum + byte, length) & 255;
    const packet = Uint8Array.from([255, 255, length, ...body, checksum]);
    const event = new Event('inputreport');
    event.data = new DataView(packet.buffer);
    device.dispatchEvent(event);
  };
  try {
    const usb = new MiniBase(() => {});
    await usb.connect();
    await usb.enterProgramming();
    await usb.pose(initialPose());
    await usb.pose(initialPose(), () => false);
    await usb.disconnect();
    assert.deepEqual(commands, [251, 245, 1, 246]);
    assert.equal(usb.connected, false);
  } finally {
    delete navigator.hid;
  }
});
