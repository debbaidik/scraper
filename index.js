/**
 * Hot Wheels Multi-Site Stock Scraper
 * ====================================
 * Monitors multiple stores (Shopify + Wix) for new die-cast products.
 * - Shopify: Uses Collection Products JSON API with pagination.
 * - Wix: Uses store-products-sitemap.xml to detect new product URLs.
 * Sends email notifications via Gmail and serves a live dashboard.
 */

const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const express = require("express");

// node-notifier is optional — desktop notifications don't work on cloud
let notifier;
try {
  notifier = require("node-notifier");
} catch {
  notifier = null;
}

// ─── Config ──────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    console.log("ℹ  No .env file found — using environment variables from host.");
    return;
  }
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

// ─── Sites Configuration ────────────────────────────────────────────
// type: "shopify" => Shopify Collection Products JSON API (paginated)
// type: "wix-ssr" => Wix SSR warmup data extraction (real-time, with prices/images)
// type: "sitemap" => XML sitemap product URL detection (fallback)
const SITES = [
  {
    type: "shopify",
    name: "Crossword.in",
    shortName: "crossword",
    baseUrl: "https://www.crossword.in",
    collectionApi: "https://www.crossword.in/collections/hotwheels/products.json",
    color: "#00d4ff",
    icon: "📚",
  },
  {
    type: "shopify",
    name: "ToysSam.com",
    shortName: "toyssam",
    baseUrl: "https://www.toyssam.com",
    collectionApi: "https://www.toyssam.com/collections/hotwheels/products.json",
    color: "#ff8800",
    icon: "🧸",
  },
  {
    type: "wix-ssr",
    name: "TinyMetalWheels.in",
    shortName: "tmw",
    baseUrl: "https://www.tinymetalwheels.in",
    shopPageUrl: "https://www.tinymetalwheels.in/shop-all?sort=newest",
    wixAppId: "1380b703-ce81-ff05-f115-39571d94dfcd",
    color: "#ff3366",
    icon: "🏎️",
  },
  {
    type: "sitemap",
    name: "KarzAndDolls.com",
    shortName: "karzanddolls",
    baseUrl: "https://www.karzanddolls.com",
    sitemapUrl: "https://www.karzanddolls.com/sitemap.xml",
    productPathMatch: "/product/",
    color: "#aa44ff",
    icon: "🚗",
  },
  {
    type: "ogmini-api",
    name: "OGMini.com",
    shortName: "ogmini",
    baseUrl: "https://ogmini.com",
    apiUrl: "https://ogmini.com/api/products",
    color: "#ff2a2a",
    icon: "🎯",
  },
  {
    type: "woo-api",
    name: "TooneyWheels",
    shortName: "tooneywheels",
    baseUrl: "https://tooneywheels.in",
    apiUrl: "https://tooneywheels.in/wp-json/wc/store/products?category=86&per_page=100",
    color: "#ffc107",
    icon: "🛵",
  },
  {
    type: "shopify",
    name: "ToyMarche.com",
    shortName: "toymarche",
    baseUrl: "https://www.toymarche.com",
    collectionApi: "https://www.toymarche.com/collections/cars/products.json",
    color: "#e84393",
    icon: "🧩",
  },
  {
    type: "shopify",
    name: "Toycra.com",
    shortName: "toycra",
    baseUrl: "https://toycra.com",
    collectionApi: "https://toycra.com/collections/category-vehicles/products.json",
    vendorFilter: "Hot Wheels",
    color: "#00b894",
    icon: "🎲",
  },
  {
    type: "firstcry",
    name: "FirstCry.com",
    shortName: "firstcry",
    baseUrl: "https://www.firstcry.com",
    listingUrl: "https://www.firstcry.com/hotwheels/5/0/113?sort=Newest",
    color: "#ff6f00",
    icon: "🍼",
  },
];

const CONFIG = {
  gmailUser: process.env.GMAIL_USER,
  gmailPass: process.env.GMAIL_APP_PASSWORD,
  notifyEmail: process.env.NOTIFY_EMAIL,
  interval: (parseInt(process.env.SCRAPE_INTERVAL, 10) || 10) * 1000,
  port: parseInt(process.env.PORT, 10) || 3000,
  dataDir: path.join(__dirname, "data"),
};

