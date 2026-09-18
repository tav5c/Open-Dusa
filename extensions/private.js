// ─────────────────────────────────────────────────────────────────────────────
// extensions/private.js, Owner tools, Announcer, AutoVC, Keywords, Verify, Snake, Call, Mail, Timezones
// ─────────────────────────────────────────────────────────────────────────────
import { VoiceConnectionStatus, entersState, getVoiceConnection, joinVoiceChannel } from '@discordjs/voice'
import {
    ActionRowBuilder,
    ButtonBuilder, ButtonStyle,
    ChannelType,
    ComponentType,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder
} from 'discord.js'
import fs, { existsSync, readFileSync, writeFileSync } from 'fs'
// Read the owner ID from config safely
const config = JSON.parse(readFileSync('config.json', 'utf8').replace(/(?<=:\s*|\[\s*|,\s*)\b(\d{15,})\b(?=\s*[,}\]])/g, '"$1"'))
const rawOwnerId = config.ownerId || config.owner_id || '0'
const BOT_OWNER_ID = /^\d+$/.test(String(rawOwnerId)) ? BigInt(rawOwnerId) : 0n

// Load priv.json (announcer and VC settings) from configs/, moving the old
// root copy over on first boot
const PRIV_FILE = 'configs/priv.json'
function readPriv() {
    if (!existsSync(PRIV_FILE) && existsSync('priv.json')) {
        fs.mkdirSync('configs', { recursive: true })
        fs.renameSync('priv.json', PRIV_FILE)
        console.log('[Private] Moved priv.json into configs/')
    }
    if (!existsSync(PRIV_FILE)) return null
    return JSON.parse(readFileSync(PRIV_FILE, 'utf8').replace(/(?<=:\s*|\[\s*|,\s*)\b(\d{15,})\b(?=\s*[,}\]])/g, '"$1"'))
}
let privConfig = { auto_vc_channels: [], announcer_channel_id: null, random_msgs: null }
try {
    const p = readPriv()
    if (p) {
        privConfig = p
        console.log('[Private] Loaded priv.json configuration.')
    }
} catch (e) {
    console.error('[Private] Failed to parse priv.json:', e)
}

// ── Background Loops (Extracted from old index) ──

const RANDOM_MSGS = privConfig.random_msgs ?? [
    'Stay hydrated💧','👁️',
    'https://tenor.com/view/saba-sameko-saba-vtuber-saba-stare-fish-vtuber-gif-16837510218267028334',
    'https://cdn.discordapp.com/attachments/1368624032915652798/1385673005543194644/mor37222_-_1935806122440769789.gif?ex=6866154d&is=6864c3cd&hm=e7d99a84ed1dff3b0b554df7cca98764423615f9850b5bbbb9c06959d412d936&',
    'https://tenor.com/view/robin-robin-hsr-hsr-honkai-star-rail-soundoriented-gif-11898432521776141262',
    'https://tenor.com/view/scooby-doo-mystery-machine-cartoons-gif-18861458',
    'https://tenor.com/view/stop-stealing-my-gifs-franklin-saint-gif-11576013489607767524',
    'https://tenor.com/view/tung-tung-tung-sahur-alexcraft7192-brainrot-funny-meme-gif-4715879311681591702',
    'https://tenor.com/view/kc3-kai-cenat-dancing-gif-8555711709355605378',
    'https://tenor.com/view/slim-shady-eminem-zombie-land-saga-rap-god-rap-gif-20615824',
    'https://tenor.com/view/playing-dad-father-and-son-gif-15302231',
    'https://cdn.discordapp.com/attachments/1349021437389836351/1369588968886374490/Snapchat-957527208.jpg?ex=681dba1f&is=681c689f&hm=aee5a40e8a173265ce3ec1cec60b40a700ee19f795ce5501edce1c970362f904&',
    'https://tenor.com/view/bocchi-the-rock-bocchi-bocchi-dance-anime-dance-anime-cute-dance-gif-8640564821222907754',
    'https://tenor.com/view/miyabi-hoshimi-miyabi-miyabi-zzz-zenless-zone-zero-gif-12882626072026445974',
    'https://tenor.com/view/haii-hi-cat-kawaii-shadow-moses-gif-25909724',
    'https://tenor.com/view/ninja-fortnite-gamer-chair-fan-gif-8096875456019717833',
    'https://media.tenor.com/ikMNH_m3IKwAAAAC/ass-server-this-server-so-ass.gif',
    'https://tenor.com/view/pou-explosion-gif-gif-8917358471656223563',
    'https://tenor.com/view/crazy-rubber-room-gif-10524477174166992043',
    'https://cdn.discordapp.com/attachments/1330439659163095072/1403590273900216340/image.png?ex=68981ace&is=6896c94e&hm=8b0116a3f659ea71addbbd1c1a8e27a9213cb72e800ab9b1fc323fd6aeb32c24&',
    'https://tenor.com/view/sameko-saba-saba-vtuber-gif-168684179404108859',
    'https://tenor.com/view/suichan-gif-12778579481454310893',
    'https://tenor.com/view/fuwawa-eheh-eheheh-chibi-abyssgard-gif-7773982025085371939',
    'https://tenor.com/view/doobin-dooby3d-doob-dooby-dance-dooby3d-dance-gif-6582174353027662320',
    'https://tenor.com/view/nerissa-ravencroft-nerissa-rissa-hips-dance-gif-8607017259203000719',
    'https://tenor.com/view/zzz-zenless-zone-zero-kiroko96-ellen-joe-gif-15296614147472758947',
    'https://tenor.com/view/cantarella-wuwa-cantarella-wuwa-wuwa-cantarella-wuthering-gif-6716962597894312878',
    'https://tenor.com/view/miyabi-hoshimi-miyabi-zzz-disagreement-disagree-gif-2514870511680637718',
    'https://tenor.com/view/gigi-murin-gif-10547832950987970776',
    'https://tenor.com/view/dokibird-shock-shocked-reaction-vtuber-gif-3184297915140176134',
    'https://tenor.com/view/saba-sameko-fish-surprise-shock-gif-7813141461308805572',
    'https://tenor.com/view/perosna5-gif-12452700',
    'https://tenor.com/view/tuff-sick-wow-wowsers-minecraft-gif-10059021701103936359',
    'https://tenor.com/view/carti-backrooms-travis-scott-gif-8638223596627175438',
    'https://tenor.com/view/carti-blick-sum-gif-playboi-carti-gif-blick-sum-latto-blick-sum-gif-9898218780544084009',
    'https://cdn.discordapp.com/attachments/1353153870854885387/1402828634644942949/IMG_3713.jpg?ex=6897f879&is=6896a6f9&hm=3bdf720a6229bf8c478a29047601ec66e407e4b7d03465d7b7e29b8e9feb4e03&',
    'https://tenor.com/view/paldo-loona-loossemble-hyunjin-cute-gif-13177800198050094961',
    'https://tenor.com/view/yui-hirasawa-k-on-im-going-to-kill-myself-die-anime-girl-gif-1718982061284062723',
    'https://tenor.com/view/persona5-takemi-gif-18310437',
    'https://tenor.com/view/cipher-honkai-star-rail-hsr-yuri-where-the-yuri-at-gif-6722209646095238979',
    'https://tenor.com/view/takemi-mikujo-persona-dhar-man-dhar-mann-gif-16441343114801646436',
    'https://cdn.discordapp.com/attachments/669224390139052112/1392475263962710079/attachment.gif?ex=6897e0e5&is=68968f65&hm=29892d5a6801d4bd2fa79f62fb940604ef72b47d1b11a3b1895e7c83239aff2b&',
    'https://tenor.com/view/mambo-ume-usume-chibi-dance-anime-gif-10304596603435351987',
    'https://tenor.com/view/happy-anime-girl-anime-happy-jumping-gif-11351867894405026979',
    'https://tenor.com/view/medusa-stare-snakes-gif-13755442',
    'https://cdn.discordapp.com/attachments/1330439659163095072/1403593903252308068/xt0mHHY34LdZZFmuhlWghkaIelEe83yOuYeU1jnJF9w7GZys4Z.png?ex=68981e30&is=6896ccb0&hm=134ffc575cc3283811e784511f6702de8b9421ce45e7ded2b5cbcff7b502c0a3&',
    'https://tenor.com/view/asgore-knight-gif-10095168295952009600',
    'https://cdn.discordapp.com/attachments/1403034340694425712/1451428115627642880/IMG_9865.jpg?ex=69462344&is=6944d1c4&hm=7813ad70d64cc4a1d47a78002237e491dba5573bbb0d3baa18832a96ca638b57&',
    'https://tenor.com/view/sparkle-sparxie-hsr-honkai-star-rail-elation-gif-7211878678690487288',
    'https://tenor.com/view/masked-fool-hibana-honkai-star-rail-sparxie-honkai-star-rail-hibana-hsr-sparxie-hsr-gif-6148878037404596276',
    'https://tenor.com/view/manhattan-cafe-manhattan-cafe-uma-musume-manhattan-cafe-umamusume-dance-cute-gif-14514884201447499027',
    'https://tenor.com/view/lynae-wuthering-waves-wuwa-scan-gif-1406042117873893246',
    'https://cdn.discordapp.com/attachments/1424378605609160814/1475322482675417190/IMG_0703.jpg?ex=699d10a2&is=699bbf22&hm=a8d1e41bdf5172a3ae757eac745cef63a035bbddaf207f71643a5cbcc9f0ec63&',
    'https://tenor.com/view/vestia-zeta-moona-hoshinova-zeta-moona-3d-gif-1620233575719242973',
]

async function autoVcLoop(client) {
    if (!privConfig.auto_vc_channels?.length) return
    while (!client.destroyed) {
        for (const vc of privConfig.auto_vc_channels) {
            try {
                const guild = client.guilds.cache.get(String(vc.guild_id))
                const channel = client.channels.cache.get(String(vc.channel_id))
                if (!guild || !channel) continue
                
                const existing = getVoiceConnection(String(vc.guild_id))
                if (!existing || [VoiceConnectionStatus.Disconnected, VoiceConnectionStatus.Destroyed].includes(existing.state.status)) {
                    if (existing) { try { existing.removeAllListeners(); existing.destroy() } catch {} }
                    const conn = joinVoiceChannel({ 
                        channelId: String(vc.channel_id), 
                        guildId: String(vc.guild_id), 
                        adapterCreator: guild.voiceAdapterCreator, 
                        selfDeaf: true, 
                        selfMute: true 
                    })
                    await entersState(conn, VoiceConnectionStatus.Ready, 6_000).catch(() => {})
                }
            } catch (e) { console.error(`[AutoVC] Error in guild ${vc.guild_id}:`, e.message) }
        }
        await new Promise(r => setTimeout(r, 60_000))
    }
}

