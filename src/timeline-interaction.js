'use strict';

const timelineInteraction = {
  pixelsPerMs: .48,
  playheadHitRadius: 8,
  dragThreshold: 5,
  dropEdgeInset: 18,
  groupDropWidth: 96,
  scrollAcceleration: 9,
  maximumScrollSpeed: 1800
};

function rulerSpacing(scale) {
  const target = 84 / scale;
  const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000,
    60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000];
  return steps.find(step => step >= target) ?? Math.ceil(target / 3600000) * 3600000;
}

function rulerLabel(time, step, language) {
  if (step < 60000) return (time / 1000).toLocaleString(language, { maximumFractionDigits: 1, useGrouping: false })
    + (language === 'ru' ? ' с' : ' s');
  const minutes = Math.round(time / 60000);
  if (step < 3600000 && minutes < 60) return minutes + (language === 'ru' ? ' мин' : ' min');
  return Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0');
}

class TimelineInteraction {
  constructor(editor) {
    this.editor = editor;
    this.rail = document.getElementById('rail');
    this.scroller = document.getElementById('scroller');
    this.zoom = document.getElementById('zoom');
    this.marqueeOverlay = document.getElementById('marquee');
    this.dropMarker = document.getElementById('dropMarker');
  }

  bind() {
    this.zoom.oninput = () => this.zoomAt();
    this.scroller.addEventListener('wheel', event => {
      if (!event.ctrlKey || !event.deltaY) return;
      event.preventDefault();
      this.zoom.value = Number(this.zoom.value) - Math.sign(event.deltaY);
      this.zoomAt(event.clientX - this.scroller.getBoundingClientRect().left);
    }, { passive: false });
    document.querySelector('main').addEventListener('wheel', event => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
        || event.target.closest('.inspector, input, select, textarea, [contenteditable]')) return;
      const scroller = this.scroller;
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      const delta = event.deltaX || event.deltaY;
      if (!delta) return;
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientWidth : 1;
      event.preventDefault();
      scroller.scrollLeft += delta * units;
    }, { passive: false });
    this.rail.onclick = event => {
      if (event.target.closest('.group-edit, .group-name')) return;
      if (event.detail && this.ignoreClick) { this.ignoreClick = false; return; }
      if (event.detail || !event.target.closest('.clip')) this.editor.seek(this.pointerTime(event));
    };
    this.rail.onpointerdown = event => this.begin(event);
    document.addEventListener('pointermove', event => this.update(event));
    document.addEventListener('pointerup', event => this.end(event));
    document.addEventListener('pointercancel', event => this.end(event, true));
    this.rail.onlostpointercapture = event => this.end(event, true);
  }

  cancel() {
    this.end({ pointerId: this.gesture.id }, true);
    this.ignoreClick = true;
  }

  revealPlayhead() {
    const scroller = this.scroller;
    const pixel = this.editor.time * this.editor.scale;
    if (pixel < scroller.scrollLeft || pixel > scroller.scrollLeft + scroller.clientWidth - 20) {
      scroller.scrollLeft = pixel - scroller.clientWidth / 2;
    }
  }

  fit() {
    const scroller = this.scroller;
    this.zoom.value = 3 * Math.log2((scroller.clientWidth * .82) / (Math.max(1, this.editor.timeline.length) * timelineInteraction.pixelsPerMs));
    this.editor.renderTracks();
    scroller.scrollLeft = 0;
    this.editor.draw();
  }

  zoomAt(x = this.scroller.clientWidth / 2) {
    const scroller = this.scroller;
    const time = (scroller.scrollLeft + x) / this.editor.scale;
    this.editor.renderTracks();
    scroller.scrollLeft = time * this.editor.scale - x;
    this.editor.draw();
  }

  pointerTime(event) {
    return (event.clientX - this.rail.getBoundingClientRect().left) / this.editor.scale;
  }

  begin(event) {
    this.ignoreClick = false;
    if (event.button !== 0 || event.target.closest('.group-edit, .group-name')) return;
    const rail = this.rail;
    const bounds = rail.getBoundingClientRect();
    const scrub = Boolean(event.target.closest('.ruler')) || (!event.ctrlKey && !event.metaKey
      && Math.abs(event.clientX - bounds.left - this.editor.time * this.editor.scale) <= timelineInteraction.playheadHitRadius);
    const clip = scrub ? null : event.target.closest('.clip');
    if (clip && !clip.hasAttribute('data-start')) return;
    const range = clip ? { start: Number(clip.dataset.start), end: Number(clip.dataset.end) } : null;
    const source = range && this.editor.frames.dragSource(range, clip.classList.contains('group'));
    this.gesture = { id: event.pointerId, x: event.clientX - bounds.left, y: event.clientY - bounds.top,
      dragging: false, scrub, source, clip };
    if (scrub) {
      rail.setPointerCapture(event.pointerId);
      this.editor.pause();
      this.scrubPlayhead(this.gesture, event.clientX);
    }
  }

  update(event) {
    const box = this.gesture;
    if (box?.id !== event.pointerId) return;
    if (box.scrub) {
      this.scrubPlayhead(box, event.clientX);
      return;
    }
    const rail = this.rail;
    const bounds = rail.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    if (!box.dragging && Math.hypot(x - box.x, y - box.y) < timelineInteraction.dragThreshold) return;
    if (!box.dragging) {
      box.dragging = true;
      rail.setPointerCapture(event.pointerId);
      this.editor.pause();
      if (box.source) {
        rail.classList.add('reordering');
        box.clip.classList.add('moving');
        this.showGroupDropZones(box);
      }
    }
    if (box.source) {
      this.scrollAtEdge(box, event.clientX, clientX => {
        this.updateDrop(box, { clientX, clientY: event.clientY });
      }, timelineInteraction.dropEdgeInset);
      return;
    }
    const left = Math.min(x, box.x);
    const right = Math.max(x, box.x);
    const top = Math.min(y, box.y);
    const bottom = Math.max(y, box.y);
    const overlay = this.marqueeOverlay;
    Object.assign(overlay.style, { left: left + 'px', top: top + 'px', width: right - left + 'px', height: bottom - top + 'px' });
    overlay.hidden = false;
    const indices = [];
    for (const clip of rail.querySelectorAll('#frames .clip, #groups .clip')) {
      const rect = clip.getBoundingClientRect();
      if (rect.right - bounds.left <= left || rect.left - bounds.left >= right
        || rect.bottom - bounds.top < top || rect.top - bounds.top > bottom) continue;
      indices.push(Number(clip.dataset.start), Number(clip.dataset.end) - 1);
    }
    this.editor.frames.selectRange(indices.length ? {
      start: indices.reduce((a, b) => Math.min(a, b)), end: indices.reduce((a, b) => Math.max(a, b)) + 1
    } : null);
    this.editor.markFrames();
    this.editor.renderInspector();
    this.editor.renderButtons();
  }

  scrubPlayhead(box, clientX) {
    this.scrollAtEdge(box, clientX, x => this.editor.setPlayhead(this.pointerTime({ clientX: x })));
  }

  scrollAtEdge(box, clientX, update, inset = 0) {
    const scroller = this.scroller;
    const edge = (x, { left, right }) =>
      x < left + inset ? x - left - inset : Math.max(0, x - right + inset);
    const visibleX = (x, { left, right }) => Math.max(left, Math.min(right - 1, x));
    const bounds = scroller.getBoundingClientRect();
    box.edgeScroll = { clientX, update };
    update(visibleX(clientX, bounds));
    if (!edge(clientX, bounds) || scroller.scrollWidth <= scroller.clientWidth) {
      cancelAnimationFrame(box.scrollFrame);
      box.scrollFrame = null;
      return;
    }
    if (box.scrollFrame != null) return;
    let last = performance.now();
    let position = scroller.scrollLeft;
    const tick = now => {
      if (this.gesture !== box) return;
      const bounds = scroller.getBoundingClientRect();
      const { clientX, update } = box.edgeScroll;
      const offset = edge(clientX, bounds);
      const maximum = scroller.scrollWidth - scroller.clientWidth;
      const { maximumScrollSpeed, scrollAcceleration } = timelineInteraction;
      const speed = Math.max(-maximumScrollSpeed, Math.min(maximumScrollSpeed, offset * scrollAcceleration));
      const elapsed = Math.max(0, Math.min(40, now - last));
      position = Math.max(0, Math.min(maximum, position + speed * elapsed / 1000));
      last = now;
      scroller.scrollLeft = position;
      update(visibleX(clientX, bounds));
      if ((speed > 0 && position < maximum) || (speed < 0 && position > 0)) box.scrollFrame = requestAnimationFrame(tick);
      else box.scrollFrame = null;
    };
    box.scrollFrame = requestAnimationFrame(tick);
  }

  showGroupDropZones(box) {
    const { project, timeline, scale } = this.editor;
    box.groupZones = [];
    for (const group of project.groups) {
      if (selectionRanges(box.source).some(range => range.start <= group.start && range.end >= group.end)) continue;
      const end = timeline.boundaries[group.end];
      const width = Math.min(timelineInteraction.groupDropWidth, (end - timeline.boundaries[group.end - 1]) * scale);
      for (const lane of ['groups', 'frames']) {
        const node = document.createElement('span');
        node.className = 'group-drop-zone';
        node.style.left = end * scale - width + 'px';
        node.style.width = width + 'px';
        document.getElementById(lane).append(node);
        box.groupZones.push({ node, group });
      }
    }
  }

  updateDrop(box, event) {
    const time = this.pointerTime(event);
    const rail = this.rail.getBoundingClientRect();
    const view = this.scroller.getBoundingClientRect();
    const marker = this.dropMarker;
    box.destination = null;
    box.destinationGroup = null;
    box.highlightedZone?.classList.remove('active');
    box.highlightedZone = null;
    marker.hidden = true;
    if (event.clientY < rail.top || event.clientY > Math.min(rail.bottom, view.bottom)
      || event.clientX < view.left || event.clientX > view.right) return;
    for (const { node, group } of box.groupZones ?? []) {
      const rect = node.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX >= rect.right
        || event.clientY < rect.top || event.clientY >= rect.bottom) continue;
      box.destination = group.end;
      box.destinationGroup = group;
      node.classList.add('active');
      box.highlightedZone = node;
      break;
    }
    const clip = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-start]');
    let target = clip ? { start: Number(clip.dataset.start), end: Number(clip.dataset.end) } : null;
    if (!target && time >= 0 && time < this.editor.timeline.length) {
      const index = this.editor.timeline.at(time).index;
      target = { start: index, end: index + 1 };
    }
    const afterGroup = target && this.editor.project.groups.some(group => group.end === target.start)
      && (time - this.editor.timeline.boundaries[target.start]) * this.editor.scale < timelineInteraction.dropEdgeInset;
    const destination = box.destination ?? (target ? (afterGroup || target.start < box.source.start ? target.start : target.end)
      : time < 0 ? 0 : this.editor.project.frames.length);
    if (!box.destinationGroup && FrameEditing.containsBoundary(box.source, destination)) return;
    box.destination = destination;
    marker.style.left = this.editor.timeline.boundaries[destination] * this.editor.scale + 'px';
    marker.hidden = false;
  }

  end(event, cancelled = false) {
    const box = this.gesture;
    if (box?.id !== event.pointerId) return;
    cancelAnimationFrame(box.scrollFrame);
    if (box.source && box.dragging && !cancelled) this.updateDrop(box, event);
    this.gesture = null;
    this.marqueeOverlay.hidden = true;
    this.dropMarker.hidden = true;
    this.rail.classList.remove('reordering');
    box.clip?.classList.remove('moving');
    for (const { node } of box.groupZones ?? []) node.remove();
    this.ignoreClick = (box.dragging || box.scrub) && !cancelled;
    if (!cancelled && box.destination != null) {
      try { this.editor.move(box.source, box.destination, box.destinationGroup); }
      catch (error) { this.editor.status(error.message, error.detail, true); }
    }
  }

}
