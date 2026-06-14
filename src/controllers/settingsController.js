const Setting = require("../models/Setting");
const catchAsync = require("../utils/catchAsync");

exports.getSettings = catchAsync(async (req, res) => {
  let settings = await Setting.findOne();
  if (!settings) {
    settings = await Setting.create({});
  }
  res.json({ success: true, data: settings });
});

exports.updateSettings = catchAsync(async (req, res) => {
  const allowed = ["salesTaxRate", "taxLabel", "taxEnabled"];
  const update = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );

  let settings = await Setting.findOneAndUpdate({}, update, {
    new: true,
    upsert: true,
    runValidators: true,
  });

  res.json({ success: true, data: settings });
});