async function announcerLoop(client) {
    if (!privConfig.announcer_channel_id) return
    while (!client.destroyed) {
        const ch = client.channels.cache.get(privConfig.announcer_channel_id)
        if (ch) try { await ch.send(RANDOM_MSGS[Math.floor(Math.random() * RANDOM_MSGS.length)]) } catch (e) { console.error('[Announcer]', e) }
        await new Promise(r => setTimeout(r, 6_200_000))
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFY, button-based verification system
// Set verify_channel_id, verify_message_id, verify_role_ids in config.json to enable.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleVerify(interaction) {
    if (!_verifyRoles.length) return false
    if (!interaction.isButton() || interaction.customId !== 'verify_button') return false
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const guild = interaction.guild
    if (!guild) { await interaction.followUp({ content: '⚠️ Guild not found.', flags: MessageFlags.Ephemeral }); return true }
    try {
        const member  = await guild.members.fetch(interaction.user.id)
        const roles   = _verifyRoles.map(id => guild.roles.cache.get(id)).filter(Boolean)
        const missing = roles.filter(r => !member.roles.cache.has(r.id))
        if (!missing.length) { await interaction.followUp({ content: "You're already verified!", flags: MessageFlags.Ephemeral }); return true }
        await member.roles.add(missing, 'User clicked verify.')
        await interaction.followUp({ content: 'Verified successfully! You can message now.', flags: MessageFlags.Ephemeral })
    } catch { await interaction.followUp({ content: '⚠️ Error verifying. Try rejoining.', flags: MessageFlags.Ephemeral }) }
    return true
}


// ═══════════════════════════════════════════════════════════════════════════════
// KEYWORDS, server-specific keyword triggers with escalating timeout
// Edit KW_GROUPS and WORD_TRIGGERS below. Clear to disable.
// ═══════════════════════════════════════════════════════════════════════════════
const COOLDOWN_SEC = 30

const KW_GROUPS = [
    {
        phrases: ['mambo'],
        key: 'kuro',
        responses: [
            'https://tenor.com/view/mambo-uma-musume-gif-13573514226392127213',
            'https://cdn.discordapp.com/attachments/1420412929823477981/1420413071498936452/g2rjoy83wmdf1.gif',
            'https://cdn.discordapp.com/attachments/1420412929823477981/1420413072744648906/wryr3anhmrif1.gif',
            'https://cdn.discordapp.com/attachments/1420412929823477981/1420413074099404851/download_4.jpg',
            'https://cdn.discordapp.com/attachments/1420412929823477981/1420413075537920123/uma-musume-matikane-tannhauser.gif',
            'https://cdn.discordapp.com/attachments/1420412929823477981/1420413076225917109/mambo_hachimi_on_TikTok.jpg',
            'https://cdn.discordapp.com/attachments/1420412929823477981/1420413077018513570/download_2.jpg',
            'https://cdn.discordapp.com/attachments/1420412929823477981/1420413077622624276/download_1.jpg',
            'https://media.discordapp.net/attachments/1424378605609160814/1448414258537824440/IMG_9752.jpg',
            'https://cdn.discordapp.com/attachments/1420412929823477981/1449494459917275136/IMG_9707.jpg',
            'https://cdn.discordapp.com/attachments/1403034340694425712/1451428115627642880/IMG_9865.jpg',
            'https://cdn.discordapp.com/attachments/1424378605609160814/1475322482675417190/IMG_0703.jpg',
        ],
    },
    {
        phrases: ['paldo'],
        key: 'layan',
        responses: [
            'https://cdn.discordapp.com/attachments/1353153870854885387/1402828634644942949/IMG_3713.jpg',
            'https://cdn.discordapp.com/attachments/1353153870854885387/1402827912503230625/IMG_3743.jpg',
            'https://cdn.discordapp.com/attachments/1353153870854885387/1402827912230604950/IMG_3744.jpg',
            'https://cdn.discordapp.com/attachments/1353153870854885387/1402827911874220112/IMG_3745.jpg',
            'https://cdn.discordapp.com/attachments/1353153870854885387/1402827911433556048/IMG_3746.jpg',
            'https://cdn.discordapp.com/attachments/1353153870854885387/1402827911165251634/IMG_3747.jpg',
            'https://cdn.discordapp.com/attachments/1353153870854885387/1402827910879907920/IMG_3748.jpg',
            'https://cdn.discordapp.com/attachments/1353153870854885387/1402827910485774439/IMG_3749.jpg',
            'https://tenor.com/view/paldo-loona-loossemble-hyunjin-cute-gif-13177800198050094961',
            'https://cdn.discordapp.com/attachments/1353153870854885387/1417160980583944294/IMG_4477.jpg',
            'https://cdn.discordapp.com/attachments/1353153870854885387/1417160981477326858/IMG_4476.jpg',
            'https://cdn.discordapp.com/attachments/1353153870854885387/1417160981787836616/IMG_4475.jpg',
            'https://cdn.discordapp.com/attachments/1353153870854885387/1417160982093889656/IMG_4479.jpg',
            'https://cdn.discordapp.com/attachments/1403034340694425712/1449459749291823184/IMG_5801.jpg',
            'https://cdn.discordapp.com/attachments/1403034340694425712/1449459749572706496/IMG_5800.jpg',
            'https://cdn.discordapp.com/attachments/1403034340694425712/1449459750126489600/IMG_5798.jpg',
            'https://cdn.discordapp.com/attachments/1403034340694425712/1449459750386401310/IMG_5419.jpg',
        ],
    },
]

const WORD_TRIGGERS = [
    { word: 'clove', response: 'https://tenor.com/view/clove-clove-valorant-valorant-clove-clove-dance-clove-valorant-dance-gif-2770676594616560266' },
]

const kwCooldowns = new Map()
const kysTracker  = new Map()

setInterval(() => {
    const now = Date.now()
    for (const [k, ts] of kwCooldowns) if (now - ts > 3_600_000) kwCooldowns.delete(k)
    for (const [k, v]  of kysTracker)  if (now - v.lastUsed > 86_400_000) kysTracker.delete(k)
}, 60_000).unref()

async function handleKeywords(message) {
    const contentLower = message.content.toLowerCase().trim()
    const userId       = message.author.id
    const now          = Date.now()

    for (const { phrases, key, responses } of KW_GROUPS) {
        if (!phrases.includes(contentLower)) continue
        const ck   = `${userId}_${key}`
        const last = kwCooldowns.get(ck) ?? 0
        if ((now - last) / 1000 < COOLDOWN_SEC) break
        kwCooldowns.set(ck, now)
        let t = kysTracker.get(userId) ?? { count: 0, timeoutMinutes: 5, lastUsed: null }
        if (t.lastUsed && (now - t.lastUsed) > 120_000) { t.count = 1; t.timeoutMinutes = 5 }
        else t.count++
        t.lastUsed = now
        kysTracker.set(userId, t)
        if (t.count >= 3) {
            try {
                const member = await message.guild.members.fetch(userId)
                // Cap at Discord's max timeout (28 days = 40320 minutes)
                const MAX_TIMEOUT_MINUTES = 40320
                const duration = Math.min(t.timeoutMinutes, MAX_TIMEOUT_MINUTES)
                await member.timeout(duration * 60_000, 'Keyword spam timeout')
                await message.reply(`**shut it, ${message.author.displayName}**, timeout: ${duration}m`)
                t.timeoutMinutes = Math.min(t.timeoutMinutes * 2, MAX_TIMEOUT_MINUTES)
            } catch { await message.reply(key === 'kuro' ? 'mamabo?' : `${key}?`) }
        } else {
            await message.reply(responses[Math.floor(Math.random() * responses.length)])
        }
        break
    }

    for (const { word, response } of WORD_TRIGGERS) {
        if (contentLower.includes(word)) await message.channel.send(response)
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SNAKE, med,snake
// Uses 'snake_*' button IDs to avoid collision with private.js 'sn_*' IDs
// ═══════════════════════════════════════════════════════════════════════════════
const GRID    = 16
const TICK    = 1000
const TIMEOUT = 90_000

function spawnFood(snake) {
    let pos
    do { pos = [Math.floor(Math.random() * GRID), Math.floor(Math.random() * GRID)] }
    while (snake.some(([x, y]) => x === pos[0] && y === pos[1]))
    return pos
}

function renderBoard(snake, food, mention) {
    const board = Array.from({ length: GRID }, () => Array(GRID).fill('⬛'))
    board[food[0]][food[1]] = '🍎'
    for (let i = 0; i < snake.length; i++) {
        const [x, y] = snake[i]; board[x][y] = i === 0 ? '🟢' : '🟩'
    }
    return new EmbedBuilder()
        .setTitle('🐍 Medusa Arcade: Snake')
        .setDescription(`**Player:** ${mention}\n**Score:** \`${snake.length - 1}\``)
        .addFields({ name: 'Board', value: board.map(r => r.join('')).join('\n') })
        .setColor(0x1D9E75)
        .setFooter({ text: 'Use buttons to steer • Powered by Medusa' })
        .setTimestamp()
}

function renderGameOver(snake, mention) {
    return new EmbedBuilder()
        .setTitle('💀 Game Over')
        .setDescription(`**Player:** ${mention}\n**Final Score:** \`${snake.length - 1}\``)
        .setColor(0xE24B4A).setTimestamp()
}

function buildControls() {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('snake_up').setLabel('⬆️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('snake_down').setLabel('⬇️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('snake_left').setLabel('⬅️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('snake_right').setLabel('➡️').setStyle(ButtonStyle.Secondary),
    )]
}

const DIR_MAP  = { snake_up:[-1,0], snake_down:[1,0], snake_left:[0,-1], snake_right:[0,1] }
const OPPOSITE = { snake_up:'snake_down', snake_down:'snake_up', snake_left:'snake_right', snake_right:'snake_left' }

async function runSnake(message) {
    let snake = [[7,7]], food = spawnFood([[7,7]]), dir = [0,1], curKey = 'snake_right'
    let running = true, timedOut = false
    const mention = message.author.toString()
    const msg = await message.reply({ embeds: [renderBoard(snake, food, mention)], components: buildControls() })
    const col = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: TIMEOUT })
    col.on('collect', async i => {
        if (i.user.id !== message.author.id) return i.reply({ content: '❌ Not your game.', flags: MessageFlags.Ephemeral })
        if (DIR_MAP[i.customId] && OPPOSITE[i.customId] !== curKey) { dir = DIR_MAP[i.customId]; curKey = i.customId }
        await i.deferUpdate()
    })
    col.on('end', (_, reason) => { if (reason === 'time') timedOut = true; running = false })
    while (running) {
        await new Promise(r => setTimeout(r, TICK))
        if (!running) break
        const [hx, hy] = snake[0], [dx, dy] = dir, head = [hx+dx, hy+dy]
        const oob  = head[0] < 0 || head[0] >= GRID || head[1] < 0 || head[1] >= GRID
        const self = snake.some(([x,y]) => x === head[0] && y === head[1])
        if (oob || self) {
            running = false; col.stop('gameover')
            try { await msg.edit({ embeds: [renderGameOver(snake, mention)], components: [] }) } catch {}
            break
        }
        snake.unshift(head)
        if (head[0] === food[0] && head[1] === food[1]) food = spawnFood(snake)
        else snake.pop()
        try { await msg.edit({ embeds: [renderBoard(snake, food, mention)], components: buildControls() }) }
        catch { running = false; col.stop('error') }
    }
    if (timedOut) try { await msg.edit({ content: '⏱️ Timed out.', embeds: [renderGameOver(snake, mention)], components: [] }) } catch {}
}

const TAV_PERM        = 772499734207660042n
const CALL_EMOJIS     = ['<:call1:1475608957908156466>', '<:call2:1475608956553400523>']
const CALL_TIMEOUT    = 600_000
const MAIL_HINT       = '-# Use /mail to send messages to the developer (Tav)'
const MAIL_CHANNEL_ID = '1476366809316851862'
const MAIL_GUILD_ID   = '1279895010111655999'
const MAIL_DAILY_LIMIT = 3
const CALLERS_FILE    = 'configs/callers.json'

function loadCallers() {
    try {
        // one-time move from the old call-d/ location
        if (!fs.existsSync(CALLERS_FILE) && fs.existsSync('call-d/callers.json')) {
            fs.mkdirSync('configs', { recursive: true })
            fs.renameSync('call-d/callers.json', CALLERS_FILE)
        }
    } catch {}
    try {
        if (fs.existsSync(CALLERS_FILE)) return JSON.parse(fs.readFileSync(CALLERS_FILE, 'utf8'))
    } catch {}
    return {}
}

class CallManager {
    constructor(client) {
        this.client      = client
        this.activeCalls = new Map()
        this.mailUsage   = new Map()
        this._callers    = loadCallers()
    }

    cfg(userId) { return this._callers[String(userId)] ?? null }

    async getDM(userId) {
        try {
            const user = this.client.users.cache.get(String(userId)) ?? await this.client.users.fetch(String(userId))
            return await user.createDM()
        } catch { return null }
    }

    async startCall(interaction, serverId, channelId, attachment) {
        const cfg = this.cfg(interaction.user.id)
        if (!cfg) return interaction.reply({ content: '❗ this command is not implemented yet', flags: MessageFlags.Ephemeral })

        const srcChannel = interaction.channel ?? await this.getDM(interaction.user.id)
        if (!srcChannel) return interaction.reply({ content: '❗ Could not resolve source channel.', flags: MessageFlags.Ephemeral })

        if (this.activeCalls.has(srcChannel.id))
            return interaction.reply({ content: '❗ A call is already active in this channel.', flags: MessageFlags.Ephemeral })

        const targetGuild = this.client.guilds.cache.get(serverId)
        if (!targetGuild) return interaction.reply({ content: '❗ this command is not implemented yet', flags: MessageFlags.Ephemeral })
        const targetChannel = targetGuild.channels.cache.get(channelId)
        if (!targetChannel || targetChannel.type !== ChannelType.GuildText)
            return interaction.reply({ content: '❗ this command is not implemented yet', flags: MessageFlags.Ephemeral })

        await interaction.deferReply({ flags: MessageFlags.Ephemeral })

        const emoji  = BigInt(interaction.user.id) === TAV_PERM ? CALL_EMOJIS[Math.floor(Math.random() * 2)] : null
        const prefix = emoji ? `${emoji} | ` : ''

        let callMsg
        try {
            callMsg = await targetChannel.send({ content: `${prefix}${cfg.calling_msg}`, flags: [MessageFlags.SuppressNotifications] })
        } catch { return interaction.followUp({ content: '**connection got interrupted** ‼️', flags: MessageFlags.Ephemeral }) }

        await new Promise(r => setTimeout(r, 2000))

        try {
            await callMsg.edit({ content: `${prefix}${cfg.calling_msg}\n-# connection has been made! ${cfg.connected_suffix}` })
        } catch { return interaction.followUp({ content: '**connection got interrupted** ‼️', flags: MessageFlags.Ephemeral }) }

        if (attachment) {
            try { await targetChannel.send({ files: [attachment.url] }) } catch {}
        }

        const state = {
            callerId:       interaction.user.id,
            targetChannelId: targetChannel.id,
            targetGuildId:  targetGuild.id,
            srcChannel,
            lastMsgTime:    Date.now(),
            msgMap:         new Set(),
        }
        this.activeCalls.set(srcChannel.id, state)
        state.timeoutRef = setInterval(() => this._checkTimeout(srcChannel.id), 30_000)

        await interaction.followUp({ content: `📞 Call connected to **${targetGuild.name}** / **#${targetChannel.name}**`, flags: MessageFlags.Ephemeral })
    }

    async endCall(srcChannelId, reason = 'manual') {
        const call = this.activeCalls.get(srcChannelId)
        if (!call) return
        clearInterval(call.timeoutRef)
        this.activeCalls.delete(srcChannelId)
        const target = this.client.channels.cache.get(call.targetChannelId)
        if (target) try { await target.send({ content: "🐍 | snake's out (connection closed)" }) } catch {}
    }

    _checkTimeout(srcChannelId) {
        const call = this.activeCalls.get(srcChannelId)
        if (!call) return
        if (Date.now() - call.lastMsgTime >= CALL_TIMEOUT) {
            this.endCall(srcChannelId, 'timeout').then(() => {
                call.srcChannel?.send({ content: "🐍 | snake's out (connection closed)" }).catch(() => {})
            })
        }
    }

    async sendMail(source, messageText, attachment) {
        const userId = source.user.id
        const today  = new Date().toDateString()
        const rec    = this.mailUsage.get(userId)

        if (rec?.date === today && rec.count >= MAIL_DAILY_LIMIT)
            return { ok: false, error: 'daily mail limit reached (3/3)' }

        const count = (rec?.date === today ? rec.count : 0) + 1
        this.mailUsage.set(userId, { date: today, count })

        try {
            const guild   = this.client.guilds.cache.get(MAIL_GUILD_ID)
            if (!guild) throw new Error('mail guild not found')
            const channel = guild.channels.cache.get(MAIL_CHANNEL_ID)
            if (!channel) throw new Error('mail channel not found')

            const embed = new EmbedBuilder()
                .setDescription(messageText)
                .setColor(0x5865F2)
                .setAuthor({ name: `${source.user.tag} (${source.user.id})`, iconURL: source.user.displayAvatarURL() })
                .setFooter({ text: source.guild ? `from ${source.guild.name} • #${source.channel?.name}` : 'from DMs' })
                .setTimestamp()

            const files = attachment ? [attachment.url] : []
            await channel.send({ content: '📬 new mail', embeds: [embed], files })
        } catch (e) {
            this.mailUsage.set(userId, { date: today, count: count - 1 })
            return { ok: false, error: e.message }
        }

        const remaining = MAIL_DAILY_LIMIT - count
        return { ok: true, remaining }
    }

    async handleMailSend(interaction, messageText, attachment) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        const result = await this.sendMail(interaction, messageText, attachment)
        if (!result.ok)
            return interaction.followUp({ content: `❌️ | **an error has occurred** : \`${result.error}\``, flags: MessageFlags.Ephemeral })
        const remText = result.remaining === 1 ? '1 remaining mail left for today' : `${result.remaining} remaining mails left for today`
        await interaction.followUp({ content: `💌 | **mailed successfully**\n-# ${remText}`, flags: MessageFlags.Ephemeral })
    }

    async onMessage(message) {
        if (message.author.bot) return

        const cfg  = this.cfg(message.author.id)
        const call = this.activeCalls.get(message.channel.id)

        if (cfg && call && call.callerId === message.author.id) {
            const target = this.client.channels.cache.get(call.targetChannelId)
            if (target) {
                call.lastMsgTime = Date.now()
                const parts = []
                if (message.content) {
                    let content = message.content
                    if (!cfg.secure) content = content.replace(/@everyone/g, '@\u200beveryone').replace(/@here/g, '@\u200bhere')
                    parts.push(`**${cfg.display}** : ${content}`)
                }
                if (cfg.reply_hint) parts.push(cfg.reply_hint)
                parts.push(MAIL_HINT)

                const files = []
                for (const att of message.attachments.values()) files.push(att.url)

                try {
                    const payload = { content: parts.join('\n') };
                    if (files.length) payload.files = files;
                    const fwd = await target.send(payload);
                    
                    call.msgMap.add(fwd.id)
                        if (call.msgMap.size > 1000) {
                            const arr = [...call.msgMap]
                            call.msgMap = new Set(arr.slice(arr.length - 800))
                        }
                } catch (e) { console.error('[Call] Forward error:', e) }
            }
            return
        }

        if (message.reference?.messageId) {
            const refId = message.reference.messageId
            for (const [, c] of this.activeCalls) {
                if (message.channel.id === c.targetChannelId && c.msgMap.has(refId)) {
                    const src = c.srcChannel
                    if (!src) break
                    const content = message.content
                        ? `↩️ **${message.member?.displayName ?? message.author.username}** replied: ${message.content}`
                        : `↩️ **${message.member?.displayName ?? message.author.username}** replied:`
                    const files = []
                    for (const att of message.attachments.values()) files.push(att.url)
                    try { await src.send({ content, files: files.length ? files : [] }) } catch {}
                    break
                }
            }
        }
    }
}

