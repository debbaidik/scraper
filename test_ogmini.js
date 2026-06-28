const https = require("https");
const http = require("http");
const zlib = require("zlib");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function trace(url, depth = 0) {
  console.log(`${"  ".repeat(depth)}[${depth}] Fetching: ${url}`);
  const parsed = new URL(url);
  const mod = parsed.protocol === "https:" ? https : http;
  
  mod.get(
    { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { "User-Agent": UA, "Accept": "application/json" } },
    (res) => {
      console.log(`${"  ".repeat(depth)}    Status: ${res.statusCode}`);
      if (res.headers.location) {
        console.log(`${"  ".repeat(depth)}    Location: ${res.headers.location}`);
        if (depth < 5) trace(res.headers.location, depth + 1);
      } else {
        // Read body
        let data = "";
        let stream = res;
        const enc = (res.headers["content-encoding"] || "").toLowerCase();
        if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        
        stream.on("data", (chunk) => (data += chunk));
        stream.on("end", () => {
          console.log(`${"  ".repeat(depth)}    Content-Type: ${res.headers["content-type"]}`);
          console.log(`${"  ".repeat(depth)}    Body length: ${data.length}`);
          try {
            const json = JSON.parse(data);
            console.log(`${"  ".repeat(depth)}    Products count: ${json.products?.length}`);
          } catch(e) {
            console.log(`${"  ".repeat(depth)}    Parse error: ${e.message}`);
            console.log(`${"  ".repeat(depth)}    Preview: ${data.substring(0, 200)}`);
          }
        });
      }
    }
  ).on("error", (e) => console.error(`${"  ".repeat(depth)}    Error: ${e.message}`));
}

trace("https://www.ogmini.com/api/products");
