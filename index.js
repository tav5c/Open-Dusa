import {
    ActionRowBuilder, ActivityType, ButtonBuilder, ButtonStyle,
    Client, Collection, ComponentType,
    EmbedBuilder, GatewayIntentBits, MessageFlags,
    Options, PermissionFlagsBits, REST, Routes, SlashCommandBuilder
} from 'discord.js'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import http from 'http'
import os from 'os'
import { existsSync } from 'fs'
import { performance } from 'perf_hooks'
import { setGlobalDispatcher } from 'undici'
import { _undiciAgent, buildAISlashCommands } from './extensions/ai.js'
import { attachHeart } from './extensions/heart.js'
import { resolveTarget } from './extensions/utils.js'

// Owner permission
const isOwner = (id) => {
    const appOwner = client.application?.owner;
    // Handle both Team owners and Individual owners
    const ownerId = appOwner?.ownerId || appOwner?.id || config.owner_id;
    return String(id) === String(ownerId);
};
setGlobalDispatcher(_undiciAgent)
process.setMaxListeners(30)
global.backendErrors = 0

// Logger 
const clr = {
    black: "\x1b[1;30m", red: "\x1b[1;31m", green: "\x1b[1;32m", yellow: "\x1b[1;33m",
    blue: "\x1b[1;34m", magenta: "\x1b[1;35m", cyan: "\x1b[1;36m", white: "\x1b[1;37m",
    reset: "\x1b[0m", pink: "\x1b[38;2;255;192;203m", light_green: "\x1b[1;92m",
    light_yellow: "\x1b[1;93m", light_magenta: "\x1b[1;95m", light_cyan: "\x1b[1;96m",
    light_red: "\x1b[1;91m", light_blue: "\x1b[1;94m"
}

const _tsFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Algiers', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
})
function getTs() {
    const parts = Object.fromEntries(_tsFormatter.formatToParts(new Date()).map(p => [p.type, p.value]))
    return `[${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod?.toUpperCase() ?? ''}]`
}
const origLog = console.log, origError = console.error, origWarn = console.warn
console.log   = (...a) => origLog(`${clr.cyan}${getTs()}${clr.reset}`, ...a)
console.warn  = (...a) => origWarn(`${clr.light_yellow}${getTs()} [WARN]${clr.reset}`, ...a)
console.error = (...a) => {
    const m = typeof a[0] === 'string' ? a[0] : (a[0]?.message || a[0]?.code || String(a[0]))
    if (m && (m.includes('No libpcap provider') || m.includes('UND_ERR_HEADERS_TIMEOUT') || m.includes('Headers Timeout'))) return
    if (a[1]?.code === 'UND_ERR_HEADERS_TIMEOUT') return
    const allArgs = a.map(x => typeof x === 'string' ? x : (x?.message || x?.code || String(x))).join(' ')
    if (allArgs.includes('521') || allArgs.includes('Unexpected server response')) return
    origError(`${clr.light_red}${getTs()} [ERROR]${clr.reset}`, ...a)
}

// Config 
const CONFIG_PATH = 'config.json'
function loadConfig() {
    try {const raw = readFileSync(CONFIG_PATH, 'utf8')
        return JSON.parse(raw.replace(/(?<=:\s*|\[\s*|,\s*)\b(\d{15,})\b(?=\s*[,}\]])/g, '"$1"'))} catch { return {} }}
function saveConfig(data) {
    try { 
        const runtimePath = 'runtime.json'
        const existing = existsSync(runtimePath) ? JSON.parse(readFileSync(runtimePath, 'utf8')) : {}
        // Only merge specific mutable fields, never overwrite base config
        const mutable = ['aiModel', 'ping_mode', 'ignore_users', 'isolated_servers']
        for (const key of mutable) {
            if (data[key] !== undefined) existing[key] = data[key]
        }
        writeFileSync(runtimePath, JSON.stringify(existing, null, 2), 'utf8')
    } catch (e) { console.error('[Config] runtime save error:', e) }
}
const config = loadConfig()

const RUNTIME_PATH = 'runtime.json'
if (existsSync(RUNTIME_PATH)) {
    try {
        const runtime = JSON.parse(readFileSync(RUNTIME_PATH, 'utf8'))
        // Only override specific mutable fields
        const mutable = ['aiModel', 'ping_mode', 'ignore_users', 'isolated_servers', 'temperature', 'topP']
        for (const key of mutable) {
            if (runtime[key] !== undefined) config[key] = runtime[key]
        }
        console.log('[Config] Loaded runtime overrides')
    } catch (e) { console.warn('[Config] Failed to load runtime.json:', e.message) }
}

// Constants 
const BOT_OWNER_ID    = config.owner_id ? BigInt(config.owner_id) : 0n;
const PREFIX          = config.prefix ?? 'med,'
const ALLOWED_GUILDS  = new Set((config.guilds || []).map(BigInt))

