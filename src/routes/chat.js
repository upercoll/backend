const router = require("express").Router();
const ctrl = require("../controllers/chatController");
const { protect, supportOrAdmin } = require("../middleware/auth");

router.get("/session/:sessionId", ctrl.getSessionHistory);

router.get("/sessions", protect, supportOrAdmin, ctrl.getAllSessions);
router.delete("/sessions/:sessionId", protect, supportOrAdmin, ctrl.deleteSession);

module.exports = router;
