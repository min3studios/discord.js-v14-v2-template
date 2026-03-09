const axios = require('axios');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
require('dotenv').config({ quiet: true });

class MarketWhaleTracker {
    constructor(client) {
        this.client = client;
        this.processedTradeIds = new Set();
        this.isScanning = false;
        
        // Configuration
        this.threshold = parseFloat(process.env.WHALE_ALERT_THRESHOLD || '1000'); // Increased default to avoid spam if scanning all
        this.targetGuildId = process.env.TARGET_GUILD_ID;
        this.targetChannelId = process.env.WHALE_CHANNEL_ID;
        
        // Cache for market metadata (AssetID -> { title, image, ... })
        this.marketCache = new Map();

        // API Clients
        this.dataApi = axios.create({
            baseURL: 'https://data-api.polymarket.com',
            headers: { 'Content-Type': 'application/json' }
        });

        this.gammaApi = axios.create({
            baseURL: 'https://gamma-api.polymarket.com'
        });
    }

    async start() {
        if (this.isScanning) return;
        this.isScanning = true;
        
        console.log(`[MarketWhaleTracker] Starting whale tracker. Threshold: $${this.threshold}`);

        // Initial cache population (optional but good for context)
        await this.updateTopMarketsCache();

        // Start polling loop
        this.pollTrades();
        
        // Schedule cache updates - every 10 minutes
        setInterval(() => this.updateTopMarketsCache(), 10 * 60 * 1000);
    }

    async pollTrades() {
        if (!this.isScanning) return;

        const POLL_INTERVAL = 2000; // 2 seconds (Safe: 5 req/10s vs Limit 200/10s)
        
        try {
            await this.scanGlobalTrades();
        } catch (error) {
            console.error('[MarketWhaleTracker] Error in poll cycle:', error.message);
        } finally {
            setTimeout(() => this.pollTrades(), POLL_INTERVAL);
        }
    }

    async updateTopMarketsCache() {
        try {
            console.log('[MarketWhaleTracker] Refreshing top market cache...');
            
            // Fetch top active events/markets to populate cache
            const response = await this.gammaApi.get('/events', {
                params: {
                    limit: 50, 
                    active: true,
                    closed: false,
                    order: 'volume', 
                    ascending: false
                }
            });

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
            // Fetch latest trades globally
            const response = await this.dataApi.get('/trades', {
                params: {
                    limit: 100, // Max limit
                    takerOnly: true
                }
            });

            await this.processTrades(response.data);
        } catch (error) {
            console.error('[MarketWhaleTracker] Global scan error:', error.message);
        }
    }

    async processTrades(trades) {
        if (!Array.isArray(trades)) return;

        const now = Date.now();
        // We only care about trades in the last few seconds to avoid duplicate processing on restart
        // But since we track IDs, we can be lenient.
        const MAX_AGE = 5 * 60 * 1000; 

        // Filter and process
        // We process from oldest to newest in the batch if we want to preserve order, 
        // but the API returns newest first. Let's reverse to process chronologically.
        const newTrades = trades.reverse().filter(trade => {
            // 1. Check recency
            const tradeTime = trade.timestamp * 1000;
            if (now - tradeTime > MAX_AGE) return false;

            // 2. Check if already processed
            // Data API trades usually have 'match_id' or 'id'.
            // Fallback to timestamp-maker-asset combo if needed.
            const tradeId = trade.match_id || trade.id || `${trade.timestamp}-${trade.maker_address}-${trade.asset}`;
            
            if (this.processedTradeIds.has(tradeId)) return false;
            
            // Add to processed set
            this.processedTradeIds.add(tradeId);
            
            // Prune set if too large
            if (this.processedTradeIds.size > 10000) {
                const it = this.processedTradeIds.values();
                for (let i = 0; i < 2000; i++) this.processedTradeIds.delete(it.next().value);
            }

            // 3. Check value threshold
            const price = parseFloat(trade.price);
            const size = parseFloat(trade.size);
            const value = price * size;
            
            if (value < this.threshold) return false;

            return true;
        });

        if (newTrades.length > 0) {
            console.log(`[MarketWhaleTracker] Found ${newTrades.length} new whale trades.`);
            for (const trade of newTrades) {
                await this.postWhaleAlert(trade);
            }
        }
    }

    async postWhaleAlert(trade) {
        try {
            const guild = await this.client.guilds.fetch(this.targetGuildId).catch(() => null);
            if (!guild) return;

            const channel = await guild.channels.fetch(this.targetChannelId).catch(() => null);
            if (!channel) return;

            const assetId = trade.asset || trade.asset_id; // Data API uses 'asset', sometimes 'asset_id'
            
            // Resolve Market Metadata
            let marketTitle = trade.title || 'Unknown Market'; // Data API often provides title
            let marketImage = trade.icon || trade.image;
            let outcomeLabel = trade.outcome;

            // Fallback to cache if Data API missing details
            if (!marketTitle || marketTitle === 'Unknown Market') {
                const cached = this.marketCache.get(assetId);
                if (cached) {
                    marketTitle = cached.title;
                    marketImage = marketImage || cached.image || cached.icon;
                } else {
                    // Last resort: Fetch on demand (Rate limited)
                    try {
                        const marketRes = await this.gammaApi.get(`/markets`, { params: { asset_id: assetId } });
                        if (marketRes.data?.[0]) {
                            const m = marketRes.data[0];
                            marketTitle = m.question;
                            marketImage = marketImage || m.image;
                            // Update cache
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

            const isBuy = trade.side === 'BUY';
            const priceVal = parseFloat(trade.price);
            const sizeVal = parseFloat(trade.size);
            const valueVal = priceVal * sizeVal;
            
            const priceStr = (priceVal * 100).toFixed(1) + '%';
            const sizeStr = sizeVal.toLocaleString(undefined, {maximumFractionDigits: 2});
            const valueStr = `$${valueVal.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

            // Outcome formatting
            const outcomeText = outcomeLabel ? `(${outcomeLabel})` : '';
            
            // Time formatting (Discord Relative Timestamp)
            const tradeTimestamp = Math.floor(trade.timestamp); // Ensure it's in seconds
            const timeField = `<t:${tradeTimestamp}:R>`; // e.g. "2 minutes ago"

            const embed = new EmbedBuilder()
                .setTitle('🐋 WHALE ALERT')
                .setDescription(`**${marketTitle}** ${outcomeText}\n\n**Whale ${isBuy ? 'Bought' : 'Sold'}**`)
                .setColor(0x00FFFF) // Cyan
                .addFields(
                    { name: 'Price', value: priceStr, inline: true },
                    { name: 'Size', value: `${sizeStr} shares`, inline: true },
                    { name: 'Value', value: valueStr, inline: true },
                    { name: 'Time', value: timeField, inline: true }
                )
                .setFooter({ text: 'Polymarket Whale Alert • Powered by CordEx' })
                .setTimestamp(new Date(trade.timestamp * 1000));

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
            console.log(`[MarketWhaleTracker] Alert sent for ${valueStr} trade on ${marketTitle}`);

        } catch (error) {
            console.error('[MarketWhaleTracker] Error posting alert:', error.message);
        }
    }
}

module.exports = MarketWhaleTracker;
