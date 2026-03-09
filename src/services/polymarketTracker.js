const axios = require('axios');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
require('dotenv').config({ quiet: true });

class LeaderboardTracker {
    constructor(client) {
        this.client = client;
        // Map: address (lowercase) -> { rank, pnl, username, address }
        this.topTraders = new Map();
        this.processedTradeIds = new Set();
        this.isScanning = false;
        
        // Configuration
        this.targetGuildId = process.env.TARGET_GUILD_ID;
        this.targetChannelId = process.env.LEADERBOARD_CHANNEL_ID;
        this.leaderboardLimit = parseInt(process.env.LEADERBOARD_ACCOUNT_LIMIT || '50'); // Top N traders

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
        
        console.log(`[LeaderboardTracker] Starting tracker for top ${this.leaderboardLimit} traders...`);

        // Initial cache population
        await this.updateTopMarketsCache();
        await this.updateTopTraders();

        // Start polling loop
        this.pollTrades();
        
        // Schedule updates
        setInterval(() => this.updateTopMarketsCache(), 10 * 60 * 1000); // 10 mins
        setInterval(() => this.updateTopTraders(), 10 * 60 * 1000); // 10 mins (Leaderboard)
    }

    async pollTrades() {
        if (!this.isScanning) return;

        const POLL_INTERVAL = 1000; // 1 second - Fast polling
        
        try {
            await this.scanGlobalTrades();
        } catch (error) {
            console.error('[LeaderboardTracker] Error in poll cycle:', error.message);
        } finally {
            setTimeout(() => this.pollTrades(), POLL_INTERVAL);
        }
    }

    async updateTopMarketsCache() {
        try {
            console.log('[LeaderboardTracker] Refreshing top market cache...');
            
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
            console.log(`[LeaderboardTracker] Cache updated. Known assets: ${this.marketCache.size}`);
        } catch (error) {
            console.error('[LeaderboardTracker] Error updating market cache:', error.message);
        }
    }

    async updateTopTraders() {
        try {
            console.log('[LeaderboardTracker] Refreshing top traders leaderboard...');
            const response = await this.dataApi.get('/v1/leaderboard', {
                params: {
                    category: 'OVERALL',
                    timePeriod: 'DAY',
                    orderBy: 'PNL',
                    limit: this.leaderboardLimit
                }
            });

            if (response.data && Array.isArray(response.data)) {
                this.topTraders.clear();
                response.data.forEach(trader => {
                    const info = {
                        rank: trader.rank,
                        pnl: parseFloat(trader.pnl || 0),
                        username: trader.userName || trader.xUsername || 'Unknown',
                        address: trader.proxyWallet || trader.user
                    };

                    if (trader.proxyWallet) {
                        this.topTraders.set(trader.proxyWallet.toLowerCase(), info);
                    }
                    if (trader.user) {
                        this.topTraders.set(trader.user.toLowerCase(), info);
                    }
                });
                console.log(`[LeaderboardTracker] Updated top traders list. Count: ${this.topTraders.size}`);
            }
        } catch (error) {
            console.error('[LeaderboardTracker] Error fetching leaderboard:', error.message);
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
            console.error('[LeaderboardTracker] Global scan error:', error.message);
        }
    }

