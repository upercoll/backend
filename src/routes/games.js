const express = require("express");
const router = express.Router();
const gamesCtrl = require("../controllers/gamesController");

router.get("/", gamesCtrl.listGames);
router.get("/:slug", gamesCtrl.getGame);

module.exports = router;
