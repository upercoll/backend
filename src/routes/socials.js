const router = require("express").Router();
const ctrl = require("../controllers/socialController");
router.get("/featured-youtubers", ctrl.publicFeaturedYouTubers);
module.exports = router;