// Database 
let db
try {
    const { default: Database } = await import('better-sqlite3')
    mkdirSync('Logs', { recursive: true })
    db = new Database('Logs/medusa.db')
    db.pragma('locking_mode = EXCLUSIVE')
    try { db.pragma('journal_mode = WAL') } catch (e) { console.warn(`[DB] WAL mode fallback: ${e.message}`) }
    db.pragma('synchronous = NORMAL')
    db.pragma('temp_store = MEMORY')
    db.pragma('journal_size_limit = 4096000')
    try { db.pragma('mmap_size = 67108864') } catch {}
    db.pragma('cache_size = -20000')
    db.pragma('wal_autocheckpoint = 1000')
    db.pragma('busy_timeout = 5000')
    
    setInterval(() => { 
        try { 
            if (db.open) {
                db.pragma('wal_checkpoint(TRUNCATE)')
                // Prune old mod logs and resolved warnings monthly
                const cutoff = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10)
                db.prepare('DELETE FROM mod_logs WHERE timestamp < ?').run(cutoff)
                db.prepare('DELETE FROM warnings WHERE active = FALSE AND timestamp < ?').run(cutoff)
                db.prepare('DELETE FROM server_data WHERE guild_id NOT IN (SELECT DISTINCT guild_id FROM mod_logs UNION SELECT DISTINCT guild_id FROM warnings)').run()
                // Compact DB after major deletion
                db.prepare('VACUUM').run()
            }
        } catch {} 
    }, 300_000).unref();
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS mod_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id INTEGER, user_id INTEGER, moderator_id INTEGER,
            action TEXT, reason TEXT, duration TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS warnings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id INTEGER, user_id INTEGER, moderator_id INTEGER,
            reason TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            active BOOLEAN DEFAULT TRUE
        );
        CREATE TABLE IF NOT EXISTS automod_settings (
            guild_id INTEGER PRIMARY KEY,
            anti_spam BOOLEAN DEFAULT FALSE, anti_caps BOOLEAN DEFAULT FALSE,
            anti_links BOOLEAN DEFAULT FALSE, max_mentions INTEGER DEFAULT 5,
            spam_threshold INTEGER DEFAULT 5
        );
        CREATE TABLE IF NOT EXISTS reaction_roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id INTEGER, message_id INTEGER, emoji TEXT, role_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(message_id, emoji)
        );
        CREATE INDEX IF NOT EXISTS idx_warnings_gu ON warnings(guild_id, user_id);
        CREATE INDEX IF NOT EXISTS idx_mod_logs_g  ON mod_logs(guild_id);
        CREATE INDEX IF NOT EXISTS idx_mod_logs_gu ON mod_logs(guild_id, user_id);
    `)
    console.log('[DB] SQLite WAL initialized')
} catch (e) {
    console.error('[DB] better-sqlite3 unavailable:', e.message)
    db = { prepare: () => ({ run: () => {}, get: () => null, all: () => [] }), exec: () => {} }
}

// Client 
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates,
    ],
    ws: { properties: { os: 'linux', browser: 'Discord Android', device: 'Mobile' } },
    makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 100,
        GuildMemberManager: {
            maxSize: 200,
            keepOverLimit: m => m.id === client.user?.id,
        },
    }),
    sweepers: {
        ...Options.DefaultSweeperSettings,
        messages:     { interval: 300, lifetime: 900 },
        guildMembers: { interval: 600, filter: () => (m) => !m.voice?.channelId && m.id !== client.user?.id },
        users:        { interval: 1800, filter: () => u => u.id !== client.user?.id },
        threads:      { interval: 600, lifetime: 1800 },
    },
    rest: { timeout: 15000, retries: 3, globalRequestsPerSecond: 50 },
    allowedMentions: { parse: ['users'], repliedUser: false },
})

const heart = attachHeart(client)

// Prefix command map — must exist before extensions load
client.commands = new Collection()
const addCmd = (name, fn) => client.commands.set(name, fn)

// Dynamic Extension Loader — runs after client and heart are initialized
const CORE_EXTENSIONS = new Set(['ai', 'heart', 'moderation', 'automod', 'afk', 'utils'])
client.extensions = new Collection()
const extensionsPath = './extensions'
const extensionFiles = readdirSync(extensionsPath).filter(
    file => file.endsWith('.js') && !CORE_EXTENSIONS.has(file.replace('.js', ''))
)
for (const file of extensionFiles) {
    try {
        const { init, handleMessage, handleInteraction } = await import(`./extensions/${file}`)
        const extName = file.replace('.js', '')
        client.extensions.set(extName, { init, handleMessage, handleInteraction })
        if (init) init(client, db, heart)
        console.log(`[System] Loaded extension: ${extName}`)
    } catch (e) { console.error(`[System] Failed to load extension ${file}:`, e.message) }
}

process.on('exit', () => {
    try { if (db?.open) { db.pragma('wal_checkpoint(TRUNCATE)'); db.close() } } catch {}
    if (globalThis._aiMemManagers) {
        for (const mgr of globalThis._aiMemManagers) {
            try {
                if (mgr._flushTimer) { clearTimeout(mgr._flushTimer); for (const f of mgr._writeQueue) try { f() } catch {}; mgr._writeQueue = [] }
                if (mgr.db?.open) { mgr.db.pragma('wal_checkpoint(TRUNCATE)'); mgr.db.close() }
            } catch {}
        }
    }
})

async function cmdPing(ctx) {
    const t = performance.now();
    const reply = await ctx.reply({ content: 'Pinging...' });
    
    const cli = (performance.now() - t).toFixed(2);
    const content = `Websocket Latency: \`${client.ws.ping.toFixed(2)}ms\`, Client Latency: \`${cli}ms\``;

    if (ctx.isChatInputCommand?.()) {
        // It's a slash command idiota
        await ctx.editReply({ content });
    } else {
        // It's a prefix message command
        await reply.edit({ content });
    }
}

