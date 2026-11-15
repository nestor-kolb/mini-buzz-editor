'use strict';

class ProjectZip {
  static manifest = 'project.json';
  static localSignature = 0x04034b50;
  static directorySignature = 0x02014b50;
  static endSignature = 0x06054b50;

  static write(project) {
    const data = JSON.parse(project.toJson());
    const entries = [];
    for (const [id, asset] of Object.entries(data.assets)) {
      const bytes = project.assets[id].bytes;
      if (!bytes?.length) throw new EditorError('missingAudio', asset.path);
      if (bytes.length > Buzz.audioLimit) throw new EditorError('oversizeAudio', asset.path);
      asset.path = id + '.mp3';
      entries.push([asset.path, bytes]);
    }
    const encoder = new TextEncoder();
    entries.unshift([this.manifest, encoder.encode(JSON.stringify(data, null, 2))]);
    if (entries.length > 65535) throw new EditorError('invalidArchive');
    const local = [];
    const directory = [];
    let offset = 0;
    let directorySize = 0;
    const header = size => new DataView(new ArrayBuffer(size));
    for (const [filename, bytes] of entries) {
      const name = encoder.encode(filename);
      if (name.length > 65535 || offset + bytes.length > 0xffffffff) throw new EditorError('invalidArchive');
      const crc = crc32(bytes);
      const file = header(30);
      file.setUint32(0, this.localSignature, true);
      file.setUint16(4, 20, true);
      file.setUint16(6, 0x800, true);
      file.setUint16(12, 0x21, true);
      file.setUint32(14, crc, true);
      file.setUint32(18, bytes.length, true);
      file.setUint32(22, bytes.length, true);
      file.setUint16(26, name.length, true);
      const item = header(46);
      item.setUint32(0, this.directorySignature, true);
      item.setUint16(4, 20, true);
      item.setUint16(6, 20, true);
      item.setUint16(8, 0x800, true);
      item.setUint16(14, 0x21, true);
      item.setUint32(16, crc, true);
      item.setUint32(20, bytes.length, true);
      item.setUint32(24, bytes.length, true);
      item.setUint16(28, name.length, true);
      item.setUint32(42, offset, true);
      local.push(file.buffer, name, bytes);
      directory.push(item.buffer, name);
      offset += file.byteLength + name.length + bytes.length;
      directorySize += item.byteLength + name.length;
    }
    if (offset + directorySize + 22 > 0xffffffff) throw new EditorError('invalidArchive');
    const end = header(22);
    end.setUint32(0, this.endSignature, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, directorySize, true);
    end.setUint32(16, offset, true);
    return new Blob([...local, ...directory, end.buffer], { type: 'application/zip' });
  }

  static read(bytes) {
    try {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const u16 = at => view.getUint16(at, true);
      const u32 = at => view.getUint32(at, true);
      const fail = () => { throw new EditorError('invalidArchive'); };
      const end = bytes.length - 22;
      if (end < 0 || u32(end) !== this.endSignature || u32(end + 4) || u16(end + 8) !== u16(end + 10)
        || u16(end + 20)) fail();
      const directory = u32(end + 16);
      if (directory + u32(end + 12) !== end) fail();
      const entries = new Map();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let position = directory;
      let nextOffset = 0;
      for (let index = 0; index < u16(end + 10); index++) {
        if (position + 46 > end || u32(position) !== this.directorySignature
          || (u16(position + 8) & ~0x800) || u16(position + 10)) fail();
        const size = u32(position + 20);
        const nameLength = u16(position + 28);
        const next = position + 46 + nameLength + u16(position + 30) + u16(position + 32);
        const offset = u32(position + 42);
        if (next > end || offset !== nextOffset || offset + 30 > directory || size !== u32(position + 24)
          || u32(offset) !== this.localSignature || u16(offset + 8) || u16(offset + 6) !== u16(position + 8)
          || u32(offset + 18) !== size || u32(offset + 22) !== size || u16(offset + 26) !== nameLength) fail();
        const start = offset + 30 + nameLength + u16(offset + 28);
        if (start + size > directory) fail();
        const name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));
        if (entries.has(name) || !/^(?:project\.json|[a-z0-9-]+\.mp3)$/i.test(name)
          || decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)) !== name) fail();
        const content = bytes.subarray(start, start + size);
        const crc = u32(position + 16);
        if (crc !== u32(offset + 14) || crc !== crc32(content)) fail();
        entries.set(name, content);
        position = next;
        nextOffset = start + size;
      }
      if (position !== end || nextOffset !== directory || !entries.has(this.manifest)) fail();
      const project = Project.fromJson(JSON.parse(decoder.decode(entries.get(this.manifest))));
      project.loops();
      for (const asset of Object.values(project.assets)) {
        asset.bytes = entries.get(asset.path);
        if (!asset.bytes?.length) throw new EditorError('missingAudio', asset.path);
        if (asset.bytes.length > Buzz.audioLimit) throw new EditorError('oversizeAudio', asset.path);
      }
      return project;
    } catch (error) {
      if (error instanceof EditorError) throw error;
      throw new EditorError('invalidArchive');
    }
  }
}

Object.assign(globalThis, { ProjectZip });