// ─── Persistence ─────────────────────────────────────────────────────
if (!fs.existsSync(CONFIG.dataDir)) fs.mkdirSync(CONFIG.dataDir, { recursive: true });

const SEEN_FILE = path.join(CONFIG.dataDir, "seen_products.json");
const LOG_FILE = path.join(CONFIG.dataDir, "scrape_log.json");

function loadJSON(filepath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return fallback;
  }
}

function saveJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

let seenProducts = loadJSON(SEEN_FILE, {});
let scrapeLog = loadJSON(LOG_FILE, []);

// ─── Email Transport ─────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: CONFIG.gmailUser,
    pass: CONFIG.gmailPass,
  },
});

async function sendEmail(subject, htmlBody) {
  try {
    await transporter.sendMail({
      from: `"🏎️ Hot Wheels Tracker" <${CONFIG.gmailUser}>`,
      to: CONFIG.notifyEmail,
      subject,
      html: htmlBody,
    });
    console.log("📧 Email sent successfully!");
    return true;
  } catch (err) {
    console.error("❌ Email failed:", err.message);
    return false;
  }
}

// ─── Scraping ────────────────────────────────────────────────────────
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Fetches a URL and returns raw text.
 * Handles gzip/deflate compression and 3xx redirects.
 */
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate" },
          timeout: 10000 // 10 second timeout
        },
        (res) => {
          // Follow redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return fetchText(res.headers.location).then(resolve, reject);
          }

          // Decompress if needed
          let stream = res;
          const encoding = (res.headers["content-encoding"] || "").toLowerCase();
          if (encoding === "gzip") {
            stream = res.pipe(zlib.createGunzip());
          } else if (encoding === "deflate") {
            stream = res.pipe(zlib.createInflate());
          }

          let data = "";
          stream.on("data", (chunk) => (data += chunk));
          stream.on("end", () => {
            if (res.statusCode === 429) return reject(new Error("Rate limited (429) — will retry next cycle"));
            if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
            resolve(data);
          });
          stream.on("error", reject);
        }
      );
      
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out after 10s"));
    });
    req.on("error", reject);
  });
}

/**
 * Fetches a URL and returns parsed JSON.
 */
function fetchJSON(url) {
  return fetchText(url).then((data) => {
    try {
      return JSON.parse(data);
    } catch (e) {
      throw new Error("Failed to parse JSON: " + e.message);
    }
  });
}

/**
 * Fetches ALL products from a Shopify collection, handling pagination.
 * Shopify collections return max 250 products per page.
 */
async function fetchAllCollectionProducts(collectionApiUrl) {
  const allProducts = [];
  let page = 1;

  while (true) {
    const url = `${collectionApiUrl}?limit=250&page=${page}`;
    const data = await fetchJSON(url);

    if (!data.products || data.products.length === 0) break;

    allProducts.push(...data.products);

    // If we got fewer than 250, we've reached the last page
    if (data.products.length < 250) break;
    page++;
  }

  return allProducts;
}

/**
 * Normalizes a Shopify collection product into a consistent format.
 */
function normalizeProduct(product) {
  const firstVariant = product.variants?.[0];
  const image = product.images?.[0]?.src || product.image?.src || "";
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    price: firstVariant?.price || "0.00",
    compare_at_price: firstVariant?.compare_at_price || null,
    available: product.variants?.some((v) => v.available) ?? false,
    image: image,
    url: `/products/${product.handle}`,
    vendor: product.vendor,
    product_type: product.product_type,
    created_at: product.created_at,
    updated_at: product.updated_at,
  };
}

/**
 * Fetches product URLs from any site's XML sitemap.
 * @param {string} sitemapUrl  - Full URL to the sitemap XML
 * @param {string} pathMatch   - Path substring to identify product URLs (e.g. "/product-page/" or "/product/")
 * Returns normalized product objects derived from the URL slugs.
 */
