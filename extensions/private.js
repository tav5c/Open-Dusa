// ─────────────────────────────────────────────────────────────────────────────
// extensions/private.js — Owner tools, Announcer, AutoVC, Keywords, Verify, Snake, Call, Mail
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

// Load priv.json for announcer and VC settings
let privConfig = { auto_vc_channels: [], announcer_channel_id: null, random_msgs: null }
if (existsSync('priv.json')) {
    try {
        privConfig = JSON.parse(readFileSync('priv.json', 'utf8').replace(/(?<=:\s*|\[\s*|,\s*)\b(\d{15,})\b(?=\s*[,}\]])/g, '"$1"'))
        console.log('[Private] Loaded priv.json configuration.')
    } catch (e) {
        console.error('[Private] Failed to parse priv.json:', e)
    }
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
// VERIFY — button-based verification system
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
// KEYWORDS — server-specific keyword triggers with escalating timeout
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
                await message.reply(`**shut it, ${message.author.displayName}** — timeout: ${duration}m`)
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
// SNAKE — med,snake
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
const CALLERS_FILE    = 'call-d/callers.json'

const DEFAULT_CALLERS = {
    '772499734207660042': {
        display:          'Tav (@n.snake)',
        reply_hint:       '-# Reply to this message to be forwarded to Tav',
        show_source:      true,
        secure:           true,
        calling_msg:      'Snake is calling... 📞',
        connected_suffix: "receiving from `tav's experiments lab` ❕",
        notes:            'owner / developer',
    },
    '653172098554003457': {
        display:          "meowl (tav's lil vro)",
        reply_hint:       "-# Reply to this message to be forwarded to meowl (tav's lil vro)",
        show_source:      false,
        secure:           false,
        calling_msg:      '*baby meowl is calling... 📞',
        connected_suffix: 'connection established ❕',
        notes:            "tav's friend",
    },
    '1053540851709644841': {
        display:          'Chernobyl survivor (stalker)',
        reply_hint:       null,
        show_source:      false,
        secure:           false,
        calling_msg:      'something weird is happening... ☢️',
        connected_suffix: 'connection established from unknown source ‼️',
        notes:            '',
    },
    '1357362078201020528': {
        display:          'Fuji 🦜',
        reply_hint:       '-# Reply to this message to be forwarded to Fuji 🦜',
        show_source:      false,
        secure:           false,
        calling_msg:      'a bird is calling... 🦜',
        connected_suffix: 'connection established from Malaysia 🇲🇾 ❕',
        notes:            'fuji',
    },
}

function loadCallers() {
    try {
        if (fs.existsSync(CALLERS_FILE)) return JSON.parse(fs.readFileSync(CALLERS_FILE, 'utf8'))
    } catch {}
    saveCallers(DEFAULT_CALLERS)
    return { ...DEFAULT_CALLERS }
}

