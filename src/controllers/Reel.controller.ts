import type { SpineLayout } from "@pixijs-userland/spine-layout";
import { settings } from "../settings/settings";

const SPIN_CLICK = "spin_click";
const UPDATE_SYMBOLS = "update_symbols";

export class ReelController {
  constructor(private readonly layout: SpineLayout) {
    layout.animations.addEventListener(SPIN_CLICK, () => this.roll());

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

  private roll() {
    console.log(`!!! REQUEST BE SPIN RESUTL HERE !!!`);
  }
}
