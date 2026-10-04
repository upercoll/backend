const router = require("express").Router();
const ctrl = require("../controllers/announcementController");
const { panelAuth, requirePermission } = require("../middleware/panelAuth");
const rateLimit = require("express-rate-limit");

// The storefront polls this on load; keep it cheap but not uncached.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: "Too many requests" },
});

// ---------------------------------------------------------------------------
// Public — used by the storefront announcement popup.
// ---------------------------------------------------------------------------
router.get("/", publicLimiter, ctrl.listLive);
router.post("/:id/view", publicLimiter, ctrl.trackView);

// ---------------------------------------------------------------------------
// Panel — everything else. Mounted AFTER the public routes so "/:id/view" and
// the literal /broadcasts paths below never collide.
// Permission-gated rather than owner-only so the owner can hand the popup
// editor to a marketing teammate; broadcasting email stays its own gate
// because it emails every customer on the site.
// ---------------------------------------------------------------------------
router.use(panelAuth);

router.get("/admin", requirePermission("view_announcements"), ctrl.listAll);
router.post("/admin", requirePermission("manage_announcements"), ctrl.create);
router.patch("/admin/:id", requirePermission("manage_announcements"), ctrl.update);
router.delete("/admin/:id", requirePermission("manage_announcements"), ctrl.remove);

router.get("/broadcasts", requirePermission("send_broadcasts"), ctrl.listBroadcasts);
router.get("/broadcasts/audience-count", requirePermission("send_broadcasts"), ctrl.audienceCount);
router.post("/broadcasts", requirePermission("send_broadcasts"), ctrl.sendBroadcast);
router.post("/broadcasts/:id/cancel", requirePermission("send_broadcasts"), ctrl.cancelBroadcast);

module.exports = router;