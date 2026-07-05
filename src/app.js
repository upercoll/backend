const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const mongoSanitize = require("express-mongo-sanitize");
const morgan = require("morgan");

const { apiLimiter, authLimiter } = require("./middleware/rateLimiter");
const errorHandler = require("./middleware/errorHandler");
const logger = require("./utils/logger");

const productRoutes = require("./routes/products");
const categoryRoutes = require("./routes/categories");
const orderRoutes = require("./routes/orders");
const paymentRoutes = require("./routes/payments");
const adminRoutes = require("./routes/admin");
const authRoutes = require("./routes/auth");
const chatRoutes = require("./routes/chat");
const promoRoutes = require("./routes/promo");
const claimRoutes = require("./routes/claims");
const customerAuthRoutes = require("./routes/customerAuth");
const panelRoutes = require("./routes/panel");
const gamesRoutes = require("./routes/games");
const collaboratorRoutes = require("./routes/collaborator");
const stockerPanelRoutes = require("./routes/stockerPanel");
const delivererPanelRoutes = require("./routes/delivererPanel");

const app = express();

app.use(helmet());
app.use(mongoSanitize());

const allowedOrigins = [
  process.env.FRONTEND_URL,
  "http://localhost:5173",
  "http://localhost:5000",
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));

app.use("/api/payments/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.use(compression());
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
} else {
  app.use(morgan("combined", { stream: { write: (msg) => logger.info(msg.trim()) } }));
}

app.use("/api", apiLimiter);
app.use("/api/auth", authLimiter);

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/products", productRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/promo", promoRoutes);
app.use("/api/claims", claimRoutes);
app.use("/api/customer-auth", customerAuthRoutes);
app.use("/api/panel", panelRoutes);
app.use("/api/games", gamesRoutes);
app.use("/api/collab", collaboratorRoutes);
app.use("/api/stocker", stockerPanelRoutes);
app.use("/api/deliverer", delivererPanelRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

app.use(errorHandler);

module.exports = app;
