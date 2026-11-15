'use strict';

class MfpCodec {
  static headerSize = 24;
  static entrySize = 22;
  static mime = { audio: 'audio/mpeg', motion: 'application/octet-stream' };

  static async hash(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  }

  static readEntries(bytes) {
    const fail = () => { throw new EditorError('invalidMfp'); };
    if (bytes.length < this.headerSize || bytes[0] !== 77 || bytes[1] !== 70 || bytes[2] !== 80
      || bytes[3] > 1 || bytes[4] !== 1 || bytes[5] !== 0) fail();
    const little = bytes[3] === 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(6, little);
    const table = Number(view.getBigUint64(10, little));
    if (table < this.headerSize || table > bytes.length || count > (bytes.length - table) / this.entrySize
      || crc32(bytes.subarray(0, 18)) !== view.getUint32(18, little)) fail();

    const entries = [];
    let cursor = table;
    let consumed = this.headerSize;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (let index = 0; index < count; index++) {
      if (cursor + this.entrySize > bytes.length) fail();
      const offset = this.headerSize + Number(view.getBigUint64(cursor, little));
      const size = Number(view.getBigUint64(cursor + 8, little));
      const nameLength = view.getUint8(cursor + 16);
      const mimeLength = view.getUint8(cursor + 17);
      const metaLength = view.getUint32(cursor + 18, little);
      cursor += this.entrySize;
      if (offset !== consumed || offset + size > table || !size || !nameLength
        || cursor + nameLength + mimeLength + metaLength > bytes.length) fail();
      const read = length => {
        const part = bytes.subarray(cursor, cursor + length);
        cursor += length;
        try { return decoder.decode(part); } catch { return fail(); }
      };
      entries.push({ name: read(nameLength), mime: read(mimeLength), metadata: read(metaLength),
        bytes: bytes.slice(offset, offset + size) });
      consumed += size;
    }
    if (cursor !== bytes.length || consumed !== table) fail();
    return entries;
  }

  static async read(bytes) {
    const assets = {};
    const audio = new Map();
    let motion;
    for (const entry of this.readEntries(bytes)) {
      if (entry.mime === this.mime.motion && /^[^\\/]+\.sh$/i.test(entry.name) && !motion) {
        motion = entry;
      } else if (entry.mime === this.mime.audio && /^\d+\.mp3$/i.test(entry.name)) {
        const number = Number(entry.name.slice(0, -4));
        if (!inRange(number, 0, 255) || audio.has(number)) throw new EditorError('unsupportedMfp', entry.name);
        if (entry.metadata && await this.hash(entry.bytes) !== entry.metadata.toLowerCase()) {
          throw new EditorError('invalidMfp', entry.name);
        }
        const id = uid();
        audio.set(number, id);
        assets[id] = { path: id + '.mp3', label: entry.name, bytes: entry.bytes };
      } else {
        throw new EditorError('unsupportedMfp', entry.name);
      }
    }
    if (!motion || motion.bytes.length % Buzz.frameSize) throw new EditorError('invalidMfp');
    const frames = [];
    const codes = Object.entries(Buzz.audioCodes);
    for (let offset = 0; offset < motion.bytes.length; offset += Buzz.frameSize) {
      const frame = motion.bytes.subarray(offset, offset + Buzz.frameSize);
      const pose = Array.from({ length: Buzz.slots }, (_, index) =>
        frame[7 + index] * (frame[1 + (index >> 3)] & (128 >> (index % 8)) ? -1 : 1));
      const code = codes.find(([, value]) => frame[57] === value && frame[58] === value);
      const command = code ? { mode: code[0] } : { mode: 'play', id: audio.get(frame[58]) };
      if (!code && (frame[57] !== 0 || !command.id)) throw new EditorError('unsupportedMfp', frames.length + 1);
      frames.push({ pose, speed: frame[55], delay: frame[56], loop: frame[0], audio: command });
    }
    const project = new Project(motion.name.slice(0, -3), frames, [], assets);
    project.loops();
    return project;
  }

  static writeEntries(entries) {
    const encoder = new TextEncoder();
    const directory = [];
    let payload = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const mime = encoder.encode(entry.mime);
      const metadata = encoder.encode(entry.metadata ?? '');
      if (name.length > 255 || mime.length > 255) throw new EditorError('invalidName');
      const record = new Uint8Array(this.entrySize);
      const view = new DataView(record.buffer);
      view.setBigUint64(0, BigInt(payload));
      view.setBigUint64(8, BigInt(entry.bytes.length));
      record[16] = name.length;
      record[17] = mime.length;
      view.setUint32(18, metadata.length);
      directory.push(record, name, mime, metadata);
      payload += entry.bytes.length;
    }
    const header = new Uint8Array(this.headerSize);
    header.set([77, 70, 80, 1, 1, 0]);
    const view = new DataView(header.buffer);
    view.setUint32(6, entries.length);
    view.setBigUint64(10, BigInt(this.headerSize + payload));
    view.setUint32(18, crc32(header.subarray(0, 18)));
    const chunks = [header, ...entries.map(entry => entry.bytes), ...directory];
    const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let position = 0;
    for (const chunk of chunks) {
      result.set(chunk, position);
      position += chunk.length;
    }
    return result;
  }

  static async write(project) {
    if (!project.frames.length) throw new EditorError('empty');
    if (!project.title.trim() || project.title.length > Buzz.nameLimit || /[\\/:*?"<>|\x00-\x1f]/.test(project.title)) {
      throw new EditorError('invalidName', Buzz.nameLimit);
    }
    project.validateMotion();
    const entries = [];
    const tracks = new Map();
    const bytes = new Uint8Array(project.frames.length * Buzz.frameSize);
    for (const [index, frame] of project.frames.entries()) {
      const encoded = bytes.subarray(index * Buzz.frameSize, (index + 1) * Buzz.frameSize);
      encoded[0] = frame.loop;
      for (const [axis, value] of frame.pose.entries()) {
        if (value < 0) encoded[1 + (axis >> 3)] |= 128 >> (axis % 8);
        encoded[7 + axis] = Math.abs(value);
      }
      encoded[55] = frame.speed;
      encoded[56] = frame.delay;
      if (frame.audio.mode !== 'play') {
        encoded[57] = encoded[58] = Buzz.audioCodes[frame.audio.mode];
        continue;
      }
      const id = frame.audio.id;
      if (!tracks.has(id)) {
        const asset = project.assets[id];
        if (!asset?.bytes) throw new EditorError('missingAudio', asset?.path ?? index + 1);
        if (asset.bytes.length > Buzz.audioLimit) throw new EditorError('oversizeAudio', asset.path);
        if (tracks.size > 255) throw new EditorError('tooManyTracks');
        const track = tracks.size;
        tracks.set(id, track);
        entries.push({ name: track + '.mp3', mime: this.mime.audio, bytes: asset.bytes, metadata: await this.hash(asset.bytes) });
      }
      encoded[58] = tracks.get(id);
    }
    entries.push({ name: project.title + '.sh', mime: this.mime.motion, bytes });
    return this.writeEntries(entries);
  }
}

Object.assign(globalThis, { MfpCodec });