async function fetchSitemapProducts(sitemapUrl, pathMatch) {
  const xml = await fetchText(sitemapUrl);
  const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);

  return urls
    .filter((u) => u.includes(pathMatch))
    .map((u) => {
      const afterMatch = u.split(pathMatch)[1] || "";
      // Extract the readable slug: find the product-name segment
      // e.g. "/product/special-stocks/mazda-rx-7-falken/abc123hash" -> "mazda-rx-7-falken"
      // e.g. "/product-page/hot-wheels-premium-car" -> "hot-wheels-premium-car"
      const segments = afterMatch.split("/").filter(Boolean);
      // Pick the longest hyphenated segment under 100 chars (the product name),
      // skip short category names and long hashes
      const nameSegment =
        [...segments]
          .filter((s) => s.includes("-") && s.length < 100)
          .sort((a, b) => b.length - a.length)[0] ||
        segments[0] ||
        afterMatch;
      const slug = nameSegment;
      const title = slug
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      // Use the full path after the domain as the relative URL
      const relUrl = new URL(u).pathname;
      return {
        id: slug,
        title: title,
        handle: slug,
        price: "—",
        available: true,
        image: "",
        url: relUrl,
      };
    });
}

/**
 * Fetches products from the OGMini custom API.
 * The API returns a JSON object with a "products" array containing rich product data.
 */
async function fetchOGMiniProducts(apiUrl) {
  const data = await fetchJSON(apiUrl);

  if (!data.products || data.products.length === 0) {
    throw new Error("No products found in OGMini API response");
  }

  return data.products
    .filter((p) => p.is_active)
    .map((p) => {
      const imageUrl = p.images?.[0] || "";
      const slug = p.sku || p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      return {
        id: p.id,
        title: p.name,
        handle: slug,
        price: String(p.price || "0"),
        compare_at_price: p.compare_at_price ? String(p.compare_at_price) : null,
        available: (p.inventory_count || 0) > 0,
        image: imageUrl,
        url: `/product/${slug}`,
        vendor: p.brand || "",
        product_type: p.category || "",
        scale: p.scale || "",
      };
    });
}

/**
 * Fetches products from WooCommerce Store API.
 */
async function fetchWooProducts(apiUrl) {
  const products = await fetchJSON(apiUrl);
  if (!Array.isArray(products)) {
    throw new Error("WooCommerce API did not return an array");
  }

  return products.map((p) => {
    const imageUrl = p.images?.[0]?.src || "";
    const minorUnit = p.prices?.currency_minor_unit || 0;
    const priceRaw = p.prices?.price || "0";
    const priceStr = minorUnit > 0
      ? (parseInt(priceRaw, 10) / Math.pow(10, minorUnit)).toString()
      : priceRaw;
    
    const compareRaw = p.prices?.regular_price || "0";
    const compareStr = minorUnit > 0
      ? (parseInt(compareRaw, 10) / Math.pow(10, minorUnit)).toString()
      : compareRaw;

    // Decode simple HTML entities from title
    const title = p.name.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec)).replace(/&#x([0-9a-f]+);/ig, (match, hex) => String.fromCharCode(parseInt(hex, 16)));

    return {
      id: p.id.toString(),
      title: title,
      handle: p.slug,
      price: priceStr,
      compare_at_price: compareStr !== priceStr ? compareStr : null,
      available: p.is_in_stock,
      image: imageUrl,
      url: `/product/${p.slug}/`,
    };
  });
}

/**
 * Fetches products from a Wix store by extracting SSR warmup data.
 * This is the data embedded in the page HTML when the server renders the shop page.
 * It provides real-time product data with stable UUIDs, prices, images, and stock.
 * @param {string} shopPageUrl - Full URL to the shop page (e.g. with ?sort=newest)
 * @param {string} wixAppId   - The Wix Stores app ID (found in warmup data keys)
 */
async function fetchWixSSRProducts(shopPageUrl, wixAppId) {
  const html = await fetchText(shopPageUrl);

  // Extract the wix-warmup-data JSON blob from the SSR page
  const warmupMatch = html.match(/id="wix-warmup-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!warmupMatch) {
    throw new Error("No wix-warmup-data found in SSR page");
  }

  const warmupData = JSON.parse(warmupMatch[1]);
  const appData = warmupData.appsWarmupData?.[wixAppId];
  if (!appData) {
    throw new Error(`No Wix store app data found for app ID: ${wixAppId}`);
  }

  // Find the data key that contains product data (matches the sort parameter)
  const dataKey = Object.keys(appData).find(
    (k) => k.includes("initialData") || k.includes("sort=")
  );
  if (!dataKey) {
    throw new Error("No product data key found in Wix warmup data");
  }

  const productList = appData[dataKey]?.catalog?.category?.productsWithMetaData?.list;
  if (!productList || productList.length === 0) {
    throw new Error("No products found in Wix warmup data");
  }

  return productList.map((p) => {
    const imageUrl = p.media?.[0]?.fullUrl || "";
    return {
      id: p.id, // Stable UUID — no unicode encoding issues
      title: p.name,
      handle: p.urlPart || p.id,
      price: p.formattedComparePrice || p.formattedPrice || String(p.price) || "0",
      compare_at_price: p.formattedPrice !== p.formattedComparePrice ? p.formattedPrice : null,
      available: p.isInStock ?? p.inventory?.status === "in_stock",
      image: imageUrl,
      url: `/product-page/${p.urlPart || p.id}`,
    };
  });
}