function buildCallCommands() {
    return [
        new SlashCommandBuilder()
            .setName('call')
            .setDescription('this command is not implemented yet')
            .addStringOption(o => o.setName('server').setDescription('this command is not implemented yet').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('channel').setDescription('this command is not implemented yet').setRequired(true).setAutocomplete(true))
            .addAttachmentOption(o => o.setName('attachment').setDescription('this command is not implemented yet')),

        new SlashCommandBuilder()
            .setName('calle')
            .setDescription('this command is not implemented yet'),

        new SlashCommandBuilder()
            .setName('mail')
            .setDescription('feedback, enterprise, bug report, concerns')
            .addStringOption(o => o.setName('message').setDescription('your message to the developer').setRequired(true))
            .addAttachmentOption(o => o.setName('attachment').setDescription('optional file to attach')),
    ].map(c => c.toJSON())
}

async function dispatchCall(interaction, mgr) {
    const cmd = interaction.commandName
    if (cmd === 'call')
        return mgr.startCall(
            interaction,
            interaction.options.getString('server', true),
            interaction.options.getString('channel', true),
            interaction.options.getAttachment('attachment'),
        )
    if (cmd === 'calle') {
        const active = mgr.activeCalls.has(interaction.channelId)
        if (active) await mgr.endCall(interaction.channelId)
        return interaction.reply({
            content: active ? '📞 Call ended.' : '❗ No active call in this channel.',
            flags: MessageFlags.Ephemeral,
        })
    }
    if (cmd === 'mail')
        return mgr.handleMailSend(
            interaction,
            interaction.options.getString('message', true),
            interaction.options.getAttachment('attachment'),
        )
    return false
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Extension API
// ─────────────────────────────────────────────────────────────────────────────
let _callMgr = null
let _verifyRoles = []

export function init(client, db, heart) {
    // ── priv: AutoVC + Announcer ──
    if (heart) {
    if (privConfig.auto_vc_channels?.length) heart.fire(autoVcLoop(client), 'auto_vc', 0)
    if (privConfig.announcer_channel_id)      heart.fire(announcerLoop(client), 'announcer', 0)
    } else {
        console.warn('[Private] Heartbeat not provided, loops will not start.')
    }

    // ── extras: verify role load + snake command ──
    try {
        const cfg = JSON.parse(readFileSync('config.json', 'utf8'))
        const roles = cfg.verify_role_ids ?? []
        if (cfg.verify_channel_id && cfg.verify_message_id && roles.length) {
            _verifyRoles = roles
            console.log(`[Private] Verify enabled with ${roles.length} role(s)`)
        }
    } catch {}
    client.commands.set('snake', async (msg) => {
        try { await runSnake(msg) } catch (e) { console.error('[Private] Snake error:', e) }
    })

    // ── call: CallManager ──
    _callMgr = new CallManager(client)
    client.sendDeveloperMail = (message, text, attachment = null) =>
        _callMgr.sendMail(
            { user: message.author, guild: message.guild, channel: message.channel },
            text,
            attachment,
        )
    client.on('interactionCreate', async interaction => {
        if (!interaction.isAutocomplete() || interaction.commandName !== 'call') return
        const focused = interaction.options.getFocused(true)
        if (focused.name === 'server') {
            return interaction.respond(
                client.guilds.cache.filter(g => g.name.toLowerCase().includes(focused.value.toLowerCase()))
                    .map(g => ({ name: g.name, value: g.id })).slice(0, 25)
            )
        }
        if (focused.name === 'channel') {
            const guild = client.guilds.cache.get(interaction.options.getString('server'))
            return interaction.respond(
                guild ? guild.channels.cache
                    .filter(c => c.type === 0 && c.name.toLowerCase().includes(focused.value.toLowerCase()))
                    .map(c => ({ name: `# ${c.name}`, value: c.id })).slice(0, 25) : []
            )
        }
    })

    console.log('[Private] Announcer, AutoVC, keywords, snake, verify, call, mail, timezones ready')
}

export async function handleMessage(message) {
    if (message.author.bot) return
    // keywords (extras)
    if (message.guild && (KW_GROUPS.length || WORD_TRIGGERS.length)) await handleKeywords(message)
    // call forwarding
    if (_callMgr) await _callMgr.onMessage(message)
}

export async function handleInteraction(interaction) {
    // verify button
    if (await handleVerify(interaction)) return true
    // tz paginator buttons + /tz* commands
    if (await handleTzInteraction(interaction)) return true
    // owner slash commands (private)
    if (interaction.isChatInputCommand()) {
        const privHandled = await _handlePrivateInteraction(interaction)
        if (privHandled) return true
        // call commands
        if (_callMgr && ['call', 'calle', 'mail'].includes(interaction.commandName)) {
            await dispatchCall(interaction, _callMgr)
            return true
        }
    }
    return false
}

export function getSlashCommands() {
    return [
        ...(_buildPrivateSlashCommands()),
        ...buildCallCommands(),
        ...buildTzSlashCommands().map(c => c.toJSON()),
    ]
}

// ── Private slash commands (formerly private.js getSlashCommands) ──
function _buildPrivateSlashCommands() {
    return [
        new SlashCommandBuilder().setName('snap').setDescription('.').addStringOption(o => o.setName('role-id').setDescription('Role ID').setRequired(true)).setDefaultMemberPermissions(0).setContexts(0),
        new SlashCommandBuilder().setName('snaps').setDescription('.').setDefaultMemberPermissions(0).setContexts(0),
        new SlashCommandBuilder().setName('reload-config').setDescription('.').setDefaultMemberPermissions(0).setContexts(0),
    ].map(c => c.toJSON())
}

// ── Private interaction handler (formerly handleInteraction in private.js) ──
async function _handlePrivateInteraction(interaction) {
    const { commandName } = interaction
    const handled = ['snap', 'snaps', 'reload-config']
    if (!handled.includes(commandName)) return false
    const uid = BigInt(interaction.user.id)

    if (commandName === 'snap') {
        if (uid !== BOT_OWNER_ID) { interaction.reply({ content: 'this command is not implemented', flags: MessageFlags.Ephemeral }); return true }
        if (!interaction.guild) { interaction.reply({ content: 'this command can only be used in a server', flags: MessageFlags.Ephemeral }); return true }
        const roleId = interaction.options.getString('role-id')
        try {
            const role = interaction.guild.roles.cache.get(roleId)
            if (!role) { interaction.reply({ content: 'Role not found', flags: MessageFlags.Ephemeral }); return true }
            if (role.comparePositionTo(interaction.guild.members.me.roles.highest) >= 0) { interaction.reply({ content: 'this role is above me', flags: MessageFlags.Ephemeral }); return true }
            if (interaction.member.roles.cache.has(roleId)) await interaction.member.roles.remove(role)
            else await interaction.member.roles.add(role)
            await interaction.reply({ content: 'done :white_check_mark:', flags: MessageFlags.Ephemeral })
        } catch { await interaction.reply({ content: 'An error occurred', flags: MessageFlags.Ephemeral }) }
        return true
    }
    if (commandName === 'snaps') {
        if (uid !== BOT_OWNER_ID) { interaction.reply({ content: 'this command is not implemented yet', flags: MessageFlags.Ephemeral }); return true }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        const guilds = [...interaction.client.guilds.cache.values()]
        if (!guilds.length) { interaction.followUp({ content: 'No servers found.', flags: MessageFlags.Ephemeral }); return true }
        let idx = 0
        const buildEmbed = async (g) => {
            const owner = g.members.cache.get(g.ownerId)
            const me = g.members.me
            return new EmbedBuilder().setTitle(`${g.name} - ${owner?.displayName ?? g.ownerId}`).setColor(0x378ADD)
                .setDescription(`🐍 Medusa: ✅\n👁️ Tav: ${g.members.cache.has(String(BOT_OWNER_ID)) ? '✅' : '❌'}\n📃 Cmds: ${me?.permissions.has(PermissionFlagsBits.SendMessages) ? '✅' : '❌'}\n🤖 AI: ${me?.permissions.has(PermissionFlagsBits.ModerateMembers) ? '✅' : '❌'}\n🆔 \`${g.id}\``)
                .setFooter({ text: `${g.memberCount} members • Page ${idx + 1}/${guilds.length}` })
        }
        const mkRow = (i) => new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('sn_left').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(i === 0),
            new ButtonBuilder().setCustomId('sn_right').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(i >= guilds.length - 1),
            new ButtonBuilder().setCustomId('sn_leave').setEmoji('🚪').setStyle(ButtonStyle.Danger),
        )
        await interaction.followUp({ embeds: [await buildEmbed(guilds[0])], components: [mkRow(0)], flags: MessageFlags.Ephemeral })
        const msg = await interaction.fetchReply()
        const col = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120_000 })
        col.on('collect', async i => {
            if (BigInt(i.user.id) !== BOT_OWNER_ID) return i.reply({ content: 'not yours', flags: MessageFlags.Ephemeral })
            if (i.customId === 'sn_left')  idx = Math.max(0, idx - 1)
            if (i.customId === 'sn_right') idx = Math.min(guilds.length - 1, idx + 1)
            if (i.customId === 'sn_leave') {
                try {
                    await guilds[idx].leave(); guilds.splice(idx, 1)
                    if (!guilds.length) { col.stop(); return i.update({ content: 'Left. No servers remaining.', embeds: [], components: [] }) }
                    if (idx >= guilds.length) idx = guilds.length - 1
                } catch (e) { return i.followUp({ content: `❌ ${e.message}`, flags: MessageFlags.Ephemeral }) }
            }
            await i.update({ embeds: [await buildEmbed(guilds[idx])], components: [mkRow(idx)] })
        })
        col.on('end', () => msg.edit({ components: [] }).catch(() => {}))
        return true
    }
    if (commandName === 'reload-config') {
        if (uid !== BOT_OWNER_ID) return true
        try {
            const fresh = JSON.parse(readFileSync('config.json', 'utf8').replace(/(?<=:\s*|\[\s*|,\s*)\b(\d{15,})\b(?=\s*[,}\]])/g, '"$1"'))
            const ai = interaction.client.aiCog
            if (!ai) { await interaction.reply({ content: '❌ AI cog not loaded.', flags: MessageFlags.Ephemeral }); return true }
            ai.temperature    = fresh.temperature    ?? ai.temperature
            ai.topP           = fresh.topP           ?? ai.topP
            ai.chatTokens     = fresh.chatTokens     ?? ai.chatTokens
            ai.researchTemp   = fresh.researchTemp   ?? ai.researchTemp
            ai.searchTokens   = fresh.searchTokens   ?? ai.searchTokens
            ai.visionTemp     = fresh.visionTemp     ?? ai.visionTemp
            ai.visionTokens   = fresh.visionTokens   ?? ai.visionTokens
            ai.maxHistory     = fresh.memoryDepth    ?? ai.maxHistory
            ai.allowDM        = fresh.allowDMs       ?? ai.allowDM
            ai.instructions   = fresh.systemPrompt   ?? ai.instructions
            ai.FunMsgInterval = ((fresh.FunMsgInterval ?? 5400)) * 1000
            ai.aiModel        = fresh.aiModel        ?? ai.aiModel
            ai.researchModel  = fresh.research_model ?? ai.researchModel
            ai.visionModel    = fresh.vision_model   ?? ai.visionModel
            ai.classifierModel= fresh.classifier_model ?? ai.classifierModel
            const freshGuilds  = fresh.guilds && typeof fresh.guilds === 'object' && !Array.isArray(fresh.guilds) ? fresh.guilds : {}
            ai.allowedGuilds   = new Set(Object.keys(freshGuilds).map(String))
            ai.pausedGuilds    = new Set(Object.keys(freshGuilds).filter(id => freshGuilds[id]?.ai === false).map(String))
            ai.alwaysActiveCh  = new Set((fresh.always_active_channels ?? []).map(String))
            ai.funChannels     = new Set((fresh.fun_channels ?? []).map(String))
            const newKeys = Array.isArray(fresh.llm_keys) ? fresh.llm_keys.filter(v => typeof v === 'string' && v.length > 20) : []
            if (newKeys.length) { ai.aiTokens = newKeys; ai.deadKeys.clear(); ai.keyFailures = {}; ai.currentKeyIdx = 0; ai._initGroq() }
            const triggers = fresh.triggers ?? 'medusa'
            ai.triggerWords   = (Array.isArray(triggers) ? triggers : triggers.split(',')).map(t => t.trim().toLowerCase()).filter(Boolean)
            ai._triggerRegexes = ai.triggerWords.map(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`))
            ai.userCache.clear()
            ai._config = fresh
            const freshPriv = readPriv()
            if (freshPriv) privConfig = freshPriv
            await interaction.reply({ content: `✅ Config reloaded. Model: \`${ai.aiModel}\` · Keys: \`${ai.aiTokens.length}\` · Triggers: \`${ai.triggerWords.join(', ')}\``, flags: MessageFlags.Ephemeral })
        } catch (e) {
            await interaction.reply({ content: `❌ Reload failed: ${e.message}`, flags: MessageFlags.Ephemeral })
        }
        return true
    }
    return false
}

// ─────────────────────────────────────────────────────────────────────────
// Timezones (merged from extensions/timezone.js), tracking + meeting-time finder
// Commands: /tzset, /tzremove, /tz, /tzbesttime, /tzis, /tzwhen
// Data lives in configs/timezones.json with async write-through.
// ─────────────────────────────────────────────────────────────────────────

// Data cache, lives in configs/ with the other generated files.
const DATA_FILE = 'configs/timezones.json';
let _cache = null;

// one-time move from the old repo-root location
if (!fs.existsSync(DATA_FILE) && fs.existsSync('timezones.json')) {
  try {
    fs.mkdirSync('configs', { recursive: true });
    fs.renameSync('timezones.json', DATA_FILE);
    console.log('[Timezone] Moved timezones.json into configs/');
  } catch (e) {
    console.error('[Timezone] Migration failed:', e.message);
  }
}

