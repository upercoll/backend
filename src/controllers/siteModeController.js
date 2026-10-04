const SiteMode = require("../models/SiteMode");
const catchAsync = require("../utils/catchAsync");

async function getOrCreate() {
  let doc = await SiteMode.findOne();
  if (!doc) doc = await SiteMode.create({});
  return doc;
}

// Public — storefront reads this on load (no auth)
exports.getPublic = catchAsync(async (req, res) => {
  const doc = await getOrCreate();
  res.json({ success: true, data: { halloween: doc.halloween } });
});

// Owner panel — full document
exports.getSiteModes = catchAsync(async (req, res) => {
  const doc = await getOrCreate();
  res.json({ success: true, data: doc });
});

exports.updateSiteModes = catchAsync(async (req, res) => {
  const allowed = ["halloween"];
  const update = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );

  const doc = await SiteMode.findOneAndUpdate({}, update, {
    new: true,
    upsert: true,
    runValidators: true,
  });

  res.json({ success: true, data: doc });
});
