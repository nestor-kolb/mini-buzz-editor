'use strict';

const Buzz = Object.freeze({
  axes: [['left', 10, 180, 180], ['right', 10, 180, 180], ['head', 10, 90, 40], ['waist', 10, 180, 90]],
  speed: [1, 100, 12], delay: [0, 250, 0],
  slots: 48, frameSize: 59, audioLimit: 5 * 1024 ** 2, nameLimit: 20,
  audioCodes: { keep: 252, stop: 251, resume: 250 },
  // Preview estimates. The public Studio bundle gives points, not physical timing.
  timing: { speed: 50, delay: 100 },
  usb: { vendorId: 1155, productId: 22352, prefix: 'MINI-BASE', role: 'MINI-BUZZ',
    report: 0, interval: 50, settle: 2000, poseParameter: 40,
    command: { role: 251, enter: 245, exit: 246, storage: 252, pose: 1 } }
});

class EditorError extends Error {
  constructor(key, detail = '') { super(key); this.detail = detail; }
}

const initialPose = () => Buzz.axes.map(axis => axis[3]);
const defaultFrame = () => ({
  pose: [...initialPose(), ...Array(Buzz.slots - Buzz.axes.length).fill(0)],
  speed: Buzz.speed[2], delay: Buzz.delay[2], loop: 0, audio: { mode: 'keep' }
});
const uid = () => crypto.randomUUID();
const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class Project {
  constructor(title = '', frames = [defaultFrame()], groups = [], assets = {}) {
    Object.assign(this, { title, frames, groups, assets });
  }

  static fromJson(value) {
    const invalid = () => { throw new EditorError('invalidProject'); };
    if (value?.version !== 1 || typeof value.title !== 'string' || !Array.isArray(value.frames)
      || !Array.isArray(value.groups) || !value.assets || typeof value.assets !== 'object'
      || Array.isArray(value.assets)) invalid();
    const assets = Object.create(null);
    for (const [id, asset] of Object.entries(value.assets)) {
      if (!/^[a-z0-9-]+$/i.test(id) || !asset || !/^[^\\/:*?"<>|]+\.mp3$/i.test(asset.path)) invalid();
      assets[id] = { path: asset.path, label: typeof asset.label === 'string' ? asset.label : undefined };
    }
    for (const frame of value.frames) {
      if (!frame || frame.pose?.length !== Buzz.slots || !Array.isArray(frame.pose)
        || !frame.pose.every(number => inRange(number, -255, 255))
        || !['speed', 'delay', 'loop'].every(key => inRange(frame[key], 0, 255))
        || !frame.audio || !['keep', 'stop', 'resume', 'play'].includes(frame.audio.mode)
        || (frame.audio.mode === 'play' && !Object.hasOwn(assets, frame.audio.id))) invalid();
    }
    const used = new Set();
    for (const group of value.groups) {
      if (!group || typeof group.name !== 'string' || !inRange(group.start, 0, value.frames.length - 1)
        || !inRange(group.end, group.start + 1, value.frames.length)) invalid();
      for (let index = group.start; index < group.end; index++) {
        if (used.has(index)) invalid();
        used.add(index);
      }
    }
    return new Project(value.title, value.frames, value.groups, assets);
  }

  toJson() {
    const assets = Object.fromEntries(Object.entries(this.assets)
      .filter(([id]) => this.frames.some(frame => frame.audio.id === id))
      .map(([id, asset]) => [id, { path: asset.path, label: asset.label }]));
    return JSON.stringify({ version: 1, title: this.title, frames: this.frames, groups: this.groups, assets }, null, 2);
  }

  clone() {
    return new Project(this.title, structuredClone(this.frames), structuredClone(this.groups), { ...this.assets });
  }

  slice(start, end) {
    const frames = structuredClone(this.frames.slice(start, end));
    const groups = this.groups.filter(group => group.start >= start && group.end <= end)
      .map(group => ({ ...group, start: group.start - start, end: group.end - start }));
    const assets = Object.fromEntries(frames.filter(frame => frame.audio.mode === 'play')
      .map(frame => [frame.audio.id, this.assets[frame.audio.id]]));
    return new Project(this.title, frames, groups, assets);
  }

  splice(start, end, fragment = new Project('', [])) {
    const delta = fragment.frames.length - (end - start);
    const frames = structuredClone(fragment.frames);
    for (const [id, asset] of Object.entries(fragment.assets)) {
      const existing = Object.hasOwn(this.assets, id) ? this.assets[id] : undefined;
      if (!existing || (existing.path === asset.path && !existing.bytes)) {
        this.assets[id] = asset;
      } else if (existing.path !== asset.path || (asset.bytes && asset.bytes !== existing.bytes)) {
        const nextId = uid();
        this.assets[nextId] = { ...asset, path: nextId + '.mp3' };
        for (const frame of frames) if (frame.audio.id === id) frame.audio.id = nextId;
      }
    }
    this.frames.splice(start, end - start, ...frames);
    this.groups = this.groups.flatMap(group => {
      if (group.end <= start) return [group];
      if (group.start >= end) return [{ ...group, start: group.start + delta, end: group.end + delta }];
      const left = group.start < start;
      const right = group.end > end;
      if (left && right && !fragment.groups.length) return [{ ...group, end: group.end + delta }];
      return [
        ...(left ? [{ ...group, end: start }] : []),
        ...(right ? [{ ...group, start: start + fragment.frames.length, end: group.end + delta }] : [])
      ];
    }).concat(fragment.groups.map(group => ({ ...group, start: start + group.start, end: start + group.end })));
  }

  loops() {
    const loops = new Map();
    let start = -1;
    for (const [index, frame] of this.frames.entries()) {
      const marker = frame.loop;
      if (marker >= 128) {
        if (start === -1) start = index;
        if (marker === 128 || marker !== this.frames[start].loop) throw new EditorError('invalidLoop', index + 1);
      } else if (marker) {
        if (start === -1 || marker !== this.frames[start].loop - 128) throw new EditorError('invalidLoop', index + 1);
        loops.set(index, { start, count: marker });
        start = -1;
      } else if (start !== -1) {
        throw new EditorError('invalidLoop', index + 1);
      }
    }
    if (start !== -1) throw new EditorError('invalidLoop', start + 1);
    return loops;
  }

  validateMotion() {
    this.loops();
    this.frames.forEach((_, index) => this.validateFrameMotion(index));
  }

  validateFrameMotion(index) {
    const frame = this.frames[index];
    const valid = Buzz.axes.every(([, min, max], axis) => inRange(frame.pose[axis], min, max))
      && frame.pose.slice(Buzz.axes.length).every(value => value === 0)
      && inRange(frame.speed, ...Buzz.speed.slice(0, 2)) && inRange(frame.delay, ...Buzz.delay.slice(0, 2));
    if (!valid) throw new EditorError('invalidMotion', index + 1);
  }
}

class History {
  constructor(project) { this.reset(project); }
  reset(project) { this.current = project; this.past = []; this.future = []; }
  edit(operation) {
    const next = this.current.clone();
    operation(next);
    this.past.push(this.current);
    this.current = next;
    this.future = [];
  }
  undo() { if (this.past.length) { this.future.push(this.current); this.current = this.past.pop(); } }
  redo() { if (this.future.length) { this.past.push(this.current); this.current = this.future.pop(); } }
}

class Timeline {
  static milliseconds(parameter, points) {
    return points * Buzz.timing[parameter];
  }

  static frameDuration(frame) {
    return Math.max(1, this.milliseconds('speed', frame.speed)) + this.milliseconds('delay', frame.delay);
  }

  constructor(project) {
    const loops = project.loops();
    this.segments = [];
    this.boundaries = [];
    this.length = 0;
    let previous = initialPose();
    let audio = null;
    let audioOffset = 0;
    let audible = false;
    const repetitions = new Map();
    for (let index = 0; index < project.frames.length;) {
      const frame = project.frames[index];
      const motion = Math.max(1, Timeline.milliseconds('speed', frame.speed));
      const duration = Timeline.frameDuration(frame);
      if (frame.audio.mode === 'play') {
        audio = frame.audio.id;
        audioOffset = 0;
        audible = true;
      } else if (frame.audio.mode === 'stop') {
        audio = null;
        audible = false;
      } else if (frame.audio.mode === 'resume') {
        audible = Boolean(audio);
      }
      this.boundaries[index] ??= this.length;
      this.segments.push({ start: this.length, end: this.length + duration, index,
        motion, previous, target: frame.pose, audio: audible ? audio : null, audioOffset });
      previous = frame.pose;
      this.length += duration;
      if (audible) audioOffset += duration;
      const loop = loops.get(index);
      const remaining = repetitions.get(index) ?? (loop ? loop.count - 1 : 0);
      if (remaining) {
        repetitions.set(index, remaining - 1);
        index = loop.start;
      } else {
        repetitions.delete(index++);
      }
    }
    this.boundaries[project.frames.length] = this.length;
  }

  at(time) {
    let low = 0;
    let high = this.segments.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.segments[middle].end <= time) low = middle + 1;
      else high = middle;
    }
    const segment = this.segments[Math.min(low, this.segments.length - 1)];
    if (!segment) return { pose: initialPose(), audio: null, index: -1 };
    const elapsed = Math.max(0, time - segment.start);
    const fraction = Math.min(1, elapsed / segment.motion);
    const eased = fraction * fraction * (3 - 2 * fraction);
    const pose = Buzz.axes.map((_, index) => segment.previous[index]
      + (segment.target[index] - segment.previous[index]) * eased);
    return { pose, index: segment.index, segment, audio: segment.audio, offset: (segment.audioOffset + elapsed) / 1000 };
  }
}

Object.assign(globalThis, { Buzz, EditorError, Project, History, Timeline, crc32, initialPose, defaultFrame, uid, inRange });