async function cmdStats(ctx) {
    const isMsg = !ctx.isChatInputCommand?.()
    const t = performance.now()
    const reply = isMsg ? await ctx.reply('📊 Gathering telemetry...') : await ctx.deferReply({ withResponse: true })
    const cli   = (performance.now() - t).toFixed(2)
    const upMs  = Date.now() - heart.startTime
    const h = Math.floor(upMs / 3_600_000), m = Math.floor((upMs % 3_600_000) / 60_000), s = Math.floor((upMs % 60_000) / 1_000)
    const mem   = process.memoryUsage()
    const memMB = (mem.rss / 1024 / 1024).toFixed(1)
    const cpu   = (heart.monitor.cpu ?? 0).toFixed(1)
    const lat   = client.ws.ping
    let stability = 100
    if (parseFloat(memMB) > 230 || parseFloat(cpu) > 85) stability -= 30
    if (lat > 200) stability -= 15
    const aiCog  = client.aiCog
    const aiStats= aiCog ? `\n🧠 **AI Engine:** Cache: \`${aiCog.userCache.size}\` | Hist: \`${aiCog.messageHistory.size}\` | Errors: \`${aiCog.errorCount}\`` : ''
    const embed = new EmbedBuilder()
        .setTitle('📊 | Medusa System Telemetry')
        .setColor(stability >= 70 ? 0x1D9E75 : stability >= 50 ? 0xEF9F27 : 0xE24B4A)
        .setDescription(`**Host Information & Performance Benchmark**${aiStats}\n🚪 **Backend:** Process Errors: \`${global.backendErrors}\``)
        .addFields(
            { name: '📡 Network Latency',  value: `WebSocket: \`${lat}ms\`\nAPI/Cmd: \`${cli}ms\``, inline: true },
            { name: '⚙️ Resource Usage',   value: `RAM: \`${memMB}MB\`\nCPU: \`${cpu}%\` (\`${os.cpus().length}\` cores)`, inline: true },
            { name: '🔄 Uptime & Status',  value: `Up: \`${h}h ${m}m ${s}s\`\nStability: \`${Math.max(0, stability)}/100\``, inline: true },
            { name: '📈 Cache & Coverage', value: `Guilds: \`${client.guilds.cache.size}\`\nUsers: \`${client.users.cache.size}\`\nChannels: \`${client.channels.cache.size}\``, inline: true },
            { name: '⚡ Active Processing',value: `Tasks: \`${heart._tasks.size}\`\nFired: \`${heart._stats.firedTasks}\``, inline: true },
            { name: '🖥️ OS Environment',   value: `${os.type()} ${os.release()}\nNode: \`${process.version}\``, inline: true },
        )
    isMsg ? await reply.edit({ content: '', embeds: [embed] }) : await ctx.editReply({ embeds: [embed] })
}

async function cmdGuild(ctx) {
    const guild = ctx.guild
    if (!guild) return ctx.reply({ content: 'This command can only be used in a server.' })
    const owner = await guild.fetchOwner().catch(() => null)
    const created = `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`
    const embed = new EmbedBuilder()
        .setTitle(`📊 ${guild.name}`)
        .setThumbnail(guild.iconURL({ size: 256 }))
        .addFields(
            { name: '👑 Owner',    value: owner ? `${owner.user.username} (\`${owner.id}\`)` : 'Unknown', inline: true },
            { name: '👥 Members',  value: `\`${guild.memberCount}\``, inline: true },
            { name: '📅 Created',  value: created, inline: true },
            { name: '🆔 Server ID',value: `\`${guild.id}\``, inline: true },
        )
        .setColor(0x378ADD)
    await ctx.reply({ embeds: [embed] })
}

async function cmdUserinfo(ctx, targetArgs) {
    let member = targetArgs
    if (!member) member = ctx.member
    const isRawUser = !member.user
    const userObj   = isRawUser ? member : member.user
    const displayName = isRawUser ? (userObj.globalName ?? userObj.username) : member.displayName
    const created = `<t:${Math.floor(userObj.createdTimestamp / 1000)}:D>`
    const joined  = (!isRawUser && member.joinedTimestamp) ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : 'N/A'
    const roles   = isRawUser ? [] : [...member.roles.cache.values()].filter(r => r.id !== ctx.guild?.id).sort((a,b) => b.position-a.position).map(r => `<@&${r.id}>`)
    const embed = new EmbedBuilder()
        .setTitle(`👤 ${displayName}`)
        .setThumbnail(userObj.displayAvatarURL({ size: 256 }))
        .addFields(
            { name: '🏷️ Username', value: `@${userObj.username}`, inline: true },
            { name: '🆔 User ID',  value: `\`${userObj.id}\``, inline: true },
            { name: '📅 Dates',    value: `**Created:** ${created}\n**Joined:** ${joined}`, inline: true },
            { name: `🏷️ Roles (${roles.length})`, value: roles.length ? roles.slice(0, 15).join(' ') + (roles.length > 15 ? '...' : '') : 'No roles', inline: false },
        )
        .setColor((!isRawUser && member.displayHexColor !== '#000000') ? member.displayHexColor : 0x378ADD)
        .setFooter({ text: `Requested by ${ctx.user?.username ?? ctx.author?.username}`, iconURL: ctx.user?.displayAvatarURL() ?? ctx.author?.displayAvatarURL() })
        .setTimestamp()
    if (userObj.bannerURL()) embed.setImage(userObj.bannerURL({ size: 1024, forceStatic: false }))
    await ctx.reply({ embeds: [embed] })
}

