'use strict';

class MiniBase {
  constructor(onDisconnect) {
    this.config = Buzz.usb;
    this.device = null;
    this.calibration = null;
    this.programmingRequested = false;
    this.buffer = [];
    this.pending = null;
    this.lastReport = -Infinity;
    this.tail = Promise.resolve();
    this.onDisconnect = onDisconnect;
    navigator.hid?.addEventListener('disconnect', event => {
      if (event.device !== this.device) return;
      this.pending?.finish(null);
      this.device.removeEventListener('inputreport', this.receiveReport);
      this.device = this.calibration = null;
      this.programmingRequested = false;
      this.onDisconnect();
    });
  }

  get connected() { return Boolean(this.device?.opened); }

  async connect() {
    if (this.connected) return;
    if (!navigator.hid) throw new EditorError('hidUnavailable');
    const { vendorId, productId, prefix, role, command } = this.config;
    const devices = await navigator.hid.requestDevice({ filters: [{ vendorId, productId }] });
    const device = devices.find(candidate => candidate.productName.startsWith(prefix));
    if (!device) throw new EditorError('noDevice');
    await device.open();
    this.device = device;
    this.buffer = [];
    this.calibration = null;
    this.programmingRequested = false;
    this.receiveReport = event => this.receive(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
    device.addEventListener('inputreport', this.receiveReport);
    try {
      const reply = await this.request(command.role, 3000);
      if (new TextDecoder().decode(reply).replace(/\0+$/, '').trim() !== role) throw new EditorError('wrongRobot');
    } catch (error) {
      device.removeEventListener('inputreport', this.receiveReport);
      this.device = null;
      if (device.opened) await device.close();
      throw error;
    }
  }

  receive(bytes) {
    this.buffer.push(...bytes);
    while (this.buffer.length >= 4) {
      const start = this.buffer.findIndex((byte, index) => byte === 255 && this.buffer[index + 1] === 255);
      if (start < 0) { this.buffer = this.buffer.slice(-1); return; }
      this.buffer.splice(0, start);
      const length = this.buffer[2];
      if (length < 2 || length > 62) { this.buffer.shift(); continue; }
      if (this.buffer.length < length + 3) return;
      const body = this.buffer.slice(3, length + 2);
      const checksum = (body.reduce((sum, byte) => sum + byte, length)) & 255;
      if (checksum !== this.buffer[length + 2]) { this.buffer.shift(); continue; }
      this.buffer.splice(0, length + 3);
      const [command, ...data] = body;
      if (this.pending?.command === command && this.pending.accept(data)) this.pending.finish(Uint8Array.from(data));
    }
  }

  async send(payload, active = () => true) {
    const device = this.device;
    const task = this.tail.then(async () => {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, this.config.interval - (performance.now() - this.lastReport))));
      if (!active()) return;
      if (!device?.opened || this.device !== device) throw new EditorError('noDevice');
      const length = payload.length + 1;
      const checksum = payload.reduce((sum, byte) => sum + byte, length) & 255;
      this.lastReport = performance.now();
      await device.sendReport(this.config.report, Uint8Array.from([255, 255, length, ...payload, checksum]));
    });
    this.tail = task.catch(() => {});
    return task;
  }

  request(command, timeout, accept = () => true, onSend = () => {}) {
    return new Promise((resolve, reject) => {
      if (this.pending) { reject(new EditorError('usbBusy')); return; }
      const finish = (reply, error) => {
        clearTimeout(timer);
        this.pending = null;
        if (reply) resolve(reply);
        else reject(error ?? new EditorError('noReply'));
      };
      const timer = setTimeout(() => finish(null), timeout);
      const pending = { command, accept, finish };
      this.pending = pending;
      this.send([command], () => {
        if (this.pending !== pending) return false;
        onSend();
        return true;
      }).catch(error => {
        if (this.pending === pending) finish(null, error);
      });
    });
  }

  async enterProgramming() {
    if (this.calibration) return;
    if (!this.calibrationRequest) {
      const device = this.device;
      this.calibrationRequest = this.request(this.config.command.enter, 30000, data => data.length === Buzz.slots,
        () => { this.programmingRequested = true; })
        .then(calibration => { if (this.device === device && this.programmingRequested) this.calibration = calibration; })
        .finally(() => { this.calibrationRequest = null; });
    }
    await this.calibrationRequest;
  }

  async prepare(pose, active) {
    await this.enterProgramming();
    if (!active()) return;
    await this.pose(pose, active);
    await new Promise(resolve => setTimeout(resolve, this.config.settle));
  }

  async pose(pose, active = () => true) {
    if (!this.calibration) throw new EditorError('noReply');
    const values = pose.map((value, index) => Math.round(value) + this.calibration[index]);
    if (values.some(value => !inRange(value, 0, 255))) throw new EditorError('invalidCalibration');
    const padded = [...values, ...Array(Buzz.slots - values.length).fill(0)];
    await this.send([this.config.command.pose, ...padded, this.config.poseParameter], active);
  }

  async exitProgramming() {
    if (this.pending?.command === this.config.command.enter) this.pending.finish(null);
    if (this.pending) throw new EditorError('usbBusy');
    if (this.programmingRequested) {
      await this.request(this.config.command.exit, 3000, data => data[0] === 79 && data[1] === 75);
      this.programmingRequested = false;
      this.calibration = null;
    }
  }

  async disconnect() {
    await this.exitProgramming();
    const device = this.device;
    if (!device) return;
    device.removeEventListener('inputreport', this.receiveReport);
    await device.close();
    this.device = null;
  }

  async storage() {
    await this.exitProgramming();
    await this.send([this.config.command.storage]);
  }
}

Object.assign(globalThis, { MiniBase });
