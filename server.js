require("dotenv").config();
const http = require("http");
const app = require("./src/app");
const { connectDB } = require("./src/config/db");
const { initSocket } = require("./src/config/socket");
const logger = require("./src/utils/logger");

const PORT = process.env.PORT || 4000;

async function start() {
  await connectDB();

  const server = http.createServer(app);
  initSocket(server);

  server.listen(PORT, () => {
    logger.info(`RBstars API running on port ${PORT} [${process.env.NODE_ENV}]`);
  });

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