async function cmdAv(ctx, args) {
    let member = Array.isArray(args) ? await resolveTarget(ctx, args) : (args ?? ctx.member)
    if (!member) return ctx.reply({ content: '❌ Could not find that user.' }).catch(() => {})
    const isRawUser   = !member.joinedTimestamp && !member.user
    const userObj     = isRawUser ? member : member.user
    const displayName = isRawUser ? (userObj.globalName ?? userObj.username) : member.displayName
    const color       = (!isRawUser && member.displayHexColor && member.displayHexColor !== '#000000') ? member.displayHexColor : 0x378ADD    
    const avatarUrl   = (member.displayAvatarURL ? member : userObj).displayAvatarURL({ size: 1024, forceStatic: false })
    await ctx.reply({ embeds:[new EmbedBuilder().setTitle(`👤 Avatar - ${displayName}`).setImage(avatarUrl).setColor(color).setFooter({ text: 'Medusa • Server Avatar' })] })
}

async function cmdMav(ctx, args) {
    let member = Array.isArray(args) ? await resolveTarget(ctx, args) : (args ?? ctx.member)
    if (!member) return ctx.reply({ content: '❌ Could not find that user.' }).catch(() => {})
    const isRawUser = !member.joinedTimestamp && !member.user
    const userObj   = isRawUser ? member : member.user
    if (!userObj) return ctx.reply({ content: '❌ Could not resolve user.' }).catch(() => {})
    await ctx.reply({ embeds: [new EmbedBuilder().setTitle(`🖼️ Main Avatar - ${userObj.username}`).setImage(userObj.displayAvatarURL({ size: 1024, forceStatic: false })).setColor(0x378ADD)] })
}

async function cmdBn(ctx, args) {
    let member = Array.isArray(args) ? await resolveTarget(ctx, args) : (args ?? ctx.member)
    let bannerUrl = null, isFallback = false
    try {
        const data = await client.rest.get(`/guilds/${ctx.guild.id}/members/${member.id}`)
        if (data.banner) bannerUrl = `https://cdn.discordapp.com/guilds/${ctx.guild.id}/users/${member.id}/banners/${data.banner}.${data.banner.startsWith('a_') ? 'gif' : 'png'}?size=2048`
    } catch {}
    const user = !bannerUrl ? await client.users.fetch(member.id, { force: true }).catch(() => null) : null
    if (!bannerUrl && user) { bannerUrl = user.bannerURL({ size: 2048, forceStatic: false }); if (bannerUrl) isFallback = true }
    const isRawUser = !member.joinedTimestamp && !member.user
    const embed = new EmbedBuilder()
        .setTitle(`🎌 Banner - ${isRawUser ? (member.globalName ?? member.username) : member.displayName}`)
        .setColor((!isRawUser && member.displayHexColor && member.displayHexColor !== '#000000') ? member.displayHexColor : 0x378ADD)
    if (bannerUrl) { embed.setImage(bannerUrl); embed.setFooter({ text: isFallback ? '💡 Showing global banner' : 'Medusa • Server-Specific Banner' }) }
    else { if (user?.hexAccentColor) embed.setColor(user.hexAccentColor); embed.setDescription('❌ No banner image found.') }
    await ctx.reply({ embeds: [embed] })
}

async function cmdMbn(ctx, args) {
    let member = Array.isArray(args) ? await resolveTarget(ctx, args) : (args ?? ctx.member)
    if (ctx.isChatInputCommand?.() && !ctx.deferred) await ctx.deferReply().catch(() => {})
    const user = await client.users.fetch(member.id, { force: true })
    const embed = new EmbedBuilder().setTitle(`🎌 Main Banner - ${user.username}`).setColor(0x378ADD)
    if (user.bannerURL()) {
        embed.setImage(user.bannerURL({ size: 1024, forceStatic: false }))
        embed.setColor(typeof user.hexAccentColor === 'string' ? user.hexAccentColor : 0x378ADD)
    } else { embed.setDescription('❌ No main banner set.') }
    if (ctx.deferred) await ctx.editReply({ embeds: [embed] }); else await ctx.reply({ embeds: [embed] })
}

