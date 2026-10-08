import { SpineLayout } from "@pixijs-userland/spine-layout";
import { AppController } from "./controllers/App.controller";
import { BackendController } from "./controllers/Backend.controller";
import { BetController } from "./controllers/Bet.controller";
import { ReelController } from "./controllers/Reel.controller";
import { initSounds } from "./controllers/Sounds.controller";
import { TimeController } from "./controllers/Time.controller";
import { ValuesController } from "./controllers/Values.controller";
import { RootLayout } from "./layout/Root.layout";

async function main() {
  const app = new AppController();

  await app.init();

  initSounds(app.manifest);

  const spineLayout = new SpineLayout({ debug: true });

  spineLayout.createInstancesFromManifest(app.manifest, "spine");

  app.stage.addChild(new RootLayout(spineLayout));

  // The backend is reached through the `vite dev` proxy (vite.config.ts),
  // so it is only wired in there.
  const backend = import.meta.env.DEV
    ? new BackendController({
        game: "thunder_coins_xxxl",
        serverURL: `${location.origin}/playson-backend`,
        wlCode: "demomode",
        projectId: 1,
        columns: 3,
        rows: 6,
        lines: 20,
        player: { key: "test" },
      })
    : undefined;

  new ReelController(spineLayout, backend);
  new TimeController(spineLayout);

  if (backend) {
    const values = new ValuesController(spineLayout, backend);
    new BetController(spineLayout, backend, values);
    Object.assign(window, { backend });
    backend.on("error", (error) => console.error("[backend]", error));

    await backend.connect();
    await values.seed();
    console.info(`[backend] connected, balance ${backend.balance / 100}`);
  }
}

void main();
