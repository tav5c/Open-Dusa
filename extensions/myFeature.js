/**
 * myFeature.js — Extension template. Rename this file and build your feature here.
 *
 * ⚠️  REMOVE OR DISABLE THE PING HANDLER BELOW BEFORE PRODUCTION USE.
 *     It intercepts ANY message with content === 'ping' and sinks it from
 *     the entire pipeline. Use a prefixed command or a unique keyword instead.
 */

export function init(client, db, heart) {
    console.log('[myFeature] Template extension loaded. Replace this with your own feature.')
}

export async function handleMessage(message) {
    // Example: intercept bare "ping" — REMOVE this before going live.
    // if (message.content === 'ping') {
    //     await message.reply('pong')
    //     return true  // sinks the message
    // }
}

export async function handleInteraction(interaction) {
    // Handle your custom slash commands dynamically here.
}