/**
 * Fetches products from FirstCry.com by scraping server-rendered HTML.
 * FirstCry uses a custom platform — product cards are embedded in the HTML
 * with class="li_inner_block listingpg-{PID}" and aria-label for titles.
 * @param {string} listingUrl - Full URL to the brand/category listing page
 */
async function fetchFirstCryProducts(listingUrl) {
  const html = await fetchText(listingUrl);

  // Extract product cards: class="li_inner_block listingpg-{PID}" aria-label="{title}"
  const cards = [...html.matchAll(
    /class="li_inner_block\s+listingpg-(\d+)"[^>]*aria-label="([^"]+)"/g
  )];

  // Deduplicate by PID
  const seenPids = new Set();
  const products = [];

  for (const card of cards) {
    const pid = card[1];
    const title = card[2];
    if (seenPids.has(pid)) continue;
    seenPids.add(pid);

    // Find the product URL for this PID
    const urlMatch = html.match(new RegExp(`href=['"]([^'"]*/${pid}/product-detail)['"]`));
    const relUrl = urlMatch ? urlMatch[1].replace(/^\/\/www\.firstcry\.com/, "") : `/product-detail`;

    // Find stock status: the parent div has data-outstock="true" or "false"
    const stockMatch = html.match(new RegExp(
      `data-outstock="(\w+)"[^>]*>[\s\S]*?listingpg-${pid}"`
    ));
    const isOutOfStock = stockMatch ? stockMatch[1] === "true" : false;

    // Image URL follows a predictable pattern
    const image = `https://cdn.fcglcdn.com/brainbees/images/products/438x531/${pid}a.webp`;

    products.push({
      id: pid,
      title: title,
      handle: pid,
      price: "—", // Prices are loaded via JS on FirstCry, not in SSR HTML
      available: !isOutOfStock,
      image: image,
      url: relUrl,
    });
  }

  return products;
}

function buildEmailHTML(newProducts) {
  // Group products by site
  const grouped = {};
  for (const p of newProducts) {
    if (!grouped[p._siteName]) grouped[p._siteName] = [];
    grouped[p._siteName].push(p);
  }

  let siteSections = "";
  for (const [siteName, products] of Object.entries(grouped)) {
    const site = SITES.find((s) => s.name === siteName) || { color: "#00d4ff", icon: "🛒" };
    const rows = products
      .map(
        (p) => `
      <tr>
        <td style="padding:12px; border-bottom:1px solid #2a2a3e;">
          <img src="${p.image}" alt="${p.title}" style="width:80px; height:80px; object-fit:contain; border-radius:8px; background:#1a1a2e;" />
        </td>
        <td style="padding:12px; border-bottom:1px solid #2a2a3e;">
          <a href="${p._fullUrl}" style="color:${site.color}; text-decoration:none; font-weight:600;">${p.title}</a>
          <br/>
          <span style="color:#888; font-size:12px;">${p.available ? "✅ In Stock" : "❌ Out of Stock"}</span>
        </td>
        <td style="padding:12px; border-bottom:1px solid #2a2a3e; color:#00ff88; font-weight:700; font-size:18px; white-space:nowrap;">
          ₹${p.price}
        </td>
      </tr>`
      )
      .join("");

    siteSections += `
      <div style="margin:16px 0 8px; padding:10px 16px; background:${site.color}11; border-left:3px solid ${site.color}; border-radius:0 8px 8px 0;">
        <span style="font-size:14px; font-weight:700; color:${site.color};">${site.icon} ${siteName}</span>
        <span style="color:#888; font-size:12px; margin-left:8px;">${products.length} new</span>
      </div>
      <table style="width:100%; border-collapse:collapse;">
        <tbody>${rows}</tbody>
      </table>`;
  }

  return `
    <div style="font-family:'Segoe UI',Arial,sans-serif; background:#0a0a1a; color:#e0e0e0; padding:24px; border-radius:12px; max-width:700px; margin:auto;">
      <div style="text-align:center; padding:16px 0; border-bottom:2px solid #00d4ff;">
        <h1 style="margin:0; color:#00d4ff; font-size:24px;">🏎️ New Hot Wheels Found!</h1>
        <p style="margin:4px 0 0; color:#888; font-size:14px;">${newProducts.length} new product${newProducts.length > 1 ? "s" : ""} across ${Object.keys(grouped).length} store${Object.keys(grouped).length > 1 ? "s" : ""}</p>
      </div>
      ${siteSections}
      <p style="text-align:center; color:#555; font-size:11px; margin-top:16px;">Sent by Hot Wheels Tracker • ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</p>
    </div>`;
}

