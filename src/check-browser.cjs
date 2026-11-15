'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');

function browserPath() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const programs = ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe'];
  const candidates = [process.env.BUZZ_TEST_BROWSER, ...roots.flatMap(root => programs.map(exe => path.join(root, exe)))];
  const executable = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!executable) throw new Error('Set BUZZ_TEST_BROWSER to the installed Edge or Chrome executable.');
  return executable;
}

async function until(predicate, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await wait(30);
  }
  throw new Error('Timed out: ' + description);
}

async function openDebugPage(profile) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  await until(() => fs.existsSync(portFile), 'browser debugging port');
  const [port] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let sequence = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const receive = event => {
      const reply = JSON.parse(event.data);
      if (reply.id !== id) return;
      socket.removeEventListener('message', receive);
      if (reply.error) reject(new Error(reply.error.message));
      else resolve(reply.result);
    };
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (operation, ...args) => {
    const expression = '(' + operation.toString() + ')(...' + JSON.stringify(args) + ')';
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception.description);
    return reply.result.value;
  };
  return { send, evaluate, close: () => socket.close() };
}

async function checkEditor({ send, evaluate }) {
  const click = selector => evaluate(value => document.querySelector(value).click(), selector);
  const choose = (index, modifiers = {}) => evaluate((position, keys) => {
    document.querySelectorAll('#frames .clip')[position].dispatchEvent(new MouseEvent('click', { bubbles: true, ...keys }));
  }, index, modifiers);
  const addFrames = count => evaluate(total => {
    for (let i = 0; i < total; i++) document.querySelector('#add').click();
  }, count);
  const editNumber = (index, value) => evaluate((position, next) => {
    const field = document.querySelectorAll('#properties input[type=number]')[position];
    field.value = next;
    field.dispatchEvent(new Event('change'));
  }, index, value);
  const count = () => evaluate(() => document.querySelectorAll('#frames .clip').length);
  const selected = () => evaluate(() => [...document.querySelectorAll('#frames .selected')].map(clip => Number(clip.textContent)));
  const scroll = () => evaluate(() => document.querySelector('#scroller').scrollLeft);
  const mouse = (type, x, y, options) => send('Input.dispatchMouseEvent', { type, x, y, ...options });
  const press = (x, y) => mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
  const move = (x, y) => mouse('mouseMoved', x, y, { button: 'left', buttons: 1 });
  const release = (x, y) => mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
  const dragPoint = selector => evaluate(value => {
    const clip = document.querySelector(value).getBoundingClientRect();
    const scroller = document.querySelector('#scroller').getBoundingClientRect();
    return { x: clip.left + Math.min(45, clip.width / 2), y: clip.top + clip.height / 2, right: scroller.right };
  }, selector);

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await until(count, 'editor boot');
  await evaluate(() => {
    window.confirm = () => true;
    // Leave room inside the browser viewport for dragging past the timeline edge.
    document.querySelector('#scroller').style.flex = '0 0 850px';
  });

  await addFrames(9);
  await choose(0);
  await choose(2, { ctrlKey: true });
  assert.deepEqual(await selected(), [1, 3]);
  await editNumber(4, 1000);
  const motions = () => evaluate(() => [...document.querySelectorAll('#frames .clip')].slice(0, 3)
    .map(clip => clip.title.split(' · ')[1]));
  assert.deepEqual(await motions(), ['1000 + 0 ms', '600 + 0 ms', '1000 + 0 ms']);
  await click('#undo');
  assert.deepEqual(await motions(), ['600 + 0 ms', '600 + 0 ms', '600 + 0 ms']);
  await choose(0);
  await choose(2, { ctrlKey: true });
  await click('#copy');
  await click('#delete');
  assert.equal(await count(), 8);
  await click('#paste');
  assert.equal(await count(), 10);
  await mouse('mouseWheel', 350, 350, { deltaX: 0, deltaY: 250 });
  await until(async () => await scroll() > 0, 'horizontal wheel scrolling');
  console.log('Browser: disjoint selection, bulk edit, undo, copy, delete and paste.');

  for (const kind of ['single', 'group', 'disjoint']) {
    await click('#new');
    await addFrames(13);
    await evaluate(() => { document.querySelector('#scroller').scrollLeft = 0; });
    if (kind !== 'single') {
      await choose(0);
      if (kind === 'group') {
        await choose(1, { shiftKey: true });
        await click('#group');
      } else await choose(2, { ctrlKey: true });
    }
    const { x, y, right } = await dragPoint(kind === 'group' ? '#groups .group-label' : '#frames .clip');
    const marker = () => evaluate(() => {
      const element = document.querySelector('#dropMarker');
      return element.hidden ? null : element.style.left;
    });
    await press(x, y);
    await move(right + 110, y);
    await until(async () => await scroll() > 20 && await marker(), kind + ' starts scrolling');
    const start = await scroll();
    const initialMarker = await marker();
    await until(async () => await scroll() > start + 380 && await marker() !== initialMarker, kind + ' stationary scroll and marker');
    await move(right - 45, y);
    await release(right - 45, y);
    const selection = await selected();
    assert.equal(selection.length, kind === 'single' ? 1 : 2);
    assert(selection[0] > 3, kind + ' moved');
    const position = await scroll();
    await wait(80);
    assert.equal(await scroll(), position, kind + ' stops on release');
  }

  await evaluate(() => { document.querySelector('#scroller').scrollLeft = 0; });
  const { x, y, right } = await dragPoint('#ruler');
  await press(x, y);
  await move(right + 35, y);
  await wait(200);
  const first = await scroll();
  assert(first > 20);
  await move(right + 150, y);
  await wait(200);
  assert(await scroll() > first * 2);
  await release(right + 150, y);
  const final = await scroll();
  await wait(90);
  assert.equal(await scroll(), final);
  console.log('Browser: single frame, group and disjoint drag, insertion marker and shared playhead autoscroll.');

  await click('#new');
  await addFrames(4);
  await evaluate(() => {
    document.querySelector('#zoom').value = -6;
    document.querySelector('#zoom').dispatchEvent(new Event('input'));
    document.querySelector('#scroller').scrollLeft = 0;
  });
  await choose(1);
  await choose(2, { shiftKey: true });
  await click('#group');
  await choose(4);
  const source = await dragPoint('#frames .selected');
  const group = await evaluate(() => {
    const rect = document.querySelector('#groups .group').getBoundingClientRect();
    return { right: rect.right, y: rect.top + rect.height / 2 };
  });
  const bounds = () => evaluate(() => [...document.querySelectorAll('#groups .group')].map(node =>
    [Number(node.dataset.start), Number(node.dataset.end)]));
  await press(source.x, source.y);
  await move(group.right + 4, group.y);
  const zones = () => evaluate(() => [...document.querySelectorAll('.group-drop-zone')].map(node =>
    [node.textContent, getComputedStyle(node).backgroundColor]));
  assert.deepEqual(await zones(), [['', 'rgba(0, 0, 0, 0)'], ['', 'rgba(0, 0, 0, 0)']]);
  await release(group.right + 4, group.y);
  assert.deepEqual(await bounds(), [[1, 3]]);
  const outside = await dragPoint('#frames .selected');
  await press(outside.x, outside.y);
  await move(group.right - 12, group.y);
  assert.equal((await zones()).filter(([, color]) => color !== 'rgba(0, 0, 0, 0)').length, 1);
  await release(group.right - 12, group.y);
  assert.deepEqual(await bounds(), [[1, 4]]);
  await choose(0);
  const key = (code, shiftKey = false) => evaluate((keyCode, extend) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: keyCode, ctrlKey: true, shiftKey: extend, bubbles: true }));
  }, code, shiftKey);
  const clockText = () => evaluate(() => document.querySelector('#clock').textContent);
  await key('ArrowRight', true);
  assert.match(await clockText(), /^0\.60 /);
  assert.deepEqual(await selected(), [1, 2]);
  await choose(2);
  await key('ArrowLeft');
  assert.match(await clockText(), /^0\.60 /);
  console.log('Browser: group edge insertion and Ctrl+arrow navigation.');

  await click('#new');
  await addFrames(6);
  await choose(0);
  await choose(1, { shiftKey: true });
  await click('#group');
  await choose(5);
  await choose(6, { shiftKey: true });
  await click('#group');
  await evaluate(() => {
    const [first, last] = document.querySelectorAll('#groups .group-label');
    first.click();
    last.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, shiftKey: true }));
  });
  assert.deepEqual(await selected(), [1, 2, 6, 7]);
  await choose(0);
  await choose(1, { shiftKey: true });
  await choose(5, { ctrlKey: true });
  await choose(6, { ctrlKey: true, shiftKey: true });
  assert.deepEqual(await selected(), [1, 2, 6, 7]);

  await click('#new');
  await addFrames(1);
  await choose(1);
  await editNumber(0, 100);
  await evaluate(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Home', key: 'Home', bubbles: true }));
    window.poses = [];
    window.mockConnected = false;
    Object.defineProperty(MiniBase.prototype, 'connected', { get: () => window.mockConnected });
    MiniBase.prototype.connect = async () => { window.mockConnected = true; };
    MiniBase.prototype.enterProgramming = async () => {};
    MiniBase.prototype.pose = async (pose, active = () => true) => { if (active()) window.poses.push(pose); };
  });
  await click('#connect');
  await until(() => evaluate(() => !document.querySelector('#livePoses').disabled), 'simulated USB connection');
  await evaluate(() => { window.poses.length = 0; });
  await click('#livePoses');
  await click('#play');
  await until(() => evaluate(() => window.poses.length >= 2), 'two target poses');
  assert.deepEqual(await evaluate(() => window.poses), [[180, 180, 40, 90], [10, 180, 40, 90]]);
  await click('#play');
  const clock = await evaluate(() => document.querySelector('#clock').textContent);
  await wait(90);
  assert.equal(await evaluate(() => document.querySelector('#clock').textContent), clock);
  console.log('Browser: simulated USB playback sends two exact targets and pauses.');
}

async function main() {
  const executable = browserPath();
  const temporary = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(temporary, 'buzz-edge-'));
  const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
  const browser = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', page], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise(resolve => {
    browser.once('exit', resolve);
    browser.once('error', resolve);
  });
  let debugPage;
  try {
    debugPage = await openDebugPage(profile);
    await checkEditor(debugPage);
  } finally {
    debugPage?.close();
    browser.kill();
    await Promise.race([exited, wait(500)]);
    const resolved = fs.realpathSync(profile);
    if (path.dirname(resolved) === temporary && path.basename(resolved).startsWith('buzz-edge-')) {
      try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); }
      catch { console.warn('Could not remove the temporary browser profile:', resolved); }
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