function getCache() {
  if (_cache === null) {
    _cache = fs.existsSync(DATA_FILE)
      ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
      : {};
  }
  return _cache;
}

function persistCache() {
  // Fire-and-forget. Caller never awaits, no interaction latency.
  fs.promises.writeFile(DATA_FILE, JSON.stringify(_cache, null, 2))
    .catch(err => console.error('[timezone] persist failed:', err.message));
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGINATION SESSIONS
// ─────────────────────────────────────────────────────────────────────────────
const PAGE_SIZE   = 10;
const SESSION_TTL = 10 * 60 * 1000; // 10 min
const _sessions   = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _sessions)
    if (v.expiresAt < now) _sessions.delete(k);
}, 5 * 60 * 1000).unref();

function createSession(type, lines, extra = {}) {
  const id = Math.random().toString(36).slice(2, 10);
  _sessions.set(id, { type, lines, extra, expiresAt: Date.now() + SESSION_TTL });
  return id;
}

function getSession(id) {
  const s = _sessions.get(id);
  if (!s || s.expiresAt < Date.now()) { _sessions.delete(id); return null; }
  return s;
}

function buildPageEmbed(session, page) {
  const { type, lines, extra } = session;
  const total = Math.ceil(lines.length / PAGE_SIZE);
  const slice = lines.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const footer = { text: `Page ${page + 1} of ${total} · ${lines.length} users` };

  if (type === 'tz') {
    return new EmbedBuilder()
      .setColor('#00CCFF').setTitle('🕐 All Saved Timezones')
      .setDescription(slice.join('\n')).setFooter(footer);
  }
  if (type === 'tzbt') {
    return new EmbedBuilder()
      .setColor('#FFD700').setTitle('🕐 Best Time to Meet')
      .setDescription(
        (page === 0 ? `**<t:${extra.ts}:t> (UTC ${extra.utcHour}:00)**\n` : '') +
        slice.join('\n')
      ).setFooter(footer);
  }
}

function buildPageRow(sessionId, page, totalLines) {
  const totalPages = Math.ceil(totalLines / PAGE_SIZE);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tzpage:${sessionId}:${page - 1}`)
      .setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`tzpage:${sessionId}:${page + 1}`)
      .setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TIME HELPERS, pure Intl, no network, DST handled by JS engine
// ─────────────────────────────────────────────────────────────────────────────
function getUTCOffsetLabel(tz) {
  try {
    const p = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find(p => p.type === 'timeZoneName');
    return (p?.value ?? '').replace('GMT', 'UTC');
  } catch { return ''; }
}

function getTZAbbreviation(tz) {
  try {
    const p = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date()).find(p => p.type === 'timeZoneName');
    return p?.value ?? '';
  } catch { return ''; }
}

function getTimeForTimezone(tz) {
  try {
    const time = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: tz,
    });
    return { time, abbreviation: getTZAbbreviation(tz), utcOffset: getUTCOffsetLabel(tz), tzName: tz };
  } catch { return null; }
}

function formatLabel(alias, tz) {
  const offset = getUTCOffsetLabel(tz);
  const a = alias.toUpperCase();
  if (offset && a !== offset && a !== offset.replace('UTC+', 'UTC') && a !== offset.replace('UTC-', 'UTC-'))
    return `${a} · ${offset}`;
  return a;
}

function hourDiff(tzA, tzB) {
  const parseMin = tz => {
    const m = getUTCOffsetLabel(tz).match(/UTC([+-])(\d+)(?::(\d+))?/);
    if (!m) return 0;
    return (m[1] === '+' ? 1 : -1) * (parseInt(m[2]) * 60 + parseInt(m[3] ?? 0));
  };
  return (parseMin(tzB) - parseMin(tzA)) / 60;
}

function formatDiff(diff) {
  if (diff === 0) return 'same timezone';
  const abs = Math.abs(diff);
  const h = Math.floor(abs), m = Math.round((abs - h) * 60);
  return `${diff > 0 ? '+' : '-'}${m ? `${h}h ${m}m` : `${h}h`} vs your time`;
}

// ─────────────────────────────────────────────────────────────────────────────
// REVERSE MAP, built lazily at first use (locationMap defined below)
// ─────────────────────────────────────────────────────────────────────────────
let _reverseMap = null;
const ABBR_RE = /^(UTC|ETC|EST|EDT|CST|CDT|MST|MDT|PST|PDT|AKS|AKD|HST|NST|NDT|AST|ADT|GMT|BST|WET|CET|EET|MSK|TRT|IST|PKT|BDT|ICT|SGT|MYT|PHT|HKT|JST|KST|GST|IRS|AFT|MMT|NPT|AES|AED|ACS|ACD|AWS|NZS|NZD|CHA|ART|BRT|CAT|EAT|WAT|SAS|SST|TOT|WIT|CIT|EIT|ET$|CT$|MT$|PT$)/;

function getReverseMap() {
  if (_reverseMap) return _reverseMap;
  _reverseMap = {};
  for (const [alias, zones] of Object.entries(locationMap)) {
    if (zones.length !== 1) continue;
    const tz = zones[0];
    (_reverseMap[tz] ??= new Set()).add(alias);
  }
  return _reverseMap;
}

function tzFooterInfo(tz) {
  const abbr   = getTZAbbreviation(tz);
  const offset = getUTCOffsetLabel(tz);
  const showAbbr = abbr.replace('GMT', 'UTC') !== offset ? abbr : null;
  const places = [...(getReverseMap()[tz] ?? [])]
    .filter(a => !ABBR_RE.test(a)).slice(0, 12).join(', ');
  return [showAbbr, offset, places].filter(Boolean).join('  ·  ');
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCATION LOOKUP
// ─────────────────────────────────────────────────────────────────────────────
function lookupLocation(input) {
  const key = input.trim().toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
  if (locationMap[key]) return { zones: locationMap[key], display: key };
  try {
    Intl.DateTimeFormat(undefined, { timeZone: input });
    return { zones: [input], display: input };
  } catch {}
  return null;
}

function canManageUser(interaction, targetId) {
  if (interaction.user.id === targetId) return true;
  if (!interaction.guild) return false; // DMs: only self allowed
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;
}

// Who's actually in the room: guild members in servers, the two heads in a DM,
// everyone in a group chat. Never the whole saved file.
async function tzVisibleIds(interaction, allIds) {
  try {
    if (interaction.guild) {
      const fetched = await interaction.guild.members.fetch({ user: allIds }).catch(() => null);
      const memberSet = fetched
        ? new Set(fetched.keys())
        : new Set(allIds.filter(id => interaction.guild.members.cache.has(id)));
      return allIds.filter(id => memberSet.has(id));
    }
    const channel = interaction.channel
      ?? await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
    if (channel?.type === ChannelType.GroupDM) {
      // User apps only get partial recipients here: usernames, no ids. Match by
      // id when we have one, otherwise by the username saved at /tzset time.
      const recips = channel.recipients ? [...channel.recipients.values()] : [];
      const ids = new Set([interaction.user.id]);
      const names = new Set();
      for (const r of recips) {
        if (r?.id) ids.add(r.id);
        if (r?.username) names.add(r.username.toLowerCase());
      }
      if (recips.length) {
        const cache = getCache();
        return allIds.filter(id =>
          ids.has(id)
          || names.has(String(cache[id]?.name ?? '').toLowerCase())
          || names.has(interaction.client.users.cache.get(id)?.username?.toLowerCase() ?? '\0'));
      }
    }
    if (channel?.type === ChannelType.DM) {
      const partnerId = channel.recipientId ?? channel.recipient?.id;
      if (partnerId) {
        const pair = new Set([interaction.user.id, partnerId]);
        return allIds.filter(id => pair.has(id));
      }
    }
  } catch {}
  // Discord hides DM participants from user apps entirely, so when the room
  // can't be read the full list beats a lonely one-entry embed.
  return allIds;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND HANDLERS
// ─────────────────────────────────────────────────────────────────────────────
async function cmdTzset(interaction) {
  const user     = interaction.options.getUser('user');
  const rawInput = interaction.options.getString('timezone');

  if (!canManageUser(interaction, user.id)) {
    return interaction.reply({
      content: '❌ You can only set your own timezone unless you have ManageMessages.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const result = lookupLocation(rawInput);
  if (!result) {
    return interaction.reply({
      content: [
        `❌ Unknown location: **${rawInput}**`,
        'Try: country, US state, city, abbreviation, or UTC offset.',
        'Examples: `Malaysia` · `Germany` · `ET` · `UTC+8` · `America/New_York`',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  }

  if (result.zones.length > 1) {
    const lines = result.zones.map(tz => {
      const td = getTimeForTimezone(tz);
      return `🌍 \`${tz}\`  **${getUTCOffsetLabel(tz)}** (${getTZAbbreviation(tz)})  ${td ? `\`${td.time}\`` : ''}`;
    });
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle(`⚠️ Multiple timezones for ${result.display}`)
        .setDescription(lines.join('\n') + `\n\nRe-run with a specific one:\n\`/tzset @${user.username} <timezone>\``)],
    });
  }

  const tz    = result.zones[0];
  const td    = getTimeForTimezone(tz);
  const cache = getCache();
  cache[user.id] = {
    alias: result.display, timezone: tz,
    name: user.username, setBy: interaction.user.id, setAt: new Date().toISOString(),
  };
  persistCache();

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#00AA00').setTitle('✅ Timezone Set')
      .setDescription(`<@${user.id}>\n\`${td?.time ?? '--:--:-- --'}\` (${formatLabel(result.display, tz)})`)
      .setThumbnail(user.displayAvatarURL())],
  });
}

async function cmdTzremove(interaction) {
  const user  = interaction.options.getUser('user');
  const cache = getCache();

  if (!canManageUser(interaction, user.id)) {
    return interaction.reply({
      content: '❌ You can only remove your own timezone unless you have ManageMessages.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!cache[user.id]) {
    return interaction.reply({
      content: `${user.username} doesn't have a timezone set.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  delete cache[user.id];
  persistCache();

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#FF0000').setTitle('❌ Timezone Removed')
      .setDescription(`<@${user.id}>`).setThumbnail(user.displayAvatarURL())],
  });
}

async function cmdTz(interaction) {
  const cache  = getCache();
  const target = interaction.options.getUser('user');

  if (target) {
    if (!cache[target.id]) {
      return interaction.reply({
        content: `❌ No timezone set for ${target.username}. Use \`/tzset @${target.username} TIMEZONE\` first.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    const { alias, timezone } = cache[target.id];
    const td    = getTimeForTimezone(timezone);
    const label = td ? formatLabel(alias || timezone, timezone) : (alias || timezone);
    const inv   = cache[interaction.user.id];
    const diffLine = (inv && inv.timezone !== timezone && td)
      ? `\n${formatDiff(hourDiff(inv.timezone, timezone))}` : '';

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor('#0099FF').setTitle('🕐 Current Time')
        .setThumbnail(target.displayAvatarURL())
        .setDescription(td
          ? `<@${target.id}>\n## ${td.time}\n${label}${diffLine}`
          : `<@${target.id}>\nInvalid timezone, use \`/tzset\` to fix.`)
        .setFooter(td ? { text: tzFooterInfo(timezone) } : null)],
    });
  }

  // All users in this context
  const allIds = Object.keys(cache);
  if (!allIds.length) {
    return interaction.reply({
      content: '❌ No timezones saved yet. Use `/tzset @user TIMEZONE` to add one.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const visibleIds = await tzVisibleIds(interaction, allIds);

  if (!visibleIds.length) {
    return interaction.reply({
      content: '❌ No one in this chat has a timezone set.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const lines = visibleIds.map(uid => {
    const { alias, timezone } = cache[uid];
    const td = getTimeForTimezone(timezone);
    return td
      ? `<@${uid}>\n\`${td.time}\` (${formatLabel(alias || timezone, timezone)})`
      : `<@${uid}>\nInvalid timezone, use \`/tzset\` to fix.`;
  });

  if (lines.length <= PAGE_SIZE) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor('#00CCFF').setTitle('🕐 All Saved Timezones')
        .setDescription(lines.join('\n'))],
    });
  }

  const sid = createSession('tz', lines);
  return interaction.reply({
    embeds: [buildPageEmbed(getSession(sid), 0)],
    components: [buildPageRow(sid, 0, lines.length)],
  });
}

async function cmdTzbesttime(interaction) {
  const cache      = getCache();
  const usersRaw   = interaction.options.getString('users') ?? '';
  const mentionIds = [...usersRaw.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);
  const taggedIds  = [...new Set(mentionIds)];

  let userIds;
  if (taggedIds.length > 0) {
    const missing = taggedIds.filter(id => !cache[id]);
    if (missing.length) {
      return interaction.reply({
        content: `❌ No timezone set for: ${missing.map(id => `<@${id}>`).join(', ')}. Use \`/tzset\` first.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    userIds = taggedIds;
  } else {
    userIds = await tzVisibleIds(interaction, Object.keys(cache));
  }

  if (!userIds.length) {
    return interaction.reply({
      content: '❌ No one in this chat has a timezone set. Use `/tzset` to add one.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const fmtHour = h => `${h % 12 || 12}:00 ${h >= 12 ? 'PM' : 'AM'}`;
  const scores  = [];

  for (let utcHour = 0; utcHour < 24; utcHour++) {
    const ref = new Date();
    ref.setUTCHours(utcHour, 0, 0, 0);
    let score = 0;
    const userTimes = [];

    for (const uid of userIds) {
      const { timezone, alias } = cache[uid];
      try {
        const localHour = parseInt(
          new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: timezone }).format(ref)
        );
        let s = 0;
        if      (localHour >= 16 && localHour <= 22) s = 3;
        else if (localHour >= 21 || localHour <= 3)  s = 2;
        else if (localHour >= 8  && localHour < 12)  s = 1;
        score += s;
        userTimes.push({ id: uid, hour: localHour, label: alias || timezone });
      } catch {}
    }
    scores.push({ utcHour, score, userTimes });
  }

  const best = scores.reduce((a, b) => b.score > a.score ? b : a);
  const ref  = new Date();
  ref.setUTCHours(best.utcHour, 0, 0, 0);
  const ts = Math.floor(ref.getTime() / 1000);

  const lines = best.userTimes.map(ut => `<@${ut.id}>\n\`${fmtHour(ut.hour)}\` (${ut.label})`);
  const scopeNote = taggedIds.length > 0
    ? ` · scoped to ${taggedIds.length} user${taggedIds.length > 1 ? 's' : ''}` : '';

  if (lines.length <= PAGE_SIZE) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor('#FFD700').setTitle('🕐 Best Time to Meet')
        .setDescription(`**<t:${ts}:t> (UTC ${best.utcHour}:00)**\n` + lines.join('\n'))
        .setFooter({ text: `${lines.length} user${lines.length !== 1 ? 's' : ''}${scopeNote}` })],
    });
  }

  const sid = createSession('tzbt', lines, { ts, utcHour: best.utcHour });
  return interaction.reply({
    embeds: [buildPageEmbed(getSession(sid), 0)],
    components: [buildPageRow(sid, 0, lines.length)],
  });
}

