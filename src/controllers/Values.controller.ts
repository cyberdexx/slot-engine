import type { SpineLayout } from "@pixijs-userland/spine-layout";
import type { BackendController } from "./Backend.controller";

/**
 * Cents as the plain `1234.56` the texts' number count-up can parse — it reads
 * `\d+(\.\d+)?`, so a grouping separator would cut the number short.
 */
const money = (cents: number) => (cents / 100).toFixed(2);

/** What the win fields show when there is no win. */
const NO_WIN = "-";

/** A win, or `-` when there is none. */
const win = (cents: number) => (cents ? money(cents) : NO_WIN);

/**
 * Keeps the layout's balance, bet and win texts in step with the backend:
 * `win` is the last round's win, `total_win` the win so far — the whole
 * freespins sequence while one runs.
 */
export class ValuesController {
  /** Responses before seed() belong to the session start, which seed() shows. */
  private seeded = false;

  constructor(
    private layout: SpineLayout,
    private backend: BackendController,
  ) {
    backend.on("response", ({ command, status }) => {
      if (!this.seeded || status === "error") return;
      if (command === "bet" || command === "next") void this.showRound();
      else void this.set("balance", money(backend.balance));
    });
  }

  /**
   * The values of a freshly connected session, put in place without the
   * `<text>_change` animation — nothing has changed for the player yet.
   */
  async seed() {
    const { backend } = this;
    await Promise.all([
      this.write("balance", money(backend.balance), "seed"),
      this.write("bet", money(backend.totalBet()), "seed"),
      this.write("win", win(backend.roundPaid), "seed"),
      this.write("total_win", win(this.totalWin), "seed"),
    ]);
    this.seeded = true;
  }

  /** The total bet for the selected line bet. */
  showBet() {
    return this.set("bet", money(this.backend.totalBet()));
  }

  /** Bet, win and balance after a round. */
  private async showRound() {
    const { backend } = this;
    await Promise.all([
      this.showBet(),
      this.showWin("win", backend.roundPaid),
      this.showWin("total_win", this.totalWin),
      this.set("balance", money(backend.balance)),
    ]);
  }

  private get totalWin() {
    const { backend } = this;
    return backend.freespinsActive ? backend.freespinsPaid : backend.roundPaid;
  }

  /** A win counts up (from 0 after a `-`); no win shows `-` at once. */
  private showWin(key: string, cents: number) {
    return cents
      ? this.set(key, win(cents))
      : this.write(key, NO_WIN, "settle");
  }

  private set(key: string, value: string) {
    return this.write(key, value, "set");
  }

  /** Writes a text the layout has; a layout without that field is left alone. */
  private async write(
    key: string,
    value: string,
    how: "seed" | "set" | "settle",
  ) {
    const { texts } = this.layout;
    if (!texts.has(key) || texts.getVal(key) === value) return;
    await texts[how](key, value);
  }
}