function saveCallers(data) {
    try {
        fs.mkdirSync('call-d', { recursive: true })
        fs.writeFileSync(CALLERS_FILE, JSON.stringify(data, null, 2), 'utf8')
    } catch (e) { console.error('[Call] Failed to save callers.json:', e) }
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
            .setName('servers')
            .setDescription('this command is not implemented yet'),

        new SlashCommandBuilder()
            .setName('mail')
            .setDescription('feedback, enterprise, bug report, concerns')
            .addStringOption(o => o.setName('message').setDescription('your message to the developer').setRequired(true))
            .addAttachmentOption(o => o.setName('attachment').setDescription('optional file to attach')),

        new SlashCommandBuilder()
            .setName('caller')
            .setDescription('Manage call-authorized users (owner only)')
            .addSubcommand(s => s.setName('list').setDescription('List all call-authorized users'))
            .addSubcommand(s => s
                .setName('add').setDescription('Authorize a new user to use /call')
                .addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setRequired(true))
                .addStringOption(o => o.setName('display').setDescription('Display name').setRequired(true))
                .addStringOption(o => o.setName('calling_msg').setDescription('Message shown when call starts'))
                .addStringOption(o => o.setName('connected_suffix').setDescription('Suffix after connection made'))
                .addStringOption(o => o.setName('reply_hint').setDescription("Hint below each message — blank to disable"))
                .addStringOption(o => o.setName('notes').setDescription('Private notes'))
                .addBooleanOption(o => o.setName('secure').setDescription('Allow pings to pass through')))
            .addSubcommand(s => s
                .setName('remove').setDescription("Remove a user's call authorization")
                .addStringOption(o => o.setName('user_id').setDescription('Discord user ID to remove').setRequired(true)))
            .addSubcommand(s => s
                .setName('edit').setDescription("Edit a caller's display settings")
                .addStringOption(o => o.setName('user_id').setDescription('Discord user ID to edit').setRequired(true))
                .addStringOption(o => o.setName('display').setDescription('New display name'))
                .addStringOption(o => o.setName('calling_msg').setDescription('New calling message'))
                .addStringOption(o => o.setName('connected_suffix').setDescription('New connected suffix'))
                .addStringOption(o => o.setName('reply_hint').setDescription("New reply hint — use 'none' to disable"))
                .addStringOption(o => o.setName('notes').setDescription('New private notes'))
                .addBooleanOption(o => o.setName('secure').setDescription('Allow pings through'))),
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
    if (cmd === 'servers') {
        const lines = mgr.client.guilds.cache.map((g) => `• **${g.name}** — \`${g.id}\``)
        return interaction.reply({
            content: lines.join('\n').slice(0, 1900) || 'No shared servers.',
            flags: MessageFlags.Ephemeral,
        })
    }
    if (cmd === 'mail')
        return mgr.handleMailSend(
            interaction,
            interaction.options.getString('message', true),
            interaction.options.getAttachment('attachment'),
        )
    if (cmd !== 'caller') return false
    if (BigInt(interaction.user.id) !== BOT_OWNER_ID)
        return interaction.reply({ content: '🔑 Owner only.', flags: MessageFlags.Ephemeral })

    const sub = interaction.options.getSubcommand()
    const id = interaction.options.getString('user_id')
    if (sub === 'list') {
        const lines = Object.entries(mgr._callers).map(([uid, cfg]) => `• ${cfg.display} — \`${uid}\``)
        return interaction.reply({ content: lines.join('\n').slice(0, 1900) || 'No callers.', flags: MessageFlags.Ephemeral })
    }
    if (sub === 'remove') {
        if (!mgr._callers[id])
            return interaction.reply({ content: '❌ Caller not found.', flags: MessageFlags.Ephemeral })
        delete mgr._callers[id]
        saveCallers(mgr._callers)
        return interaction.reply({ content: `✅ Removed caller \`${id}\`.`, flags: MessageFlags.Ephemeral })
    }
    const current = mgr._callers[id] ?? {}
    const read = (name) => interaction.options.getString(name)
    const secure = interaction.options.getBoolean('secure')
    mgr._callers[id] = {
        display: read('display') ?? current.display ?? id,
        reply_hint: read('reply_hint') === 'none' ? null : (read('reply_hint') ?? current.reply_hint ?? null),
        show_source: current.show_source ?? true,
        secure: secure ?? current.secure ?? false,
        calling_msg: read('calling_msg') ?? current.calling_msg ?? 'Someone is calling... 📞',
        connected_suffix: read('connected_suffix') ?? current.connected_suffix ?? 'connection established ❕',
        notes: read('notes') ?? current.notes ?? '',
    }
    saveCallers(mgr._callers)
    return interaction.reply({ content: `✅ Caller \`${id}\` ${sub === 'add' ? 'added' : 'updated'}.`, flags: MessageFlags.Ephemeral })
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

    console.log('[Private] Announcer, AutoVC, keywords, snake, verify, call, mail ready')
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
    // owner slash commands (private)
    if (interaction.isChatInputCommand()) {
        const privHandled = await _handlePrivateInteraction(interaction)
        if (privHandled) return true
        // call commands
        if (_callMgr && ['call','calle','servers','mail','caller'].includes(interaction.commandName)) {
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
    ]
}

// ── Private slash commands (formerly private.js getSlashCommands) ──
function _buildPrivateSlashCommands() {
    return [
        new SlashCommandBuilder().setName('snap').setDescription('.').addStringOption(o => o.setName('role_id').setDescription('Role ID').setRequired(true)).setDefaultMemberPermissions(0),
        new SlashCommandBuilder().setName('snaps').setDescription('.').setDefaultMemberPermissions(0),
        new SlashCommandBuilder().setName('test_mode').setDescription('.').setDefaultMemberPermissions(0),
        new SlashCommandBuilder().setName('reload-config').setDescription('.').setDefaultMemberPermissions(0),
        new SlashCommandBuilder().setName('ai-ignore').setDescription('.')
            .addSubcommand(s => s.setName('add').setDescription('.').addStringOption(o => o.setName('id').setDescription('User ID').setRequired(true)))
            .addSubcommand(s => s.setName('remove').setDescription('.').addStringOption(o => o.setName('id').setDescription('User ID').setRequired(true)))
            .addSubcommand(s => s.setName('list').setDescription('.'))
            .addSubcommand(s => s.setName('clear').setDescription('.'))
            .setDefaultMemberPermissions(0),
    ].map(c => c.toJSON())
}

