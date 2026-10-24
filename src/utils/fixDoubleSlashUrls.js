/* One-time self-heal for image URLs saved before the R2_PUBLIC_URL fix.

   Uploads used to build `https://pub-xxx.r2.dev//rbstars/...` (double slash,
   R2 404s on it) whenever the env var carried a trailing slash — so every
   image uploaded since the Cloudinary→R2 migration is stored broken in the
   DB. r2.js now normalizes on write; this pass repairs what's already saved.

   Runs once at boot after connectDB. It's idempotent and a no-op once the
   data is clean (the query matches nothing), so it never costs anything on
   later restarts. Failures are logged, never allowed to block boot. */

const logger = require("./logger");
const { fixR2Url } = require("../config/r2");

// Collections + fields that can hold an R2 image URL.
const TARGETS = [
  { model: require("../models/Game"), name: "Game", fields: ["imageUrl", "bannerUrl", "bgImageUrl"] },
  { model: require("../models/Product"), name: "Product", fields: ["imageUrl", "images"] },
  { model: require("../models/Announcement").Announcement, name: "Announcement", fields: ["imageUrl"] },
  { model: require("../models/Tutorial"), name: "Tutorial", fields: ["thumbnailUrl"] },
  { model: require("../models/StockRequest"), name: "StockRequest", fields: ["imageUrl"] },
  { model: require("../models/ProofOfDelivery"), name: "ProofOfDelivery", fields: ["proofImageUrl", "proofImageUrls"] },
  { model: require("../models/FeaturedYouTuber"), name: "FeaturedYouTuber", fields: ["avatarUrl"] },
];

// A stored URL is broken when its PATH (everything after scheme+host) contains
// a double slash. The query regex matches scheme+host followed by `//`, which
// normal single-slashed URLs never satisfy.
const BROKEN = /:\/\/[^/]*\/\//;

function needsFix(val) {
  if (typeof val === "string") return BROKEN.test(val);
  if (Array.isArray(val)) return val.some(needsFix);
  return false;
}

function fixValue(val) {
  if (typeof val === "string") return fixR2Url(val);
  if (Array.isArray(val)) return val.map(fixValue);
  return val;
}

async function fixDoubleSlashUrls() {
  let total = 0;
  for (const { model, name, fields } of TARGETS) {
    try {
      const docs = await model.find({ $or: fields.map(f => ({ [f]: BROKEN })) }).select(fields.join(" ")).lean();
      const dirty = docs.filter(d => fields.some(f => needsFix(d[f])));
      if (!dirty.length) continue;
      const ops = dirty.map(d => ({
        updateOne: { filter: { _id: d._id }, update: { $set: Object.fromEntries(fields.filter(f => needsFix(d[f])).map(f => [f, fixValue(d[f])])) } },
      }));
      const res = await model.bulkWrite(ops, { ordered: false });
      total += res.modifiedCount;
      logger.info(`fixDoubleSlashUrls: repaired ${res.modifiedCount} ${name} image URL(s)`);
    } catch (err) {
      logger.error(`fixDoubleSlashUrls: ${name} scan failed — ${err.message}`);
    }
  }
  if (total > 0) logger.info(`fixDoubleSlashUrls: done — ${total} broken image URL(s) repaired`);
  return total;
}

module.exports = fixDoubleSlashUrls;
