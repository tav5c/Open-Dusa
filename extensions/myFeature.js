// extensions/myFeature.js, example extension using the manifest-based loader.
// Copy this file, rename the manifest, and drop it in /extensions to activate.

export const manifest = {
    name: 'myFeature',
    version: '1.0.0',
    author: 'you',
    description: 'Example extension template',
    apiVersion: 1,
    slashCommands: [], // array of SlashCommandBuilder().toJSON() shapes
    permissions: [], // e.g. ['ManageMessages']
    dependencies: [], // ['ai', 'moderation', ...]
}

export async function init(client, db, heart) {
    console.log(`[${manifest.name}] Loaded v${manifest.version}`)
    // Register dynamic prefix commands or listeners here
    client.commands.set('hello', async (msg) => {
        await msg.reply('world!')
    })
}

export async function handleMessage(_message) {
    // Return true to "sink" (stop pipeline), false/undefined to pass through.
    return false
}

export async function handleInteraction(_interaction) {
    return false
}
