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
`{ text }`, `{ css }`. Narrow with `within` and `nth`:

```js
click({ role: 'row', name: 'Заказ 42', within: { testId: 'orders' } })
```

## Steps

- Navigation: `goto`, `back`, `forward`, `reload`
- Actions: `click`, `dblclick`, `fill`, `type`, `press`, `check`, `uncheck`,
  `select`, `hover`, `upload`, `drag`, `scrollTo`
- Waits: `waitFor(target, 'visible'|'hidden'|'attached')`, `waitForUrl`,
  `waitForResponse`, `sleep`
- UI assertions: `expectVisible`, `expectHidden`, `expectText`, `expectValue`,
  `expectUrl`, `expectCount`, `expectAttr`
- HTTP assertions: `expectRequest`, `expectResponse`, `expectNoRequest`
- Reads: `getText`, `getValue`, `getAttr`, `getUrl`, `count`
- Composition: `run('scripts/login.js')`, `run('scripts/login.js', { USER: 'someone@example.com' })`
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
7. **Compose instead of repeating.** Record login once and call it:

```js
run('scripts/login.js')
click({ role: 'link', name: 'Search' })
```

   The called script runs in the same browser, its steps appear in the report
   under its path, and a second argument overlays variables for that call only
   (`run('scripts/login.js', { USER: '{{ADMIN}}' })`). Cycles are refused.
