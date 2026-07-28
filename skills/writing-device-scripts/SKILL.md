---
name: writing-device-scripts
description: Use when writing or editing Trawl device scripts — the declarative JS DSL recorded and replayed by trawl-devices-agent.
---

# Writing device scripts

A device script is a plain `.js` file made of flat step calls. It is **not**
Playwright code: do not write `page.` anything, do not write `await`, do not
import anything.

```js
device('chrome-desktop')
use({ baseUrl: '{{BASE_URL}}', timeout: 15000 })

goto('/login')
fill({ label: 'Email' }, '{{USER}}')
fill({ label: 'Пароль' }, secret('PWD'))
click({ role: 'button', name: 'Войти' })
expectResponse('POST /api/login', { status: 200, jsonPath: { '$.token': /^ey/ } })
expectUrl('**/dashboard')
expectText({ testId: 'greeting' }, /Привет/)
```

## Targets

Prefer, in order: `{ testId }`, `{ role, name }`, `{ label }`, `{ placeholder }`,
`{ text }`, `{ css }`. Narrow with `within` and `nth`, and keep fallbacks in
`or` — the replay uses them when a refactor breaks the primary, and says so in
the report:

```js
click({ testId: 'submit', or: [{ role: 'button', name: 'Войти' }] })
```

Narrow with `within` and `nth`:

```js
click({ role: 'row', name: 'Заказ 42', within: { testId: 'orders' } })
```

Recording follows the same order, with one twist: wording that contains digits
(`Заказ 42`, a price, a date) is treated as data, not as a selector. Such an
element is matched by its position among elements of the same role instead, and
the recording says so in its warnings. The exception is an element belonging to a
fixed set of choices — a radio group, a listbox, a `fieldset` — where digits are
the identity of the option (`2010`, `210 л.с.`) rather than this week's value.

## Names from the map

Where the workspace has a `map/`, a **string** takes the place of a target and
the map holds the locator:

```js
open('Подача объявления')
select('Год', '2010')
click('Подать объявление')
expectApi('POST /api/adverts', 201)
```

A name is looked up on the current screen first, then among the shared elements,
then anywhere it is unique. When it is ambiguous the run refuses it and names the
qualified form that would fix it — `click('Характеристики › Продолжить')`.

Prefer names to literal targets. A markup change is then one edit in the map
rather than one edit per scenario, and the scenario says what it means.

The plugin edits this file as rows rather than text. That works because the DSL
is flat — one call per line — so a row maps to a line and back. Anything that is
not a flat step call (a loop, a condition, arbitrary JS) is kept verbatim and
shown read-only, and a step commented out with `//` stays a disabled row rather
than disappearing. Write flat steps and the visual editor stays useful.

## Steps

- Navigation: `goto`, `back`, `forward`, `reload`, `open('Экран')` — go to a
  screen the map knows, which holds how to get there (`open.url` or `open.flow`)
- Actions: `click`, `dblclick`, `fill`, `type`, `press`, `check`, `uncheck`,
  `select`, `hover`, `upload`, `drag`, `scrollTo`
- Waits: `waitFor(target, 'visible'|'hidden'|'attached')`, `waitForUrl`,
  `waitForResponse`, `sleep`
- UI assertions: `expectVisible`, `expectHidden`, `expectText`, `expectValue`,
  `expectUrl`, `expectCount`, `expectAttr`
- HTTP assertions: `expectRequest`, `expectResponse`, `expectNoRequest`,
  `expectApi('POST /api/adverts', 201)` — one call, one status, no dependence on
  markup at all, which is what makes it survive a redesign
- Reads: `getText`, `getValue`, `getAttr`, `getUrl`, `count`
- Composition: `run('scripts/login.js')`, `run('scripts/login.js', { USER: 'someone@example.com' })`
- Signed-in state: `saveState('auth')`, `useState('auth')`
- Mocks (applied by Trawl's proxy): `mock('GET api/orders', { status: 500 })`,
  `mock('GET api/orders', { json: { items: [] } })`,
  `mock('POST api/login', { status: 429, delayMs: 2000 })`, `unmock('GET api/orders')`
- Misc: `step(name, fn)`, `screenshot(name)`, `note(text)`

## Rules

1. **No `await`.** The runner inserts it. Reads return real values:
   `const title = getText({ css: 'h1' })`.
2. **`{{VAR}}`** comes from the Trawl project env; an unknown name fails the run.
   `env.VAR` reads the same values in code. **`secret('NAME')`** reads the
   Keychain — never paste a literal password.
3. **Prefer assertions over `sleep`.** Every step already auto-waits.
4. **Group with `step('name', () => { … })`** — the report shows the group name.
5. **HTTP matchers are a method plus a URL substring** (`'POST /api/login'`), or
   an object (`{ method, host, path }`). Each `expectResponse` consumes the
   first matching response not yet consumed, waiting up to the timeout.
6. **A failing step ends the run.** Steps after it never execute, so they do not
   appear in the report.
7. **Mocks are Trawl rules**, created for the run and deleted after it. They only
   apply to hosts inside the active project's scope, and the faked exchange shows
   up in the traffic list like any other flow. A mock that never fired is
   reported as a warning rather than passing quietly.
8. **Record only the part that matters.** Get the browser where you want it —
   by hand or by running the login scenario with `closeAfterRun` off — then
   start recording in that same session. The recorded fragment begins where you
   are, and is usually written to start with `run('scripts/login.js')`.
9. **Sign in once.** End a login scenario with `saveState('auth')`; other
   scenarios call `useState('auth')` right after their first `goto` and skip the
   login entirely. Cookies apply immediately; localStorage is seeded for the
   origin the page is on, so the order matters.
10. **Compose instead of repeating.** Record login once and call it:

```js
run('scripts/login.js')
click({ role: 'link', name: 'Search' })
```

   The called script runs in the same browser, its steps appear in the report
   under its path, and a second argument overlays variables for that call only
   (`run('scripts/login.js', { USER: '{{ADMIN}}' })`). Cycles are refused.
