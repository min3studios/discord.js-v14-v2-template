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
        this.threshold = parseFloat(process.env.LEADERBOARD_ALERT_THRESHOLD || '50'); // Value threshold

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

        // Round-robin index for polling specific users
        this.userPollIndex = 0;
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

        // Poll Strategy:
        // We will cycle through our top traders and fetch their recent activity directly.
        // This guarantees we don't miss trades that might fall off the global feed.
        
        const POLL_INTERVAL = 2000; // 2 seconds per batch
        
        try {
            await this.scanSpecificTraders();
        } catch (error) {
            console.error('[LeaderboardTracker] Error in poll cycle:', error.message);
        } finally {
            setTimeout(() => this.pollTrades(), POLL_INTERVAL);
        }
    }

    async updateTopMarketsCache() {
        try {
            console.log('[LeaderboardTracker] Refreshing top market cache...');
            const response = await this.gammaApi.get('/events', {
                params: { limit: 50, active: true, closed: false, order: 'volume', ascending: false }
            });

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
            const response = await this.dataApi.get('/v1/leaderboard', {
                params: { category: 'OVERALL', timePeriod: 'DAY', orderBy: 'PNL', limit: this.leaderboardLimit }
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
                    // Store by address for easy lookup
                    if (trader.proxyWallet) this.topTraders.set(trader.proxyWallet.toLowerCase(), info);
                    else if (trader.user) this.topTraders.set(trader.user.toLowerCase(), info);
                });
                console.log(`[LeaderboardTracker] Updated top traders list. Count: ${this.topTraders.size}`);
                // Reset poll index if list changed significantly or just for safety
                if (this.userPollIndex >= this.topTraders.size) this.userPollIndex = 0;
            }
        } catch (error) {
            console.error('[LeaderboardTracker] Error fetching leaderboard:', error.message);
        }
    }

    async scanSpecificTraders() {
        if (this.topTraders.size === 0) return;

        const traders = Array.from(this.topTraders.values());
        const BATCH_SIZE = 5; // Check 5 traders per interval
        
        // Get next batch of traders to check
        const batch = [];
        for (let i = 0; i < BATCH_SIZE; i++) {
            if (this.userPollIndex >= traders.length) this.userPollIndex = 0;
            batch.push(traders[this.userPollIndex]);
            this.userPollIndex++;
        }

        // Process batch in parallel
        await Promise.all(batch.map(async (trader) => {
            try {
                // Use /activity endpoint as suggested by docs for user activity
                // Or /trades?user=ADDRESS. Let's use /trades for consistency with structure.
                const response = await this.dataApi.get('/trades', {
                    params: {
                        user: trader.address,
                        limit: 5, // Only need very recent ones
                        takerOnly: false // See ALL trades (Maker & Taker)
                    }
                });
                
                await this.processTrades(response.data, trader);
            } catch (err) {
                // Ignore errors for individual users (e.g. 404 or rate limit glitches)
                // console.warn(`[LeaderboardTracker] Failed to scan ${trader.username}: ${err.message}`);
            }
        }));
    }

    async processTrades(trades, knownTraderInfo = null) {
        if (!Array.isArray(trades)) return;

        const now = Date.now();
        const MAX_AGE = 2 * 60 * 1000; // 2 minutes window

        // Filter valid new trades
        const newTrades = trades.reverse().filter(trade => {
            const tradeTime = trade.timestamp * 1000;
            if (now - tradeTime > MAX_AGE) return false;

            // Value filter
            const value = parseFloat(trade.price) * parseFloat(trade.size);
            if (value < this.threshold) return false;

            const tradeId = trade.match_id || trade.id || `${trade.timestamp}-${trade.maker_address}-${trade.asset}`;
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
            for (const trade of newTrades) {
                // If we called this from scanSpecificTraders, we know who it is.
                // Otherwise (if we reused global scan), we'd lookup.
                let traderInfo = knownTraderInfo;
                let role = 'Trader'; 

                if (!traderInfo) {
                    // Fallback lookup
                    const maker = trade.maker_address ? trade.maker_address.toLowerCase() : '';
                    const taker = trade.taker_address ? trade.taker_address.toLowerCase() : '';
                    traderInfo = this.topTraders.get(taker) || this.topTraders.get(maker);
                    if (this.topTraders.has(maker)) role = 'Maker';
                    if (this.topTraders.has(taker)) role = 'Taker';
                } else {
                    // Determine role if possible
                    if (trade.maker_address && trade.maker_address.toLowerCase() === traderInfo.address.toLowerCase()) role = 'Maker';
                    else if (trade.taker_address && trade.taker_address.toLowerCase() === traderInfo.address.toLowerCase()) role = 'Taker';
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
            let marketSlug = trade.eventSlug || trade.slug;

            if (!marketTitle || marketTitle === 'Unknown Market') {
                const cached = this.marketCache.get(assetId);
                if (cached) {
                    marketTitle = cached.title;
                    marketImage = marketImage || cached.image || cached.icon;
                    marketSlug = cached.slug;
                } else {
                    try {
                        const marketRes = await this.gammaApi.get(`/markets`, { params: { asset_id: assetId } });
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

            const isBuy = trade.side === 'BUY';
            const priceVal = parseFloat(trade.price);
            const sizeVal = parseFloat(trade.size);
            const valueVal = priceVal * sizeVal;
            
            const priceStr = (priceVal * 100).toFixed(1) + '%';
            const sizeStr = sizeVal.toLocaleString(undefined, {maximumFractionDigits: 2});
            const valueStr = `$${valueVal.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
            
            const traderName = traderInfo.username !== 'Unknown' ? traderInfo.username : `${traderInfo.address.slice(0,6)}...`;
            const pnlStr = traderInfo.pnl >= 0 ? `+$${traderInfo.pnl.toLocaleString()}` : `-$${Math.abs(traderInfo.pnl).toLocaleString()}`;
            const outcomeText = outcomeLabel ? `(${outcomeLabel})` : '';
            
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
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('📈'),
                    new ButtonBuilder()
                        .setLabel('View on Polymarket') 
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://polymarket.com/event/${marketSlug || ''}`)
                );

            await channel.send({ embeds: [embed], components: [row] });
            console.log(`[LeaderboardTracker] Alert sent for ${traderName} on ${marketTitle}`);

        } catch (error) {
            console.error('[LeaderboardTracker] Error posting alert:', error.message);
        }
    }
}

module.exports = LeaderboardTracker;