async function cmdEmbed(interaction) {
    const title  = interaction.options.getString('title')
    const desc   = interaction.options.getString('description')
    const image  = interaction.options.getString('image') ?? null
    const ftText = interaction.options.getString('footer_text') ?? null
    const ftIcon = interaction.options.getString('footer_icon') ?? null
    const embed  = new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0x378ADD)
    if (image) embed.setImage(image)
    if (ftText) embed.setFooter({ text: ftText, iconURL: ftIcon ?? undefined })
    await interaction.reply({ embeds: [embed] })
}

async function cmdMenu(ctx) {
    // Menu implementation preserved from original — abbreviated here for clarity
    const PREFIX_REF = config.prefix ?? 'med,'
    const pages = [
        { title: '🐍 Medusa — Main Menu', desc: `**Prefix:** \`${PREFIX_REF}\`\nUse the arrows to browse commands.` },
        { title: '🛡️ Moderation', desc: `\`ban\` \`unban\` \`mute\` \`unmute\` \`warn\` \`warnings\` \`modlog\` \`clearwarns\` \`clear\` \`mpurge\` \`fpurge\`` },
        { title: '👤 Profile', desc: `\`av\` \`mav\` \`bn\` \`mbn\` \`userinfo\` \`guild\`` },
        { title: '🤖 AI', desc: `Mention Medusa or type her name to chat.\n\`${PREFIX_REF}p\` — Set custom prompt\n\`${PREFIX_REF}pr\` — Reset prompt\n\`${PREFIX_REF}mode\` — focused/normal\n\`/memory\` \`/forgetme\` \`/summarize\` \`/lore\`` },
        { title: '💤 AFK', desc: `\`${PREFIX_REF}afk [reason]\` — Go AFK\n\`${PREFIX_REF}unafk\` — Return` },
        { title: '🔧 Utility', desc: `\`ping\` \`stats\` \`menu\` \`help\` \`embed\` \`benchmark\`` },
    ]
    let cur = 0
    const mkEmbed = (p) => new EmbedBuilder().setTitle(pages[p].title).setDescription(pages[p].desc).setColor(0x378ADD).setFooter({ text: `Page ${p + 1}/${pages.length} • n.snake (tav) • Project: Medusa` })
    const mkRow   = (p) => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mn_prev').setLabel('◀️').setStyle(ButtonStyle.Primary).setDisabled(p === 0),
        new ButtonBuilder().setCustomId('mn_next').setLabel('▶️').setStyle(ButtonStyle.Primary).setDisabled(p >= pages.length - 1),
        new ButtonBuilder().setCustomId('mn_close').setLabel('❌').setStyle(ButtonStyle.Danger),
    )
    const resp = await ctx.reply({ embeds: [mkEmbed(0)], components: [mkRow(0)], withResponse: true })
    const send = resp.resource?.message ?? await ctx.fetchReply().catch(() => null)
    const auth = ctx.user ?? ctx.author
    const col  = send.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60_000 })
    col.on('collect', async i => {
        if (i.user.id !== auth.id) return i.reply({ content: `Not yours. Use /menu.`, flags: MessageFlags.Ephemeral })
        if (i.customId === 'mn_close') { col.stop(); return i.update({ components: [] }) }
        cur = i.customId === 'mn_prev' ? Math.max(0, cur - 1) : Math.min(pages.length - 1, cur + 1)
        await i.update({ embeds: [mkEmbed(cur)], components: [mkRow(cur)] })
    })
    col.on('end', () => send.edit({ components: [] }).catch(() => {}))
}

