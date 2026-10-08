import type { SpineLayout } from "@pixijs-userland/spine-layout";
import { settings } from "../settings/settings";
import type { BackendController } from "./Backend.controller";
import type { ValuesController } from "./Values.controller";

const SPIN_CLICK = "spin_click";
const UPDATE_SYMBOLS = "update_symbols";
/** `state_spin_end/` — the reels landing. */
const SPIN_END = "spin_end";
/** `state_reveal_win/` — shown after the reels land on a win. */
const REVEAL_WIN = "reveal_win";

export class ReelController {
  private spinning = false;

  constructor(
    private readonly layout: SpineLayout,
    private readonly backend?: BackendController,
    private readonly values?: ValuesController,
  ) {
    layout.animations.addEventListener(SPIN_CLICK, () => this.startSpin());

    layout.animations.addEventListener(UPDATE_SYMBOLS, () =>
      this.updateSymbols(),
    );

    this.updateSymbols();
  }

  private updateSymbols() {
    const { layout } = this;

    // random skin from settings.symbols for each symbol instance
    layout.multipleInstanceIds.forEach((spineID) => {
      const spine = layout.getSpine(spineID);
      if (!spine) return;

      const skins = settings.symbols.filter((s) =>
        spine.skeleton.data.findSkin(s),
      );
      if (!skins.length) return;

      layout.skins.applyBySpineID(
        spineID,
        skins[Math.floor(Math.random() * skins.length)],
      );
    });
  }

  private async startSpin() {
    if (this.spinning) return;
    this.spinning = true;
    this.blockUI();

    try {
      const win = await this.roll();
      await this.reveal();
      if (win > 0) await this.revealWin();
      // Counts up while the UI is already free again.
      void this.values?.showTotalWin();
    } finally {
      this.unblockUI();
      this.spinning = false;
    }
  }

  /**
   * Requests the round from the backend and resolves with its win, in cents —
   * 0 without a backend or on a failed request: the reels land either way.
   */
  private async roll() {
    const { backend } = this;
    // No backend (production build) or not connected yet.
    if (!backend?.connected) return 0;

    try {
      const result = await backend.spin();
      console.info("[backend] spin", result);
      return result.win;
    } catch (error) {
      console.error("[backend] spin failed", error);
      return 0;
    }
  }

  /** Plays `state_spin_end` on every spine that has it and waits for it to finish. */
  private async reveal() {
    await this.layout.animations.playState(SPIN_END);
  }

  /** Plays `state_reveal_win` and waits for it to finish. */
  private async revealWin() {
    await this.layout.animations.playState(REVEAL_WIN);
  }

  /**
   * Every button in the layout is a hit area under it, so switching off its
   * children's interactivity blocks them all — spin included — at once.
   */
  private blockUI() {
    this.layout.interactiveChildren = false;
  }

  private unblockUI() {
    this.layout.interactiveChildren = true;
  }
}
