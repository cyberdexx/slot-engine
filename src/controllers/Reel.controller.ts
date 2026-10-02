import { EventTimeline } from "@esotericsoftware/spine-pixi-v8";
import type { SpineLayout } from "@pixijs-userland/spine-layout";

const SPIN = "spin_5_rows";
const SPIN_TIME = 3000;
const SPECIAL = ["SC", "WI"];
const reelNumber = (id: string) => Number(id.match(/(\d+)$/)?.[1] ?? 0);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ReelController {
  private reels: string[];
  private slots: number;
  private symbols: string[];
  private alignTime = 0;

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

    data.findAnimation(SPIN)?.timelines.forEach((timeline) => {
      if (!(timeline instanceof EventTimeline)) return;

      timeline.events.forEach((event) => {
        if (event.data.name.startsWith("update/symbol-")) {
          this.alignTime = Math.max(this.alignTime, event.time);
        }
      });
    });

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

    for (let slot = 0; slot < this.slots; slot++) {
      layout.animations.addEventListener(`update/symbol-${slot}`, (reelID) =>
        this.setSymbol(this.reels.indexOf(reelID as string), slot),
      );
    }

    this.reels.forEach((reelID, reel) => void this.spin(reelID, reel));
  }

  private async spin(reelID: string, reel: number) {
    const { animations } = this.layout;
    const end = Date.now() + SPIN_TIME + reel * 150;

    await wait(reel * 150);

    while (Date.now() < end) await animations.play(reelID, SPIN);

    const last = animations.play(reelID, SPIN);
    const entry = this.layout.spines
      .get(reelID)!
      .state.tracks.find((track) => track?.animation?.name.endsWith(SPIN));

    if (entry && this.alignTime) entry.animationEnd = this.alignTime;

    await last;
  }

  private setSymbol(reel: number, slot: number) {
    const name = this.symbols[Math.floor(Math.random() * this.symbols.length)];

    this.layout.skins.applyBySpineID(
      `symbol${reel * this.slots + slot + 1}`,
      name,
    );
  }
}