// Slash command definitions 
const SLASH_CMDS = [
    new SlashCommandBuilder().setName('ping').setDescription('Check latency'),
    new SlashCommandBuilder().setName('stats').setDescription('Live performance stats'),
    new SlashCommandBuilder().setName('menu').setDescription("Open Medusa's system menu"),
    new SlashCommandBuilder().setName('guild').setDescription('Server information'),
    new SlashCommandBuilder().setName('userinfo').setDescription('User information').addUserOption(o => o.setName('member').setDescription('Target user')),
    new SlashCommandBuilder().setName('av').setDescription("User's server avatar").addUserOption(o => o.setName('member').setDescription('Target user')),
    new SlashCommandBuilder().setName('mav').setDescription("User's main profile avatar").addUserOption(o => o.setName('member').setDescription('Target user')),
    new SlashCommandBuilder().setName('bn').setDescription("User's server banner").addUserOption(o => o.setName('member').setDescription('Target user')),
    new SlashCommandBuilder().setName('mbn').setDescription("User's main profile banner").addUserOption(o => o.setName('member').setDescription('Target user')),
    new SlashCommandBuilder().setName('ban').setDescription('Ban a user').addUserOption(o => o.setName('member').setDescription('Member to ban').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason')).setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID').addStringOption(o => o.setName('user_id').setDescription('User ID').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    new SlashCommandBuilder().setName('mute').setDescription('Timeout a user').addUserOption(o => o.setName('member').setDescription('Member to mute').setRequired(true)).addStringOption(o => o.setName('duration').setDescription('e.g. 15m, 2h, 1d').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason')).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder().setName('unmute').setDescription('Remove timeout').addUserOption(o => o.setName('member').setDescription('Member to unmute').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder().setName('warn').setDescription('Warn a user').addUserOption(o => o.setName('member').setDescription('Member to warn').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason')).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder().setName('warnings').setDescription('View warnings').addUserOption(o => o.setName('member').setDescription('Target user').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder().setName('modlog').setDescription('View moderation logs').addUserOption(o => o.setName('user').setDescription('Filter by user')).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder().setName('clear').setDescription('Purge messages').addIntegerOption(o => o.setName('amount').setDescription('Number of messages').setMinValue(1).setMaxValue(500)),
    new SlashCommandBuilder().setName('mpurge').setDescription('Delete all messages from a member').addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true)).addBooleanOption(o => o.setName('server_wide').setDescription('All channels')).addStringOption(o => o.setName('start_from_id').setDescription('Message ID to start from')).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    new SlashCommandBuilder().setName('filter_purge').setDescription('Delete messages matching text').addStringOption(o => o.setName('text').setDescription('Text to search for').setRequired(true)).addUserOption(o => o.setName('user').setDescription('Only from this user')).addIntegerOption(o => o.setName('limit').setDescription('Messages to scan').setMinValue(1).setMaxValue(500)).addBooleanOption(o => o.setName('exact').setDescription('Exact match')).addStringOption(o => o.setName('after_id').setDescription('After message ID')).addStringOption(o => o.setName('before_id').setDescription('Before message ID')).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    new SlashCommandBuilder().setName('embed').setDescription('Send a custom embed').addStringOption(o => o.setName('title').setDescription('Embed title').setRequired(true)).addStringOption(o => o.setName('description').setDescription('Embed description').setRequired(true)).addStringOption(o => o.setName('image').setDescription('Image URL')).addStringOption(o => o.setName('footer_text').setDescription('Footer text')).addStringOption(o => o.setName('footer_icon').setDescription('Footer icon URL')).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    new SlashCommandBuilder().setName('automod').setDescription('Configure automod').addSubcommand(s => s.setName('status').setDescription('View settings')).addSubcommand(s => s.setName('anti-spam').setDescription('Toggle anti-spam').addBooleanOption(o => o.setName('enabled').setDescription('Enable/disable').setRequired(true))).addSubcommand(s => s.setName('anti-caps').setDescription('Toggle anti-caps').addBooleanOption(o => o.setName('enabled').setDescription('Enable/disable').setRequired(true))).addSubcommand(s => s.setName('anti-links').setDescription('Toggle anti-links').addBooleanOption(o => o.setName('enabled').setDescription('Enable/disable').setRequired(true))).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(c => c.toJSON())


addCmd('av',    (msg, args) => cmdAv(msg, args))
addCmd('bn',    (msg, args) => cmdBn(msg, args))
addCmd('mbn',   (msg, args) => cmdMbn(msg, args))
addCmd('mav',   (msg, args) => cmdMav(msg, args))
addCmd('userinfo', (msg, args) => resolveTarget(msg, args).then(m => cmdUserinfo(msg, m)))
addCmd('ping',      (msg) => cmdPing(msg))
addCmd('stats',     (msg) => cmdStats(msg))
addCmd('benchmark', (msg) => cmdStats(msg))
addCmd('system',    (msg) => cmdStats(msg))
addCmd('guild',     (msg) => cmdGuild(msg))
addCmd('menu',      (msg) => cmdMenu(msg))
addCmd('help', async (msg, args) => {
    const name = args[0]
    if (!name) return msg.reply({ content: `Please provide a command name. Usage: \`${PREFIX}help <command>\`` })
    await msg.reply(client.commands.has(name)
        ? `\`\`\`js\n1 - Command Help : ${name}\n2 - Usage : ${PREFIX}${name} [...args]\n\`\`\``
        : `**No command named** \`'${name}'\` **was ever found**`)
})

