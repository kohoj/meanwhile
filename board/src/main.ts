// Entry point for the board BFF. Reads configuration from the environment and
// starts the Project Watch BFF. In team mode each person exchanges their API
// key for an opaque browser session; the key is never persisted by the board.
import { BoardServer } from "./server";

const baseUrl = Bun.env.MEANWHILE_URL ?? "http://127.0.0.1:7331";
const apiKey = Bun.env.MEANWHILE_API_KEY;

const assetsDir = new URL("../dist/", import.meta.url).pathname;
if (!(await Bun.file(`${assetsDir}index.html`).exists())) {
  console.error("Board UI is not built. Run `bun run build` in the board workspace first.");
  process.exit(1);
}

const server = new BoardServer({
  baseUrl,
  ...(apiKey === undefined ? {} : { apiKey }),
  assetsDir,
  hostname: Bun.env.MEANWHILE_BOARD_HOST ?? "127.0.0.1",
  port: Number(Bun.env.MEANWHILE_BOARD_PORT ?? 7333),
});

const { url } = server.start();
console.log(`Meanwhile board on ${url}`);

const shutdown = () => {
  void server.stop().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
