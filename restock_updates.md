# Smart Tracking & System Improvements

This document explains the high-level concepts for handling restocks and improving the terminal output stability.
y
## Part 1: Smart Restock Tracking
The tracker should be smart enough to only alert you when there is actually an opportunity to buy something. You don't want to be spammed with notifications for items that are already sold out the moment they appear on the store. 

### 1. New Arrivals (In-Stock)
When the tracker scans the store and spots a product it has never seen before, it checks the stock status. If the item is **In Stock**, it will send you an immediate "New Arrival" alert.

### 2. Silent Discovery (Out of Stock)
If the tracker discovers a brand-new item, but the item is already **Out of Stock** (e.g., the store listed it as sold out, or an old sold-out item was just moved into the category), the tracker will silently add the item to its memory. It will **not** send you an email about this discovery.

### 3. Restock Alerts
Because the tracker silently remembers the "Out of Stock" items from step 2 (as well as items that you were alerted about but later sold out), it keeps watching their status. 
If the store later updates the item and it becomes **In Stock**, the tracker recognizes this as a restock event. It will then trigger a notification, giving you a chance to grab the newly replenished item.

### 4. Clearer Notifications
To make it easy to digest your emails at a glance, restocked items will be visually flagged differently than brand-new items. You will see special icons indicating a restock in the subject line, and the item will be clearly labeled as a restock in the email body.

---

## Part 2: Terminal Output Stability

### The Issue
Currently, the tracker uses a carriage return trick for "quiet polling." It tries to continuously overwrite the same line in the terminal to show the current check number without flooding the screen. 
However, because the scraper checks multiple sites simultaneously, if one of those sites encounters an error mid-cycle, the error message is dumped to the screen right in the middle of the polling line. This clobbers the output, resulting in messy, unreadable, and staggered text in your terminal.

### Proposed Solution
To fix this, the quiet polling mechanism needs to be adjusted. Instead of relying on a simple carriage return, the system should either:
1. **Use standard line breaks:** Accept a scrolling log format, printing a fresh line for each successful poll, which inherently prevents asynchronous errors from colliding with the status text.
2. **Implement stream clearing:** When writing the polling status or an error log, the application should hook into the terminal's standard output stream to explicitly clear the current line and reset the cursor position before writing any new information. This ensures that asynchronous errors and polling statuses cleanly take turns displaying on the screen without overlapping.

---

## Part 3: Architecture Vulnerabilities (Ordered by Work Needed)

These known limitations are ordered from the easiest "Quick Wins" to the most complex structural changes.

### 1. No Retry Logic for Network Blips (Lowest Effort)
If a store's server hiccups or briefly drops a connection, the tracker currently logs an error and completely skips that store until the next full cycle.
* **Suggestion:** Add a simple, quick-retry wrapper around the network requests. If a connection fails, wait a fraction of a second and try again before giving up for that cycle.

### 2. Infinite Memory Growth (Low-Medium Effort)
The tracker currently saves every item it ever sees into a single, flat memory file (`seen_products.json`). Because it never deletes old items, this file will grow unboundedly forever, eventually consuming too much memory.
* **Suggestion:** Introduce a simple Time-To-Live (TTL) pruning loop. Before or after a scrape cycle, automatically delete items from the tracking dictionary that haven't been seen or updated in over X months.

### 3. Sequential Polling Bottleneck (Medium Effort)
Right now, the tracker loops through all 9 sites in a single chain. If it takes a few seconds per site, a single site might actually go 90+ seconds between checks.
* **Suggestion:** Refactor the main scraping loop to fetch sites concurrently. Trigger all the checks at once so they process in parallel, drastically reducing latency.

### 4. Sitemap Deduplication Risks (Medium-High Effort)
For stores tracked via their sitemaps, the tracker guesses the product ID by looking at the URL structure. If a store uses an unusual URL format, this guesswork can misfire, leading to duplicate alerts or missed items.
* **Suggestion:** Strengthen the URL-parsing heuristics using more robust pattern matching, or implement a fallback mechanism that fetches the page to grab a definitive, unique product ID.

### 5. Silent Breakages on Custom Scrapers (Highest Effort)
The scrapers for sites that require parsing page structures (like FirstCry and Wix-based stores) are brittle. If the store owners change their website's HTML, the tracker fails to read the page and just logs a silent error, leaving you unaware that tracking has stopped.
* **Suggestion:** Build a separate "Loud Failure" notification system. If a parser fails repeatedly (e.g., 3 times in a row), it should dispatch a special system email alerting you that the scraper for that site is fundamentally broken and requires maintenance.


WHAT WAS DONE:

3.1 — Retry logic (withRetry): Added a generic withRetry(fn, maxAttempts=3, delayMs=500) wrapper. It retries up to 3 times with a 500ms pause between attempts, but skips retrying on definitive HTTP 4xx or rate-limit errors (those won't fix themselves). Every site fetcher in the scrape loop is now wrapped in it.
3.2 — TTL pruning (pruneStaleProducts): Added a TTL_MONTHS = 3 constant and a pruneStaleProducts() function that runs at the start of each cycle. It deletes any entry from seenProducts whose lastSeen is older than 3 months, then saves the file if anything was actually removed. Adjust TTL_MONTHS to taste.
3.3 — Concurrent polling: Replaced the sequential for (const site of SITES) loop with Promise.allSettled(SITES.map(async (site) => ...)). All 9 sites now fire simultaneously. allSettled (not Promise.all) ensures one site's failure doesn't cancel the others. Results are then processed sequentially for the state updates and notifications.
3.4 — Sitemap deduplication: The old approach guessed a product ID from the most descriptive URL slug, which could collide across differently-structured URLs. The new approach uses the full relative pathname (e.g. /product/category/product-name/hash) as the stable id. A URL is unique by definition, so there can never be a duplicate. The human-readable title is still derived from the slug for display purposes.
3.5 — Loud failure notifications: Added a consecutiveFailures counter per site and a LOUD_FAILURE_THRESHOLD = 3. For sites typed as firstcry or wix-ssr (the brittle HTML scrapers), each failure increments the counter. When it hits exactly 3, a formatted system alert email is dispatched warning that the scraper needs maintenance. The counter resets to 0 on any successful scrape.