// ─── State for Dashboard ─────────────────────────────────────────────
let dashboardState = {
  status: "starting",
  lastCheck: null,
  totalChecks: 0,
  totalProducts: 0,
  newProductsFound: 0,
  emailsSent: 0,
  emailsFailed: 0,
  recentProducts: [],
  errors: [],
  uptime: Date.now(),
  siteStats: {},
};

// Initialize per-site stats
for (const site of SITES) {
  dashboardState.siteStats[site.shortName] = {
    name: site.name,
    icon: site.icon,
    color: site.color,
    totalProducts: 0,
    newFound: 0,
    lastCheck: null,
    lastError: null,
  };
}

// ─── Scrape Loop ─────────────────────────────────────────────────────
async function scrape() {
  dashboardState.status = "scraping";
  const timestamp = new Date().toISOString();
  let allNewProducts = [];

  for (const site of SITES) {
    try {
      let products;
      if (site.type === "ogmini-api") {
        products = await fetchOGMiniProducts(site.apiUrl);
      } else if (site.type === "woo-api") {
        products = await fetchWooProducts(site.apiUrl);
      } else if (site.type === "wix-ssr") {
        products = await fetchWixSSRProducts(site.shopPageUrl, site.wixAppId);
      } else if (site.type === "sitemap") {
        products = await fetchSitemapProducts(site.sitemapUrl, site.productPathMatch);
      } else if (site.type === "firstcry") {
        products = await fetchFirstCryProducts(site.listingUrl);
      } else {
        // Default: Shopify
        const rawProducts = await fetchAllCollectionProducts(site.collectionApi);
        products = rawProducts.map(normalizeProduct);
      }

      // Optional: filter by vendor (Shopify JSON API doesn't support server-side vendor filtering)
      if (site.vendorFilter) {
        products = products.filter((p) => p.vendor && p.vendor.toLowerCase() === site.vendorFilter.toLowerCase());
      }

      const stats = dashboardState.siteStats[site.shortName];
      stats.totalProducts = products.length;
      stats.lastCheck = timestamp;
      stats.lastError = null;

      const newProducts = products.filter((p) => {
        const key = `${site.shortName}:${p.id}`;
        if (seenProducts[key]) return false;
        seenProducts[key] = {
          site: site.name,
          siteShort: site.shortName,
          title: p.title,
          price: p.price,
          available: p.available,
          image: p.image,
          url: p.url,
          firstSeen: timestamp,
        };
        return true;
      });

      if (newProducts.length > 0) {
        stats.newFound += newProducts.length;
        const enriched = newProducts.map((p) => ({
          ...p,
          _siteName: site.name,
          _siteShort: site.shortName,
          _siteColor: site.color,
          _siteIcon: site.icon,
          _fullUrl: `${site.baseUrl}${p.url}`,
        }));
        allNewProducts.push(...enriched);

        console.log(`\n🆕 ${site.icon} ${site.name}: ${newProducts.length} NEW product(s)!`);
        newProducts.forEach((p) => {
          console.log(`   🏎️  ${p.title} — ₹${p.price} (${p.available ? "In Stock" : "Out of Stock"})`);
        });
      }
    } catch (err) {
      const stats = dashboardState.siteStats[site.shortName];
      stats.lastError = err.message;
      dashboardState.errors.push({ timestamp, site: site.name, message: err.message });
      if (dashboardState.errors.length > 20) dashboardState.errors = dashboardState.errors.slice(-20);
      console.error(`\n❌ ${site.icon} ${site.name} error: ${err.message}`);
    }
  }

  dashboardState.totalChecks++;
  dashboardState.lastCheck = timestamp;
  dashboardState.totalProducts = SITES.reduce(
    (sum, s) => sum + (dashboardState.siteStats[s.shortName]?.totalProducts || 0),
    0
  );

  if (allNewProducts.length > 0) {
    dashboardState.newProductsFound += allNewProducts.length;
    dashboardState.recentProducts = [
      ...allNewProducts.map((p) => ({
        title: p.title,
        price: p.price,
        available: p.available,
        image: p.image,
        url: p._fullUrl,
        site: p._siteName,
        siteShort: p._siteShort,
        siteColor: p._siteColor,
        siteIcon: p._siteIcon,
        foundAt: timestamp,
      })),
      ...dashboardState.recentProducts,
    ].slice(0, 100);

    saveJSON(SEEN_FILE, seenProducts);

    const firstProduct = allNewProducts[0];
    const subject = allNewProducts.length === 1 
      ? `🏎️ [${firstProduct._siteName}] ${firstProduct.title}`
      : `🏎️ [${firstProduct._siteName}] ${firstProduct.title} (+ ${allNewProducts.length - 1} more)`;

    // Send email
    const html = buildEmailHTML(allNewProducts);
    const sent = await sendEmail(subject, html);
    if (sent) {
      dashboardState.emailsSent++;
    } else {
      dashboardState.emailsFailed++;
    }

    // Send Desktop Notification (only if running locally)
    if (notifier) {
      notifier.notify({
        title: "New Hot Wheels Found!",
        message: subject.replace("🏎️ ", ""),
        sound: true,
        wait: true
      });
    }

    // Log
    scrapeLog.push({
      timestamp,
      newCount: allNewProducts.length,
      products: allNewProducts.map((p) => ({ title: p.title, price: p.price, site: p._siteName })),
    });
    if (scrapeLog.length > 500) scrapeLog = scrapeLog.slice(-500);
    saveJSON(LOG_FILE, scrapeLog);
  } else {
    const siteSummary = SITES.map(
      (s) => `${s.icon}${dashboardState.siteStats[s.shortName]?.totalProducts || 0}`
    ).join(" ");
    process.stdout.write(
      `\r🔍 Check #${dashboardState.totalChecks} — ${siteSummary} — no new items — ${new Date().toLocaleTimeString("en-IN")}`
    );
  }

  dashboardState.status = "watching";
}

