const {
    MessageFlags,
    TextDisplayBuilder,
    ContainerBuilder,
} = require('discord.js');
const config = require('../../config/config.json');

module.exports = {
    name: 'interactionCreate',
    once: false,
    async execute(client, interaction) {
        try {
            if (interaction.isChatInputCommand()) {

                // Block DM (server-only commands)
                if (!interaction.inGuild()) {
                    const accentColor = parseInt(config.color.replace('#', ''), 16);
                    const dmBlock = new ContainerBuilder()
                        .setAccentColor(accentColor)
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(`${config.crossmark_emoji} This command can only be used in a server.`)
                        );

                    return interaction.reply({
                        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
                        components: [dmBlock],
                    });
                }

                const command = client.slash.get(interaction.commandName);
                if (!command) return;

                await command.run(client, interaction, interaction.options);
            } else if (interaction.isButton()) {
                const { customId } = interaction;

                if (customId === 'copy_trade') {
                    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
                    
                    // Dummy balance for display
                    const dummyBalance = 10000;

                    const row1 = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder().setCustomId('trade_pct_100').setLabel('100%').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId('trade_pct_75').setLabel('75%').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId('trade_pct_50').setLabel('50%').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId('trade_pct_25').setLabel('25%').setStyle(ButtonStyle.Primary)
                        );

                    const row2 = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder().setCustomId('trade_pct_10').setLabel('10%').setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId('trade_pct_5').setLabel('5%').setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId('trade_pct_2.5').setLabel('2.5%').setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId('trade_pct_1').setLabel('1%').setStyle(ButtonStyle.Secondary)
                        );

                    await interaction.reply({
                        content: `**Current Balance:** $${dummyBalance.toLocaleString()}\nSelect the percentage of your balance you would like to trade:`,
                        components: [row1, row2],
                        flags: MessageFlags.Ephemeral
                    });
                } else if (customId.startsWith('trade_pct_')) {
                    const percentage = customId.split('_')[2];
                    
                    // TODO: Replace with API call to execute trade
                    // const result = await api.executeTrade(userId, percentage);
                    
                    // Dummy data logic
                    const price = 99.0; // cents
                    // Assume a dummy balance or just calculate based on a fixed amount for now
                    const dummyBalance = 10000; // $10,000
                    const tradeAmount = (dummyBalance * (parseFloat(percentage) / 100)).toFixed(2);
                    const shares = (tradeAmount / (price / 100)).toFixed(2);

                    await interaction.update({
                        content: `✅ **Trade Executed!**\n\nYou bought **${shares} shares** of "Federico Cina" at **${price}¢** using **${percentage}%** of your balance ($${tradeAmount}).`,
                        components: [], // Remove buttons
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

        } catch (err) {
            console.error('[INTERACTION ERROR]', err);

            if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
                const errorBlock = new ContainerBuilder()
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('An unexpected error occurred while handling this interaction.')
                    );

                interaction.reply({
                    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
                    components: [errorBlock],
                }).catch(console.error);
            }
        }
    },
};
