import { randomBytes } from "node:crypto";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright";
import { AgentError, type Device, type Session } from "./types.js";

export type LiveSession = Session & { context: BrowserContext; page: Page; browser: Browser };

const ENGINES = { chromium, firefox, webkit };

/** Playwright context options derived from a device. */
export function contextOptionsFor(device: Device, trawlProxyPort: number): BrowserContextOptions {
  const proxy =
    device.proxy.mode === "trawl"
      ? { server: `http://127.0.0.1:${trawlProxyPort}` }
      : device.proxy.mode === "custom"
        ? { server: device.proxy.url! }
        : undefined;

  return {
    ...(proxy ? { proxy } : {}),
    ignoreHTTPSErrors: device.ignoreHTTPSErrors,
    viewport: device.viewport,
    ...(device.userAgent ? { userAgent: device.userAgent } : {}),
    ...(device.locale ? { locale: device.locale } : {}),
    ...(device.timezone ? { timezoneId: device.timezone } : {}),
    ...(device.storageStateFile ? { storageState: device.storageStateFile } : {}),
  };
}

export interface StartOptions {
  /** Trawl's proxy port; only used when the device's proxy mode is "trawl". */
  trawlProxyPort?: number;
  /** Overrides the device's headless flag (runs default to the device value). */
  headless?: boolean;
  /** Directory for the video, when the device records one. */
  videoDir?: string;
}

export class SessionStore {
  private readonly sessions = new Map<string, LiveSession>();

  async start(device: Device, options: StartOptions = {}): Promise<Session> {
    const engine = ENGINES[device.browser];
    const headless = options.headless ?? device.headless;
    let browser: Browser;
    try {
      browser = await engine.launch({ headless });
    } catch (err) {
      throw new AgentError(
        "device",
        `failed to launch ${device.browser}: ${(err as Error).message}. ` +
          `Install it with: pnpm exec playwright install ${device.browser}`,
      );
    }

    const contextOptions = contextOptionsFor(device, options.trawlProxyPort ?? 8080);

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    const live: LiveSession = {
      sessionId: `s_${randomBytes(6).toString("hex")}`,
      deviceId: device.id,
      state: "idle",
      startedAt: Date.now(),
      currentUrl: null,
      browser,
      context,
      page,
    };
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) live.currentUrl = frame.url();
    });
    this.sessions.set(live.sessionId, live);
    return this.describe(live);
  }

  get(sessionId: string): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) throw new AgentError("device", `unknown session: ${sessionId}`);
    return live;
  }

  setState(sessionId: string, state: Session["state"]): void {
    this.get(sessionId).state = state;
  }

  list(): Session[] {
    return [...this.sessions.values()].map((s) => this.describe(s));
  }

  async stop(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    this.sessions.delete(sessionId);
    await live.context.close().catch(() => {});
    await live.browser.close().catch(() => {});
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  private describe(live: LiveSession): Session {
    const { sessionId, deviceId, state, startedAt, currentUrl } = live;
    return { sessionId, deviceId, state, startedAt, currentUrl };
  }
}
