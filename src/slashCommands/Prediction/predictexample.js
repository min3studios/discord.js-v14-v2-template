const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('predictexample')
        .setDescription('Shows a copy trade example'),

    async run(client, interaction) {
        const embed = new EmbedBuilder()
            .setTitle('🏆 Top Trader Alert')
            .setDescription('**+$4,550,802 PnL** (Rank #16)\n\n**Bought "Federico Cina"** in Pune: Duje Ajdukovic vs Federico Cina')
            .setColor(0xFFD700) // Gold color
            .addFields(
                { name: 'Price', value: '99.0%', inline: true },
                { name: 'Transaction Size', value: '3,534.12 shares', inline: true },
                { name: 'Transaction Value', value: '$3,498.66', inline: true }
            )
            .setFooter({ text: 'Polymarket Alert • Powered by Onsight' })
            .setTimestamp();

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('copy_trade')
                    .setLabel('Copy Trade')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('📈')
            );

        await interaction.reply({
            embeds: [embed],
            components: [row]
        });
    }
};
