const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const ctrl = require("../controllers/siteContentController");

// Public read of the storefront copy the page loaders and the promo banner
// slider need. Only the `loader` and `banners` sections are exposed — the rest
// of SiteContent stays behind the panel's edit_site_content permission.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { success: false, message: "Too many requests" },
});

router.get("/", publicLimiter, ctrl.getPublicContent);

module.exports = router;
