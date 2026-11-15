'use strict';

const $ = id => document.getElementById(id);
const element = (tag, className, label) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label !== undefined) node.textContent = label;
  return node;
};
const download = (name, content, type) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = element('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};

const icons = {
  play: 'M8 5l12 7-12 7z', pause: 'M9 5v14m6-14v14',
  fit: 'M3 5v14m18-14v14M6 12h12m-9-3-3 3 3 3m6-6 3 3-3 3',
  fullscreen: 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5',
  add: 'M4 6h16v12H4zm8 3v6m-3-3h6',
  addAudio: 'M10 16V5l8-2v8M10 16a2.5 2 0 1 1-5 0 2.5 2 0 1 1 5 0zm8-5a2.5 2 0 1 1-5 0 2.5 2 0 1 1 5 0zm0 4v6m-3-3h6',
  duplicate: 'M8 8h12v12H8zM4 16V4h12m-2 7v6m-3-3h6',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  paste: 'M8 5H5v15h14V5h-3M8 3h8v5H8z',
  delete: 'M4 6h16M9 6V3h6v3m3 0-1 14H7L6 6m4 4v6m4-6v6',
  group: 'M8 4H4v16h4m8-16h4v16h-4M8 9h3v6H8zm5 0h3v6h-3z',
  rename: 'M4 20l1-5L16 4l4 4L9 19zm9-13l4 4',
  ungroup: 'M6 4H3v16h3m12-16h3v16h-3M7 9h3v6H7zm7 0h3v6h-3z',
  undo: 'M9 6l-5 5 5 5m-5-5h10a5 5 0 0 1 5 5v2',
  redo: 'M15 6l5 5-5 5m5-5H10a5 5 0 0 0-5 5v2',
  pose: 'M12 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM4 9l8 2 8-2m-8 2v4m0 0-4 6m4-6 4 6',
  timer: 'M9 3h6m-3 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm0 3v4l3 2',
  reset: 'M5 11a7 7 0 1 1 2 6m-2-12v6h6'
};

const shortcuts = [
  ['add', 'Insert', 'Insert'], ['duplicate', 'KeyD', 'Ctrl+D', true],
  ['copy', 'KeyC', 'Ctrl+C', true], ['paste', 'KeyV', 'Ctrl+V', true],
  ['delete', 'Delete', 'Delete'], ['group', 'KeyG', 'Ctrl+G', true],
  ['rename', 'F2', 'F2'], ['ungroup', 'KeyG', 'Ctrl+Shift+G', true, true],
  ['undo', 'KeyZ', 'Ctrl+Z', true], ['redo', 'KeyY', 'Ctrl+Y', true],
  ['redo', 'KeyZ', 'Ctrl+Shift+Z', true, true], ['play', 'Space', 'Space']
];

function setIcon(button, name, title) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', icons[name]);
  svg.append(path);
  button.replaceChildren(svg);
  button.title = title;
  button.setAttribute('aria-label', title);
}

class Editor {
  constructor() {
    this.language = 'ru';
    this.studioUnits = false;
    this.history = new History(new Project(this.t('untitled')));
    this.time = 0;
    this.frames = new FrameEditing(this.history);
    this.viewport = new TimelineInteraction(this);
    this.busy = false;
    this.usb = new MiniBase(() => {
      this.usbReady = false;
      this.livePoses = false;
      this.pause();
      this.renderButtons();
      this.status('offline', '', true);
    });
    this.playback = new PlaybackSession(this.usb, {
      onStart: () => { this.renderButtons(); this.status(''); },
      onFrame: time => {
        this.time = time;
        this.draw();
        this.viewport.revealPlayhead();
      },
      onPause: wasPlaying => {
        if (wasPlaying) {
          this.syncInsertion();
          this.markFrames();
        }
        this.renderButtons();
      },
      onError: error => this.status(error.message, error.detail, true),
      onAudioError: () => this.status('audioPreviewError', '', true),
      liveEnabled: () => this.livePoses && !document.hidden
    });
    this.preview = new BuzzPreview($('robotPreview'));
    this.bind();
    this.refresh();
  }

  get project() { return this.history.current; }
  t(key) { return messages[key]?.[this.language === 'en' ? 1 : 0] ?? key; }

  status(key, detail = '', error = false) {
    $('status').textContent = [key ? this.t(key) : '', detail].filter(Boolean).join(' · ');
    $('status').classList.toggle('error', error);
  }

