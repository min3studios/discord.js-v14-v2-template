# Polymarket Bot Integration Plan

## 1. Trade Prediction Signals (Manual)
**Goal:** Allow signal givers to easily share trade signals by pasting a Polymarket URL and a direction.

### Implementation Steps
- [ ] **Command/Format Definition**
    - **Input Format:** `<Polymarket URL> <Direction>`
    - **Example:** `https://polymarket.com/event/will-btc-hit-100k Buy Yes`
    - **Parsing:** Extract the slug from the URL (segment after `/event/`).

- [ ] **Market Data Fetching**
    - Use Polymarket Gamma API to fetch market details using the extracted slug.
    - **Docs:** 
        - [Get Market by Slug](https://docs.polymarket.com/api-reference/markets/get-market-by-slug)
        - [Fetching Markets](https://docs.polymarket.com/market-data/fetching-markets)
    - **Endpoint:** `GET https://gamma-api.polymarket.com/events?slug={slug}`

- [ ] **Embed Generation**
    - Create a formatted embed displaying:
        - Event Title & Image
        - Current Probability/Price
        - **Signal Direction** (e.g., "BET YES")
        - Interactive "Copy Trade" Button

---

## 2. Automated Feeds (Top Traders, Whales, Insiders)
**Goal:** Automatically post signals from high-performing traders or identify large market movements. We have two approaches:

### Option A: PolyAlertHub (Paid Service)
*Easier implementation using pre-built signals.*
- [ ] **Integration**
    - Service: [PolyAlertHub Plans](https://polyalerthub.com/plans) ($100/month).
    - **API Docs:** [PolyAlertHub System API](https://polyalerthub.com/api-docs#tag/system).
    - **Workflow:** Poll their API for new alerts and forward them to the Discord channel.

### Option B: Custom Implementation (Polymarket Data)
*Harder implementation. Requires building custom tracking infrastructure.*
- [ ] **Leaderboard Scanning**
    - **Docs:** [Get Trader Leaderboard Rankings](https://docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings)
    - **Logic:**
        1. Periodically fetch top traders (Overall, PnL, Volume).
        2. Monitor specific addresses for new transactions.
    
- [ ] **Whale & Insider Filtering**
    - Build logic to differentiate signal types:
        - **Whales:** Filter for transactions > $X amount.
        - **Insiders:** Track wallets with high win rates on early positions.
    - **Challenges:** Requires database state management to avoid duplicate alerts and efficient polling to respect rate limits.

---

## 3. Next Steps
- [ ] Select Option A or B for the feed.
- [ ] Build the `/predict` command to accept the URL+Direction input.
- [ ] Connect the "Copy Trade" button to the backend API.