async function cmdTzis(interaction) {
  const cache    = getCache();
  const rawInput = interaction.options.getString('location');
  const result   = lookupLocation(rawInput);

  if (!result) {
    return interaction.reply({
      content: [
        `❌ Unknown location: **${rawInput}**`,
        'Try: country, US state, city, abbreviation, or UTC offset.',
        'Examples: `Malaysia` · `CT` · `UTC+8` · `America/Chicago`',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  }

  if (result.zones.length > 1) {
    const lines = result.zones.map(tz => {
      const td = getTimeForTimezone(tz);
      return `🌍 \`${tz}\`  **${getUTCOffsetLabel(tz)}** (${getTZAbbreviation(tz)})  ${td ? `\`${td.time}\`` : ''}`;
    });
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle(`⚠️ Multiple timezones for ${result.display}`)
        .setDescription(lines.join('\n') + `\n\nRe-run with a specific one:\n\`/tzis <timezone>\``)],
    });
  }

  const tz = result.zones[0];
  const td = getTimeForTimezone(tz);
  if (!td) {
    return interaction.reply({
      content: `❌ Couldn't get time for **${tz}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const inv = cache[interaction.user.id];
  const diffLine = (inv && inv.timezone !== tz)
    ? `\n${formatDiff(hourDiff(inv.timezone, tz))}` : '';

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#00CCFF')
      .setTitle(`🕐 ${formatLabel(result.display, tz)}`)
      .setDescription(`## ${td.time}${diffLine}`)
      .setFooter({ text: tzFooterInfo(tz) })],
  });
}

