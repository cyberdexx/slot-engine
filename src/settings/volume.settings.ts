import type { SoundSettings } from "@pixijs-userland/spine-layout";

/**
 * The game's authored mix, 0 to 1. Keys of `soundsVolumes` are the sound names
 * the spine events ask for — the file name in assets/sounds without its
 * extension. A sound left out plays at `fxVolume`.
 */
export const volumeSettings = {
  musicVolume: 0.3,
  fxVolume: 0.8,
  soundsVolumes: {
    click: 0.6,
    fly: 0.8,
    land: 0.5,
  },
} satisfies Partial<SoundSettings>;
