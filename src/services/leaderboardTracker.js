const axios = require('axios');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
require('dotenv').config({ quiet: true });

class LeaderboardTracker {
    constructor(client) {
        this.client = client;
        this.topTraders = new Map();
        this.processedTradeIds = new Set();
        this.isScanning = false;

        this.targetGuildId = process.env.TARGET_GUILD_ID;
        this.targetChannelId = process.env.LEADERBOARD_CHANNEL_ID;
        this.leaderboardLimit = parseInt(process.env.LEADERBOARD_ACCOUNT_LIMIT || '50', 10);
        this.threshold = parseFloat(process.env.LEADERBOARD_ALERT_THRESHOLD || '50');
        this.pollIntervalMs = parseInt(process.env.LEADERBOARD_POLL_INTERVAL_MS || '1500', 10);
        this.tradesPerUserLimit = parseInt(process.env.LEADERBOARD_TRADES_PER_USER_LIMIT || '20', 10);
        this.requestedBatchSize = parseInt(process.env.LEADERBOARD_BATCH_SIZE || '12', 10);
        this.dataTradesBudgetPer10s = parseInt(process.env.LEADERBOARD_DATA_TRADES_BUDGET_PER_10S || '140', 10);
        this.alertConcurrency = parseInt(process.env.LEADERBOARD_ALERT_CONCURRENCY || '3', 10);
        this.apiTimeoutMs = parseInt(process.env.POLY_API_TIMEOUT_MS || '9000', 10);
        this.maxRetryAttempts = parseInt(process.env.POLY_API_RETRY_ATTEMPTS || '3', 10);
        this.cacheRefreshMs = parseInt(process.env.LEADERBOARD_CACHE_REFRESH_MS || `${10 * 60 * 1000}`, 10);
        this.leaderboardRefreshMs = parseInt(process.env.LEADERBOARD_REFRESH_MS || `${10 * 60 * 1000}`, 10);
        this.statsLogIntervalMs = parseInt(process.env.LEADERBOARD_STATS_LOG_INTERVAL_MS || '60000', 10);

        this.marketCache = new Map();
        this.userPollIndex = 0;
        this.userErrorStreaks = new Map();
        this.batchSize = this.calculateBatchSize();
        this.stats = {
            polls: 0,
            tradersScanned: 0,
            tradesFetched: 0,
            candidates: 0,
            alertsSent: 0,
            apiErrors: 0
        };

        this.dataApi = axios.create({
            baseURL: 'https://data-api.polymarket.com',
            headers: { 'Content-Type': 'application/json' },
            timeout: this.apiTimeoutMs
        });

        this.gammaApi = axios.create({
            baseURL: 'https://gamma-api.polymarket.com',
            timeout: this.apiTimeoutMs
        });
    }

    calculateBatchSize() {
        const byRate = Math.floor((this.dataTradesBudgetPer10s * this.pollIntervalMs) / 10000);
        const safeByRate = Math.max(1, byRate);
        return Math.max(1, Math.min(this.requestedBatchSize, safeByRate, Math.max(1, this.leaderboardLimit)));
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    isRetryableError(error) {
        const status = error?.response?.status;
        return error?.code === 'ECONNABORTED' || status === 429 || (status >= 500 && status < 600);
    }

    getRetryDelayMs(attempt) {
        const base = 250 * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 150);
        return base + jitter;
    }

    async requestWithRetry(apiClient, requestConfig, label) {
        let attempt = 0;
        while (attempt <= this.maxRetryAttempts) {
            try {
                return await apiClient.request(requestConfig);
            } catch (error) {
                const shouldRetry = attempt < this.maxRetryAttempts && this.isRetryableError(error);
                if (!shouldRetry) {
                    this.stats.apiErrors++;
                    throw error;
                }
                const waitMs = this.getRetryDelayMs(attempt);
                console.warn(`[LeaderboardTracker] Retry ${label} in ${waitMs}ms (${attempt + 1}/${this.maxRetryAttempts})`);
                await this.sleep(waitMs);
                attempt++;
            }
        }
        throw new Error(`[LeaderboardTracker] Unreachable retry branch for ${label}`);
    }