async function cmdTzwhen(interaction) {
  const cache   = getCache(); // single load, was loaded twice in original
  const rawTime = interaction.options.getString('time');
  const rawTZ   = interaction.options.getString('timezone');
  const target  = interaction.options.getUser('user');

  const timeRx = /^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*(am|pm)?$/i;
  const match  = rawTime.trim().match(timeRx);
  if (!match) {
    return interaction.reply({
      content: `❌ Couldn't parse time **${rawTime}**.\nExamples: \`9\` · \`14\` · \`9am\` · \`9:42\` · \`9:42:31AM\` · \`18:24\``,
      flags: MessageFlags.Ephemeral,
    });
  }

  let hours   = parseInt(match[1]);
  let minutes = parseInt(match[2] ?? '0');
  let seconds = parseInt(match[3] ?? '0');
  const ampm  = match[4]?.toLowerCase();

  if (hours > 23 || minutes > 59 || seconds > 59) {
    return interaction.reply({
      content: `❌ Invalid time **${rawTime}**, check hours/minutes/seconds.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (ampm === 'am' && hours === 12) hours = 0;
  else if (ampm === 'pm' && hours !== 12) hours += 12;
  if (hours > 23) {
    return interaction.reply({
      content: `❌ **${rawTime}** resolves to an invalid hour after AM/PM conversion.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // Resolve source timezone
  let sourceTz = null;
  if (rawTZ) {
    const r = lookupLocation(rawTZ);
    if (!r || r.zones.length > 1) {
      return interaction.reply({
        content: r
          ? `❌ **${rawTZ}** maps to multiple timezones, be more specific (e.g. \`America/Chicago\`).`
          : `❌ Unknown timezone **${rawTZ}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    sourceTz = r.zones[0];
  } else {
    const inv = cache[interaction.user.id];
    if (!inv) {
      return interaction.reply({
        content: '❌ No timezone saved for you. Set one with `/tzset` or pass a `timezone` to this command.',
        flags: MessageFlags.Ephemeral,
      });
    }
    sourceTz = inv.timezone;
  }

  // Build UTC instant from local time + sourceTz offset
  const now       = new Date();
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: sourceTz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const pad      = n => String(n).padStart(2, '0');
  const localISO = `${dateParts}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  const offMatch = getUTCOffsetLabel(sourceTz).match(/UTC([+-])(\d+)(?::(\d+))?/);
  const offsetMin = offMatch
    ? (offMatch[1] === '+' ? 1 : -1) * (parseInt(offMatch[2]) * 60 + parseInt(offMatch[3] ?? '0'))
    : 0;
  const utcDate = new Date(new Date(localISO + 'Z').getTime() - offsetMin * 60000);

  const sourceTzAlias = rawTZ
    ? (lookupLocation(rawTZ)?.display ?? rawTZ.toUpperCase())
    : (cache[interaction.user.id]?.alias ?? sourceTz);
  const sourceLabel = formatLabel(sourceTzAlias, sourceTz);
  const srcFormatted = utcDate.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit',
    second: seconds ? '2-digit' : undefined,
    hour12: true, timeZone: sourceTz,
  });

  // Build target list
  let targets;
  if (target) {
    if (!cache[target.id]) {
      return interaction.reply({
        content: `❌ No timezone set for ${target.username}.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    targets = [{ id: target.id, ...cache[target.id] }];
  } else {
    const visible = await tzVisibleIds(interaction, Object.keys(cache));
    targets = visible.map(id => ({ id, ...cache[id] }));
  }

  if (!targets.length) {
    return interaction.reply({ content: '❌ No one in this chat has a timezone set.', flags: MessageFlags.Ephemeral });
  }

  const lines = targets.map(({ id, alias, timezone }) => {
    const converted = utcDate.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit',
      second: seconds ? '2-digit' : undefined,
      hour12: true, timeZone: timezone,
    });
    const sameZone = timezone === sourceTz;
    return `<@${id}>\n\`${converted}\` (${formatLabel(alias || timezone, timezone)})${sameZone ? ' ← same as source' : ''}`;
  });

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor('#7B68EE')
      .setTitle(`🕐 ${srcFormatted} ${sourceLabel}`)
      .setDescription(lines.join('\n'))],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH MAP, replaces the if-chain in the original handleCommand
// ─────────────────────────────────────────────────────────────────────────────
const _dispatch = {
  tzset:      (i) => cmdTzset(i),
  tzremove:   (i) => cmdTzremove(i),
  tz:         (i) => cmdTz(i),
  tzbesttime: (i) => cmdTzbesttime(i),
  tzis:       (i) => cmdTzis(i),
  tzwhen:     (i) => cmdTzwhen(i),
};

// ─────────────────────────────────────────────────────────────────────────────
// TZ DISPATCH, wired into private.js handleInteraction below.
// Returns true if it handled the interaction, false to let the chain continue.
// ─────────────────────────────────────────────────────────────────────────────
async function handleTzInteraction(interaction) {
  if (interaction.isButton()) {
    const parts = interaction.customId.split(':');
    if (parts[0] !== 'tzpage') return false;

    const session = getSession(parts[1]);
    if (!session) {
      await interaction.reply({
        content: '❌ This paginator has expired. Run the command again.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const page = parseInt(parts[2]);
    await interaction.update({
      embeds: [buildPageEmbed(session, page)],
      components: [buildPageRow(parts[1], page, session.lines.length)],
    });
    return true;
  }

  if (interaction.isChatInputCommand()) {
    const handler = _dispatch[interaction.commandName];
    if (!handler) return false;
    await handler(interaction);
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND DEFINITIONS
// Spread into getSlashCommands() below with the rest of the private commands.
// ─────────────────────────────────────────────────────────────────────────────
function _tzCmd(name, desc) {
  const b = new SlashCommandBuilder().setName(name).setDescription(desc);
  if (b.setIntegrationTypes) b.setIntegrationTypes(0, 1).setContexts(0, 1, 2);
  return b;
}

function buildTzSlashCommands() {
  return [
    _tzCmd('tzset', 'Set timezone for a user')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption(o => o.setName('timezone').setDescription('e.g. Malaysia, ET, UTC+8, America/New_York').setRequired(true)),
    _tzCmd('tz', 'Show current time for everyone (or a specific user)')
      .addUserOption(o => o.setName('user').setDescription('User to check (optional)')),
    _tzCmd('tzremove', 'Remove timezone for a user')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    _tzCmd('tzbesttime', 'Find the best time for people to meet')
      .addStringOption(o => o.setName('users').setDescription('Tag people to include (omit = everyone)')),
    _tzCmd('tzis', 'Look up the current time for any timezone or location')
      .addStringOption(o => o.setName('location').setDescription('e.g. Malaysia, ET, UTC+8, Michigan').setRequired(true)),
    _tzCmd('tzwhen', 'Convert a time to everyone\'s timezone')
      .addStringOption(o => o.setName('time').setDescription('e.g. 9, 14, 9am, 9:42, 18:24:09').setRequired(true))
      .addStringOption(o => o.setName('timezone').setDescription('Source timezone (default: your saved one)'))
      .addUserOption(o => o.setName('user').setDescription('Show conversion for one specific user only')),
  ];
}



// ─────────────────────────────────────────────────────────────────────────────
// LOCATION MAP, country/city/abbreviation -> IANA timezone(s)
// Entries with >1 zone trigger disambiguation UI in /tzset and /tzis.
// ─────────────────────────────────────────────────────────────────────────────
const locationMap = {
  // ── UTC OFFSETS ─────────────────────────────────────────────────────────────
  'UTC':      ['UTC'],
  'UTC+0':    ['UTC'],  'UTC-0':  ['UTC'],  'UTC0': ['UTC'],
  'UTC+1':    ['Etc/GMT-1'],   'UTC1':   ['Etc/GMT-1'],
  'UTC+2':    ['Etc/GMT-2'],   'UTC2':   ['Etc/GMT-2'],
  'UTC+3':    ['Etc/GMT-3'],   'UTC3':   ['Etc/GMT-3'],
  'UTC+4':    ['Etc/GMT-4'],   'UTC4':   ['Etc/GMT-4'],
  'UTC+5':    ['Etc/GMT-5'],   'UTC5':   ['Etc/GMT-5'],
  'UTC+6':    ['Etc/GMT-6'],   'UTC6':   ['Etc/GMT-6'],
  'UTC+7':    ['Etc/GMT-7'],   'UTC7':   ['Etc/GMT-7'],
  'UTC+8':    ['Etc/GMT-8'],   'UTC8':   ['Etc/GMT-8'],
  'UTC+9':    ['Etc/GMT-9'],   'UTC9':   ['Etc/GMT-9'],
  'UTC+10':   ['Etc/GMT-10'],  'UTC10':  ['Etc/GMT-10'],
  'UTC+11':   ['Etc/GMT-11'],  'UTC11':  ['Etc/GMT-11'],
  'UTC+12':   ['Etc/GMT-12'],  'UTC12':  ['Etc/GMT-12'],
  'UTC+13':   ['Etc/GMT-13'],  'UTC13':  ['Etc/GMT-13'],
  'UTC+14':   ['Etc/GMT-14'],  'UTC14':  ['Etc/GMT-14'],
  'UTC-1':    ['Etc/GMT+1'],
  'UTC-2':    ['Etc/GMT+2'],
  'UTC-3':    ['Etc/GMT+3'],
  'UTC-4':    ['Etc/GMT+4'],
  'UTC-5':    ['Etc/GMT+5'],
  'UTC-6':    ['Etc/GMT+6'],
  'UTC-7':    ['Etc/GMT+7'],
  'UTC-8':    ['Etc/GMT+8'],
  'UTC-9':    ['Etc/GMT+9'],
  'UTC-10':   ['Etc/GMT+10'],
  'UTC-11':   ['Etc/GMT+11'],
  'UTC-12':   ['Etc/GMT+12'],
  // Half / quarter hour offsets
  'UTC+3:30':  ['Asia/Tehran'],
  'UTC+4:30':  ['Asia/Kabul'],
  'UTC+5:30':  ['Asia/Kolkata'],
  'UTC+5:45':  ['Asia/Kathmandu'],
  'UTC+6:30':  ['Asia/Yangon'],
  'UTC+9:30':  ['Australia/Darwin'],
  'UTC+10:30': ['Australia/Lord_Howe'],
  'UTC+12:45': ['Pacific/Chatham'],
  'UTC-9:30':  ['Pacific/Marquesas'],

  // ── COMMON ABBREVIATIONS ─────────────────────────────────────────────────────
  'ET':    ['America/New_York'],
  'EST':   ['America/New_York'],
  'EDT':   ['America/New_York'],
  'CT':    ['America/Chicago'],
  'CST':   ['America/Chicago'],
  'CDT':   ['America/Chicago'],
  'MT':    ['America/Denver'],
  'MST':   ['America/Denver'],
  'MDT':   ['America/Denver'],
  'PT':    ['America/Los_Angeles'],
  'PST':   ['America/Los_Angeles'],
  'PDT':   ['America/Los_Angeles'],
  'AKT':   ['America/Anchorage'],
  'AKST':  ['America/Anchorage'],
  'AKDT':  ['America/Anchorage'],
  'HST':   ['Pacific/Honolulu'],
  'NST':   ['America/St_Johns'],
  'NDT':   ['America/St_Johns'],
  'AST':   ['America/Halifax'],
  'ADT':   ['America/Halifax'],
  'GMT':   ['Europe/London'],
  'BST':   ['Europe/London'],
  'WET':   ['Europe/Lisbon'],
  'CET':   ['Europe/Paris'],
  'CEST':  ['Europe/Paris'],
  'EET':   ['Europe/Helsinki'],
  'MSK':   ['Europe/Moscow'],
  'TRT':   ['Europe/Istanbul'],
  'IST':   ['Asia/Kolkata'],
  'PKT':   ['Asia/Karachi'],
  'BDT':   ['Asia/Dhaka'],
  'ICT':   ['Asia/Bangkok'],
  'SGT':   ['Asia/Singapore'],
  'MYT':   ['Asia/Kuala_Lumpur'],
  'PHT':   ['Asia/Manila'],
  'HKT':   ['Asia/Hong_Kong'],
  'JST':   ['Asia/Tokyo'],
  'KST':   ['Asia/Seoul'],
  'GST':   ['Asia/Dubai'],
  'IRST':  ['Asia/Tehran'],
  'AFT':   ['Asia/Kabul'],
  'MMT':   ['Asia/Yangon'],
  'NPT':   ['Asia/Kathmandu'],
  'AEST':  ['Australia/Sydney'],
  'AEDT':  ['Australia/Sydney'],
  'ACST':  ['Australia/Darwin'],
  'ACDT':  ['Australia/Adelaide'],
  'AWST':  ['Australia/Perth'],
  'NZST':  ['Pacific/Auckland'],
  'NZDT':  ['Pacific/Auckland'],
  'CHAST': ['Pacific/Chatham'],
  'ART':   ['America/Argentina/Buenos_Aires'],
  'BRT':   ['America/Sao_Paulo'],
  'CAT':   ['Africa/Harare'],
  'EAT':   ['Africa/Nairobi'],
  'WAT':   ['Africa/Lagos'],
  'SAST':  ['Africa/Johannesburg'],
  'SST':   ['Pacific/Apia'],
  'TOT':   ['Pacific/Tongatapu'],
  'WIT':   ['Asia/Jakarta'],
  'CIT':   ['Asia/Makassar'],
  'EIT':   ['Asia/Jayapura'],

  // ── NORTH AMERICA, US ───────────────────────────────────────────────────────
  'US':             ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'],
  'USA':            ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'],
  'UNITED STATES':  ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'],
  'AMERICA':        ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'],
  'U.S.':           ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'],
  'U.S.A.':         ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'],

  // US states
  'ALABAMA':              ['America/Chicago'],
  'ALASKA':               ['America/Anchorage', 'America/Adak'],
  'ARIZONA':              ['America/Phoenix'],
  'ARKANSAS':             ['America/Chicago'],
  'CALIFORNIA':           ['America/Los_Angeles'],
  'COLORADO':             ['America/Denver'],
  'CONNECTICUT':          ['America/New_York'],
  'DELAWARE':             ['America/New_York'],
  'FLORIDA':              ['America/New_York', 'America/Chicago'],
  'GEORGIA':              ['America/New_York'],
  'HAWAII':               ['Pacific/Honolulu'],
  'IDAHO':                ['America/Boise', 'America/Los_Angeles'],
  'ILLINOIS':             ['America/Chicago'],
  'INDIANA':              ['America/Indiana/Indianapolis', 'America/Indiana/Knox'],
  'IOWA':                 ['America/Chicago'],
  'KANSAS':               ['America/Chicago', 'America/Denver'],
  'KENTUCKY':             ['America/New_York', 'America/Chicago'],
  'LOUISIANA':            ['America/Chicago'],
  'MAINE':                ['America/New_York'],
  'MARYLAND':             ['America/New_York'],
  'MASSACHUSETTS':        ['America/New_York'],
  'MICHIGAN':             ['America/Detroit', 'America/Menominee'],
  'MINNESOTA':            ['America/Chicago'],
  'MISSISSIPPI':          ['America/Chicago'],
  'MISSOURI':             ['America/Chicago'],
  'MONTANA':              ['America/Denver'],
  'NEBRASKA':             ['America/Chicago', 'America/Denver'],
  'NEVADA':               ['America/Los_Angeles'],
  'NEW HAMPSHIRE':        ['America/New_York'],
  'NEW JERSEY':           ['America/New_York'],
  'NEW MEXICO':           ['America/Denver'],
  'NEW YORK':             ['America/New_York'],
  'NORTH CAROLINA':       ['America/New_York'],
  'NORTH DAKOTA':         ['America/Chicago', 'America/Denver'],
  'OHIO':                 ['America/New_York'],
  'OKLAHOMA':             ['America/Chicago'],
  'OREGON':               ['America/Los_Angeles', 'America/Boise'],
  'PENNSYLVANIA':         ['America/New_York'],
  'RHODE ISLAND':         ['America/New_York'],
  'SOUTH CAROLINA':       ['America/New_York'],
  'SOUTH DAKOTA':         ['America/Chicago', 'America/Denver'],
  'TENNESSEE':            ['America/New_York', 'America/Chicago'],
  'TEXAS':                ['America/Chicago', 'America/Denver'],
  'UTAH':                 ['America/Denver'],
  'VERMONT':              ['America/New_York'],
  'VIRGINIA':             ['America/New_York'],
  'WASHINGTON STATE':     ['America/Los_Angeles'],
  'WEST VIRGINIA':        ['America/New_York'],
  'WISCONSIN':            ['America/Chicago'],
  'WYOMING':              ['America/Denver'],
  'WASHINGTON DC':        ['America/New_York'],
  'DC':                   ['America/New_York'],
  'DISTRICT OF COLUMBIA': ['America/New_York'],
  'PUERTO RICO':          ['America/Puerto_Rico'],
  'GUAM':                 ['Pacific/Guam'],
  'US VIRGIN ISLANDS':    ['America/St_Thomas'],
  'AMERICAN SAMOA':       ['Pacific/Pago_Pago'],

  // US cities
  'NEW YORK CITY':    ['America/New_York'],
  'NYC':              ['America/New_York'],
  'NEW YORK CITY NY': ['America/New_York'],
  'LOS ANGELES':      ['America/Los_Angeles'],
  'CHICAGO':          ['America/Chicago'],
  'HOUSTON':          ['America/Chicago'],
  'PHOENIX':          ['America/Phoenix'],
  'PHILADELPHIA':     ['America/New_York'],
  'SAN ANTONIO':      ['America/Chicago'],
  'SAN DIEGO':        ['America/Los_Angeles'],
  'DALLAS':           ['America/Chicago'],
  'SAN FRANCISCO':    ['America/Los_Angeles'],
  'SF':               ['America/Los_Angeles'],
  'SEATTLE':          ['America/Los_Angeles'],
  'DENVER':           ['America/Denver'],
  'BOSTON':           ['America/New_York'],
  'MIAMI':            ['America/New_York'],
  'ATLANTA':          ['America/New_York'],
  'MINNEAPOLIS':      ['America/Chicago'],
  'PORTLAND':         ['America/Los_Angeles'],
  'LAS VEGAS':        ['America/Los_Angeles'],
  'DETROIT':          ['America/Detroit'],
  'NASHVILLE':        ['America/Chicago'],
  'AUSTIN':           ['America/Chicago'],
  'CHARLOTTE':        ['America/New_York'],
  'INDIANAPOLIS':     ['America/Indiana/Indianapolis'],
  'COLUMBUS':         ['America/New_York'],
  'MEMPHIS':          ['America/Chicago'],
  'LOUISVILLE':       ['America/Kentucky/Louisville'],
  'BALTIMORE':        ['America/New_York'],
  'MILWAUKEE':        ['America/Chicago'],
  'ALBUQUERQUE':      ['America/Denver'],
  'TUCSON':           ['America/Phoenix'],
  'FRESNO':           ['America/Los_Angeles'],
  'SACRAMENTO':       ['America/Los_Angeles'],
  'KANSAS CITY':      ['America/Chicago'],
  'OMAHA':            ['America/Chicago'],
  'CLEVELAND':        ['America/New_York'],
  'RALEIGH':          ['America/New_York'],
  'COLORADO SPRINGS': ['America/Denver'],
  'HONOLULU':         ['Pacific/Honolulu'],
  'ANCHORAGE':        ['America/Anchorage'],

  // ── NORTH AMERICA, CANADA ──────────────────────────────────────────────────
  'CANADA': ['America/St_Johns', 'America/Halifax', 'America/Toronto', 'America/Winnipeg', 'America/Edmonton', 'America/Vancouver'],
  'ONTARIO':                    ['America/Toronto'],
  'QUEBEC':                     ['America/Toronto'],
  'BRITISH COLUMBIA':           ['America/Vancouver'],
  'ALBERTA':                    ['America/Edmonton'],
  'MANITOBA':                   ['America/Winnipeg'],
  'SASKATCHEWAN':               ['America/Regina'],
  'NOVA SCOTIA':                ['America/Halifax'],
  'NEW BRUNSWICK':              ['America/Moncton'],
  'NEWFOUNDLAND':               ['America/St_Johns'],
  'NEWFOUNDLAND AND LABRADOR':  ['America/St_Johns'],
  'PRINCE EDWARD ISLAND':       ['America/Halifax'],
  'PEI':                        ['America/Halifax'],
  'NORTHWEST TERRITORIES':      ['America/Yellowknife'],
  'NUNAVUT':                    ['America/Iqaluit', 'America/Rankin_Inlet'],
  'YUKON':                      ['America/Whitehorse'],
  'TORONTO':      ['America/Toronto'],
  'VANCOUVER':    ['America/Vancouver'],
  'MONTREAL':     ['America/Toronto'],
  'CALGARY':      ['America/Edmonton'],
  'EDMONTON':     ['America/Edmonton'],
  'WINNIPEG':     ['America/Winnipeg'],
  'OTTAWA':       ['America/Toronto'],
  'QUEBEC CITY':  ['America/Toronto'],
  'VICTORIA BC':  ['America/Vancouver'],
  'HALIFAX':      ['America/Halifax'],
  'SASKATOON':    ['America/Regina'],
  'REGINA':       ['America/Regina'],
  'MONCTON':      ['America/Moncton'],
  'WHITEHORSE':   ['America/Whitehorse'],
  'YELLOWKNIFE':  ['America/Yellowknife'],
  'IQALUIT':      ['America/Iqaluit'],

  // ── MEXICO & CENTRAL AMERICA ─────────────────────────────────────────────────
  'MEXICO':       ['America/Mexico_City', 'America/Tijuana', 'America/Chihuahua', 'America/Cancun', 'America/Hermosillo'],
  'MEXICO CITY':  ['America/Mexico_City'],
  'CDMX':         ['America/Mexico_City'],
  'MONTERREY':    ['America/Monterrey'],
  'GUADALAJARA':  ['America/Mexico_City'],
  'TIJUANA':      ['America/Tijuana'],
  'CANCUN':       ['America/Cancun'],
  'HERMOSILLO':   ['America/Hermosillo'],
  'GUATEMALA':    ['America/Guatemala'],
  'BELIZE':       ['America/Belize'],
  'HONDURAS':     ['America/Tegucigalpa'],
  'EL SALVADOR':  ['America/El_Salvador'],
  'NICARAGUA':    ['America/Managua'],
  'COSTA RICA':   ['America/Costa_Rica'],
  'PANAMA':       ['America/Panama'],

  // ── CARIBBEAN ────────────────────────────────────────────────────────────────
  'CUBA':                 ['America/Havana'],
  'HAVANA':               ['America/Havana'],
  'JAMAICA':              ['America/Jamaica'],
  'KINGSTON':             ['America/Jamaica'],
  'HAITI':                ['America/Port-au-Prince'],
  'DOMINICAN REPUBLIC':   ['America/Santo_Domingo'],
  'TRINIDAD':             ['America/Port_of_Spain'],
  'TRINIDAD AND TOBAGO':  ['America/Port_of_Spain'],
  'BAHAMAS':              ['America/Nassau'],
  'BARBADOS':             ['America/Barbados'],
  'MARTINIQUE':           ['America/Martinique'],
  'GUADELOUPE':           ['America/Guadeloupe'],
  'ARUBA':                ['America/Aruba'],
  'CURACAO':              ['America/Curacao'],
  'CAYMAN ISLANDS':       ['America/Cayman'],
  'BERMUDA':              ['Atlantic/Bermuda'],

  // ── SOUTH AMERICA ────────────────────────────────────────────────────────────
  'COLOMBIA':    ['America/Bogota'],
  'BOGOTA':      ['America/Bogota'],
  'VENEZUELA':   ['America/Caracas'],
  'CARACAS':     ['America/Caracas'],
  'ECUADOR':     ['America/Guayaquil', 'Pacific/Galapagos'],
  'QUITO':       ['America/Guayaquil'],
  'PERU':        ['America/Lima'],
  'LIMA':        ['America/Lima'],
  'BRAZIL':      ['America/Sao_Paulo', 'America/Manaus', 'America/Belem', 'America/Recife', 'America/Fortaleza', 'America/Cuiaba', 'America/Porto_Velho', 'America/Noronha', 'America/Rio_Branco'],
  'BRASIL':      ['America/Sao_Paulo', 'America/Manaus', 'America/Belem', 'America/Recife', 'America/Fortaleza', 'America/Cuiaba', 'America/Porto_Velho', 'America/Noronha', 'America/Rio_Branco'],
  'SAO PAULO':   ['America/Sao_Paulo'],
  'RIO DE JANEIRO': ['America/Sao_Paulo'],
  'RIO':         ['America/Sao_Paulo'],
  'MANAUS':      ['America/Manaus'],
  'RECIFE':      ['America/Recife'],
  'FORTALEZA':   ['America/Fortaleza'],
  'BOLIVIA':     ['America/La_Paz'],
  'LA PAZ':      ['America/La_Paz'],
  'PARAGUAY':    ['America/Asuncion'],
  'ASUNCION':    ['America/Asuncion'],
  'URUGUAY':     ['America/Montevideo'],
  'MONTEVIDEO':  ['America/Montevideo'],
  'ARGENTINA':   ['America/Argentina/Buenos_Aires'],
  'BUENOS AIRES':['America/Argentina/Buenos_Aires'],
  'CHILE':       ['America/Santiago', 'Pacific/Easter'],
  'SANTIAGO':    ['America/Santiago'],
  'GUYANA':      ['America/Guyana'],
  'SURINAME':    ['America/Paramaribo'],
  'FRENCH GUIANA': ['America/Cayenne'],

  // ── EUROPE ───────────────────────────────────────────────────────────────────
  'UK':               ['Europe/London'],
  'UNITED KINGDOM':   ['Europe/London'],
  'GREAT BRITAIN':    ['Europe/London'],
  'U.K.':             ['Europe/London'],
  'ENGLAND':          ['Europe/London'],
  'SCOTLAND':         ['Europe/London'],
  'WALES':            ['Europe/London'],
  'NORTHERN IRELAND': ['Europe/London'],
  'IRELAND':          ['Europe/Dublin'],
  'PORTUGAL':         ['Europe/Lisbon', 'Atlantic/Azores'],
  'LISBON':           ['Europe/Lisbon'],
  'SPAIN':            ['Europe/Madrid', 'Atlantic/Canary'],
  'MADRID':           ['Europe/Madrid'],
  'BARCELONA':        ['Europe/Madrid'],
  'FRANCE':           ['Europe/Paris'],
  'PARIS':            ['Europe/Paris'],
  'BELGIUM':          ['Europe/Brussels'],
  'BRUSSELS':         ['Europe/Brussels'],
  'NETHERLANDS':      ['Europe/Amsterdam'],
  'HOLLAND':          ['Europe/Amsterdam'],
  'AMSTERDAM':        ['Europe/Amsterdam'],
  'LUXEMBOURG':       ['Europe/Luxembourg'],
  'GERMANY':          ['Europe/Berlin'],
  'BERLIN':           ['Europe/Berlin'],
  'MUNICH':           ['Europe/Berlin'],
  'FRANKFURT':        ['Europe/Berlin'],
  'HAMBURG':          ['Europe/Berlin'],
  'AUSTRIA':          ['Europe/Vienna'],
  'VIENNA':           ['Europe/Vienna'],
  'SWITZERLAND':      ['Europe/Zurich'],
  'ZURICH':           ['Europe/Zurich'],
  'GENEVA':           ['Europe/Zurich'],
  'ITALY':            ['Europe/Rome'],
  'ROME':             ['Europe/Rome'],
  'MILAN':            ['Europe/Rome'],
  'NAPLES':           ['Europe/Rome'],
  'DENMARK':          ['Europe/Copenhagen'],
  'COPENHAGEN':       ['Europe/Copenhagen'],
  'SWEDEN':           ['Europe/Stockholm'],
  'STOCKHOLM':        ['Europe/Stockholm'],
  'GOTHENBURG':       ['Europe/Stockholm'],
  'NORWAY':           ['Europe/Oslo'],
  'OSLO':             ['Europe/Oslo'],
  'BERGEN':           ['Europe/Oslo'],
  'FINLAND':          ['Europe/Helsinki'],
  'HELSINKI':         ['Europe/Helsinki'],
  'ICELAND':          ['Atlantic/Reykjavik'],
  'REYKJAVIK':        ['Atlantic/Reykjavik'],
  'POLAND':           ['Europe/Warsaw'],
  'WARSAW':           ['Europe/Warsaw'],
  'KRAKOW':           ['Europe/Warsaw'],
  'CZECH REPUBLIC':   ['Europe/Prague'],
  'CZECHIA':          ['Europe/Prague'],
  'PRAGUE':           ['Europe/Prague'],
  'SLOVAKIA':         ['Europe/Bratislava'],
  'BRATISLAVA':       ['Europe/Bratislava'],
  'HUNGARY':          ['Europe/Budapest'],
  'BUDAPEST':         ['Europe/Budapest'],
  'ROMANIA':          ['Europe/Bucharest'],
  'BUCHAREST':        ['Europe/Bucharest'],
  'BULGARIA':         ['Europe/Sofia'],
  'SOFIA':            ['Europe/Sofia'],
  'GREECE':           ['Europe/Athens'],
  'ATHENS':           ['Europe/Athens'],
  'THESSALONIKI':     ['Europe/Athens'],
  'CROATIA':          ['Europe/Zagreb'],
  'ZAGREB':           ['Europe/Zagreb'],
  'SERBIA':           ['Europe/Belgrade'],
  'BELGRADE':         ['Europe/Belgrade'],
  'SLOVENIA':         ['Europe/Ljubljana'],
  'LJUBLJANA':        ['Europe/Ljubljana'],
  'BOSNIA':           ['Europe/Sarajevo'],
  'BOSNIA AND HERZEGOVINA': ['Europe/Sarajevo'],
  'SARAJEVO':         ['Europe/Sarajevo'],
  'NORTH MACEDONIA':  ['Europe/Skopje'],
  'MACEDONIA':        ['Europe/Skopje'],
  'SKOPJE':           ['Europe/Skopje'],
  'ALBANIA':          ['Europe/Tirane'],
  'TIRANA':           ['Europe/Tirane'],
  'TIRANE':           ['Europe/Tirane'],
  'MONTENEGRO':       ['Europe/Podgorica'],
  'PODGORICA':        ['Europe/Podgorica'],
  'KOSOVO':           ['Europe/Belgrade'],
  'PRISTINA':         ['Europe/Belgrade'],
  'MOLDOVA':          ['Europe/Chisinau'],
  'CHISINAU':         ['Europe/Chisinau'],
  'UKRAINE':          ['Europe/Kiev', 'Europe/Uzhgorod', 'Europe/Zaporozhye'],
  'KYIV':             ['Europe/Kiev'],
  'KIEV':             ['Europe/Kiev'],
  'KHARKIV':          ['Europe/Kiev'],
  'ODESSA':           ['Europe/Kiev'],
  'BELARUS':          ['Europe/Minsk'],
  'MINSK':            ['Europe/Minsk'],
  'LITHUANIA':        ['Europe/Vilnius'],
  'VILNIUS':          ['Europe/Vilnius'],
  'LATVIA':           ['Europe/Riga'],
  'RIGA':             ['Europe/Riga'],
  'ESTONIA':          ['Europe/Tallinn'],
  'TALLINN':          ['Europe/Tallinn'],
  'RUSSIA':           ['Europe/Moscow', 'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Novosibirsk', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok', 'Asia/Magadan', 'Asia/Sakhalin', 'Asia/Kamchatka'],
  'MOSCOW':           ['Europe/Moscow'],
  'SAINT PETERSBURG': ['Europe/Moscow'],
  'ST PETERSBURG':    ['Europe/Moscow'],
  'SPB':              ['Europe/Moscow'],
  'KALININGRAD':      ['Europe/Kaliningrad'],
  'SAMARA':           ['Europe/Samara'],
  'YEKATERINBURG':    ['Asia/Yekaterinburg'],
  'EKATERINBURG':     ['Asia/Yekaterinburg'],
  'NOVOSIBIRSK':      ['Asia/Novosibirsk'],
  'OMSK':             ['Asia/Omsk'],
  'KRASNOYARSK':      ['Asia/Krasnoyarsk'],
  'IRKUTSK':          ['Asia/Irkutsk'],
  'YAKUTSK':          ['Asia/Yakutsk'],
  'VLADIVOSTOK':      ['Asia/Vladivostok'],
  'MAGADAN':          ['Asia/Magadan'],
  'KAMCHATKA':        ['Asia/Kamchatka'],
  'TURKEY':           ['Europe/Istanbul'],
  'TURKIYE':          ['Europe/Istanbul'],
  'ISTANBUL':         ['Europe/Istanbul'],
  'ANKARA':           ['Europe/Istanbul'],
  'IZMIR':            ['Europe/Istanbul'],
  'CYPRUS':           ['Asia/Nicosia'],
  'NICOSIA':          ['Asia/Nicosia'],
  'MALTA':            ['Europe/Malta'],
  'VALLETTA':         ['Europe/Malta'],
  'LIECHTENSTEIN':    ['Europe/Vaduz'],
  'MONACO':           ['Europe/Monaco'],
  'SAN MARINO':       ['Europe/San_Marino'],
  'ANDORRA':          ['Europe/Andorra'],
  'FAROE ISLANDS':    ['Atlantic/Faroe'],
  'LONDON':           ['Europe/London'],
  'EDINBURGH':        ['Europe/London'],
  'DUBLIN':           ['Europe/Dublin'],
  'AZORES':           ['Atlantic/Azores'],
  'MADEIRA':          ['Atlantic/Madeira'],
  'CANARY ISLANDS':   ['Atlantic/Canary'],

  // ── MIDDLE EAST ─���────────────────────────────────────────────────────────────
  'SAUDI ARABIA':          ['Asia/Riyadh'],
  'KSA':                   ['Asia/Riyadh'],
  'RIYADH':                ['Asia/Riyadh'],
  'JEDDAH':                ['Asia/Riyadh'],
  'MECCA':                 ['Asia/Riyadh'],
  'UAE':                   ['Asia/Dubai'],
  'UNITED ARAB EMIRATES':  ['Asia/Dubai'],
  'DUBAI':                 ['Asia/Dubai'],
  'ABU DHABI':             ['Asia/Dubai'],
  'SHARJAH':               ['Asia/Dubai'],
  'QATAR':                 ['Asia/Qatar'],
  'DOHA':                  ['Asia/Qatar'],
  'BAHRAIN':               ['Asia/Bahrain'],
  'MANAMA':                ['Asia/Bahrain'],
  'KUWAIT':                ['Asia/Kuwait'],
  'KUWAIT CITY':           ['Asia/Kuwait'],
  'OMAN':                  ['Asia/Muscat'],
  'MUSCAT':                ['Asia/Muscat'],
  'IRAN':                  ['Asia/Tehran'],
  'TEHRAN':                ['Asia/Tehran'],
  'ISFAHAN':               ['Asia/Tehran'],
  'IRAQ':                  ['Asia/Baghdad'],
  'BAGHDAD':               ['Asia/Baghdad'],
  'BASRA':                 ['Asia/Baghdad'],
  'ISRAEL':                ['Asia/Jerusalem'],
  'TEL AVIV':              ['Asia/Jerusalem'],
  'JERUSALEM':             ['Asia/Jerusalem'],
  'HAIFA':                 ['Asia/Jerusalem'],
  'PALESTINE':             ['Asia/Gaza', 'Asia/Hebron'],
  'GAZA':                  ['Asia/Gaza'],
  'WEST BANK':             ['Asia/Hebron'],
  'JORDAN':                ['Asia/Amman'],
  'AMMAN':                 ['Asia/Amman'],
  'LEBANON':               ['Asia/Beirut'],
  'BEIRUT':                ['Asia/Beirut'],
  'SYRIA':                 ['Asia/Damascus'],
  'DAMASCUS':              ['Asia/Damascus'],
  'YEMEN':                 ['Asia/Aden'],
  'SANAA':                 ['Asia/Aden'],

  // ── CENTRAL ASIA ─────────────────────────────────────────────────────────────
  'KAZAKHSTAN':   ['Asia/Almaty', 'Asia/Aqtau', 'Asia/Aqtobe', 'Asia/Oral'],
  'ALMATY':       ['Asia/Almaty'],
  'ASTANA':       ['Asia/Almaty'],
  'NUR-SULTAN':   ['Asia/Almaty'],
  'UZBEKISTAN':   ['Asia/Tashkent'],
  'TASHKENT':     ['Asia/Tashkent'],
  'SAMARKAND':    ['Asia/Tashkent'],
  'TURKMENISTAN': ['Asia/Ashgabat'],
  'ASHGABAT':     ['Asia/Ashgabat'],
  'KYRGYZSTAN':   ['Asia/Bishkek'],
  'BISHKEK':      ['Asia/Bishkek'],
  'TAJIKISTAN':   ['Asia/Dushanbe'],
  'DUSHANBE':     ['Asia/Dushanbe'],

  // ── SOUTH ASIA ───────────────────────────────────────────────────────────────
  'AFGHANISTAN':  ['Asia/Kabul'],
  'KABUL':        ['Asia/Kabul'],
  'PAKISTAN':     ['Asia/Karachi'],
  'KARACHI':      ['Asia/Karachi'],
  'LAHORE':       ['Asia/Karachi'],
  'ISLAMABAD':    ['Asia/Karachi'],
  'RAWALPINDI':   ['Asia/Karachi'],
  'FAISALABAD':   ['Asia/Karachi'],
  'INDIA':        ['Asia/Kolkata'],
  'MUMBAI':       ['Asia/Kolkata'],
  'BOMBAY':       ['Asia/Kolkata'],
  'DELHI':        ['Asia/Kolkata'],
  'NEW DELHI':    ['Asia/Kolkata'],
  'KOLKATA':      ['Asia/Kolkata'],
  'CALCUTTA':     ['Asia/Kolkata'],
  'CHENNAI':      ['Asia/Kolkata'],
  'MADRAS':       ['Asia/Kolkata'],
  'BANGALORE':    ['Asia/Kolkata'],
  'BENGALURU':    ['Asia/Kolkata'],
  'HYDERABAD':    ['Asia/Kolkata'],
  'PUNE':         ['Asia/Kolkata'],
  'AHMEDABAD':    ['Asia/Kolkata'],
  'SURAT':        ['Asia/Kolkata'],
  'JAIPUR':       ['Asia/Kolkata'],
  'SRI LANKA':    ['Asia/Colombo'],
  'COLOMBO':      ['Asia/Colombo'],
  'NEPAL':        ['Asia/Kathmandu'],
  'KATHMANDU':    ['Asia/Kathmandu'],
  'BANGLADESH':   ['Asia/Dhaka'],
  'DHAKA':        ['Asia/Dhaka'],
  'CHITTAGONG':   ['Asia/Dhaka'],
  'BHUTAN':       ['Asia/Thimphu'],
  'THIMPHU':      ['Asia/Thimphu'],
  'MALDIVES':     ['Indian/Maldives'],
  'MALE':         ['Indian/Maldives'],

  // ── SOUTHEAST ASIA ───────────────────────────────────────────────────────────
  'MYANMAR':      ['Asia/Yangon'],
  'BURMA':        ['Asia/Yangon'],
  'YANGON':       ['Asia/Yangon'],
  'RANGOON':      ['Asia/Yangon'],
  'NAYPYIDAW':    ['Asia/Yangon'],
  'THAILAND':     ['Asia/Bangkok'],
  'BANGKOK':      ['Asia/Bangkok'],
  'CHIANG MAI':   ['Asia/Bangkok'],
  'PHUKET':       ['Asia/Bangkok'],
  'CAMBODIA':     ['Asia/Phnom_Penh'],
  'PHNOM PENH':   ['Asia/Phnom_Penh'],
  'SIEM REAP':    ['Asia/Phnom_Penh'],
  'LAOS':         ['Asia/Vientiane'],
  'VIENTIANE':    ['Asia/Vientiane'],
  'VIETNAM':      ['Asia/Ho_Chi_Minh'],
  'VIET NAM':     ['Asia/Ho_Chi_Minh'],
  'HO CHI MINH':  ['Asia/Ho_Chi_Minh'],
  'HO CHI MINH CITY': ['Asia/Ho_Chi_Minh'],
  'SAIGON':       ['Asia/Ho_Chi_Minh'],
  'HANOI':        ['Asia/Ho_Chi_Minh'],
  'DA NANG':      ['Asia/Ho_Chi_Minh'],
  'MALAYSIA':     ['Asia/Kuala_Lumpur'],
  'KUALA LUMPUR': ['Asia/Kuala_Lumpur'],
  'KL':           ['Asia/Kuala_Lumpur'],
  'PENANG':       ['Asia/Kuala_Lumpur'],
  'JOHOR BAHRU':  ['Asia/Kuala_Lumpur'],
  'KOTA KINABALU':['Asia/Kuching'],
  'KUCHING':      ['Asia/Kuching'],
  'SINGAPORE':    ['Asia/Singapore'],
  'INDONESIA':    ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'],
  'JAKARTA':      ['Asia/Jakarta'],
  'SURABAYA':     ['Asia/Jakarta'],
  'MEDAN':        ['Asia/Jakarta'],
  'BANDUNG':      ['Asia/Jakarta'],
  'BALI':         ['Asia/Makassar'],
  'MAKASSAR':     ['Asia/Makassar'],
  'LOMBOK':       ['Asia/Makassar'],
  'JAYAPURA':     ['Asia/Jayapura'],
  'INDONESIA WEST':    ['Asia/Jakarta'],
  'INDONESIA CENTRAL': ['Asia/Makassar'],
  'INDONESIA EAST':    ['Asia/Jayapura'],
  'WIB':          ['Asia/Jakarta'],
  'WITA':         ['Asia/Makassar'],
  'WIE':          ['Asia/Jayapura'],
  'PHILIPPINES':  ['Asia/Manila'],
  'MANILA':       ['Asia/Manila'],
  'CEBU':         ['Asia/Manila'],
  'DAVAO':        ['Asia/Manila'],
  'BRUNEI':       ['Asia/Brunei'],
  'BANDAR SERI BEGAWAN': ['Asia/Brunei'],
  'BSB':          ['Asia/Brunei'],
  'EAST TIMOR':   ['Asia/Dili'],
  'TIMOR-LESTE':  ['Asia/Dili'],
  'DILI':         ['Asia/Dili'],

  // ── EAST ASIA ────────────────────────────────────────────────────────────────
  'CHINA':        ['Asia/Shanghai'],
  'PRC':          ['Asia/Shanghai'],
  'BEIJING':      ['Asia/Shanghai'],
  'SHANGHAI':     ['Asia/Shanghai'],
  'GUANGZHOU':    ['Asia/Shanghai'],
  'SHENZHEN':     ['Asia/Shanghai'],
  'CHENGDU':      ['Asia/Shanghai'],
  'WUHAN':        ['Asia/Shanghai'],
  'XIAN':         ['Asia/Shanghai'],
  "XI'AN":        ['Asia/Shanghai'],
  'CHONGQING':    ['Asia/Shanghai'],
  'TIANJIN':      ['Asia/Shanghai'],
  'NANJING':      ['Asia/Shanghai'],
  'HANGZHOU':     ['Asia/Shanghai'],
  'HONG KONG':    ['Asia/Hong_Kong'],
  'HK':           ['Asia/Hong_Kong'],
  'HONGKONG':     ['Asia/Hong_Kong'],
  'MACAU':        ['Asia/Macau'],
  'MACAO':        ['Asia/Macau'],
  'TAIWAN':       ['Asia/Taipei'],
  'TAIPEI':       ['Asia/Taipei'],
  'KAOHSIUNG':    ['Asia/Taipei'],
  'TAICHUNG':     ['Asia/Taipei'],
  'JAPAN':        ['Asia/Tokyo'],
  'TOKYO':        ['Asia/Tokyo'],
  'OSAKA':        ['Asia/Tokyo'],
  'KYOTO':        ['Asia/Tokyo'],
  'YOKOHAMA':     ['Asia/Tokyo'],
  'NAGOYA':       ['Asia/Tokyo'],
  'SAPPORO':      ['Asia/Tokyo'],
  'FUKUOKA':      ['Asia/Tokyo'],
  'HIROSHIMA':    ['Asia/Tokyo'],
  'SOUTH KOREA':  ['Asia/Seoul'],
  'KOREA':        ['Asia/Seoul'],
  'SEOUL':        ['Asia/Seoul'],
  'BUSAN':        ['Asia/Seoul'],
  'INCHEON':      ['Asia/Seoul'],
  'DAEGU':        ['Asia/Seoul'],
  'NORTH KOREA':  ['Asia/Pyongyang'],
  'PYONGYANG':    ['Asia/Pyongyang'],
  'MONGOLIA':     ['Asia/Ulaanbaatar', 'Asia/Hovd'],
  'ULAANBAATAR':  ['Asia/Ulaanbaatar'],

  // ── AFRICA ───────────────────────────────────────────────────────────────────
  'EGYPT':             ['Africa/Cairo'],
  'CAIRO':             ['Africa/Cairo'],
  'ALEXANDRIA':        ['Africa/Cairo'],
  'LIBYA':             ['Africa/Tripoli'],
  'TRIPOLI':           ['Africa/Tripoli'],
  'TUNISIA':           ['Africa/Tunis'],
  'TUNIS':             ['Africa/Tunis'],
  'ALGERIA':           ['Africa/Algiers'],
  'ALGIERS':           ['Africa/Algiers'],
  'ORAN':              ['Africa/Algiers'],
  'MOROCCO':           ['Africa/Casablanca'],
  'CASABLANCA':        ['Africa/Casablanca'],
  'RABAT':             ['Africa/Casablanca'],
  'MARRAKECH':         ['Africa/Casablanca'],
  'WESTERN SAHARA':    ['Africa/El_Aaiun'],
  'SUDAN':             ['Africa/Khartoum'],
  'KHARTOUM':          ['Africa/Khartoum'],
  'SOUTH SUDAN':       ['Africa/Juba'],
  'JUBA':              ['Africa/Juba'],
  'ETHIOPIA':          ['Africa/Addis_Ababa'],
  'ADDIS ABABA':       ['Africa/Addis_Ababa'],
  'ERITREA':           ['Africa/Asmara'],
  'ASMARA':            ['Africa/Asmara'],
  'DJIBOUTI':          ['Africa/Djibouti'],
  'SOMALIA':           ['Africa/Mogadishu'],
  'MOGADISHU':         ['Africa/Mogadishu'],
  'KENYA':             ['Africa/Nairobi'],
  'NAIROBI':           ['Africa/Nairobi'],
  'MOMBASA':           ['Africa/Nairobi'],
  'TANZANIA':          ['Africa/Dar_es_Salaam'],
  'DAR ES SALAAM':     ['Africa/Dar_es_Salaam'],
  'ZANZIBAR':          ['Africa/Dar_es_Salaam'],
  'UGANDA':            ['Africa/Kampala'],
  'KAMPALA':           ['Africa/Kampala'],
  'RWANDA':            ['Africa/Kigali'],
  'KIGALI':            ['Africa/Kigali'],
  'BURUNDI':           ['Africa/Bujumbura'],
  'BUJUMBURA':         ['Africa/Bujumbura'],
  'SOUTH AFRICA':      ['Africa/Johannesburg'],
  'JOHANNESBURG':      ['Africa/Johannesburg'],
  'CAPE TOWN':         ['Africa/Johannesburg'],
  'DURBAN':            ['Africa/Johannesburg'],
  'PRETORIA':          ['Africa/Johannesburg'],
  'ZIMBABWE':          ['Africa/Harare'],
  'HARARE':            ['Africa/Harare'],
  'BULAWAYO':          ['Africa/Harare'],
  'ZAMBIA':            ['Africa/Lusaka'],
  'LUSAKA':            ['Africa/Lusaka'],
  'MOZAMBIQUE':        ['Africa/Maputo'],
  'MAPUTO':            ['Africa/Maputo'],
  'MALAWI':            ['Africa/Blantyre'],
  'BLANTYRE':          ['Africa/Blantyre'],
  'LILONGWE':          ['Africa/Blantyre'],
  'MADAGASCAR':        ['Indian/Antananarivo'],
  'ANTANANARIVO':      ['Indian/Antananarivo'],
  'BOTSWANA':          ['Africa/Gaborone'],
  'GABORONE':          ['Africa/Gaborone'],
  'NAMIBIA':           ['Africa/Windhoek'],
  'WINDHOEK':          ['Africa/Windhoek'],
  'ANGOLA':            ['Africa/Luanda'],
  'LUANDA':            ['Africa/Luanda'],
  'DRC':               ['Africa/Kinshasa', 'Africa/Lubumbashi'],
  'DEMOCRATIC REPUBLIC OF CONGO': ['Africa/Kinshasa', 'Africa/Lubumbashi'],
  'CONGO DR':          ['Africa/Kinshasa', 'Africa/Lubumbashi'],
  'REPUBLIC OF CONGO': ['Africa/Brazzaville'],
  'BRAZZAVILLE':       ['Africa/Brazzaville'],
  'KINSHASA':          ['Africa/Kinshasa'],
  'LUBUMBASHI':        ['Africa/Lubumbashi'],
  'CAMEROON':          ['Africa/Douala'],
  'DOUALA':            ['Africa/Douala'],
  'YAOUNDE':           ['Africa/Douala'],
  'NIGERIA':           ['Africa/Lagos'],
  'LAGOS':             ['Africa/Lagos'],
  'ABUJA':             ['Africa/Lagos'],
  'KANO':              ['Africa/Lagos'],
  'IBADAN':            ['Africa/Lagos'],
  'GHANA':             ['Africa/Accra'],
  'ACCRA':             ['Africa/Accra'],
  'KUMASI':            ['Africa/Accra'],
  'IVORY COAST':       ['Africa/Abidjan'],
  'COTE DIVOIRE':      ['Africa/Abidjan'],
  "CÔTE D'IVOIRE":     ['Africa/Abidjan'],
  'ABIDJAN':           ['Africa/Abidjan'],
  'SENEGAL':           ['Africa/Dakar'],
  'DAKAR':             ['Africa/Dakar'],
  'MALI':              ['Africa/Bamako'],
  'BAMAKO':            ['Africa/Bamako'],
  'NIGER':             ['Africa/Niamey'],
  'NIAMEY':            ['Africa/Niamey'],
  'CHAD':              ['Africa/Ndjamena'],
  'NDJAMENA':          ['Africa/Ndjamena'],
  'CENTRAL AFRICAN REPUBLIC': ['Africa/Bangui'],
  'GABON':             ['Africa/Libreville'],
  'LIBREVILLE':        ['Africa/Libreville'],
  'EQUATORIAL GUINEA': ['Africa/Malabo'],
  'SAO TOME AND PRINCIPE': ['Africa/Sao_Tome'],
  'CAPE VERDE':        ['Atlantic/Cape_Verde'],
  'GUINEA':            ['Africa/Conakry'],
  'CONAKRY':           ['Africa/Conakry'],
  'GUINEA-BISSAU':     ['Africa/Bissau'],
  'SIERRA LEONE':      ['Africa/Freetown'],
  'FREETOWN':          ['Africa/Freetown'],
  'LIBERIA':           ['Africa/Monrovia'],
  'MONROVIA':          ['Africa/Monrovia'],
  'TOGO':              ['Africa/Lome'],
  'LOME':              ['Africa/Lome'],
  'BENIN':             ['Africa/Porto-Novo'],
  'COTONOU':           ['Africa/Porto-Novo'],
  'BURKINA FASO':      ['Africa/Ouagadougou'],
  'OUAGADOUGOU':       ['Africa/Ouagadougou'],
  'MAURITANIA':        ['Africa/Nouakchott'],
  'NOUAKCHOTT':        ['Africa/Nouakchott'],
  'GAMBIA':            ['Africa/Banjul'],
  'BANJUL':            ['Africa/Banjul'],
  'MAURITIUS':         ['Indian/Mauritius'],
  'PORT LOUIS':        ['Indian/Mauritius'],
  'SEYCHELLES':        ['Indian/Mahe'],
  'VICTORIA SEYCHELLES': ['Indian/Mahe'],
  'COMOROS':           ['Indian/Comoro'],
  'MORONI':            ['Indian/Comoro'],
  'REUNION':           ['Indian/Reunion'],
  'MAYOTTE':           ['Indian/Mayotte'],
  'ESWATINI':          ['Africa/Mbabane'],
  'SWAZILAND':         ['Africa/Mbabane'],
  'MBABANE':           ['Africa/Mbabane'],
  'LESOTHO':           ['Africa/Maseru'],
  'MASERU':            ['Africa/Maseru'],
  'DJIBOUTI CITY':     ['Africa/Djibouti'],

  // ── OCEANIA ──────────────────────────────────────────────────────────────────
  'AUSTRALIA':          ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth', 'Australia/Adelaide', 'Australia/Darwin'],
  'NEW SOUTH WALES':    ['Australia/Sydney'],
  'NSW':                ['Australia/Sydney'],
  'SYDNEY':             ['Australia/Sydney'],
  'VICTORIA AU':        ['Australia/Melbourne'],
  'MELBOURNE':          ['Australia/Melbourne'],
  'QUEENSLAND':         ['Australia/Brisbane'],
  'QLD':                ['Australia/Brisbane'],
  'BRISBANE':           ['Australia/Brisbane'],
  'GOLD COAST':         ['Australia/Brisbane'],
  'CAIRNS':             ['Australia/Brisbane'],
  'SOUTH AUSTRALIA':    ['Australia/Adelaide'],
  'SA AU':              ['Australia/Adelaide'],
  'ADELAIDE':           ['Australia/Adelaide'],
  'WESTERN AUSTRALIA':  ['Australia/Perth'],
  'WA AU':              ['Australia/Perth'],
  'PERTH':              ['Australia/Perth'],
  'TASMANIA':           ['Australia/Hobart'],
  'HOBART':             ['Australia/Hobart'],
  'NORTHERN TERRITORY': ['Australia/Darwin'],
  'NT AU':              ['Australia/Darwin'],
  'DARWIN':             ['Australia/Darwin'],
  'ACT':                ['Australia/Sydney'],
  'CANBERRA':           ['Australia/Sydney'],
  'NEW ZEALAND':        ['Pacific/Auckland'],
  'NZ':                 ['Pacific/Auckland'],
  'AUCKLAND':           ['Pacific/Auckland'],
  'WELLINGTON':         ['Pacific/Auckland'],
  'CHRISTCHURCH':       ['Pacific/Auckland'],
  'DUNEDIN':            ['Pacific/Auckland'],
  'CHATHAM ISLANDS':    ['Pacific/Chatham'],
  'FIJI':               ['Pacific/Fiji'],
  'SUVA':               ['Pacific/Fiji'],
  'PAPUA NEW GUINEA':   ['Pacific/Port_Moresby'],
  'PNG':                ['Pacific/Port_Moresby'],
  'PORT MORESBY':       ['Pacific/Port_Moresby'],
  'SAMOA':              ['Pacific/Apia'],
  'WESTERN SAMOA':      ['Pacific/Apia'],
  'APIA':               ['Pacific/Apia'],
  'TONGA':              ['Pacific/Tongatapu'],
  'NUKUALOFA':          ['Pacific/Tongatapu'],
  "NUKU'ALOFA":         ['Pacific/Tongatapu'],
  'VANUATU':            ['Pacific/Efate'],
  'PORT VILA':          ['Pacific/Efate'],
  'SOLOMON ISLANDS':    ['Pacific/Guadalcanal'],
  'HONIARA':            ['Pacific/Guadalcanal'],
  'KIRIBATI':           ['Pacific/Tarawa', 'Pacific/Enderbury', 'Pacific/Kiritimati'],
  'TARAWA':             ['Pacific/Tarawa'],
  'PALAU':              ['Pacific/Palau'],
  'KOROR':              ['Pacific/Palau'],
  'MARSHALL ISLANDS':   ['Pacific/Majuro'],
  'MAJURO':             ['Pacific/Majuro'],
  'MICRONESIA':         ['Pacific/Pohnpei', 'Pacific/Chuuk', 'Pacific/Kosrae'],
  'POHNPEI':            ['Pacific/Pohnpei'],
  'NAURU':              ['Pacific/Nauru'],
  'TUVALU':             ['Pacific/Funafuti'],
  'FUNAFUTI':           ['Pacific/Funafuti'],
  'COOK ISLANDS':       ['Pacific/Rarotonga'],
  'RAROTONGA':          ['Pacific/Rarotonga'],
  'NIUE':               ['Pacific/Niue'],
  'FRENCH POLYNESIA':   ['Pacific/Tahiti', 'Pacific/Marquesas', 'Pacific/Gambier'],
  'TAHITI':             ['Pacific/Tahiti'],
  'PAPEETE':            ['Pacific/Tahiti'],
  'NEW CALEDONIA':      ['Pacific/Noumea'],
  'NOUMEA':             ['Pacific/Noumea'],
  'WALLIS AND FUTUNA':  ['Pacific/Wallis'],

  // ── ATLANTIC / INDIAN OCEAN ──────────────────────────────────────────────────
  'FALKLAND ISLANDS':   ['Atlantic/Stanley'],
  'SOUTH GEORGIA':      ['Atlantic/South_Georgia'],
  'ST HELENA':          ['Atlantic/St_Helena'],
};
