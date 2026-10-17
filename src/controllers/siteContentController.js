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
  { key: "footer.tagline", section: "footer", label: "Footer Tagline", type: "text", value: "Premium Roblox items with secure checkout and 24/7 support", sortOrder: 1 },
  { key: "footer.copyright", section: "footer", label: "Copyright Text", type: "text", value: "© 2024 RBstars. All rights reserved.", sortOrder: 2 },
  /* Copy that cycles under the bar on the storefront loading screens
     (/game/:slug and /product/:id). Editable here, read by the public
     /api/site-content endpoint. Leave a line blank to hide it. */
  { key: "loader.line_1", section: "loader", label: "Loading Screen — Line 1", type: "text", value: "SECURE CHECKOUT ON EVERY ORDER", sortOrder: 1 },
  { key: "loader.line_2", section: "loader", label: "Loading Screen — Line 2", type: "text", value: "10% OFF YOUR FIRST ORDER", sortOrder: 2 },
  { key: "loader.line_3", section: "loader", label: "Loading Screen — Line 3", type: "text", value: "JOIN OUR DISCORD & WIN ITEMS", sortOrder: 3 },
  /* Promo banner slider at the top of the shop page (/game/:slug). Each slide
     can be hidden, carries its own image, and points at any link. With no
     image set a slide falls back to the built-in gradient + game art. */
  { key: "banner_1.enabled", section: "banners", label: "Slide 1 — Visible", type: "boolean", value: true, sortOrder: 1 },
  { key: "banner_1.image", section: "banners", label: "Slide 1 — Image", type: "image", value: "", sortOrder: 2 },
  { key: "banner_1.title", section: "banners", label: "Slide 1 — Headline", type: "text", value: "RARE ITEMS AT UNBEATABLE PRICES!", sortOrder: 3 },
  { key: "banner_1.cta", section: "banners", label: "Slide 1 — Button", type: "text", value: "SHOP NOW", sortOrder: 4 },
  { key: "banner_1.url", section: "banners", label: "Slide 1 — Link", type: "text", value: "/browse", sortOrder: 5 },
  { key: "banner_2.enabled", section: "banners", label: "Slide 2 — Visible", type: "boolean", value: true, sortOrder: 6 },
  { key: "banner_2.image", section: "banners", label: "Slide 2 — Image", type: "image", value: "", sortOrder: 7 },
  { key: "banner_2.title", section: "banners", label: "Slide 2 — Headline", type: "text", value: "10% OFF YOUR FIRST ORDER!", sortOrder: 8 },
  { key: "banner_2.cta", section: "banners", label: "Slide 2 — Button", type: "text", value: "CLAIM DISCOUNT", sortOrder: 9 },
  { key: "banner_2.url", section: "banners", label: "Slide 2 — Link", type: "text", value: "/browse", sortOrder: 10 },
  { key: "banner_3.enabled", section: "banners", label: "Slide 3 — Visible", type: "boolean", value: true, sortOrder: 11 },
  { key: "banner_3.image", section: "banners", label: "Slide 3 — Image", type: "image", value: "", sortOrder: 12 },
  { key: "banner_3.title", section: "banners", label: "Slide 3 — Headline", type: "text", value: "JOIN OUR DISCORD & WIN ITEMS!", sortOrder: 13 },
  { key: "banner_3.cta", section: "banners", label: "Slide 3 — Button", type: "text", value: "JOIN NOW", sortOrder: 14 },
  { key: "banner_3.url", section: "banners", label: "Slide 3 — Link", type: "text", value: "/browse", sortOrder: 15 },
  { key: "seo.title", section: "seo", label: "Site Title", type: "text", value: "RBstars — Premium Roblox Items", sortOrder: 1 },
  { key: "seo.description", section: "seo", label: "Meta Description", type: "text", value: "Buy premium Roblox in-game items with secure checkout and 24/7 support.", sortOrder: 2 },
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

// Public, unauthenticated read of the storefront copy the page loaders and the
// promo banner slider need. Only the `loader` and `banners` sections leave the
// panel API here; nothing else from SiteContent is exposed.
exports.getPublicContent = catchAsync(async (req, res) => {
  await ensureDefaults();

  const items = await SiteContent.find({
    section: { $in: ["loader", "banners"] },
    visible: true,
  }).sort({ section: 1, sortOrder: 1 });

  const get = (key) => items.find((i) => i.key === key)?.value;

  const loader = items
    .filter((i) => i.section === "loader")
    .map((i) => (typeof i.value === "string" ? i.value.trim() : ""))
    .filter(Boolean);

  const banners = [1, 2, 3]
    .map((n) => {
      const str = (key) => {
        const v = get(`banner_${n}.${key}`);
        return typeof v === "string" ? v.trim() : "";
      };
      return {
        enabled: get(`banner_${n}.enabled`) !== false,
        image: str("image"),
        title: str("title"),
        cta: str("cta"),
        url: str("url"),
      };
    })
    // drop a slide only when the owner blanked both its headline and image
    .filter((b) => b.title || b.image);

  res.json({ success: true, data: { loader, banners } });
});
