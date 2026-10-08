import { sounds } from "@pixijs-userland/spine-layout";
import type { AssetsManifest, UnresolvedAsset } from "pixi.js";
import { volumeSettings } from "../settings/volume.settings";

const SOUNDS_BUNDLE = "sounds";

/**
 * Spine events name a sound by its bare file name (`click`), but the manifest
 * is built with `trimExtensions: false`, so the sounds only arrive as
 * `click.mp3` / `sounds/click.mp3` and every event resolves to nothing. Adds the
 * extension-less aliases to the sounds bundle; the rest of the manifest — whose
 * spine/atlas aliases need their extensions — is left as it is.
 */
function withBareSoundAliases(manifest: AssetsManifest): AssetsManifest {
  return {
    ...manifest,
    bundles: manifest.bundles.map((bundle) => {
      if (bundle.name !== SOUNDS_BUNDLE) return bundle;

      const assets = (bundle.assets as UnresolvedAsset[]).map((asset) => {
        const aliases = ([] as string[]).concat(asset.alias ?? []);
        const bare = aliases.map((alias) => alias.replace(/\.[^./]+$/, ""));

        return { ...asset, alias: [...new Set([...aliases, ...bare])] };
      });

      return { ...bundle, assets };
    }),
  };
}

/**
 * Registers the sounds with the layout's `sounds` singleton. Call before
 * `createInstancesFromManifest`, whose own `sounds.init` only adds to what is
 * registered here and keeps these settings.
 */
export function initSounds(manifest: AssetsManifest) {
  sounds.init(withBareSoundAliases(manifest), {
    ...volumeSettings,
    // Same base as AppController.loadAssets, so the files resolve under the
    // build's `/slot-engine/` base whatever URL the page was opened at.
    assetBase: `${import.meta.env.BASE_URL}assets`,
  });
  void sounds.preload();
}
