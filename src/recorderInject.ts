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
  const state = { paused: false, mode: 'record', pendingFill: null, seq: 0 };

  const inOverlay = (el) => !!(el && el.closest && el.closest('[data-trawl-overlay]'));

  // A human clicks a button; the event lands on the icon inside it. Recording
  // the icon produces a css path that breaks on the next redesign.
  const ACTIONABLE =
    'button, a[href], [role=button], [role=link], [role=tab], [role=menuitem], [role=option],' +
    'label, input, select, textarea, summary, [onclick], [tabindex]';
  const actionable = (el) => (el.closest && el.closest(ACTIONABLE)) || el;

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

  const byIds = (value) =>
    (value || '')
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((node) => norm(node.textContent))
      .filter(Boolean)
      .join(' ');

  // The order ARIA specifies, and the one Playwright computes with: an icon
  // button usually has nothing but a title, and losing it costs us the name.
  const accessibleName = (el) => {
    const labelledBy = byIds(el.getAttribute('aria-labelledby'));
    if (labelledBy) return labelledBy;
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    if (el.labels && el.labels[0]) return norm(el.labels[0].textContent);
    const text = norm(el.textContent);
    if (text && text.length <= 60) return text;
    const value = norm(el.getAttribute('value'));
    if (value) return value;
    return norm(el.getAttribute('title'));
  };

  const labelText = (el) => (el.labels && el.labels[0] ? norm(el.labels[0].textContent) : '');

  // Text carrying digits is almost always data — an order number, a price, a
  // date, a count. Matching on it records today's data as tomorrow's selector.
  const looksDynamic = (s) => /\d/.test(s);

  const OPTION_ROLES = ['radio', 'checkbox', 'option', 'switch', 'menuitemradio', 'menuitemcheckbox'];
  const OPTION_CONTAINERS = '[role=radiogroup], [role=listbox], [role=menu], fieldset, select';

  // Inside a closed set of choices, digits are the identity of the option — a
  // year, a capacity, a power rating. Outside one they are this week's data.
  const optionLike = (el, role) =>
    OPTION_ROLES.indexOf(role) >= 0 || !!(el.closest && el.closest(OPTION_CONTAINERS));

  const GROUP_CONTAINERS = '[role=radiogroup], [role=listbox], [role=menu], fieldset, select, [data-field]';

  const groupLabel = (container) => {
    if (!container) return '';
    const aria = norm(container.getAttribute('aria-label'));
    if (aria) return aria;
    const legend = container.querySelector('legend');
    if (legend) return norm(legend.textContent);
    const labelled = byIds(container.getAttribute('aria-labelledby'));
    if (labelled) return labelled;
    return norm(container.getAttribute('data-field'));
  };

  // A year is not seven radio buttons, it is one question with an answer. The
  // page knows which question; Node cannot work it out from the events alone.
  const groupOf = (el) => {
    const role = implicitRole(el);
    if (!optionLike(el, role)) return null;
    const container = el.closest(GROUP_CONTAINERS);
    const key = el.getAttribute('name') || (container ? cssPath(container) : '');
    if (!key || !container) return null;
    return { key: key, label: groupLabel(container), targets: verified(container) };
  };

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

    // Wording that carries digits is data — unless this element is one of a
    // fixed set of choices, where the digits are what the choice *is*.
    const dataLike = optionLike(el, role) ? () => false : looksDynamic;

    // Stable wording first.
    if (role && name && !dataLike(name)) out.push({ role: role, name: name });
    if (label && !dataLike(label)) out.push({ label: label });
    if (placeholder && !dataLike(placeholder)) out.push({ placeholder: placeholder });
    if (own && own.length <= 40 && !dataLike(own)) out.push({ text: own });

    // Then structure: the Node side pins this to the element that was clicked,
    // so "the third row" survives the numbers inside it changing.
    if (role) out.push({ role: role });

    // Only then the wording that looks like data. It is marked so the Node side
    // can use it as a last resort without ever saving it as a fallback.
    if (role && name && dataLike(name)) out.push({ role: role, name: name, __dyn: true });
    if (label && dataLike(label)) out.push({ label: label, __dyn: true });
    if (placeholder && dataLike(placeholder)) out.push({ placeholder: placeholder, __dyn: true });
    if (own && own.length <= 40 && dataLike(own)) out.push({ text: own, __dyn: true });

    out.push({ css: cssPath(el) });
    return out;
  };

  // ---- in-page verification -------------------------------------------------
  // Candidates must be checked here, synchronously, while the element is still
  // on screen: a click that navigates takes the page away long before Node
  // could ask Playwright anything.

  const ROLE_SELECTOR = {
    button: 'button, input[type=submit], input[type=button], [role=button]',
    link: 'a[href], [role=link]',
    textbox: 'input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, [role=textbox]',
    checkbox: 'input[type=checkbox], [role=checkbox]',
    radio: 'input[type=radio], [role=radio]',
    combobox: 'select, [role=combobox]',
  };

  const matchesFor = (candidate) => {
    if (candidate.testId) {
      return [...document.querySelectorAll(
        '[data-testid=' + JSON.stringify(candidate.testId) + '],' +
        '[data-test-id=' + JSON.stringify(candidate.testId) + '],' +
        '[data-qa=' + JSON.stringify(candidate.testId) + ']',
      )];
    }
    if (candidate.css) {
      try { return [...document.querySelectorAll(candidate.css)]; } catch { return []; }
    }
    if (candidate.role) {
      const selector = ROLE_SELECTOR[candidate.role] || '[role=' + JSON.stringify(candidate.role) + ']';
      let pool;
      try { pool = [...document.querySelectorAll(selector)]; } catch { return []; }
      if (candidate.name === undefined) return pool;
      return pool.filter((el) => accessibleName(el) === candidate.name);
    }
    if (candidate.label) {
      return [...document.querySelectorAll('input, textarea, select')].filter((el) => labelText(el) === candidate.label);
    }
    if (candidate.placeholder) {
      return [...document.querySelectorAll('[placeholder=' + JSON.stringify(candidate.placeholder) + ']')];
    }
    if (candidate.text) {
      return [...document.querySelectorAll('a, button, span, div, p, li, td, th, label, h1, h2, h3')]
        .filter((el) => norm(el.textContent) === candidate.text);
    }
    return [];
  };

  const strip = (candidate) => {
    const copy = Object.assign({}, candidate);
    delete copy.__dyn;
    return copy;
  };

  /** Every candidate that finds the clicked element, best first, pinned by index when needed. */
  const verified = (el) => {
    const out = [];
    for (const candidate of candidates(el)) {
      const matches = matchesFor(candidate);
      const at = matches.indexOf(el);
      if (at < 0) continue;
      if (matches.length === 1) out.push(candidate);
      else if (matches.length <= 30) out.push(Object.assign({}, candidate, { nth: at }));
      if (out.length >= 4) break;
    }
    if (out.length === 0) return out;
    // Wording that looks like data may serve as a primary when nothing else
    // matched, but is never kept as a fallback: a locator pinned to today's
    // order number puts that number back into the scenario.
    const alternatives = out.slice(1).filter((c) => !c.__dyn);
    return [out[0]].concat(alternatives).map(strip);
  };

  // What names the screen this step happened on. The heading first: a wizard
  // keeps one document title across every step, but its heading changes.
  // A heading is usually the name of the screen, but a landing page puts its
  // marketing line there — and that name is then repeated on every element the
  // screen owns. Long wording loses to a shorter honest source.
  const MAX_SCREEN_LABEL = 32;
  const screenTitle = () => {
    const heading = document.querySelector('h1');
    const candidates = [
      heading ? norm(heading.textContent) : '',
      // A document title is often "Section — Site"; the part before the dash is
      // the section.
      norm(document.title).split(/\s+[|—–·]\s+/)[0] || '',
      norm(document.title),
    ].filter(Boolean);
    return candidates.find((t) => t.length <= MAX_SCREEN_LABEL) || (candidates[0] || '').slice(0, MAX_SCREEN_LABEL);
  };

  // A modal is a screen by every measure that matters to a person, and by none
  // that matter to a url: the login form over the front page shares its address
  // with the marketing copy underneath. Without this everything a modal owns is
  // filed under whatever page it happened to open on.
  const DIALOG = '[role=dialog], [aria-modal=true], dialog';
  const dialogInfo = (el) => {
    const box = el.closest && el.closest(DIALOG);
    if (!box) return null;
    const heading = box.querySelector('h1, h2, h3, [role=heading]');
    const headingText = heading ? norm(heading.textContent) : '';
    const label = norm(box.getAttribute('aria-label')) || headingText;
    return {
      label: label || 'Диалог',
      // The marker is what tells this screen from the page beneath it, which
      // shares its url.
      marker: headingText ? { role: 'heading', name: headingText } : null,
    };
  };

  const emit = (action, el, args) => {
    if (state.paused) return;
    const found = verified(el);
    // A sequence number and a timestamp: Node orders steps by when they happened
    // in the page, not by when its own bookkeeping got round to them.
    return window.__trawlRec({
      action: action,
      action_: action,
      targets: found,
      group: groupOf(el),
      title: screenTitle(),
      dialog: dialogInfo(el),
      // Where the element sits right now. A picture of it can only be taken
      // while it is still on screen, and a click that navigates takes the page
      // away almost at once.
      rect: (() => {
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (!r || r.width < 4 || r.height < 4 || r.width > 1600 || r.height > 1200) return null;
        return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: r.height };
      })(),
      fallbackCss: cssPath(el),
      args: args || [],
      ts: Date.now(),
      seq: state.seq++,
    }).catch(() => {});
  };

  const flushFill = () => {
    const pending = state.pendingFill;
    if (!pending) return;
    state.pendingFill = null;
    emit('fill', pending.el, [pending.value]);
  };

  document.addEventListener('click', (e) => {
    const raw = e.target;
    if (!raw || inOverlay(raw)) return;
    flushFill();
    if (state.mode === 'assert') {
      state.mode = 'record';
      // The raw target on purpose: when a human points at a span to assert its
      // text, that span is what they meant.
      const text = (raw.textContent || '').trim();
      emit(text ? 'expectText' : 'expectVisible', raw, text ? [text] : []);
      return;
    }
    const el = actionable(raw);
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const type = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      emit(el.checked ? 'check' : 'uncheck', el, []);
      return;
    }
    // Clicking a label makes the browser dispatch a second click on its control,
    // which arrives here as the check/uncheck above. Recording this one as well
    // would toggle the box twice on replay.
    if (tag === 'label' && el.control) {
      const controlType = (el.control.type || '').toLowerCase();
      if (controlType === 'checkbox' || controlType === 'radio') return;
    }
    emit('click', el, []);
  }, true);

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el || inOverlay(el)) return;
    const type = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
    // check/uncheck already recorded the intent; the value here is the option's
    // own value attribute, never anything a human typed.
    if (type === 'checkbox' || type === 'radio') return;
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
