import type { SpineLayout } from "@pixijs-userland/spine-layout";
import type { BackendController } from "./Backend.controller";
import type { ValuesController } from "./Values.controller";

const BET_MINUS_DOWN = "bet_minus_down";
const BET_PLUS_DOWN = "bet_plus_down";

/**
 * The bet minus / plus buttons: step the line bet along the stakes the backend
 * offers and show the new total. The next spin is played at it.
 */
export class BetController {
  constructor(
    layout: SpineLayout,
    private readonly backend: BackendController,
    private readonly values: ValuesController,
  ) {
    layout.animations.addEventListener(BET_MINUS_DOWN, () => this.change(-1));
    layout.animations.addEventListener(BET_PLUS_DOWN, () => this.change(1));
  }

  private change(steps: number) {
    // The stakes arrive with the connect.
    if (!this.backend.connected) return;
    if (this.backend.changeLineBet(steps)) void this.values.showBet();
  }
}
