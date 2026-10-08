import { SpineLayout } from "@pixijs-userland/spine-layout";
import { AppController } from "./controllers/App.controller";
import { BackendController } from "./controllers/Backend.controller";
import { ReelController } from "./controllers/Reel.controller";
import { RootLayout } from "./layout/Root.layout";

async function main() {
  const app = new AppController();

  await app.init();

  const spineLayout = new SpineLayout({ debug: true });

  spineLayout.createInstancesFromManifest(app.manifest, "spine");

  app.stage.addChild(new RootLayout(spineLayout));

  new ReelController(spineLayout);

  // The backend is reached through the `vite dev` proxy (vite.config.ts).
  // Until the reels are wired to it: Space spins and logs the result.
  if (import.meta.env.DEV) {
    const backend = new BackendController({
      game: "thunder_coins_xxxl",
      serverURL: `${location.origin}/playson-backend`,
      wlCode: "demomode",
      projectId: 1,
      columns: 3,
      rows: 6,
      lines: 20,
      player: { key: "test" },
    });
    Object.assign(window, { backend });
    backend.on("error", (error) => console.error("[backend]", error));

    await backend.connect();
    console.info(`[backend] connected, balance ${backend.balance / 100}`);

    window.addEventListener("keydown", (event) => {
      if (event.code !== "Space" || event.repeat) return;
      backend
        .spin(10)
        .then((result) => console.info("[backend] spin", result))
        .catch((error) => console.error("[backend] spin failed", error));
    });
  }
}

void main();
