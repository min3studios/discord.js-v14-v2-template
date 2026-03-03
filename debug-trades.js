const axios = require('axios');

const dataApi = axios.create({
    baseURL: 'https://data-api.polymarket.com',
    headers: { 'Content-Type': 'application/json' }
});

async function checkTrades() {
    try {
        console.log('Fetching global trades...');
        const response = await dataApi.get('/trades', {
            params: {
                limit: 10,
                takerOnly: true
            }
        });

        const trades = response.data;
        if (Array.isArray(trades) && trades.length > 0) {
            console.log(`Received ${trades.length} trades.`);
            const now = Date.now();
            
            trades.forEach((trade, i) => {
                const tradeTime = trade.timestamp * 1000;
                const ageSeconds = (now - tradeTime) / 1000;
                console.log(`Trade ${i}: ID=${trade.id || trade.match_id}, Time=${new Date(tradeTime).toISOString()}, Age=${ageSeconds.toFixed(1)}s`);
            });
        } else {
            console.log('No trades received or invalid format.');
        }

    } catch (error) {
        console.error('Error:', error.message);
    }
}

checkTrades();