// Agent server tools
addCmd('setbotname', async (msg, args) => {
    if (BigInt(msg.author.id) !== BOT_OWNER_ID) return
    try { await client.user.setUsername(args.join(' ')); await msg.reply(`✅ Global name changed.`) }
    catch (e) { await msg.reply(`❌ Failed: ${e.message}`) }
})
addCmd('setbotavatar', async (msg, args) => {
    if (!msg.guild || !msg.member?.permissions.has(PermissionFlagsBits.Administrator)) return
    let url = args[0] || msg.attachments.first()?.url
    if (!url && msg.reference?.messageId) { const ref = await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null); url = ref?.attachments.first()?.url }
    try { await client.user.setAvatar(url); await msg.reply(`✅ Global avatar updated.`) }
    catch (e) { await msg.reply(`❌ Failed: ${e.message}`) }
})
addCmd('setnickname', async (msg, args) => {
    if (!msg.member || !msg.guild.members.me) return
    if (!msg.member.permissions.has(PermissionFlagsBits.ManageNicknames)) return
    if (msg.author.id !== msg.guild.ownerId && msg.member.roles.highest.position <= msg.guild.members.me.roles.highest.position)
        return msg.reply("❌ You must have a role higher than mine to change my nickname!")
    try { await msg.guild.members.me.setNickname(args.join(' ')); await msg.reply(`✅ Nickname changed.`) }
    catch (e) { await msg.reply(`❌ Failed: ${e.message}`) }
})
addCmd('createchan', async (msg, args) => {
    if (!msg.member.permissions.has(PermissionFlagsBits.ManageChannels)) return
    const type = args[0]?.toLowerCase() === 'voice' ? 2 : 0
    try { const ch = await msg.guild.channels.create({ name: args.slice(1).join('-') || 'new-channel', type }); await msg.reply(`✅ Created <#${ch.id}>.`) }
    catch (e) { await msg.reply(`❌ Failed: ${e.message}`) }
})
addCmd('delchan', async (msg, args) => {
    if (!msg.member.permissions.has(PermissionFlagsBits.ManageChannels)) return
    const ch = msg.mentions.channels.first() || msg.guild.channels.cache.get(args[0]?.replace(/[<#>]/g, ''))
    if (!ch) return msg.reply("❌ Channel not found.")
    try { await ch.delete(); await msg.reply(`✅ Deleted.`) } catch (e) { await msg.reply(`❌ Failed: ${e.message}`) }
})
addCmd('renameserver', async (msg, args) => {
    if (!msg.member.permissions.has(PermissionFlagsBits.ManageGuild)) return
    try { await msg.guild.setName(args.join(' ')); await msg.reply(`✅ Server renamed.`) }
    catch (e) { await msg.reply(`❌ Failed: ${e.message}`) }
})
addCmd('addemoji', async (msg, args) => {
    if (!msg.member.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) return
    const name = args[0]
    let url = args[1] || msg.attachments.first()?.url
    if (!url && msg.reference?.messageId) { const ref = await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null); url = ref?.attachments.first()?.url }
    if (!url || !name) return msg.reply("❌ Provide a name and image URL.")
    try { const emoji = await msg.guild.emojis.create({ attachment: url, name }); await msg.reply(`✅ Added emoji: ${emoji}`) }
    catch (e) { await msg.reply(`❌ Failed: ${e.message}`) }
})
addCmd('lockchannel', async (msg, args) => {
    if (!msg.member.permissions.has(PermissionFlagsBits.ManageRoles)) return
    const ch = msg.mentions.channels.first() || msg.channel
    const roleId = args.find(a => a.startsWith('<@&'))?.replace(/[<@&>]/g, '') || msg.guild.roles.everyone.id
    try { await ch.permissionOverwrites.edit(roleId, { SendMessages: false }); await msg.reply(`🔒 Locked ${ch}.`) }
    catch (e) { await msg.reply(`❌ Failed: ${e.message}`) }
})
addCmd('unlockchannel', async (msg, args) => {
    if (!msg.member.permissions.has(PermissionFlagsBits.ManageRoles)) return
    const ch = msg.mentions.channels.first() || msg.channel
    const roleId = args.find(a => a.startsWith('<@&'))?.replace(/[<@&>]/g, '') || msg.guild.roles.everyone.id
    try { await ch.permissionOverwrites.edit(roleId, { SendMessages: null }); await msg.reply(`🔓 Unlocked ${ch}.`) }
    catch (e) { await msg.reply(`❌ Failed: ${e.message}`) }
})
addCmd('auditlogs', async (msg, args) => {
    if (!msg.member.permissions.has(PermissionFlagsBits.ViewAuditLog)) return
    try {
        const fetchOpts = { limit: !isNaN(args[0]) ? Math.min(20, parseInt(args[0])) : 5 }
        if (args[1] && !isNaN(args[1])) fetchOpts.type = parseInt(args[1])
        const logs = await msg.guild.fetchAuditLogs(fetchOpts)
        const entries = logs.entries.map(e => `• **${e.executor?.username}** → Action \`${e.action}\` on \`${e.target?.username || e.targetId || 'N/A'}\`${e.reason ? ` (${e.reason})` : ''}`)
        await msg.reply({ embeds: [{ title: '📋 Audit Logs', description: entries.join('\n').slice(0, 4000) || 'No recent logs', color: 0x378ADD }] })
    } catch (e) { await msg.reply(`❌ Failed: ${e.message}`) }
})
addCmd('addrole', async (msg, args) => {
    if (!msg.member.permissions.has(PermissionFlagsBits.ManageRoles)) return
    const target = await resolveTarget(msg, args, false)
    if (!target) return msg.reply('Member not found.')
    const role = msg.guild.roles.cache.get(args[1]?.replace(/[<@&>]/g, ''))
    if (!role) return msg.reply('Role not found.')
    try { await target.roles.add(role); await msg.reply(`✅ Added **${role.name}** to ${target.user.username}.`) }
    catch (e) { await msg.reply(`❌ Failed: ${e.message}`) }
})
addCmd('removerole', async (msg, args) => {
    if (!msg.member.permissions.has(PermissionFlagsBits.ManageRoles)) return
    const target = await resolveTarget(msg, args, false)
    if (!target) return msg.reply('Member not found.')
    const role = msg.guild.roles.cache.get(args[1]?.replace(/[<@&>]/g, ''))
    if (!role) return msg.reply('Role not found.')
    try { await target.roles.remove(role); await msg.reply(`✅ Removed **${role.name}** from ${target.user.username}.`) }
    catch (e) { await msg.reply(`❌ Failed: ${e.message}`) }
})
addCmd('listroles', async (msg) => {
    const roles = msg.guild.roles.cache.sort((a,b) => b.position-a.position).map(r => r.name).slice(0, 30)
    await msg.reply(`🎭 **Server Roles:**\n${roles.join(', ')}`)
})

    client.once('clientReady', async () => {
    try {
        await client.application.fetch();
        // Check if it's a team or a single user
        const owner = client.application.owner.owner ? client.application.owner.owner.user : client.application.owner;
        console.log(`[System] Medusa is live. Owner: ${owner.tag || owner.username}`);
    } catch (e) {
        console.error('[System] Failed to fetch application info:', e);
    }
    console.clear()
    const allCmds =[...SLASH_CMDS, ...buildAISlashCommands()]
    
    // Dynamically inject Slash Commands from Extensions
    for (const ext of client.extensions.values()) {
        if (ext.getSlashCommands) allCmds.push(...ext.getSlashCommands())
    }
    
    const { createHash } = await import('crypto')
    const currentHash = createHash('md5').update(JSON.stringify(allCmds)).digest('hex')
    let cachedHash = ''
    try { cachedHash = readFileSync('.slash_hash', 'utf8') } catch {}
    if (currentHash !== cachedHash) {
        const rest = new REST().setToken(config.token)
        try { await rest.put(Routes.applicationCommands(client.user.id), { body: allCmds }); writeFileSync('.slash_hash', currentHash); console.log(`[Slash] ${allCmds.length} commands synced to Discord API`) }
        catch (e) { console.error('[Slash] Registration failed:', e) }
    } else { console.log(`[Slash] ${allCmds.length} commands (Cache match, skipped sync)`) }

    try { const { registerAI } = await import('./extensions/ai.js'); await registerAI(client, db, config); console.log('[AI] Extension loaded') }
    catch (e) { console.error('[AI] Load failed:', e) }

    await client.user.setPresence({
        activities: [{ name: 'Meduda 🪼', type: ActivityType.Watching }],
        status: 'online',
    })

    try {
        http.createServer((_, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()), guilds: client.guilds.cache.size, ping: client.ws.ping, memory: Math.floor(process.memoryUsage().rss / 1024 / 1024) }))
        }).listen(process.env.HEALTH_PORT || 8080).unref()
        console.log(`[Health] Listening on port ${process.env.HEALTH_PORT || 8080}`)
    } catch {}

    console.log(`\n  ⛧ MEDUSA ⛧\n  Logged as: ${client.user.tag}\n  Prefix: ${PREFIX}\n  Servers: ${client.guilds.cache.size}\n`)
})

