const router = require("express").Router();
const ctrl = require("../controllers/siteModeController");

router.get("/", ctrl.getPublic);

module.exports = router;
