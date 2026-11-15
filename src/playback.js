'use strict';

class AudioPreview {
  constructor(onError) {
    this.audio = new Audio();
    this.onError = onError;
    this.url = null;
    this.asset = null;
    this.generation = 0;
  }

  stop() {
    this.generation++;
    this.audio.pause();
    this.audio.onloadedmetadata = this.audio.onerror = null;
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = this.asset = null;
  }

  sync(asset, offset) {
    if (!asset?.bytes) {
      if (this.asset) this.stop();
      return;
    }
    this.offset = offset;
    if (asset === this.asset && Math.abs(this.audio.currentTime - offset) < .35) return;
    if (asset === this.asset && (!Number.isFinite(this.audio.duration) || offset >= this.audio.duration)) return;
    const generation = ++this.generation;
    const start = () => {
      if (generation !== this.generation || this.offset >= this.audio.duration) return;
      this.audio.currentTime = this.offset;
      this.audio.play().catch(error => {
        if (error.name !== 'AbortError' && generation === this.generation) this.onError();
      });
    };
    if (asset === this.asset) { start(); return; }
    this.audio.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.asset = asset;
    this.url = URL.createObjectURL(new Blob([asset.bytes], { type: 'audio/mpeg' }));
    this.audio.onloadedmetadata = start;
    this.audio.onerror = () => { if (generation === this.generation) this.onError(); };
    this.audio.src = this.url;
  }
}

class PlaybackSession {
  constructor(usb, callbacks) {
    this.usb = usb;
    this.callbacks = callbacks;
    this.sound = new AudioPreview(callbacks.onAudioError);
    this.run = null;
  }

  get running() { return Boolean(this.run); }
  get live() { return Boolean(this.run?.live); }

  pause() {
    const wasPlaying = this.running;
    this.run = null;
    this.sound.stop();
    this.callbacks.onPause(wasPlaying);
  }

  async play(project, timeline, start, live) {
    if (live) project.validateMotion();
    const run = { live, target: null, pending: false };
    this.run = run;
    this.callbacks.onStart();
    const active = () => this.run === run && this.callbacks.liveEnabled();
    try {
      if (live) await this.usb.enterProgramming();
    } catch (error) {
      if (this.run !== run) return;
      this.pause();
      throw error;
    }
    if (this.run !== run) return;
    const origin = performance.now() - start;
    const tick = now => {
      if (this.run !== run) return;
      const time = Math.min(timeline.length, Math.max(0, now - origin));
      this.callbacks.onFrame(time);
      if (time >= timeline.length) { this.pause(); return; }
      const state = timeline.at(time);
      if (live) this.sendTarget(run, state.segment.target, active);
      this.sound.sync(project.assets[state.audio], state.offset);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  sendTarget(run, target, active) {
    const pose = target.slice(0, Buzz.axes.length);
    if (run.pending || run.target?.every((value, axis) => value === pose[axis])) return;
    run.pending = true;
    run.target = pose;
    this.usb.pose(pose, active).catch(error => {
      if (this.run !== run) return;
      this.pause();
      this.callbacks.onError(error);
    }).finally(() => { run.pending = false; });
  }
}