    async processTrades(trades) {
        if (!Array.isArray(trades)) return;

        const now = Date.now();
        const MAX_AGE = 5 * 60 * 1000; // 5 minutes

        // Filter and process
        const newTrades = trades.reverse().filter(trade => {
            // 1. Check recency
            const tradeTime = trade.timestamp * 1000;
            if (now - tradeTime > MAX_AGE) return false;

            // 2. Check if already processed
            const tradeId = trade.match_id || trade.id || `${trade.timestamp}-${trade.maker_address}-${trade.asset}`;
            
            if (this.processedTradeIds.has(tradeId)) return false;
            
            // Add to processed set
            this.processedTradeIds.add(tradeId);
            
            // Prune set if too large
            if (this.processedTradeIds.size > 10000) {
                const it = this.processedTradeIds.values();
                for (let i = 0; i < 2000; i++) this.processedTradeIds.delete(it.next().value);
            }

            // 3. Check if trade involves a top trader
            const maker = trade.maker_address ? trade.maker_address.toLowerCase() : '';
            const taker = trade.taker_address ? trade.taker_address.toLowerCase() : '';
            
            return this.topTraders.has(maker) || this.topTraders.has(taker);
        });

        if (newTrades.length > 0) {
            console.log(`[LeaderboardTracker] Found ${newTrades.length} new top trader trades.`);
            for (const trade of newTrades) {
                // Determine who is the top trader
                const maker = trade.maker_address ? trade.maker_address.toLowerCase() : '';
                const taker = trade.taker_address ? trade.taker_address.toLowerCase() : '';
                
                let traderInfo = this.topTraders.get(taker);
                let role = 'Taker'; // Default to Taker if both match or just Taker matches
                
                if (!traderInfo) {
                    traderInfo = this.topTraders.get(maker);
                    role = 'Maker';
                }

                if (traderInfo) {
                    await this.postTradeAlert(trade, traderInfo, role);
                }
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
            
            // Resolve Market Metadata
            let marketTitle = trade.title || 'Unknown Market';
            let marketImage = trade.icon || trade.image;
            let outcomeLabel = trade.outcome;

            // Fallback to cache
            if (!marketTitle || marketTitle === 'Unknown Market') {
                const cached = this.marketCache.get(assetId);
                if (cached) {
                    marketTitle = cached.title;
                    marketImage = marketImage || cached.image || cached.icon;
                } else {
                    // Last resort: Fetch on demand
                    try {
                        const marketRes = await this.gammaApi.get(`/markets`, { params: { asset_id: assetId } });
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
                        console.warn(`[LeaderboardTracker] Failed to fetch metadata for ${assetId}`);
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
            
            // Format Trader Info
            const traderName = traderInfo.username !== 'Unknown' ? traderInfo.username : `${traderInfo.address.slice(0,6)}...`;
            const pnlStr = traderInfo.pnl >= 0 ? `+$${traderInfo.pnl.toLocaleString()}` : `-$${Math.abs(traderInfo.pnl).toLocaleString()}`;
            const outcomeText = outcomeLabel ? `(${outcomeLabel})` : '';
            
            // Discord Relative Timestamp
            const tradeTimestamp = Math.floor(trade.timestamp); 
            const timeField = `<t:${tradeTimestamp}:R>`; 

            const embed = new EmbedBuilder()
                .setTitle('🏆 Top Trader Alert')
                .setDescription(`**${marketTitle}** ${outcomeText}\n\n**${traderName} (Rank #${traderInfo.rank})**\n${pnlStr} PnL • ${isBuy ? 'Bought' : 'Sold'} as ${role}`)
                .setColor(0xFFD700) // Gold
                .addFields(
                    { name: 'Price', value: priceStr, inline: true },
                    { name: 'Size', value: `${sizeStr} shares`, inline: true },
                    { name: 'Value', value: valueStr, inline: true },
                    { name: 'Time', value: timeField, inline: true }
                )
                .setFooter({ text: 'Polymarket Leaderboard Alert • Powered by CordEx' })
                .setTimestamp(new Date(trade.timestamp * 1000));

            if (marketImage) embed.setThumbnail(marketImage);

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('copy_trade')
                        .setLabel('Copy Trade')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('📈')
                );

            await channel.send({ embeds: [embed], components: [row] });
            console.log(`[LeaderboardTracker] Alert sent for ${traderName} on ${marketTitle}`);

        } catch (error) {
            console.error('[LeaderboardTracker] Error posting alert:', error.message);
        }
    }
}

module.exports = LeaderboardTracker;
