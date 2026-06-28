const https = require("https");

function fetch(url) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", (e) => resolve(""));
  });
}

async function main() {
  // Get main sitemap
  const mainSm = await fetch("https://www.karzanddolls.com/sitemap.xml");
  const sitemapUrls = [...mainSm.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);

  // Check for sub-sitemaps
  const subSitemaps = sitemapUrls.filter(u => u.endsWith(".xml"));
  console.log("Sub-sitemaps:", subSitemaps);

  // Check all URLs for product patterns
  const productUrls = sitemapUrls.filter(u => u.includes("/products/") || u.includes("/product/"));
  console.log("\nProduct URLs in main sitemap:", productUrls.length);
  productUrls.slice(0, 5).forEach(u => console.log("  " + u));

  // All URLs
  console.log("\nAll URL patterns:");
  const patterns = {};
  for (const u of sitemapUrls) {
    const path = new URL(u).pathname.split("/").filter(Boolean)[0] || "root";
    patterns[path] = (patterns[path] || 0) + 1;
  }
  Object.entries(patterns).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`  /${k}: ${v}`));

  // If sub-sitemaps exist, fetch them
  for (const sm of subSitemaps) {
    console.log("\n=== Sub-sitemap:", sm, "===");
    const data = await fetch(sm);
    const urls = [...data.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
    console.log("  URLs:", urls.length);
    urls.slice(0, 5).forEach(u => console.log("    " + u));
  }
}

main();
