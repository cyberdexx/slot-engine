import type { SpineLayout } from "@pixijs-userland/spine-layout";

const SPIN_CLICK = "spin_click";
const SPECIAL = ["SC", "WI"];
const reelNumber = (id: string) => Number(id.match(/(\d+)$/)?.[1] ?? 0);

export class ReelController {
  private reels: string[];
  private slots: number;
  private symbols: string[];
  private result: string[][] = [];

  constructor(private layout: SpineLayout) {
    const symbols = layout.spine.getSpinesByNamePattern("symbol");

    this.reels = [
      ...layout.spine.getSpinesByNamePattern("reel", { not: ["reels"] }).keys(),
    ].sort((a, b) => reelNumber(a) - reelNumber(b));

    const data = layout.spines.get(this.reels[0])!.skeleton.data;

    this.slots = data.slots.filter(({ name }) =>
      name.startsWith("spine_symbol"),
    ).length;
    this.symbols = [...symbols.values()][0].skeleton.data.skins
      .map(({ name }) => name)
      .filter((name) => name !== "default" && !SPECIAL.includes(name));

    this.roll();

    this.reels.forEach((reelID, reel) => {
      for (let slot = 0; slot < this.slots; slot++) {
        const id = `symbol${reel * this.slots + slot + 1}`;

        layout.scene.addSlotChild(
          reelID,
          `spine_symbol${slot}`,
          symbols.get(id)!,
        );
        this.setSymbol(reel, slot);
      }
    });

    // The spin button fires `spin_click`, which plays `event_spin_click/` on every reel.
    layout.animations.addEventListener(SPIN_CLICK, () => this.roll());

    for (let slot = 0; slot < this.slots; slot++) {
      layout.animations.addEventListener(`update/symbol-${slot}`, (reelID) =>
        this.setSymbol(this.reels.indexOf(reelID as string), slot),
      );
    }
  }

  /** Picks the symbols the reels land on; each slot takes its own as the spin passes it. */
  private roll() {
    this.result = this.reels.map(() =>
      Array.from(
        { length: this.slots },
        () => this.symbols[Math.floor(Math.random() * this.symbols.length)],
      ),
    );
  }

  private setSymbol(reel: number, slot: number) {
    this.layout.skins.applyBySpineID(
      `symbol${reel * this.slots + slot + 1}`,
      this.result[reel][slot],
    );
  }
}
