'use strict';

const selectionRanges = selection => selection?.ranges ?? (selection ? [selection] : []);

class FrameEditing {
  constructor(history) {
    this.history = history;
    this.selection = null;
    this.anchor = 0;
    this.insertion = 0;
    this.clipboard = null;
  }

  get project() { return this.history.current; }
  get ranges() { return selectionRanges(this.selection); }
  get indices() {
    return this.ranges.flatMap(({ start, end }) => Array.from({ length: end - start }, (_, offset) => start + offset));
  }

  get selectedGroup() {
    if (this.selection?.ranges) return null;
    return this.project.groups.find(group => this.overlaps(group.start, group.end));
  }

  get canGroup() {
    const selection = this.selection;
    return Boolean(selection && !selection.ranges && selection.end - selection.start > 1 && !this.selectedGroup);
  }

  overlaps(start, end) {
    return this.ranges.some(range => start < range.end && end > range.start);
  }

  dragSource(range, group) {
    return !group && this.ranges.some(item => range.start >= item.start && range.end <= item.end) ? this.selection : range;
  }

  select(index, extend, toggle) {
    if (!extend || !this.selection) this.anchor = index;
    const range = { start: Math.min(index, this.anchor), end: Math.max(index, this.anchor) + 1 };
    if (extend && toggle) {
      this.addRange(range);
    } else if (toggle) {
      const indices = new Set(this.indices);
      if (indices.has(index)) indices.delete(index);
      else indices.add(index);
      this.setRanges([...indices].map(item => ({ start: item, end: item + 1 })));
    } else {
      this.selection = range;
    }
    this.insertion = index;
  }

  setRanges(ranges) {
    const merged = [];
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
      const last = merged.at(-1);
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    this.selection = merged.length > 1 ? { start: merged[0].start, end: merged.at(-1).end, ranges: merged }
      : merged[0] ?? null;
  }

  addRange(range) {
    this.setRanges([...this.ranges, range]);
  }

  selectRange(range) {
    this.selection = range;
    if (range) this.anchor = this.insertion = range.start;
  }

  replace(project) {
    this.history.reset(project);
    this.selection = null;
    this.insertion = 0;
  }

  travel(direction) {
    this.history[direction]();
    this.selection = null;
    this.insertion = Math.min(this.insertion, this.project.frames.length);
  }

  edit(operation) {
    this.history.edit(project => {
      operation(project);
      project.loops();
    });
  }

  fragment(selection = this.selection) {
    const fragment = new Project(this.project.title, []);
    for (const { start, end } of selectionRanges(selection)) {
      fragment.splice(fragment.frames.length, fragment.frames.length, this.project.slice(start, end));
    }
    fragment.loops();
    return fragment;
  }

  copy() { this.clipboard = this.fragment(); }

  insert(fragment, index = this.insertion) {
    if (!fragment?.frames.length) return;
    this.edit(project => project.splice(index, index, fragment));
    this.selectInserted(index, fragment.frames.length);
  }

  selectInserted(start, count) {
    this.anchor = start;
    this.insertion = start + count;
    this.selection = { start, end: this.insertion };
  }

  delete() {
    const { start } = this.selection;
    const ranges = this.ranges;
    this.edit(project => {
      for (const range of ranges.toReversed()) project.splice(range.start, range.end);
    });
    this.selection = null;
    this.insertion = start;
  }

  group(prefix) {
    if (!this.canGroup) throw new EditorError('groupOverlap');
    const numbers = new Set(this.project.groups.map(group => /^(?:Группа|Group) (\d+)$/.exec(group.name)?.[1]));
    let number = 1;
    while (numbers.has(String(number))) number++;
    this.edit(project => project.groups.push({ ...this.selection, name: prefix + ' ' + number }));
  }

  rename(start, name) {
    this.edit(project => { project.groups.find(item => item.start === start).name = name; });
  }

  ungroup() {
    const { start } = this.selectedGroup;
    this.edit(project => { project.groups = project.groups.filter(group => group.start !== start); });
  }

  static containsBoundary(selection, boundary) {
    return selectionRanges(selection).some(({ start, end }) => boundary >= start && boundary <= end);
  }

  move(selection, boundary, group = null) {
    const ranges = selectionRanges(selection);
    if (!group && FrameEditing.containsBoundary(selection, boundary)) return null;
    const removedBefore = boundary => ranges.reduce((count, { start, end }) =>
      count + Math.max(0, Math.min(end, boundary) - start), 0);
    const target = boundary - removedBefore(boundary);
    const groupStart = group && group.start - removedBefore(group.start);
    if (group && target <= groupStart) return null;
    const fragment = this.fragment(selection);
    if (group) fragment.groups = [];
    this.edit(project => {
      for (const range of ranges.toReversed()) project.splice(range.start, range.end);
      project.splice(target, target, fragment);
      if (group) {
        project.groups = project.groups.filter(item => item.end <= groupStart || item.start >= target);
        project.groups.push({ ...group, start: groupStart, end: target + fragment.frames.length });
      }
    });
    this.selectInserted(target, fragment.frames.length);
    return target;
  }

  changeFrames(project, indices, update) {
    for (const index of indices) update(project.frames[index]);
  }

  resetFrames(project, indices, mode) {
    this.changeFrames(project, indices, frame => {
      const defaults = defaultFrame();
      if (mode !== 'timing') frame.pose = defaults.pose;
      if (mode !== 'pose') Object.assign(frame, { speed: defaults.speed, delay: defaults.delay });
      if (mode === 'all' && indices.length === 1) frame.audio = defaults.audio;
    });
  }
}

Object.assign(globalThis, { FrameEditing });
