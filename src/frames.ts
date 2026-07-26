import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";

/**
 * Playwright's own video is fixed at ~25 fps, cannot be slowed down, and never
 * shows the pointer — a replay recorded that way is heavy and hard to read.
 * So frames are captured here instead, at a chosen rate, over a page that draws
 * its own cursor.
 */

export const CURSOR_SOURCE = String.raw`
(() => {
  if (window.__trawlCursorInstalled) return;
  window.__trawlCursorInstalled = true;

  const install = () => {
    if (!document.body || document.getElementById('__trawl_cursor')) return;
    const dot = document.createElement('div');
    dot.id = '__trawl_cursor';
    dot.style.cssText =
      'position:fixed;left:0;top:0;width:16px;height:16px;margin:-8px 0 0 -8px;' +
      'border-radius:50%;border:2px solid #fff;background:rgba(255,64,64,.75);' +
      'box-shadow:0 0 0 1px rgba(0,0,0,.5);pointer-events:none;z-index:2147483646;' +
      'transition:transform .05s linear';
    document.body.appendChild(dot);

    const move = (x, y) => { dot.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
    document.addEventListener('mousemove', (e) => move(e.clientX, e.clientY), true);
    document.addEventListener('mousedown', () => { dot.style.background = 'rgba(255,64,64,1)'; dot.style.width = '26px'; dot.style.height = '26px'; dot.style.margin = '-13px 0 0 -13px'; }, true);
    document.addEventListener('mouseup', () => { dot.style.background = 'rgba(255,64,64,.75)'; dot.style.width = '16px'; dot.style.height = '16px'; dot.style.margin = '-8px 0 0 -8px'; }, true);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
  // Pages replace their body on client-side navigation; keep the cursor alive.
  setInterval(install, 1000);
})();
`;

export interface FrameCapture {
  /** Frames written so far. */
  count(): number;
  stop(): Promise<{ count: number; fps: number }>;
}

/** Draw a pointer in every page of the context, current and future. */
export async function installCursor(context: BrowserContext): Promise<void> {
  await context.addInitScript(CURSOR_SOURCE);
  await Promise.all(context.pages().map((p) => p.evaluate(CURSOR_SOURCE).catch(() => {})));
}

/**
 * Screenshot `page` into `dir` at `fps` until stopped. Frames are JPEG: a run of
 * a few minutes at 5 fps is then megabytes rather than hundreds of them.
 */
export async function captureFrames(page: Page, dir: string, fps: number): Promise<FrameCapture> {
  await fs.mkdir(dir, { recursive: true });
  const interval = Math.max(50, Math.round(1000 / Math.max(1, fps)));
  let index = 0;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const shoot = async (): Promise<void> => {
    if (stopped || page.isClosed()) return;
    const file = path.join(dir, `${String(index).padStart(5, "0")}.jpg`);
    try {
      await page.screenshot({ path: file, type: "jpeg", quality: 60, timeout: interval * 4 });
      index += 1;
    } catch {
      // A screenshot can fail mid-navigation; the next tick tries again.
    }
  };

  // A run shorter than one interval would otherwise record nothing at all.
  inFlight = shoot();

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = inFlight.then(shoot);
  }, interval);
  timer.unref?.();

  return {
    count: () => index,
    stop: async () => {
      clearInterval(timer);
      await inFlight;
      // One last frame: the end state is the one you look at first.
      await shoot();
      stopped = true;
      return { count: index, fps };
    },
  };
}
