# trawl-devices-agent

Local sidecar for the Trawl **devices** plugin: records browser actions into a
declarative JS DSL and replays them with Playwright.

## Run

```sh
npx trawl-devices-agent@latest --workspace=/path/to/repo --port=8787
```

It prints the port and the bearer token; paste the token into the plugin once.
The token also lives in `~/.trawl-devices/agent.json` (mode 0600).

Install a browser once: `npx playwright install chromium`.

Flags: `--workspace` (default: `~/trawl-devices`), `--port` (8787, next free port
if taken), `--proxy-port` (8080, Trawl's proxy), `--keep-runs` (50),
`--ensure-browser` (install the Playwright browser first — a no-op once it is
there), `--browser` (chromium by default).

Trawl 1.8.0 and newer starts the agent for you from the Devices tab; running it
by hand is the fallback.

## Workspace layout

```
<workspace>/
  devices.json     # device registry, commit it
  scripts/*.js     # scenarios, commit them
  suites/*.json    # named lists of scenarios, commit them
  runs/<runId>/    # report.json, trace.zip, frames/*.jpg — gitignore this
```

## Writing scripts

See `skills/writing-device-scripts/SKILL.md` — the same text the agent serves at
`GET /guide` and that can be symlinked into `~/.claude/skills/`.

## Security model

The agent listens on `127.0.0.1` only and refuses any request that lacks the
bearer token, carries an `Origin` header, or arrives with an unexpected `Host`
header. `GET /health` answers without a token so the plugin can detect a running
agent, and returns only the agent version in that case.

**Scripts are not sandboxed against malice.** `node:vm` keeps `require`,
`process` and `fetch` out of scope so accidents stay contained, but a script runs
with your privileges. Run only scripts you wrote or reviewed — the same trust
model as Trawl plugins.

Secrets passed by the plugin are masked in reports, logs and API responses.
Playwright traces cannot be masked, so a device that uses `secret()` should keep
`trace` at `on-failure` (the default) rather than `always`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | version, DSL version, known steps |
| GET/POST | `/devices` | list / upsert devices |
| POST/GET/DELETE | `/sessions` | start, list, stop browser sessions |
| GET/POST | `/scripts…` | list, read, write, validate scripts |
| POST/GET/DELETE | `/runs…` | start, poll, cancel runs |
| POST/GET | `/record…` | start, inspect, stop a recording |
| GET/POST | `/suites…` | list, read, write suites; run one and poll it |
| POST | `/heal` | replay a failed run to its failing step and report the page |
| POST | `/control/snapshot`, `/control/do` | live browser control |
| GET | `/guide` | the DSL reference |