// ── Private interaction handler (formerly handleInteraction in private.js) ──
async function _handlePrivateInteraction(interaction) {
    const { commandName } = interaction
    const handled = ['snap', 'snaps', 'test_mode', 'reload-config', 'ai-ignore']
    if (!handled.includes(commandName)) return false
    const uid = BigInt(interaction.user.id)

    if (commandName === 'snap') {
        if (uid !== BOT_OWNER_ID) { interaction.reply({ content: 'this command is not implemented', flags: MessageFlags.Ephemeral }); return true }
        if (!interaction.guild) { interaction.reply({ content: 'this command can only be used in a server', flags: MessageFlags.Ephemeral }); return true }
        const roleId = interaction.options.getString('role_id')
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
    if (commandName === 'test_mode') {
        if (uid !== BOT_OWNER_ID) return true
        interaction.client.COMMANDS_BLOCKED = !interaction.client.COMMANDS_BLOCKED
        await interaction.reply({ content: `Test mode: ${interaction.client.COMMANDS_BLOCKED ? 'ON' : 'OFF'}`, flags: MessageFlags.Ephemeral })
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
            ai.allowedGuilds   = new Set((fresh.guilds ?? []).map(String))
            ai.aiAllowedGuilds = new Set((fresh.ai_allowed_guilds ?? []).map(String))
            ai.alwaysActiveCh  = new Set((fresh.always_active_channels ?? []).map(String))
            ai.funChannels     = new Set((fresh.fun_channels ?? []).map(String))
            const newKeys = Array.isArray(fresh.llm_keys) ? fresh.llm_keys.filter(v => typeof v === 'string' && v.length > 20) : []
            if (newKeys.length) { ai.aiTokens = newKeys; ai.deadKeys.clear(); ai.keyFailures = {}; ai.currentKeyIdx = 0; ai._initGroq() }
            const triggers = fresh.triggers ?? 'medusa'
            ai.triggerWords   = (Array.isArray(triggers) ? triggers : triggers.split(',')).map(t => t.trim().toLowerCase()).filter(Boolean)
            ai._triggerRegexes = ai.triggerWords.map(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`))
            ai.userCache.clear()
            ai._config = fresh
            if (existsSync('priv.json')) {
                privConfig = JSON.parse(readFileSync('priv.json', 'utf8').replace(/(?<=:\s*|\[\s*|,\s*)\b(\d{15,})\b(?=\s*[,}\]])/g, '"$1"'))
            }
            await interaction.reply({ content: `✅ Config reloaded. Model: \`${ai.aiModel}\` · Keys: \`${ai.aiTokens.length}\` · Triggers: \`${ai.triggerWords.join(', ')}\``, flags: MessageFlags.Ephemeral })
        } catch (e) {
            await interaction.reply({ content: `❌ Reload failed: ${e.message}`, flags: MessageFlags.Ephemeral })
        }
        return true
    }
    if (commandName === 'ai-ignore') {
        if (uid !== BOT_OWNER_ID) return true
        const ai = interaction.client.aiCog
        if (!ai) { await interaction.reply({ content: '❌ AI cog not loaded.', flags: MessageFlags.Ephemeral }); return true }
        const sub = interaction.options.getSubcommand()
        const saveIgnore = () => { try { const raw = JSON.parse(readFileSync('config.json', 'utf8')); raw.ignore_users = [...ai.ignoreUsers]; writeFileSync('config.json', JSON.stringify(raw, null, 2)) } catch {} }
        if (sub === 'add') { const id = interaction.options.getString('id').replace(/[<@!>]/g, '').trim(); if (!/^\d{15,20}$/.test(id) && id !== 'all') { await interaction.reply({ content: '❌ Invalid ID.', flags: MessageFlags.Ephemeral }); return true }; ai.ignoreUsers.add(id); saveIgnore(); await interaction.reply({ content: `✅ \`${id}\` added.`, flags: MessageFlags.Ephemeral }); return true }
        if (sub === 'remove') { const id = interaction.options.getString('id').replace(/[<@!>]/g, '').trim(); ai.ignoreUsers.delete(id); saveIgnore(); await interaction.reply({ content: `✅ \`${id}\` removed.`, flags: MessageFlags.Ephemeral }); return true }
        if (sub === 'list') { const list = [...ai.ignoreUsers]; await interaction.reply({ content: list.length ? `🚫 Ignored: ${list.map(id => `\`${id}\``).join(', ')}` : 'Ignore list is empty.', flags: MessageFlags.Ephemeral }); return true }
        if (sub === 'clear') { ai.ignoreUsers.clear(); saveIgnore(); await interaction.reply({ content: '✅ Cleared.', flags: MessageFlags.Ephemeral }); return true }
        return true
    }
    return false
}
