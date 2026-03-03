const axios = require('axios');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
require('dotenv').config({ quiet: true });

class PolymarketTracker {
    constructor(client) {
        this.client = client;
        this.topTraders = new Set();
        this.processedTradeIds = new Set();
        this.isScanning = false;
        
        // Configuration
        this.apiKey = process.env.POLY_API_KEY;
        this.apiSecret = process.env.POLY_API_SECRET;
        this.apiPassphrase = process.env.POLY_API_PASSPHRASE;
        this.targetGuildId = process.env.TARGET_GUILD_ID;
        this.targetChannelId = process.env.TARGET_CHANNEL_ID;

        // API Clients
        this.dataApi = axios.create({
            baseURL: 'https://data-api.polymarket.com',
            headers: {
                'Content-Type': 'application/json',
                // Add auth headers if required by Data API, though often public for GET
                // 'Clob-Api-Key': this.apiKey,
                // 'Clob-Api-Secret': this.apiSecret,
                // 'Clob-Api-Passphrase': this.apiPassphrase
            }
        });

        this.gammaApi = axios.create({
            baseURL: 'https://gamma-api.polymarket.com'
        });
    }

    async start() {
        if (this.isScanning) return;
        this.isScanning = true;
        console.log('[PolymarketTracker] Starting tracker service...');

        // Initial fetch
        await this.updateTopTraders();
        await this.scanTrades(); // Run initial scan immediately
        
        // Schedule updates
        // Update leaderboard every 30 minutes
        setInterval(() => this.updateTopTraders(), 30 * 60 * 1000);
        
        // Scan trades every 30 seconds
        setInterval(() => this.scanTrades(), 30 * 1000);
    }

    async updateTopTraders() {
        try {
            console.log('[PolymarketTracker] Fetching top traders...');
            const response = await this.dataApi.get('/v1/leaderboard', {
                params: {
                    category: 'OVERALL',
                    timePeriod: 'DAY',
                    orderBy: 'PNL',
                    limit: 50
                }
            });

            if (response.data && Array.isArray(response.data)) {
                this.topTraders.clear();
                response.data.forEach(trader => {
                    if (trader.proxyWallet) {
                        this.topTraders.add(trader.proxyWallet.toLowerCase());
                    }
                    if (trader.user) { // specific user address if proxyWallet not present
                         this.topTraders.add(trader.user.toLowerCase());
                    }
                });
                console.log(`[PolymarketTracker] Updated top traders list. Count: ${this.topTraders.size}`);
            }
        } catch (error) {
            console.error('[PolymarketTracker] Error fetching leaderboard:', error.message);
        }
    }

    async scanTrades() {
        try {
            const response = await this.dataApi.get('/trades', {
                params: {
                    limit: 50, // Get last 50 trades
                    takerOnly: true
                }
            });

            const trades = response.data;
            if (!Array.isArray(trades)) {
                console.log('[PolymarketTracker] No trades data received.');
                return;
            }

            const now = Date.now();
            const TWO_MINUTES = 2 * 60 * 1000;
            let skippedRecency = 0;
            let matchesFound = 0;

            // Process trades from oldest to newest to maintain order
            const newTrades = trades.reverse().filter(trade => {
                // Check recency (within 2 minutes)
                const tradeTime = trade.timestamp * 1000;
                if (now - tradeTime > TWO_MINUTES) {
                    skippedRecency++;
                    return false;
                }

                const tradeId = trade.id || trade.match_id || `${trade.timestamp}-${trade.maker_address}`;
                if (this.processedTradeIds.has(tradeId)) return false;
                
                this.processedTradeIds.add(tradeId);
                // Keep set size manageable
                if (this.processedTradeIds.size > 2000) {
                    const it = this.processedTradeIds.values();
                    for (let i = 0; i < 500; i++) this.processedTradeIds.delete(it.next().value);
                }

                // Check if trade involves a top trader
                // We typically care about the Taker (the one who initiated the trade)
                // but checking both sides is safer if we want to track their activity
                const maker = trade.maker_address ? trade.maker_address.toLowerCase() : '';
                const taker = trade.taker_address ? trade.taker_address.toLowerCase() : '';
                
                const isMatch = this.topTraders.has(maker) || this.topTraders.has(taker);
                if (isMatch) {
                    matchesFound++;
                    const matchedAddr = this.topTraders.has(taker) ? taker : maker;
                    const value = (parseFloat(trade.size) * parseFloat(trade.price)).toFixed(2);
                    console.log(`[PolymarketTracker] 🎯 Match! Trader: ${matchedAddr.slice(0,6)}... | Value: $${value} | Side: ${trade.side}`);
                }
                return isMatch;
            });

            console.log(`[PolymarketTracker] Scanned ${trades.length} trades. Ignored (old): ${skippedRecency}. Matches: ${matchesFound}.`);

            for (const trade of newTrades) {
                await this.postTradeAlert(trade);
            }

        } catch (error) {
            console.error('[PolymarketTracker] Error scanning trades:', error.message);
        }
    }

    async postTradeAlert(trade) {
        try {
            const guild = await this.client.guilds.fetch(this.targetGuildId).catch(() => null);
            if (!guild) return console.warn(`[PolymarketTracker] Target guild ${this.targetGuildId} not found`);

            const channel = await guild.channels.fetch(this.targetChannelId).catch(() => null);
            if (!channel) return console.warn(`[PolymarketTracker] Target channel ${this.targetChannelId} not found`);

            // Fetch market details to get Name/Image
            let marketTitle = trade.asset_id;
            let marketImage = null;
            
            try {
                // Try to find event/market by asset_id or similar if possible. 
                // The trade object usually has `asset_id` or `token_id`.
                // We might need to query Gamma API to get readable details.
                if (trade.asset_id) {
                     const marketRes = await this.gammaApi.get(`/markets`, {
                         params: { asset_id: trade.asset_id }
                     });
                     if (marketRes.data && marketRes.data.length > 0) {
                         const market = marketRes.data[0];
                         marketTitle = market.question;
                         // Try to get image from market or parent event
                         if (market.image) marketImage = market.image;
                         else if (market.events && market.events.length > 0) marketImage = market.events[0].image;
                     }
                }
            } catch (err) {
                // Ignore market fetch error, use defaults
            }

            const isBuy = trade.side === 'BUY';
            const price = (parseFloat(trade.price) * 100).toFixed(1) + '%';
            const size = parseFloat(trade.size).toFixed(2);
            const value = `$${(parseFloat(trade.size) * parseFloat(trade.price)).toFixed(2)}`;
            const trader = this.topTraders.has(trade.taker_address?.toLowerCase()) ? 'Top Trader (Taker)' : 'Top Trader (Maker)';

            const embed = new EmbedBuilder()
                .setTitle('🏆 Top Trader Alert')
                .setDescription(`**${marketTitle}**\n\n**${trader} ${isBuy ? 'Bought' : 'Sold'}**`)
                .setColor(0xFFD700)
                .addFields(
                    { name: 'Price', value: price, inline: true },
                    { name: 'Size', value: `${size} shares`, inline: true },
                    { name: 'Value', value: value, inline: true }
                )
                .setFooter({ text: 'Polymarket Alert • Powered by CordEx' })
                .setTimestamp(new Date(trade.timestamp * 1000)); // timestamp usually in seconds

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
            console.log(`[PolymarketTracker] Posted alert for trade ${trade.match_id || trade.id}`);

        } catch (error) {
            console.error('[PolymarketTracker] Error posting alert:', error.message);
        }
    }
}

module.exports = PolymarketTracker;
