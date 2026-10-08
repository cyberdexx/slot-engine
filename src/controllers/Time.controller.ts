import type { SpineLayout } from "@pixijs-userland/spine-layout";

const TIME = "time";

/** The player's local time as `HH:MM`. */
const clock = (date: Date) =>
  date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** Keeps the layout's time text on the player's clock. */
export class TimeController {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly layout: SpineLayout) {
    this.tick();
  }

  stop() {
    clearTimeout(this.timer);
  }

  /**
   * Writes the time, then waits for the next minute to start rather than
   * polling on an interval, so the text turns over with the system clock.
   * Seeded, not set: a new minute is not a change the player should see
   * animated.
   */
  private tick() {
    const { texts } = this.layout;
    const now = new Date();
    const value = clock(now);

    if (texts.has(TIME) && texts.getVal(TIME) !== value) {
      void texts.seed(TIME, value);
    }

    const untilNextMinute =
      60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
    this.timer = setTimeout(() => this.tick(), untilNextMinute);
  }
}
