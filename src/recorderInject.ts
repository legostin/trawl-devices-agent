/**
 * Browser-side recorder. Injected via addInitScript, so it runs before page
 * scripts on every navigation. It reports candidate targets; the Node side
 * decides which one survives (see recorder.ts).
 */
export const RECORDER_SOURCE = String.raw`
(() => {
  if (window.__trawlRecorderInstalled) return;
  window.__trawlRecorderInstalled = true;

  const MARK = 'data-trawl-rec-el';
  const state = { paused: false, mode: 'record', pendingFill: null };

  const inOverlay = (el) => !!(el && el.closest && el.closest('[data-trawl-overlay]'));

  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const implicitRole = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.getAttribute('role')) return el.getAttribute('role');
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      return 'textbox';
    }
    return null;
  };

  // Playwright collapses whitespace when it computes an accessible name; a raw
  // textContent (icons, newlines, double spaces) would never match it.
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const accessibleName = (el) => {
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    if (el.labels && el.labels[0]) return norm(el.labels[0].textContent);
    const text = norm(el.textContent);
    if (text && text.length <= 60) return text;
    return norm(el.getAttribute('value'));
  };

  const labelText = (el) => (el.labels && el.labels[0] ? norm(el.labels[0].textContent) : '');

  // Text carrying digits is almost always data — an order number, a price, a
  // date, a count. Matching on it records today's data as tomorrow's selector.
  const looksDynamic = (s) => /\d/.test(s);

  /** Ordered candidate targets, best first. */
  const candidates = (el) => {
    const out = [];
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-qa');
    if (testId) out.push({ testId: testId });

    const role = implicitRole(el);
    const name = accessibleName(el);
    const label = labelText(el);
    const placeholder = el.getAttribute('placeholder');
    const own = norm(el.textContent);

    // Stable wording first.
    if (role && name && !looksDynamic(name)) out.push({ role: role, name: name });
    if (label && !looksDynamic(label)) out.push({ label: label });
    if (placeholder && !looksDynamic(placeholder)) out.push({ placeholder: placeholder });
    if (own && own.length <= 40 && !looksDynamic(own)) out.push({ text: own });

    // Then structure: the Node side pins this to the element that was clicked,
    // so "the third row" survives the numbers inside it changing.
    if (role) out.push({ role: role });

    // Only then the wording that looks like data. It is marked so the Node side
    // can use it as a last resort without ever saving it as a fallback.
    if (role && name && looksDynamic(name)) out.push({ role: role, name: name, __dyn: true });
    if (label && looksDynamic(label)) out.push({ label: label, __dyn: true });
    if (placeholder && looksDynamic(placeholder)) out.push({ placeholder: placeholder, __dyn: true });
    if (own && own.length <= 40 && looksDynamic(own)) out.push({ text: own, __dyn: true });

    out.push({ css: cssPath(el) });
    return out;
  };

  const emit = (action, el, args) => {
    if (state.paused) return;
    el.setAttribute(MARK, '1');
    return window.__trawlRec({ action: action, candidates: candidates(el), args: args || [] })
      .catch(() => {})
      .then(() => el.removeAttribute(MARK));
  };

  const flushFill = () => {
    const pending = state.pendingFill;
    if (!pending) return;
    state.pendingFill = null;
    emit('fill', pending.el, [pending.value]);
  };

  document.addEventListener('click', (e) => {
    const el = e.target;
    if (!el || inOverlay(el)) return;
    flushFill();
    if (state.mode === 'assert') {
      state.mode = 'record';
      const text = (el.textContent || '').trim();
      emit(text ? 'expectText' : 'expectVisible', el, text ? [text] : []);
      return;
    }
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const type = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      emit(el.checked ? 'check' : 'uncheck', el, []);
      return;
    }
    emit('click', el, []);
  }, true);

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el || inOverlay(el)) return;
    if (el.tagName === 'SELECT') { emit('select', el, [el.value]); return; }
    if (state.pendingFill && state.pendingFill.el !== el) flushFill();
    state.pendingFill = { el: el, value: el.value };
  }, true);

  document.addEventListener('change', (e) => {
    if (state.pendingFill && state.pendingFill.el === e.target) flushFill();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (inOverlay(e.target)) return;
    if (e.key === 'Enter' || e.key === 'Escape') { flushFill(); emit('press', e.target, [e.key]); }
  }, true);

  window.addEventListener('beforeunload', flushFill);

  window.__trawlRecorderControl = (command) => {
    if (command === 'pause') state.paused = true;
    if (command === 'resume') state.paused = false;
    if (command === 'assert') state.mode = 'assert';
    if (command === 'flush') flushFill();
    return { paused: state.paused, mode: state.mode };
  };

  const overlay = document.createElement('div');
  overlay.setAttribute('data-trawl-overlay', '1');
  overlay.style.cssText =
    'position:fixed;z-index:2147483647;right:12px;bottom:12px;display:flex;gap:6px;' +
    'padding:8px;border-radius:8px;background:#111;color:#fff;font:12px system-ui;box-shadow:0 2px 12px rgba(0,0,0,.4)';
  const button = (label, command) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'all:unset;cursor:pointer;padding:4px 8px;border-radius:4px;background:#333;color:#fff';
    b.addEventListener('click', () => {
      const next = window.__trawlRecorderControl(command === 'pause' && state.paused ? 'resume' : command);
      if (command === 'pause') b.textContent = next.paused ? '▶' : '⏸';
    }, true);
    return b;
  };
  const install = () => {
    if (!document.body || document.querySelector('[data-trawl-overlay]')) return;
    overlay.append(button('⏸', 'pause'), button('✓ assert', 'assert'));
    document.body.appendChild(overlay);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
`;
