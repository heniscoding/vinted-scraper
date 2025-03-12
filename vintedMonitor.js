const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const axios = require("axios");
const fs = require("fs");

puppeteer.use(StealthPlugin());

// ✅ File to store seen listings (prevents duplicates across restarts)
const seenListingsFile = "seen_listings.json";
const seenListings = new Set(fs.existsSync(seenListingsFile) ? JSON.parse(fs.readFileSync(seenListingsFile)) : []);

// ✅ Search Configurations
const searchConfigs = [
    { query: "nike", webhook: "https://discord.com/api/webhooks/1347347129135398912/Bk7dc9aKV7FBlfPZdPmg_0Z12GHr1BmCKJmvw7nyT_5uRFb5KZl1hz2JSPjTp32a42uE" },
    { query: "stussy", webhook: "https://discord.com/api/webhooks/1347416356307337297/R4cii2_Z5zTFaU198_FL5G9owsVSke4587oNfKfpzGUoJgZ5uD-Qhsi5U9ns91wq3vSC" },
    { query: "corteiz", webhook: "https://discord.com/api/webhooks/1347416431326920824/l6GIliRj-7zb4DYVTqJM4KmC4SygUEM4t3SuFULtZgJ3Rju5C4Z95U0AB7Y1vOy94ZPO" },
    { query: "supreme", webhook: "https://discord.com/api/webhooks/1347416510972297349/AFdpM8ohIlrT2ZpzSggrCPXyyH6NsjHHcZOa6inhkgCrkdf_pkqEU9jiwU1E43P7ItVn" },
    { query: "palace", webhook: "https://discord.com/api/webhooks/1347416567599730749/-DnUoxWzeqmObRPjLVL0W2xbDoznRoI786S7t0RtTjMog0bxTDh9NtB6wFD1ChwW-VKz" },
    { query: "napapijri", webhook: "https://discord.com/api/webhooks/1349142597351899226/3AP7KdQ702wm6N0k-2imCmbl7nGRHZ3Ln_6AeBLgrBVCBqI0ixpAGjZXOQD1bM-nTs8E" },
];

// ❌ Keywords to Exclude
const excludeKeywords = ["fake", "damaged", "replica", "creased", "worn out", "unauthentic"];

// 💰 Price Filtering
const maxPrice = 100;

// 👟 Shoe Size Filtering
const minSize = 3;
const maxSize = 12;

// ✅ Allowed Conditions
const allowedConditions = ["New with tags", "New without tags", "Very good"];

// ✅ Normalize URL to Remove Tracking Parameters
function normalizeUrl(url) {
    return url.split("?")[0]; // Removes extra URL parameters
}

// ✅ Scrape Vinted Listings
async function scrapeVintedWithPuppeteer(searchQuery, webhookUrl) {
    const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.110 Safari/537.36");

    // ✅ Block Images & CSS for Faster Loading
    await page.setRequestInterception(true);
    page.on("request", (req) => {
        if (["stylesheet", "font"].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    const url = `https://www.vinted.co.uk/catalog?search_text=${encodeURIComponent(searchQuery)}&order=newest_first&page=1`;
    console.log(`🔍 Fetching: ${searchQuery} -> ${url}`);

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".feed-grid__item", { timeout: 8000 });

    let items = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(".feed-grid__item")).map(item => ({
            link: item.querySelector("[data-testid*='overlay-link']")?.href || "#",
            imageUrl: item.querySelector("img.web_ui__Image__content")?.src || "https://via.placeholder.com/150"
        }));
    });

    console.log(`✅ Found ${items.length} items for "${searchQuery}".`);
    await processListingsConcurrently(browser, items, webhookUrl);
    await browser.close();
}

