// Entry point for the board BFF. Reads configuration from the environment and
// starts the read-only server. The board never mints or stores credentials; it
// uses the same MEANWHILE_API_KEY the operator already has for this owner.
import { BoardServer } from "./server";

const baseUrl = Bun.env.MEANWHILE_URL ?? "http://127.0.0.1:7331";
const apiKey = Bun.env.MEANWHILE_API_KEY;
if (!apiKey) {
  console.error("MEANWHILE_API_KEY is required to run the board");
  process.exit(1);
}

const assetsDir = new URL("../dist/", import.meta.url).pathname;
if (!(await Bun.file(`${assetsDir}index.html`).exists())) {
  console.error("Board UI is not built. Run `bun run build` in the board workspace first.");
  process.exit(1);
}

const server = new BoardServer({
  baseUrl,
  apiKey,
  assetsDir,
  hostname: Bun.env.MEANWHILE_BOARD_HOST ?? "127.0.0.1",
  port: Number(Bun.env.MEANWHILE_BOARD_PORT ?? 7333),
  ...(Bun.env.MEANWHILE_BOARD_MAX_LIVE
    ? { maxLive: Number(Bun.env.MEANWHILE_BOARD_MAX_LIVE) }
    : {}),
});

const { url } = server.start();
console.log(`Meanwhile board (read-only) on ${url}`);

const shutdown = () => {
  void server.stop().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