// ─── Express Dashboard ───────────────────────────────────────────────
const app = express();

app.get("/api/status", (req, res) => {
  res.json({
    ...dashboardState,
    uptimeSeconds: Math.floor((Date.now() - dashboardState.uptime) / 1000),
    seenCount: Object.keys(seenProducts).length,
    intervalMs: CONFIG.interval,
    sites: SITES.map((s) => ({
      name: s.name,
      shortName: s.shortName,
      icon: s.icon,
      color: s.color,
      baseUrl: s.baseUrl,
      ...dashboardState.siteStats[s.shortName],
    })),
  });
});

app.get("/api/products", (req, res) => {
  res.json(dashboardState.recentProducts);
});

app.get("/api/log", (req, res) => {
  res.json(scrapeLog.slice(-50).reverse());
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// ─── Start ───────────────────────────────────────────────────────────
const siteList = SITES.map((s) => `${s.icon} ${s.name}`).join(", ");
app.listen(CONFIG.port, "0.0.0.0", async () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║       🏎️  Hot Wheels Multi-Site Stock Tracker            ║
╠═══════════════════════════════════════════════════════════╣
║  Sites:      ${siteList.padEnd(42)}║
║  Dashboard:  http://localhost:${String(CONFIG.port).padEnd(28)}║
║  Interval:   Every ${String(CONFIG.interval / 1000).padEnd(37)}s║
║  Notify:     ${CONFIG.notifyEmail.padEnd(42)}║
║  API:        Shopify Collection Products JSON            ║
╚═══════════════════════════════════════════════════════════╝
  `);

  // First scrape immediately
  await scrape();

  // Then on interval
  setInterval(scrape, CONFIG.interval);
});
