const SiteContent = require("../models/SiteContent");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

const DEFAULT_CONTENT = [
  { key: "hero.badge", section: "hero", label: "Hero Badge Text", type: "text", value: "Premium Roblox Items", sortOrder: 1 },
  { key: "hero.title", section: "hero", label: "Hero Title", type: "text", value: "Your Ultimate Roblox Item Destination", sortOrder: 2 },
  { key: "hero.subtitle", section: "hero", label: "Hero Subtitle", type: "text", value: "Browse thousands of premium in-game items across all your favorite Roblox games", sortOrder: 3 },
  { key: "hero.cta_primary", section: "hero", label: "Primary CTA Button", type: "text", value: "Browse Games", sortOrder: 4 },
  { key: "hero.cta_secondary", section: "hero", label: "Secondary CTA Button", type: "text", value: "How It Works", sortOrder: 5 },
  { key: "nav.logo", section: "navigation", label: "Logo Text", type: "text", value: "RBstars", sortOrder: 1 },
  { key: "nav.announcement", section: "navigation", label: "Announcement Bar Text", type: "text", value: "Fast delivery & 24/7 support", sortOrder: 2 },
  { key: "nav.announcement_enabled", section: "navigation", label: "Show Announcement Bar", type: "boolean", value: true, sortOrder: 3 },
  { key: "features.title", section: "features", label: "Features Section Title", type: "text", value: "Why Choose RBstars?", sortOrder: 1 },
  { key: "footer.tagline", section: "footer", label: "Footer Tagline", type: "text", value: "Premium Roblox items delivered fast and securely", sortOrder: 1 },
  { key: "footer.copyright", section: "footer", label: "Copyright Text", type: "text", value: "© 2024 RBstars. All rights reserved.", sortOrder: 2 },
  { key: "seo.title", section: "seo", label: "Site Title", type: "text", value: "RBstars — Premium Roblox Items", sortOrder: 1 },
  { key: "seo.description", section: "seo", label: "Meta Description", type: "text", value: "Buy premium Roblox in-game items with instant delivery and 24/7 support.", sortOrder: 2 },
];

async function ensureDefaults() {
  for (const item of DEFAULT_CONTENT) {
    await SiteContent.findOneAndUpdate(
      { key: item.key },
      { $setOnInsert: { ...item, defaultValue: item.value } },
      { upsert: true }
    );
  }
}

exports.getAllContent = catchAsync(async (req, res) => {
  await ensureDefaults();
  const content = await SiteContent.find({ visible: true }).sort({ section: 1, sortOrder: 1 });

  const grouped = {};
  for (const item of content) {
    if (!grouped[item.section]) grouped[item.section] = [];
    grouped[item.section].push(item.toObject());
  }

  res.json({ success: true, data: { content: grouped, flat: content } });
});

exports.getSection = catchAsync(async (req, res) => {
  const items = await SiteContent.find({ section: req.params.section, visible: true }).sort({ sortOrder: 1 });
  res.json({ success: true, data: { items } });
});

exports.updateContent = catchAsync(async (req, res, next) => {
  const { key } = req.params;
  const { value } = req.body;

  if (value === undefined) return next(new AppError("Value is required", 400));

  const item = await SiteContent.findOneAndUpdate(
    { key },
    {
      value,
      lastEditedBy: req.panelUser.isOwner ? "Owner" : req.panelUser.email,
      lastEditedById: req.panelUser.id,
    },
    { new: true }
  );

  if (!item) return next(new AppError("Content item not found", 404));
  res.json({ success: true, data: { item } });
});

exports.bulkUpdate = catchAsync(async (req, res, next) => {
  const { updates } = req.body;
  if (!Array.isArray(updates)) return next(new AppError("updates must be an array", 400));

  const results = await Promise.all(
    updates.map(({ key, value }) =>
      SiteContent.findOneAndUpdate(
        { key },
        {
          value,
          lastEditedBy: req.panelUser.isOwner ? "Owner" : req.panelUser.email,
          lastEditedById: req.panelUser.id,
        },
        { new: true }
      )
    )
  );

  res.json({ success: true, data: { updated: results.filter(Boolean).length } });
});

exports.resetToDefault = catchAsync(async (req, res, next) => {
  const { key } = req.params;
  const item = await SiteContent.findOne({ key });
  if (!item) return next(new AppError("Content item not found", 404));

  item.value = item.defaultValue;
  item.lastEditedBy = req.panelUser.isOwner ? "Owner" : req.panelUser.email;
  await item.save();

  res.json({ success: true, data: { item } });
});