// ✅ Process Listings & Avoid Duplicates
async function processListingsConcurrently(browser, items, webhookUrl) {
    let processing = [];

    for (let item of items) {
        const normalizedUrl = normalizeUrl(item.link);

        // ✅ Skip duplicate listings
        if (seenListings.has(normalizedUrl)) {
            console.log(`🔁 Duplicate detected, skipping: ${normalizedUrl}`);
            continue;
        }
        seenListings.add(normalizedUrl); // Mark as seen

        let page = await browser.newPage();
        await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));

        processing.push(
            (async () => {
                try {
                    await page.goto(item.link, { waitUntil: "domcontentloaded" });

                    let details = await page.evaluate(() => {
                        const userRatingElement = document.querySelector(".web_ui__Rating__rating");
                        let userRating = null;

                        if (userRatingElement) {
                            const ratingText = userRatingElement.getAttribute("aria-label");
                            const ratingMatch = ratingText ? ratingText.match(/(\d+(\.\d+)?)/) : null;
                            userRating = ratingMatch ? parseFloat(ratingMatch[0]) : null;
                        }

                        return {
                            title: document.querySelector(".summary-max-lines-4 .web_ui__Text__text.web_ui__Text__title.web_ui__Text__left")?.innerText.trim() || "No Title",
                            price: document.querySelector("[data-testid='item-price'] p")?.innerText.trim() || "No Price",
                            size: document.querySelector("[data-testid='item-attributes-size'] .web_ui__Text__bold")?.innerText.trim() || "Unknown",
                            condition: document.querySelector("[data-testid='item-attributes-status'] .web_ui__Text__bold")?.innerText.trim() || "Unknown",
                            imageUrl: document.querySelector("[data-testid='item-photo-1--img']")?.src || "https://via.placeholder.com/150",
                            postedDate: document.querySelector("[data-testid='item-attributes-upload_date'] .web_ui__Text__bold")?.innerText.trim() || "Unknown",
                            userRating: userRating || "No Rating",
                            priceDrop: document.querySelector(".web_ui__Text__color-destructive")?.innerText.trim() || null,
                            isNegotiable: !!document.querySelector("[data-testid='item-negotiable']")
                        };
                    });

                    console.log(`✅ Extracted: ${details.title} - ${details.price} - User Rating: ${details.userRating}`);
                    await sendDiscordMessage(webhookUrl, details, item.link);

                    // ✅ Save seen listings to file
                    fs.writeFileSync(seenListingsFile, JSON.stringify([...seenListings]));
                } catch (error) {
                    console.log(`❌ Error extracting details for ${item.link}`, error);
                } finally {
                    await page.close();
                }
            })()
        );
    }

    await Promise.all(processing);
}

// ✅ Send Message to Discord
async function sendDiscordMessage(webhookUrl, details, link) {
    if (!details.title || !details.price || !details.size || !details.condition || !link) {
        console.log("⚠️ Skipping item due to missing details.");
        return;
    }

    if (excludeKeywords.some(keyword => details.title.toLowerCase().includes(keyword.toLowerCase()))) {
        console.log(`🚫 Skipping '${details.title}' - Blacklisted word.`);
        return;
    }

    const priceMatch = details.price.match(/(\d+(\.\d+)?)/);
    const itemPrice = priceMatch ? parseFloat(priceMatch[0]) : null;

    if (!itemPrice || itemPrice > maxPrice) {
        console.log(`💰 Skipping '${details.title}' - Price too high.`);
        return;
    }

    if (!allowedConditions.includes(details.condition)) {
        console.log(`🏷 Skipping '${details.title}' - Unacceptable condition.`);
        return;
    }

    if (details.userRating !== "No Rating" && details.userRating < 4.0) {
        console.log(`🚫 Skipping '${details.title}' - Low seller rating (${details.userRating}).`);
        return;
    }

    const embed = {
        title: details.title,
        url: link,
        description: `💰 **Price:** ${details.price}\n👟 **Size:** UK ${details.size}\n🏷 **Condition:** ${details.condition}\n📅 **Uploaded:** ${details.postedDate}\n⭐ **User Rating:** ${details.userRating}`,
        color: 3447003,
        image: { url: details.imageUrl },
        footer: { text: "Vinted Monitor Bot" }
    };

    await axios.post(webhookUrl, { embeds: [embed] });
    console.log(`✅ Sent to Discord: ${details.title}`);
}

// ✅ Run Scraper
async function runScraper() {
    for (const config of searchConfigs) {
        await scrapeVintedWithPuppeteer(config.query, config.webhook);
        await new Promise(resolve => setTimeout(resolve, 10000));
    }
}

runScraper();