  act(operation) {
    return async event => {
      try { await operation(event); }
      catch (error) {
        if (error.name !== 'AbortError') this.status(error.message, error.detail, true);
      }
    };
  }

  bind() {
    const actions = {
      new: () => this.replace(new Project(this.t('untitled'))),
      open: () => $('openFile').click(),
      relinkFolder: () => this.resolveAudio(),
      exportProject: () => {
        const project = this.project;
        const name = project.title.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'project';
        download(name + '.zip', ProjectZip.write(project), 'application/zip');
        this.status('archiveReady');
      },
      export: async () => {
        const project = this.project;
        download(project.title + '.mfp', await MfpCodec.write(project), MfpCodec.mime.motion);
        this.status('exportDone', project.groups.length ? this.t('mfpGroupNote') : '');
      },
      addAudio: () => this.attachAudio(Math.max(0, this.timeline.at(this.time).index)),
      add: () => this.insert(new Project('', [defaultFrame()])),
      duplicate: () => this.insert(this.frames.fragment(), this.frames.selection.end),
      copy: () => { this.frames.copy(); this.renderButtons(); },
      paste: () => this.insert(this.frames.clipboard), delete: () => this.delete(),
      group: () => this.group(), rename: () => this.rename(), ungroup: () => this.ungroup(),
      undo: () => this.travel('undo'), redo: () => this.travel('redo'),
      play: () => this.playback.running ? this.pause() : this.play(),
      fit: () => this.viewport.fit(),
      fullscreen: () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(),
      resetPose: () => this.resetFrame('pose'), resetTiming: () => this.resetFrame('timing'),
      resetAll: () => this.resetFrame('all'),
      connect: () => this.hardware(async () => {
        if (this.usb.connected) {
          this.livePoses = false;
          this.pause();
          await this.usb.disconnect();
          this.usbReady = false;
        } else await this.connectAtPlayhead();
      }),
      storage: () => this.hardware(async () => {
        this.livePoses = false;
        this.pause();
        await this.usb.storage();
        this.status('storageReady');
      })
    };
    for (const [id, action] of Object.entries(actions)) $(id).onclick = this.act(action);
    $('title').onchange = () => this.edit(project => { project.title = $('title').value; });
    $('language').onclick = () => {
      this.language = this.language === 'ru' ? 'en' : 'ru';
      this.status('');
      this.refresh();
    };
    $('units').onclick = () => {
      this.studioUnits = !this.studioUnits;
      $('units').setAttribute('aria-checked', this.studioUnits);
      this.renderInspector();
    };
    $('livePoses').onclick = () => {
      this.editedPose = null;
      this.livePoses = !this.livePoses;
      if (this.playback.running) this.pause();
      else this.renderButtons();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.playback.live) this.pause();
    });
    this.viewport.bind();
    new ResizeObserver(() => {
      this.renderTracks();
      this.draw();
    }).observe($('scroller'));
    $('openFile').onchange = this.act(event => this.readFile(event));
    const rail = $('rail');
    document.addEventListener('dragover', event => {
      if (event.dataTransfer.types.includes('Files')) event.preventDefault();
    });
    document.addEventListener('drop', event => {
      if (event.dataTransfer.types.includes('Files')) event.preventDefault();
    });
    rail.ondragover = event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      rail.classList.add('audio-drop');
    };
    rail.ondragleave = event => {
      if (!rail.contains(event.relatedTarget)) rail.classList.remove('audio-drop');
    };
    rail.ondrop = this.act(async event => {
      event.preventDefault();
      rail.classList.remove('audio-drop');
      const file = event.dataTransfer.files[0];
      if (!file) return;
      const index = Math.max(0, this.timeline.at(Math.max(0, this.viewport.pointerTime(event))).index);
      await this.setAudio(index, file);
    });
    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.altKey
        || event.target.closest('input, textarea, select, [contenteditable]')) return;
      const modifier = event.ctrlKey || event.metaKey;
      const id = shortcuts.find(([, code, , ctrl = false, shift = false]) =>
        code === event.code && ctrl === modifier && shift === event.shiftKey)?.[0];
      if (id && !$(id).disabled && !(event.code === 'Space' && event.target.matches('button, summary'))) {
        event.preventDefault();
        if (!event.repeat) $(id).click();
      } else if (!modifier && event.code === 'Escape' && this.viewport.gesture) {
        event.preventDefault();
        this.viewport.cancel();
      } else if (['ArrowLeft', 'ArrowRight'].includes(event.code)
        || (!modifier && ['Home', 'End'].includes(event.code))) {
        event.preventDefault();
        this.stepPlayhead(event.code, event.shiftKey, modifier);
      }
    });
  }

  refresh(preserveInspector = false) {
    document.documentElement.lang = this.language;
    $('language').setAttribute('aria-checked', this.language === 'en');
    $('units').setAttribute('aria-checked', this.studioUnits);
    document.querySelectorAll('[data-t]').forEach(node => { node.textContent = this.t(node.dataset.t); });
    document.querySelectorAll('[data-icon][data-tip]').forEach(button => {
      const hint = shortcuts.filter(([id]) => id === button.id).map(([, , label]) => label).join(' / ');
      const label = this.t(button.dataset.tip);
      setIcon(button, button.dataset.icon, hint ? label + ' (' + hint + ')' : label);
    });
    document.querySelectorAll('[data-label]').forEach(node => node.setAttribute('aria-label', this.t(node.dataset.label)));
    $('robotPreview').title = this.t($('robotPreview').dataset.hover);
    $('title').value = this.project.title;
    this.timeline = new Timeline(this.project);
    this.renderTracks();
    if (!preserveInspector) this.renderInspector();
    this.renderButtons();
    this.draw();
  }

  edit(operation, preserveInspector) {
    return this.applyEdit(() => this.frames.edit(operation), preserveInspector);
  }

  applyEdit(operation, preserveInspector = false) {
    this.pause();
    const result = operation();
    if (result === null) return result;
    this.status('');
    this.refresh(preserveInspector);
    return result;
  }

  replace(project) {
    if (this.history.past.length && !confirm(this.t('openReplace'))) return;
    this.pause();
    this.frames.replace(project);
    this.time = 0;
    this.status('');
    this.refresh();
    if (this.timeline.length * this.scale > $('scroller').clientWidth) this.viewport.fit();
  }

  travel(direction) {
    this.pause();
    this.frames.travel(direction);
    this.refresh();
  }

  select(index, extend = false, toggle = false) {
    this.pause();
    this.frames.select(index, extend, toggle);
    this.time = this.timeline.boundaries[index] ?? 0;
    this.markFrames();
    this.renderInspector();
    this.renderButtons();
    this.draw();
  }

  insert(fragment, index) {
    if (fragment?.frames.length) this.applyEdit(() => this.frames.insert(fragment, index));
  }

  delete() { this.applyEdit(() => this.frames.delete()); }
  group() { this.applyEdit(() => this.frames.group(this.t('defaultGroup'))); }

  rename(group = this.frames.selectedGroup) {
    if (!group) return;
    const clip = $('groups').querySelector('[data-start="' + group.start + '"]');
    if (!clip) return;
    const field = element('input', 'group-name');
    field.type = 'text';
    field.value = group.name;
    field.setAttribute('aria-label', this.t('groupName'));
    let finished = false;
    const finish = save => {
      if (finished) return;
      finished = true;
      const next = field.value.trim();
      if (save && next && next !== group.name && this.project.groups.includes(group)) {
        this.applyEdit(() => this.frames.rename(group.start, next));
      } else this.renderTracks();
    };
    field.onblur = () => finish(true);
    field.onkeydown = event => {
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        finish(event.key === 'Enter');
      }
    };
    clip.replaceChildren(field);
    field.focus();
    field.select();
  }

  ungroup() { this.applyEdit(() => this.frames.ungroup()); }

  move(range, boundary, group) {
    const target = this.applyEdit(() => this.frames.move(range, boundary, group));
    if (target === null) return;
    this.seek(this.timeline.boundaries[target]);
    this.viewport.revealPlayhead();
  }

  renderButtons() {
    $('relinkFolder').hidden = !window.showDirectoryPicker || !Object.values(this.project.assets).some(asset => !asset.bytes);
    $('livePoses').setAttribute('aria-pressed', Boolean(this.livePoses));
    $('connect').textContent = this.t(this.connecting ? 'connecting' : this.usb.connected ? 'disconnect' : 'connect');
    const { selection, selectedGroup, canGroup, clipboard } = this.frames;
    const enabled = {
      copy: selection, delete: selection, duplicate: selection, group: canGroup,
      rename: selectedGroup, ungroup: selectedGroup, paste: clipboard,
      undo: this.history.past.length, redo: this.history.future.length, export: this.project.frames.length,
      play: this.playback.running || (this.project.frames.length && !this.busy),
      resetPose: selection, resetTiming: selection, resetAll: selection,
      connect: !this.busy, storage: this.usbReady && !this.busy,
      livePoses: this.usbReady && !this.busy
    };
    for (const [id, value] of Object.entries(enabled)) $(id).disabled = !value;
    setIcon($('play'), this.playback.running ? 'pause' : 'play', this.t(this.playback.running ? 'pause' : 'play').replace(/^▶ /, '') + ' (Space)');
    $('usbState').textContent = this.t(this.connecting ? 'connecting' : this.usbReady ? 'connected'
      : this.usb.connected ? 'usbUnconfirmed' : 'offline');
  }

  property(container, text, field) {
    const label = element('label', 'property');
    label.append(element('span', '', text), field);
    container.append(label);
  }

  renderInspector() {
    const container = $('properties');
    container.replaceChildren();
    const indices = this.frames.indices;
    const index = indices[0];
    const frame = this.project.frames[index];
    const count = indices.length;
    $('frameInfo').textContent = count > 1 ? this.t('selectedFrames').replace('{count}', count)
      : frame ? this.t('frame') + ' ' + (index + 1) : this.t('noFrame');
    if (!frame) return;
    const native = !this.studioUnits;
    const number = (label, value, min, max, update, { hint, step = 1, defaultValue = value, read } = {}) => {
      const fields = element('div', 'parameter');
      const title = element('span', '', label);
      const slider = element('input');
      const field = element('input');
      const limits = { min, max, step };
      Object.assign(slider, { type: 'range', ...limits, value });
      Object.assign(field, { type: 'number', ...limits, value });
      for (const input of [slider, field]) input.setAttribute('aria-label', label);
      const tooltip = next => {
        if (!hint) return;
        const text = hint(next);
        for (const node of [title, slider, field]) node.title = text;
      };
      tooltip(value);
      let committed = value;
      let mixed = indices.some(i => read(this.project.frames[i]) !== read(frame));
      if (mixed) { field.value = ''; field.placeholder = '—'; }
      const normalize = input => input.value === '' || !Number.isFinite(input.valueAsNumber)
        ? committed : Math.max(min, Math.min(max, min + Math.round((input.valueAsNumber - min) / step) * step));
      const commit = next => {
        slider.value = field.value = next;
        tooltip(next);
        if (next !== committed || mixed) {
          this.editFrame(index, project => this.frames.changeFrames(project, indices, item => update(item, next)), true);
          mixed = false;
          committed = next;
          this.drawPose(this.project.frames[index].pose);
        }
      };
      slider.oninput = () => {
        if (this.playback.running) this.pause();
        field.value = slider.value;
        tooltip(slider.valueAsNumber);
        const draft = structuredClone(this.project.frames[index]);
        update(draft, slider.valueAsNumber);
        this.drawPose(draft.pose);
      };
      field.oninput = () => { slider.value = normalize(field); tooltip(normalize(field)); };
      slider.onchange = () => commit(normalize(slider));
      slider.ondblclick = () => commit(defaultValue);
      field.onchange = () => { if (field.value !== '' || !mixed) commit(normalize(field)); };
      field.onkeydown = event => { if (event.key === 'Enter') field.blur(); };
      fields.append(title, slider, field);
      container.append(fields);
    };
    for (const [axis, [key, min, max, neutral]] of Buzz.axes.entries()) {
      const value = frame.pose[axis];
      const arm = key === 'left' || key === 'right';
      const percent = degrees => arm ? (max - degrees) * 100 / (max - min)
        : degrees <= neutral ? (degrees - min) * 50 / (neutral - min)
          : 50 + (degrees - neutral) * 50 / (max - neutral);
      const degrees = percentage => arm ? max - (max - min) * percentage / 100
        : percentage <= 50 ? min + (neutral - min) * percentage / 50
          : neutral + (max - neutral) * (percentage - 50) / 50;
      number(this.t(key) + (native ? ' (%)' : ' (°)'), native ? Math.round(percent(value)) : value,
        native ? 0 : min, native ? 100 : max,
        (target, next) => { target.pose[axis] = native ? Math.round(degrees(next)) : next; },
        { defaultValue: native ? Math.round(percent(neutral)) : neutral, read: item => item.pose[axis] });
    }
    container.append(element('h3', 'inspector-divider', this.t('frameTiming')));
    for (const key of ['speed', 'delay']) {
      const step = Buzz.timing[key];
      const [min, max] = Buzz[key];
      if (native) {
        number(this.t(key === 'speed' ? 'moveMs' : 'delayMs'), Timeline.milliseconds(key, frame[key]),
          min * step, max * step, (target, next) => { target[key] = next / step; },
          { step, defaultValue: Buzz[key][2] * step, read: item => item[key] });
      } else {
        const seconds = milliseconds => (milliseconds / 1000).toLocaleString(this.language, { maximumFractionDigits: 3 });
        const hint = value => this.t('pointsHint').replace('{unit}', seconds(step))
          .replace('{total}', seconds(Timeline.milliseconds(key, value)));
        number(this.t(key), frame[key], min, max, (target, next) => { target[key] = next; },
          { hint, defaultValue: Buzz[key][2], read: item => item[key] });
      }
    }
    if (count > 1) return;
    container.append(element('h3', 'inspector-divider', this.t('audio')));
    if (frame.loop) this.property(container, this.t('loop'), element('span', '', String(frame.loop & 127)));
    const field = element('select');
    const options = { keep: 'keep', stop: 'stopAudio', resume: 'resumeAudio', play: 'playAudio' };
    for (const [value, label] of Object.entries(options)) {
      const option = element('option', '', this.t(label));
      option.value = value;
      field.append(option);
    }
    field.value = frame.audio.mode;
    field.onchange = this.act(async () => {
      if (field.value === 'play') {
        field.value = frame.audio.mode;
        await this.attachAudio(index);
      } else this.editFrame(index, project => { project.frames[index].audio = { mode: field.value }; });
    });
    this.property(container, this.t('audio'), field);
    if (frame.audio.mode === 'play') {
      const asset = this.project.assets[frame.audio.id];
      const relink = element('button', '', this.t(asset?.bytes ? 'chooseAudio' : 'relink'));
      relink.onclick = this.act(() => this.attachAudio(index, asset?.bytes ? null : frame.audio.id));
      this.property(container, asset?.path ?? '', relink);
    }
  }

  async attachAudio(index, existing = null) {
    const original = this.project;
    const input = $('mp3File');
    input.value = '';
    const file = await new Promise(resolve => {
      input.onchange = () => resolve(input.files[0]);
      input.oncancel = () => resolve(null);
      input.click();
    });
    if (file && original === this.project) await this.setAudio(index, file, existing);
  }

  async setAudio(index, file, existing = null) {
    const original = this.project;
    if (!/\.mp3$/i.test(file.name) && file.type !== 'audio/mpeg') throw new EditorError('badAudio', file.name);
    if (file.size > Buzz.audioLimit) throw new EditorError('oversizeAudio', file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length) throw new EditorError('badAudio', file.name);
    const id = existing ?? uid();
    if (original !== this.project) return;
    if (!existing && !await this.confirmAudio(index, file.name)) return;
    if (original !== this.project) return;
    this.editFrame(index, project => {
      if (!project.frames.length) project.frames.push(defaultFrame());
      project.assets[id] = { path: id + '.mp3', bytes, label: file.name };
      project.frames[index].audio = { mode: 'play', id };
    });
  }

  confirmAudio(index, filename) {
    const dialog = $('audioDialog');
    if (dialog.open) return Promise.resolve(false);
    $('audioDialogFile').textContent = filename + ' · ' + this.t('frame') + ' ' + (index + 1);
    dialog.returnValue = '';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'add'), { once: true });
      dialog.showModal();
    });
  }

  renderTracks() {
    for (const id of ['ruler', 'groups', 'frames', 'audioTrack']) $(id).replaceChildren();
    const zoom = Number($('zoom').value);
    this.scale = Math.min(timelineInteraction.pixelsPerMs * 2 ** (zoom / 3), 1000000 / Math.max(1, this.timeline.length));
    const viewport = $('scroller').clientWidth;
    const width = Math.max(viewport, Math.max(this.timeline.length, this.time) * this.scale + Math.max(72, viewport * .18));
    $('rail').style.width = width + 'px';
    this.visibleDuration = width / this.scale;
    const tickMs = rulerSpacing(this.scale);
    for (let time = 0; time <= this.visibleDuration; time += tickMs) {
      const tick = element('span', 'tick', rulerLabel(time, tickMs, this.language));
      tick.style.left = time * this.scale + 'px';
      $('ruler').append(tick);
    }
    const makeClip = (label, start, end, row, type) => {
      const button = element('button', 'clip ' + type, label);
      button.title = label;
      button.style.left = start * this.scale + 'px';
      button.style.width = Math.max(3, (end - start) * this.scale - 1) + 'px';
      $(row).append(button);
      return button;
    };
    for (const group of this.project.groups) {
      const clip = element('div', 'clip group');
      const start = this.timeline.boundaries[group.start];
      const end = this.timeline.boundaries[group.end];
      clip.style.left = start * this.scale + 'px';
      clip.style.width = Math.max(3, (end - start) * this.scale - 1) + 'px';
      const label = element('button', 'group-label', group.name);
      label.title = group.name;
      label.onclick = event => {
        if (event.detail && this.viewport.ignoreClick) return;
        this.pause();
        const range = { start: group.start, end: group.end };
        if (event.shiftKey && (event.ctrlKey || event.metaKey)) {
          this.frames.addRange(range);
          this.frames.anchor = this.frames.insertion = range.start;
        } else {
          this.frames.selectRange(range);
        }
        this.markFrames();
        this.renderInspector();
        this.renderButtons();
      };
      const pencil = element('button', 'icon group-edit');
      setIcon(pencil, 'rename', this.t('rename'));
      pencil.onclick = event => { event.stopPropagation(); this.rename(group); };
      clip.append(label, pencil);
      $('groups').append(clip);
      this.tagClip(clip, group);
    }
    let audioBlock = null;
    for (const segment of this.timeline.segments) {
      const { start, end, index, audio, audioOffset, motion } = segment;
      const button = makeClip(String(index + 1), start, end, 'frames', '');
      button.style.setProperty('--motion', (motion / (end - start) * 100) + '%');
      button.title = this.t('frame') + ' ' + (index + 1) + ' · ' + motion + ' + ' + (end - start - motion) + ' ms';
      button.onclick = event => {
        if (!event.detail || !this.viewport.ignoreClick) this.select(index, event.shiftKey, event.ctrlKey || event.metaKey);
      };
      this.tagClip(button, { start: index, end: index + 1 });
      if (audioBlock && (!audio || audio !== audioBlock.id || audioOffset === 0)) {
        this.soundClip(audioBlock, start, makeClip);
        audioBlock = null;
      }
      if (audio && !audioBlock) audioBlock = { id: audio, start, index };
    }
    if (audioBlock) this.soundClip(audioBlock, this.timeline.length, makeClip);
    this.markFrames();
  }

  soundClip(block, end, makeClip) {
    const asset = this.project.assets[block.id];
    const name = asset?.label ?? asset?.path ?? 'MP3';
    const button = makeClip((asset?.bytes ? '♪ ' : '! ') + name, block.start, end, 'audioTrack', 'sound');
    button.onclick = () => this.select(block.index);
  }

  tagClip(button, range) {
    button.dataset.start = range.start;
    button.dataset.end = range.end;
  }

  stepPlayhead(code, extend, byGroup = false) {
    const current = this.time;
    const { segments, length } = this.timeline;
    const stops = byGroup ? this.project.groups.map(group => this.timeline.boundaries[group.start]).sort((a, b) => a - b)
      : segments.map(segment => segment.start);
    const next = code === 'Home' ? 0 : code === 'End' ? length
      : code === 'ArrowLeft' ? stops.findLast(start => start < current - .001) ?? 0
        : stops.find(start => start > current + .001) ?? length;
    if (extend && segments.length) {
      if (!this.frames.selection) this.select(this.timeline.at(current).index);
      this.select(this.timeline.at(next).index, true, byGroup);
    } else if (segments.length) {
      this.frames.anchor = this.timeline.at(next).index;
    }
    this.seek(next);
    this.viewport.revealPlayhead();
  }

  markFrames() {
    $('rail').querySelectorAll('[data-start]').forEach(node => {
      const start = Number(node.dataset.start);
      const end = Number(node.dataset.end);
      node.classList.toggle('selected', this.frames.overlaps(start, end));
    });
    $('head').title = this.t('insertion') + ' ' + (this.frames.insertion + 1);
  }

  seek(time) {
    this.pause();
    this.setPlayhead(time);
  }

  setPlayhead(time) {
    this.time = Math.max(0, time);
    this.syncInsertion();
    $('head').title = this.t('insertion') + ' ' + (this.frames.insertion + 1);
    this.draw();
  }

  syncInsertion() {
    const index = this.timeline.at(this.time).index;
    this.frames.insertion = this.time >= this.timeline.length ? this.project.frames.length : Math.max(0, index);
  }

  drawPose(pose) { this.preview.draw(pose); }

  draw() {
    this.drawPose(this.timeline.at(this.time).pose);
    $('head').style.left = this.time * this.scale + 'px';
    $('clock').textContent = (this.time / 1000).toFixed(2) + ' / ' + (this.timeline.length / 1000).toFixed(2) + ' s';
  }

  pause() { this.playback.pause(); }

  play() {
    if (this.playback.running || this.time > this.timeline.length || !this.timeline.segments.length) return;
    this.editedPose = null;
    if (this.time === this.timeline.length) this.time = 0;
    return this.playback.play(this.project, this.timeline, this.time, this.livePoses && this.usb.connected);
  }

  editFrame(index, operation, preserveInspector) {
    this.edit(operation, preserveInspector);
    void this.previewEditedFrame(index);
  }

  async previewEditedFrame(index) {
    const project = this.project;
    const request = {};
    this.editedPose = request;
    const active = () => this.editedPose === request && this.project === project && !this.playback.running
      && this.livePoses && this.usb.connected && !this.busy && !document.hidden;
    if (!active()) return;
    try {
      project.validateFrameMotion(index);
      await this.usb.enterProgramming();
      if (active()) await this.usb.pose(project.frames[index].pose.slice(0, Buzz.axes.length), active);
    } catch (error) {
      if (active()) this.status(error.message, error.detail, true);
    }
  }

  resetFrame(mode) {
    const indices = this.frames.indices;
    const start = indices[0];
    this.editFrame(start, project => this.frames.resetFrames(project, indices, mode));
    this.seek(this.timeline.boundaries[start]);
    this.drawPose(this.project.frames[start].pose);
  }

  async hardware(action) {
    if (this.busy) return;
    this.editedPose = null;
    this.busy = true;
    this.renderButtons();
    try { await action(); }
    finally { this.busy = false; this.renderButtons(); }
  }

  async connectAtPlayhead() {
    this.pause();
    const project = this.project;
    const { index } = this.timeline.at(this.time);
    if (index >= 0) project.validateFrameMotion(index);
    const pose = index >= 0 ? project.frames[index].pose.slice(0, Buzz.axes.length) : initialPose();
    this.connecting = true;
    this.renderButtons();
    try {
      await this.usb.connect();
      await this.usb.enterProgramming();
      await this.usb.pose(pose);
      if (!this.usb.connected) throw new EditorError('noDevice');
      this.usbReady = true;
      this.status('');
    } catch (error) {
      if (this.usb.connected) {
        try { await this.usb.disconnect(); }
        catch (cleanupError) { throw new EditorError(error.message, this.t(cleanupError.message)); }
      }
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  async readFile(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const before = this.project;
    let project;
    if (/\.mfp$/i.test(file.name)) {
      project = await MfpCodec.read(new Uint8Array(await file.arrayBuffer()));
    } else if (/\.zip$/i.test(file.name)) {
      project = ProjectZip.read(new Uint8Array(await file.arrayBuffer()));
    } else {
      try { project = Project.fromJson(JSON.parse(await file.text())); }
      catch { throw new EditorError('invalidProject'); }
      project.loops();
    }
    if (before !== this.project) return;
    this.replace(project);
  }

  async resolveAudio() {
    const project = this.project;
    try {
      const directory = await showDirectoryPicker();
      const found = {};
      for (const [id, asset] of Object.entries(project.assets)) {
        if (asset.bytes) continue;
        try {
          const handle = await directory.getFileHandle(asset.path);
          const file = await handle.getFile();
          if (file.size > Buzz.audioLimit) throw new EditorError('oversizeAudio', asset.path);
          if (!file.size) throw new EditorError('badAudio', asset.path);
          found[id] = { ...asset, bytes: new Uint8Array(await file.arrayBuffer()) };
        } catch (error) {
          if (error.name !== 'NotFoundError') throw error;
        }
      }
      if (project !== this.project) return;
      if (!Object.keys(found).length) throw new EditorError('missingAudio');
      this.edit(next => Object.assign(next.assets, found));
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  }

}

new Editor();
