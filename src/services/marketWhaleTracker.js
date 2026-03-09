const axios = require('axios');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
require('dotenv').config({ quiet: true });

class MarketWhaleTracker {
    constructor(client) {
        this.client = client;
        this.processedTradeIds = new Set();
        this.isScanning = false;

        this.threshold = parseFloat(process.env.WHALE_ALERT_THRESHOLD || '1000');
        this.targetGuildId = process.env.TARGET_GUILD_ID;
        this.targetChannelId = process.env.WHALE_CHANNEL_ID;
        this.pollIntervalMs = parseInt(process.env.WHALE_POLL_INTERVAL_MS || '1500', 10);
        this.tradeFetchLimit = parseInt(process.env.WHALE_TRADE_FETCH_LIMIT || '200', 10);
        this.maxPagesPerPoll = parseInt(process.env.WHALE_MAX_PAGES_PER_POLL || '3', 10);
        this.maxTradesPerPoll = parseInt(process.env.WHALE_MAX_TRADES_PER_POLL || '600', 10);
        this.alertConcurrency = parseInt(process.env.WHALE_ALERT_CONCURRENCY || '3', 10);
        this.apiTimeoutMs = parseInt(process.env.POLY_API_TIMEOUT_MS || '9000', 10);
        this.maxRetryAttempts = parseInt(process.env.POLY_API_RETRY_ATTEMPTS || '3', 10);
        this.cacheRefreshMs = parseInt(process.env.WHALE_CACHE_REFRESH_MS || `${10 * 60 * 1000}`, 10);
        this.statsLogIntervalMs = parseInt(process.env.WHALE_STATS_LOG_INTERVAL_MS || '60000', 10);

        this.marketCache = new Map();
        this.stats = {
            polls: 0,
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

    async start() {
        if (this.isScanning) return;
        this.isScanning = true;

        console.log(`[MarketWhaleTracker] Starting whale tracker. Threshold: $${this.threshold} | Poll: ${this.pollIntervalMs}ms | Page size: ${this.tradeFetchLimit}`);

        await this.updateTopMarketsCache();
        void this.pollTrades();
        setInterval(() => this.updateTopMarketsCache(), this.cacheRefreshMs);
        setInterval(() => this.logStats(), this.statsLogIntervalMs);
    }

    async pollTrades() {
        if (!this.isScanning) return;
        this.stats.polls++;
        try {
            await this.scanGlobalTrades();
        } catch (error) {
            console.error('[MarketWhaleTracker] Error in poll cycle:', error.message);
            this.stats.apiErrors++;
        } finally {
            setTimeout(() => this.pollTrades(), this.pollIntervalMs);
        }
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
                console.warn(`[MarketWhaleTracker] Retry ${label} in ${waitMs}ms (${attempt + 1}/${this.maxRetryAttempts})`);
                await this.sleep(waitMs);
                attempt++;
            }
        }
        throw new Error(`[MarketWhaleTracker] Unreachable retry branch for ${label}`);
    }

