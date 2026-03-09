const { ActivityType } = require('discord.js');
const MarketWhaleTracker = require('../../services/marketWhaleTracker');
const LeaderboardTracker = require('../../services/leaderboardTracker');

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

        // Start Whale Tracker
        const whaleTracker = new MarketWhaleTracker(client);
        await whaleTracker.start();

        // Start Leaderboard Tracker
        const leaderboardTracker = new LeaderboardTracker(client);
        await leaderboardTracker.start();
    },
};