// interactionCreate
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return

    const { commandName } = interaction
    const uid  = BigInt(interaction.user.id)
    const perm = interaction.memberPermissions

    if (client.COMMANDS_BLOCKED && uid !== BOT_OWNER_ID) return

    // Dynamic Extension Interaction Handlers
    for (const ext of client.extensions.values()) {
        if (ext.handleInteraction) {
            const handled = await ext.handleInteraction(interaction);
            if (handled === true) return;
        }
    }

    // Core commands
    if (commandName === 'ping')     return cmdPing(interaction)
    if (commandName === 'stats')    return cmdStats(interaction)
    if (commandName === 'menu')     return cmdMenu(interaction)
    if (commandName === 'guild')    return cmdGuild(interaction)
    if (commandName === 'userinfo') return cmdUserinfo(interaction, interaction.options.getMember('member') ?? interaction.member)
    if (commandName === 'av')  return cmdAv(interaction, interaction.options.getMember('member') ?? interaction.member)
    if (commandName === 'mav') return cmdMav(interaction, interaction.options.getMember('member') ?? interaction.member)
    if (commandName === 'bn')  return cmdBn(interaction, interaction.options.getMember('member') ?? interaction.member)
    if (commandName === 'mbn') return cmdMbn(interaction, interaction.options.getMember('member') ?? interaction.member)
    if (commandName === 'embed') return cmdEmbed(interaction)
    }
   )

// Message Creation
client.on('messageCreate', async message => {
    try {
        if (message.author.bot || !message.guild) return
    if (ALLOWED_GUILDS.size && !ALLOWED_GUILDS.has(BigInt(message.guild.id))) return

    const content = message.content.trim()

    // Dynamic Extension Message Handlers
    for (const ext of client.extensions.values()) {
        if (ext.handleMessage) {
            const handled = await ext.handleMessage(message);
            if (handled === true) return; // Stop if extension wants to 'sink' the message
        }
    }

    // Prefix commands
    if (!content.startsWith(PREFIX)) return
    const withoutPrefix = content.slice(PREFIX.length).trim()
    const [cmdName, ...args] = withoutPrefix.split(/\s+/)
    const handler = client.commands.get(cmdName.toLowerCase())
        if (!handler) return

        console.log(`[CMD] ${clr.pink}${message.author.tag}${clr.reset} executed: ${clr.light_green}${content}${clr.reset} in #${message.channel.name}`)
        try { await handler(message, args) } catch (e) { console.error(`[CMD] ${cmdName} error:`, e) }
    } catch (e) {
        console.error('Fatal Message Error:', e)
    }
})

// Run
const token = config.token ?? process.env.TOKEN
if (!token) { console.error('No token found in config.json or TOKEN env'); process.exit(1) }
client.login(token)