    normalizeTradesResponse(payload) {
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload?.trades)) return payload.trades;
        if (Array.isArray(payload?.items)) return payload.items;
        return [];
    }

    async start() {
        if (this.isScanning) return;
        this.isScanning = true;
        console.log(`[LeaderboardTracker] Starting tracker for top ${this.leaderboardLimit} traders | Poll: ${this.pollIntervalMs}ms | Batch: ${this.batchSize} | Per-user limit: ${this.tradesPerUserLimit}`);

        await this.updateTopMarketsCache();
        await this.updateTopTraders();
        void this.pollTrades();
        setInterval(() => this.updateTopMarketsCache(), this.cacheRefreshMs);
        setInterval(() => this.updateTopTraders(), this.leaderboardRefreshMs);
        setInterval(() => this.logStats(), this.statsLogIntervalMs);
    }

    async pollTrades() {
        if (!this.isScanning) return;
        this.stats.polls++;
        try {
            await this.scanSpecificTraders();
        } catch (error) {
            console.error('[LeaderboardTracker] Error in poll cycle:', error.message);
            this.stats.apiErrors++;
        } finally {
            setTimeout(() => this.pollTrades(), this.pollIntervalMs);
        }
    }

    async updateTopMarketsCache() {
        try {
            console.log('[LeaderboardTracker] Refreshing top market cache...');
            const response = await this.requestWithRetry(this.gammaApi, {
                method: 'get',
                url: '/events',
                params: { limit: 50, active: true, closed: false, order: 'volume', ascending: false }
            }, 'gamma events');

            if (response.data && Array.isArray(response.data)) {
                for (const event of response.data) {
                    if (event.markets && Array.isArray(event.markets)) {
                        for (const market of event.markets) {
                            const metadata = {
                                title: market.question,
                                slug: market.slug,
                                image: market.image || (event.image ? event.image : null),
                                icon: market.icon || (event.icon ? event.icon : null)
                            };
                            if (market.asset_id) this.marketCache.set(market.asset_id, metadata);
                            if (market.clobTokenIds) {
                                try {
                                    const ids = JSON.parse(market.clobTokenIds);
                                    if (Array.isArray(ids)) ids.forEach(id => this.marketCache.set(id, metadata));
                                } catch (e) { /* ignore */ }
                            }
                        }
                    }
                }
            }
            console.log(`[LeaderboardTracker] Cache updated. Known assets: ${this.marketCache.size}`);
        } catch (error) {
            console.error('[LeaderboardTracker] Error updating market cache:', error.message);
        }
    }

    async updateTopTraders() {
        try {
            console.log('[LeaderboardTracker] Refreshing top traders leaderboard...');
            const response = await this.requestWithRetry(this.dataApi, {
                method: 'get',
                url: '/v1/leaderboard',
                params: { category: 'OVERALL', timePeriod: 'DAY', orderBy: 'PNL', limit: this.leaderboardLimit }
            }, 'data leaderboard');

            if (response.data && Array.isArray(response.data)) {
                this.topTraders.clear();
                response.data.forEach(trader => {
                    const info = {
                        rank: trader.rank,
                        pnl: parseFloat(trader.pnl || 0),
                        username: trader.userName || trader.xUsername || 'Unknown',
                        address: trader.proxyWallet || trader.user
                    };
                    if (trader.proxyWallet) this.topTraders.set(trader.proxyWallet.toLowerCase(), info);
                    else if (trader.user) this.topTraders.set(trader.user.toLowerCase(), info);
                });
                console.log(`[LeaderboardTracker] Updated top traders list. Count: ${this.topTraders.size}`);
                this.batchSize = this.calculateBatchSize();
                if (this.userPollIndex >= this.topTraders.size) this.userPollIndex = 0;
            }
        } catch (error) {
            console.error('[LeaderboardTracker] Error fetching leaderboard:', error.message);
            this.stats.apiErrors++;
        }
    }

    async scanSpecificTraders() {
        if (this.topTraders.size === 0) return;

        const traders = Array.from(this.topTraders.values());
        const batchSize = Math.min(this.batchSize, traders.length);
        if (batchSize <= 0) return;
        const batch = [];
        for (let i = 0; i < batchSize; i++) {
            if (this.userPollIndex >= traders.length) this.userPollIndex = 0;
            batch.push(traders[this.userPollIndex]);
            this.userPollIndex++;
        }
        this.stats.tradersScanned += batch.length;

        await Promise.allSettled(batch.map(async (trader) => {
            try {
                const response = await this.requestWithRetry(this.dataApi, {
                    method: 'get',
                    url: '/trades',
                    params: {
                        user: trader.address,
                        limit: this.tradesPerUserLimit,
                        takerOnly: false
                    }
                }, `data trades for ${trader.address}`);

                const traderTrades = this.normalizeTradesResponse(response.data);
                this.stats.tradesFetched += traderTrades.length;
                await this.processTrades(traderTrades, trader);
                this.userErrorStreaks.set(trader.address.toLowerCase(), 0);
            } catch (err) {
                this.stats.apiErrors++;
                const key = trader.address.toLowerCase();
                const streak = (this.userErrorStreaks.get(key) || 0) + 1;
                this.userErrorStreaks.set(key, streak);
                if (streak === 1 || streak % 5 === 0) {
                    console.warn(`[LeaderboardTracker] Failed to scan ${trader.username || trader.address}: ${err.message} (streak ${streak})`);
                }
            }
        }));
    }

    async processTrades(trades, knownTraderInfo = null) {
        if (!Array.isArray(trades)) return;

        const now = Date.now();
        const MAX_AGE = 2 * 60 * 1000; // 2 minutes window

        const newTrades = trades.slice().reverse().filter(trade => {
            const tradeTs = Number(trade.timestamp);
            if (!Number.isFinite(tradeTs)) return false;
            if (trade.side !== 'BUY') return false;
            const tradeTime = tradeTs * 1000;
            if (now - tradeTime > MAX_AGE) return false;

            const price = parseFloat(trade.price);
            const size = parseFloat(trade.size);
            if (!Number.isFinite(price) || !Number.isFinite(size)) return false;
            const value = price * size;
            if (value < this.threshold) return false;

            const tradeId = trade.match_id || trade.id || `${trade.timestamp}-${trade.maker_address}-${trade.asset}-${trade.side}`;
            if (this.processedTradeIds.has(tradeId)) return false;
            
            this.processedTradeIds.add(tradeId);
            if (this.processedTradeIds.size > 10000) {
                const it = this.processedTradeIds.values();
                for (let i = 0; i < 2000; i++) this.processedTradeIds.delete(it.next().value);
            }
            return true;
        });

        if (newTrades.length > 0) {
            console.log(`[LeaderboardTracker] Found ${newTrades.length} new trades for monitored users.`);
            this.stats.candidates += newTrades.length;
            const alertJobs = [];
            for (const trade of newTrades) {
                let traderInfo = knownTraderInfo;
                let role = 'Trader'; 

                if (!traderInfo) {
                    const maker = trade.maker_address ? trade.maker_address.toLowerCase() : '';
                    const taker = trade.taker_address ? trade.taker_address.toLowerCase() : '';
                    traderInfo = this.topTraders.get(taker) || this.topTraders.get(maker);
                    if (this.topTraders.has(maker)) role = 'Maker';
                    if (this.topTraders.has(taker)) role = 'Taker';
                } else {
                    if (trade.maker_address && trade.maker_address.toLowerCase() === traderInfo.address.toLowerCase()) role = 'Maker';
                    else if (trade.taker_address && trade.taker_address.toLowerCase() === traderInfo.address.toLowerCase()) role = 'Taker';
                }

                if (traderInfo) {
                    alertJobs.push(() => this.postTradeAlert(trade, traderInfo, role));
                }
            }
            for (let i = 0; i < alertJobs.length; i += this.alertConcurrency) {
                const chunk = alertJobs.slice(i, i + this.alertConcurrency).map(job => job());
                await Promise.all(chunk);
            }
        }
    }

    async postTradeAlert(trade, traderInfo, role) {
        try {
            const guild = await this.client.guilds.fetch(this.targetGuildId).catch(() => null);
            if (!guild) return;

            const channel = await guild.channels.fetch(this.targetChannelId).catch(() => null);
            if (!channel) return;

            const assetId = trade.asset || trade.asset_id;
            let marketTitle = trade.title || 'Unknown Market';
            let marketImage = trade.icon || trade.image;
            let outcomeLabel = trade.outcome;
            let marketSlug = trade.eventSlug || trade.slug;

            if (!marketTitle || marketTitle === 'Unknown Market') {
                const cached = this.marketCache.get(assetId);
                if (cached) {
                    marketTitle = cached.title;
                    marketImage = marketImage || cached.image || cached.icon;
                    marketSlug = cached.slug;
                } else {
                    try {
                        const marketRes = await this.requestWithRetry(this.gammaApi, {
                            method: 'get',
                            url: '/markets',
                            params: { asset_id: assetId }
                        }, 'gamma market metadata');
                        if (marketRes.data?.[0]) {
                            const m = marketRes.data[0];
                            marketTitle = m.question;
                            marketImage = marketImage || m.image;
                            marketSlug = m.slug;
                            this.marketCache.set(assetId, { title: m.question, image: m.image, slug: m.slug });
                        }
                    } catch (e) {
                        console.warn(`[LeaderboardTracker] Failed to fetch metadata for ${assetId}`);
                    }
                }
            }

            const priceVal = parseFloat(trade.price);
            const sizeVal = parseFloat(trade.size);
            const valueVal = priceVal * sizeVal;
            
            const priceStr = (priceVal * 100).toFixed(1) + '%';
            const sizeStr = sizeVal.toLocaleString(undefined, {maximumFractionDigits: 2});
            const valueStr = `$${valueVal.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
            
            const traderName = traderInfo.username !== 'Unknown' ? traderInfo.username : `${traderInfo.address.slice(0,6)}...`;
            const pnlStr = traderInfo.pnl >= 0 ? `+$${traderInfo.pnl.toLocaleString()}` : `-$${Math.abs(traderInfo.pnl).toLocaleString()}`;
            const outcomeText = outcomeLabel ? `(${outcomeLabel})` : '';
            
            const tradeTimestamp = Math.floor(Number(trade.timestamp));
            const timeField = Number.isFinite(tradeTimestamp) ? `<t:${tradeTimestamp}:R>` : 'Unknown';

            const embed = new EmbedBuilder()
                .setTitle('🏆 Top Trader Alert')
                .setDescription(`**${marketTitle}** ${outcomeText}\n\n**${traderName} (Rank #${traderInfo.rank})**\n${pnlStr} PnL • Bought as ${role}`)
                .setColor(0xFFD700) // Gold
                .addFields(
                    { name: 'Price', value: priceStr, inline: true },
                    { name: 'Size', value: `${sizeStr} shares`, inline: true },
                    { name: 'Value', value: valueStr, inline: true },
                    { name: 'Time', value: timeField, inline: true }
                )
                .setFooter({ text: 'Polymarket Leaderboard Alert • Powered by CordEx' })
                .setTimestamp(Number.isFinite(Number(trade.timestamp)) ? new Date(Number(trade.timestamp) * 1000) : new Date());

            if (marketImage) embed.setThumbnail(marketImage);

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('copy_trade')
                        .setLabel('Copy Trade')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('📈'),
                    new ButtonBuilder()
                        .setLabel('View on Polymarket')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://polymarket.com/event/${marketSlug || ''}`)
                );

            await channel.send({ embeds: [embed], components: [row] });
            this.stats.alertsSent++;
            console.log(`[LeaderboardTracker] Alert sent for ${traderName} on ${marketTitle}`);

        } catch (error) {
            console.error('[LeaderboardTracker] Error posting alert:', error.message);
            this.stats.apiErrors++;
        }
    }

    logStats() {
        console.log(`[LeaderboardTracker] Stats | polls=${this.stats.polls} scanned=${this.stats.tradersScanned} fetched=${this.stats.tradesFetched} candidates=${this.stats.candidates} alerts=${this.stats.alertsSent} errors=${this.stats.apiErrors}`);
    }
}

module.exports = LeaderboardTracker;
