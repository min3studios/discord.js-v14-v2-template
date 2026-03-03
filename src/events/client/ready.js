const { ActivityType } = require('discord.js');
const PolymarketTracker = require('../../services/polymarketTracker');
const MarketWhaleTracker = require('../../services/marketWhaleTracker');

module.exports = {
    name: 'clientReady',
    once: true,
    async execute(client) {
        const tag = client.user.tag;
        const boxTitle = `BOT READY`;
        const boxMessage = `Logged in as ${tag}`;
        const maxLength = Math.max(boxTitle.length, boxMessage.length) + 4;
        console.log(`╔${'─'.repeat(maxLength)}╗`);
        console.log(`║ ${boxTitle.padEnd(maxLength - 2)} ║`);
        console.log(`╠${'─'.repeat(maxLength)}╣`);
        console.log(`║ ${boxMessage.padEnd(maxLength - 2)} ║`);
        console.log(`╚${'─'.repeat(maxLength)}╝`);

        client.user.setPresence({
            status: 'online',
            activities: [{
                name: 'Make sure to leave a star ⭐ on the repo',
                type: ActivityType.Custom,
            }],
        });

        // Start Polymarket Tracker
        // const tracker = new PolymarketTracker(client);
        // await tracker.start();

        // Start Whale Tracker
        const whaleTracker = new MarketWhaleTracker(client);
        await whaleTracker.start();
    },
};