    normalizeTradesResponse(payload) {
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload?.trades)) return payload.trades;
        if (Array.isArray(payload?.items)) return payload.items;
        return [];
    }

    async updateTopMarketsCache() {
        try {
            console.log('[MarketWhaleTracker] Refreshing top market cache...');

            const response = await this.requestWithRetry(this.gammaApi, {
                method: 'get',
                url: '/events',
                params: {
                    limit: 50, 
                    active: true,
                    closed: false,
                    order: 'volume', 
                    ascending: false
                }
            }, 'gamma events');

            let count = 0;
            if (response.data && Array.isArray(response.data)) {
                for (const event of response.data) {
                    if (event.markets && Array.isArray(event.markets)) {
                        for (const market of event.markets) {
                            // Extract metadata
                            const metadata = {
                                title: market.question,
                                slug: market.slug,
                                image: market.image || (event.image ? event.image : null),
                                icon: market.icon || (event.icon ? event.icon : null)
                            };

                            // Map all asset IDs (clobTokenIds) to this metadata
                            if (market.clobTokenIds) {
                                try {
                                    const tokenIds = JSON.parse(market.clobTokenIds);
                                    if (Array.isArray(tokenIds)) {
                                        tokenIds.forEach(id => this.marketCache.set(id, metadata));
                                        count++;
                                    }
                                } catch (e) {
                                    if (Array.isArray(market.clobTokenIds)) {
                                        market.clobTokenIds.forEach(id => this.marketCache.set(id, metadata));
                                        count++;
                                    }
                                }
                            }
                            if (market.asset_id) {
                                this.marketCache.set(market.asset_id, metadata);
                                count++;
                            }
                        }
                    }
                }
            }
            console.log(`[MarketWhaleTracker] Cache updated. Known assets: ${this.marketCache.size}`);
        } catch (error) {
            console.error('[MarketWhaleTracker] Error updating market cache:', error.message);
        }
    }

    async scanGlobalTrades() {
        try {
            let offset = 0;
            let pagesFetched = 0;
            let totalFetched = 0;
            while (pagesFetched < this.maxPagesPerPoll && totalFetched < this.maxTradesPerPoll) {
                const remaining = this.maxTradesPerPoll - totalFetched;
                const pageSize = Math.max(1, Math.min(this.tradeFetchLimit, remaining));
                const response = await this.requestWithRetry(this.dataApi, {
                    method: 'get',
                    url: '/trades',
                    params: {
                        limit: pageSize,
                        takerOnly: true,
                        offset
                    }
                }, 'data trades');
                const batch = this.normalizeTradesResponse(response.data);
                if (batch.length === 0) break;
                this.stats.tradesFetched += batch.length;
                totalFetched += batch.length;
                pagesFetched++;
                await this.processTrades(batch);
                if (batch.length < pageSize) break;
                offset += batch.length;
            }
        } catch (error) {
            console.error('[MarketWhaleTracker] Global scan error:', error.message);
            this.stats.apiErrors++;
        }
    }

    async processTrades(trades) {
        if (!Array.isArray(trades)) return;

        const now = Date.now();
        const MAX_AGE = 5 * 60 * 1000; 
        const newTrades = trades.slice().reverse().filter(trade => {
            const tradeTs = Number(trade.timestamp);
            if (!Number.isFinite(tradeTs)) return false;
            if (trade.side !== 'BUY') return false;
            const tradeTime = tradeTs * 1000;
            if (now - tradeTime > MAX_AGE) return false;
            const tradeId = trade.match_id || trade.id || `${trade.timestamp}-${trade.maker_address}-${trade.asset}-${trade.side}`;
            
            if (this.processedTradeIds.has(tradeId)) return false;
            this.processedTradeIds.add(tradeId);
            if (this.processedTradeIds.size > 10000) {
                const it = this.processedTradeIds.values();
                for (let i = 0; i < 2000; i++) this.processedTradeIds.delete(it.next().value);
            }
            const price = parseFloat(trade.price);
            const size = parseFloat(trade.size);
            if (!Number.isFinite(price) || !Number.isFinite(size)) return false;
            const value = price * size;
            if (value < this.threshold) return false;

            return true;
        });

        if (newTrades.length > 0) {
            console.log(`[MarketWhaleTracker] Found ${newTrades.length} new whale trades.`);
            this.stats.candidates += newTrades.length;
            for (let i = 0; i < newTrades.length; i += this.alertConcurrency) {
                const chunk = newTrades.slice(i, i + this.alertConcurrency);
                await Promise.all(chunk.map(trade => this.postWhaleAlert(trade)));
            }
        }
    }

    async postWhaleAlert(trade) {
        try {
            const guild = await this.client.guilds.fetch(this.targetGuildId).catch(() => null);
            if (!guild) return;

            const channel = await guild.channels.fetch(this.targetChannelId).catch(() => null);
            if (!channel) return;

            const assetId = trade.asset || trade.asset_id;
            let marketTitle = trade.title || 'Unknown Market';
            let marketImage = trade.icon || trade.image;
            let outcomeLabel = trade.outcome;

            if (!marketTitle || marketTitle === 'Unknown Market') {
                const cached = this.marketCache.get(assetId);
                if (cached) {
                    marketTitle = cached.title;
                    marketImage = marketImage || cached.image || cached.icon;
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
                            this.marketCache.set(assetId, { 
                                title: m.question, 
                                image: m.image,
                                slug: m.slug 
                            });
                        }
                    } catch (e) {
                        console.warn(`[MarketWhaleTracker] Failed to fetch metadata for ${assetId}`);
                    }
                }
            }

            const priceVal = parseFloat(trade.price);
            const sizeVal = parseFloat(trade.size);
            const valueVal = priceVal * sizeVal;
            
            const priceStr = (priceVal * 100).toFixed(1) + '%';
            const sizeStr = sizeVal.toLocaleString(undefined, {maximumFractionDigits: 2});
            const valueStr = `$${valueVal.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

            const outcomeText = outcomeLabel ? `(${outcomeLabel})` : '';
            const tradeTimestamp = Math.floor(Number(trade.timestamp));
            const timeField = Number.isFinite(tradeTimestamp) ? `<t:${tradeTimestamp}:R>` : 'Unknown';

            const embed = new EmbedBuilder()
                .setTitle('🐋 WHALE ALERT')
                .setDescription(`**${marketTitle}** ${outcomeText}\n\n**Whale Bought**`)
                .setColor(0x00FFFF) // Cyan
                .addFields(
                    { name: 'Price', value: priceStr, inline: true },
                    { name: 'Size', value: `${sizeStr} shares`, inline: true },
                    { name: 'Value', value: valueStr, inline: true },
                    { name: 'Time', value: timeField, inline: true }
                )
                .setFooter({ text: 'Polymarket Whale Alert • Powered by CordEx' })
                .setTimestamp(Number.isFinite(Number(trade.timestamp)) ? new Date(Number(trade.timestamp) * 1000) : new Date());

            if (marketImage) embed.setThumbnail(marketImage);

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('copy_trade')
                        .setLabel('Copy Trade')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('📈')
                );

            await channel.send({ embeds: [embed], components: [row] });
            this.stats.alertsSent++;
            console.log(`[MarketWhaleTracker] Alert sent for ${valueStr} trade on ${marketTitle}`);

        } catch (error) {
            console.error('[MarketWhaleTracker] Error posting alert:', error.message);
            this.stats.apiErrors++;
        }
    }

    logStats() {
        console.log(`[MarketWhaleTracker] Stats | polls=${this.stats.polls} fetched=${this.stats.tradesFetched} candidates=${this.stats.candidates} alerts=${this.stats.alertsSent} errors=${this.stats.apiErrors}`);
    }
}

module.exports = MarketWhaleTracker;
