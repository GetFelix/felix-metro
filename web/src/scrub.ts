// Scrubbing faster than a seek takes would, with a seek per move, cancel every seek before it finishes and show
// nothing. Instead one seek runs at a time, always for the latest target, and each is shown as it completes.

/** Milliseconds a keyboard step or a released handle waits for more input before its seek starts. */
export const REST_MS = 80;

export class Latest {
  private wanted: number | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private done: (() => void)[] = [];

  /** `run` is called with one target at a time; it should not throw. */
  constructor(
    private readonly run: (tick: number) => Promise<void>,
    private readonly restMs = REST_MS,
  ) {}

  /** The target not yet taken by a seek, or null. */
  get pending(): number | null {
    return this.wanted;
  }

  /** Whether nothing is waiting or running. */
  get idle(): boolean {
    return !this.running && this.wanted === null && this.timer === null;
  }

  /**
   * Ask for `tick`. A target replaces one not yet started. While the handle is `moving` the seek starts at once; a
   * step or a release waits `restMs` for more.
   */
  want(tick: number, moving: boolean): void {
    this.wanted = tick;
    if (this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (moving) void this.loop();
    else this.timer = setTimeout(() => void this.loop(), this.restMs);
  }

  /** Drop what has not started. */
  cancel(): void {
    this.wanted = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.finish();
  }

  /** Resolves when nothing is waiting or running. */
  settled(): Promise<void> {
    return this.idle ? Promise.resolve() : new Promise((resolve) => this.done.push(resolve));
  }

  private async loop(): Promise<void> {
    this.timer = null;
    if (this.running) return;
    this.running = true;
    try {
      while (this.wanted !== null) {
        const tick = this.wanted;
        this.wanted = null;
        try {
          await this.run(tick);
        } catch {
          // run reports its own failures; the next target still goes ahead.
        }
      }
    } finally {
      this.running = false;
      if (this.timer === null) this.finish();
    }
  }

  private finish(): void {
    if (!this.idle) return;
    for (const resolve of this.done.splice(0)) resolve();
  }
}
