require("dotenv").config();
const http = require("http");
const app = require("./src/app");
const { connectDB } = require("./src/config/db");
const { initSocket } = require("./src/config/socket");
const logger = require("./src/utils/logger");

const PORT = process.env.PORT || 4000;

async function start() {
  await connectDB();

  // Heal image URLs saved with the old double-slash R2 bug (broken previews
  // in the admin panel + broken game icons on the store). Idempotent no-op.
  require("./src/utils/fixDoubleSlashUrls")().catch(err =>
    logger.error("fixDoubleSlashUrls failed:", err)
  );

  const server = http.createServer(app);
  initSocket(server);

  server.listen(PORT, () => {
    logger.info(`RBstars API running on port ${PORT} [${process.env.NODE_ENV}]`);
  });

  // Daily/weekly/monthly raffle rollover sweep — draws whatever period just
  // closed and opens the next one. The first public /api/raffles hit also
  // triggers this lazily, so an idle server never pays for it.
  require("./src/services/raffleService").startRaffleScheduler();

  process.on("unhandledRejection", (err) => {
    logger.error("Unhandled rejection:", err);
    server.close(() => process.exit(1));
  });

  process.on("SIGTERM", () => {
    logger.info("SIGTERM received — shutting down gracefully");
    server.close(() => process.exit(0));
  });
}

start();
