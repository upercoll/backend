const router = require("express").Router();
const ctrl = require("../controllers/ticketController");
const { protect, adminOnly } = require("../middleware/auth");
const rateLimit = require("express-rate-limit");

const ticketCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: "Too many requests — please wait before trying again" },
});

// PUBLIC routes
router.post("/", ticketCreateLimiter, ctrl.createTicket);
router.get("/my", ctrl.getMyTickets);
router.get("/unread", ctrl.customerUnreadCount);
router.get("/:ticketId", ctrl.getTicket);
router.post("/message", ticketCreateLimiter, ctrl.addMessage);
router.post("/close", ctrl.closeTicket);

// ADMIN routes
router.get("/admin/stats", protect, adminOnly, ctrl.getTicketStats);
router.delete("/admin/:ticketId", protect, adminOnly, ctrl.deleteTicket);

module.exports = router;
