// a2ui-state.js — window.RelayA2uiState: the data model and event log behind one
// a2ui block. Pure data, no DOM, so it is testable on its own. a2ui.js draws it.
(() => {
  'use strict';

  const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
  const MAX_EVENTS = 50;

  // '/a/b' -> ['a','b'], '' or '/' -> [], null when a segment could reach the prototype chain.
  function segments(pointer) {
    if (typeof pointer !== 'string' || (pointer && pointer[0] !== '/')) return null;
    const parts = pointer.split('/').slice(1).filter((s) => s !== '');
    return parts.some((s) => UNSAFE.has(s)) ? null : parts;
  }

  const isContainer = (v) => v !== null && typeof v === 'object';

  function get(data, pointer) {
    const parts = segments(pointer);
    if (!parts) return undefined;
    let cur = data;
    for (const key of parts) {
      if (!isContainer(cur) || !Object.hasOwn(cur, key)) return undefined;
      cur = cur[key];
    }
    return cur;
  }

  // Writes value at pointer, creating plain objects on the way. Returns false for an unsafe path.
  function set(data, pointer, value) {
    const parts = segments(pointer);
    if (!parts || !parts.length) return false;
    let cur = data;
    for (const key of parts.slice(0, -1)) {
      if (!isContainer(cur[key]) || !Object.hasOwn(cur, key)) cur[key] = {};
      cur = cur[key];
    }
    cur[parts[parts.length - 1]] = value;
    return true;
  }

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const isBinding = (v) => isContainer(v) && !Array.isArray(v) && typeof v['@path'] === 'string';

  // A prop that is a literal or a {"@path": "/x"} binding, read against the current data.
  function resolve(data, value) {
    return isBinding(value) ? get(data, value['@path']) : value;
  }

  /**
   * The state of one block. `restored` is the {data, events} the board saved
   * before (a page reload); `onChange(snapshot)` runs after the user changes an
   * input or fires an event, never for the first render.
   */
  function createStore(initialData, restored, onChange) {
    const data = clone(restored && restored.data && typeof restored.data === 'object' ? restored.data : initialData) || {};
    const events = restored && Array.isArray(restored.events) ? restored.events.slice(-MAX_EVENTS) : [];
    const listeners = [];
    const snapshot = () => ({ type: 'a2ui', data: clone(data), events: clone(events) });
    const touch = () => {
      listeners.forEach((fn) => fn());
      if (onChange) onChange(snapshot());
    };
    return {
      data,
      get: (pointer) => get(data, pointer),
      resolve: (value) => resolve(data, value),
      subscribe: (fn) => listeners.push(fn),
      set(pointer, value) {
        if (set(data, pointer, value)) touch();
      },
      // An Event(name, {context}) action: context bindings are read now, so the agent sees the values at click time.
      fire(name, context) {
        const resolved = {};
        for (const [key, value] of Object.entries(context || {})) {
          if (!UNSAFE.has(key)) resolved[key] = clone(resolve(data, value));
        }
        events.push({ name, context: resolved, at: new Date().toISOString() });
        if (events.length > MAX_EVENTS) events.shift();
        touch();
      },
      eventCount: () => events.length,
      snapshot,
    };
  }

  const api = { get, set, clone, resolve, isBinding, createStore };
  (typeof window !== 'undefined' ? window : globalThis).RelayA2uiState = api;
})();
