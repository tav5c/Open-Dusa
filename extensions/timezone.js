// timezone.js — Medusa extension: timezone tracking and meeting-time finder.
// Commands: /tzset, /tzremove, /tz, /tzbesttime, /tzis, /tzwhen.
// Data persists to Ai Database/timezones.json with async write-through.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags, PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import fs from 'fs';

export const manifest = {
    name: 'timezone',
    version: '1.0.0',
    author: 'tav',
    description: 'Timezone tracking and meeting-time finder',
    apiVersion: 1,
};

// Data cache — stored at repo root alongside config.json, not inside Ai Database/
// (that folder is for internal SQLite/cache files; this is user-visible data).
const DATA_FILE = 'timezones.json';
let _cache = null;

function getCache() {
  if (_cache === null) {
    _cache = fs.existsSync(DATA_FILE)
      ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
      : {};
  }
  return _cache;
}

function persistCache() {
  // Fire-and-forget. Caller never awaits — no interaction latency.
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
// TIME HELPERS — pure Intl, no network, DST handled by JS engine
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
// REVERSE MAP — built lazily at first use (locationMap defined below)
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

async function cmdTz(interaction, client) {
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
          : `<@${target.id}>\nInvalid timezone — use \`/tzset\` to fix.`)
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

  let visibleIds;
  try {
    if (interaction.guild) {
      const fetched   = await interaction.guild.members.fetch({ user: allIds });
      const memberSet = new Set(fetched.keys());
      visibleIds = allIds.filter(id => memberSet.has(id));
    } else {
      const channel = interaction.channel ?? await client.channels.fetch(interaction.channelId);
      if (channel?.type === ChannelType.GroupDM && channel.recipients?.size > 0) {
        const participants = new Set([interaction.user.id, ...channel.recipients.keys()]);
        visibleIds = allIds.filter(id => participants.has(id));
      } else if (channel?.type === ChannelType.DM) {
        const participants = new Set([interaction.user.id, ...(channel.recipient?.id ? [channel.recipient.id] : [])]);
        visibleIds = allIds.filter(id => participants.has(id));
      } else {
        visibleIds = allIds;
      }
    }
  } catch {
    visibleIds = allIds;
  }

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
      : `<@${uid}>\nInvalid timezone — use \`/tzset\` to fix.`;
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
    const allSaved = Object.keys(cache);
    if (interaction.guild && allSaved.length > 0) {
      try {
        const fetched = await interaction.guild.members.fetch({ user: allSaved });
        const memberSet = new Set(fetched.keys());
        userIds = allSaved.filter(id => memberSet.has(id));
      } catch { userIds = allSaved; }
    } else {
      userIds = allSaved;
    }
  }

  if (!userIds.length) {
    return interaction.reply({
      content: '❌ No timezones saved yet. Use `/tzset @user TIMEZONE` to add one.',
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
  const cache   = getCache(); // single load — was loaded twice in original
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
      content: `❌ Invalid time **${rawTime}** — check hours/minutes/seconds.`,
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
          ? `❌ **${rawTZ}** maps to multiple timezones — be more specific (e.g. \`America/Chicago\`).`
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
    targets = Object.entries(cache).map(([id, d]) => ({ id, ...d }));
  }

  if (!targets.length) {
    return interaction.reply({ content: '❌ No timezones saved yet.', flags: MessageFlags.Ephemeral });
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
// DISPATCH MAP — replaces the if-chain in the original handleCommand
// ─────────────────────────────────────────────────────────────────────────────
const _dispatch = {
  tzset:       (i, c) => cmdTzset(i, c),
  tzremove:    (i, c) => cmdTzremove(i, c),
  tz:          (i, c) => cmdTz(i, c),
  tzbesttime:  (i, c) => cmdTzbesttime(i, c),
  tzis:        (i, c) => cmdTzis(i, c),
  tzwhen:      (i, c) => cmdTzwhen(i, c),
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC INTERFACE
// handleInteraction returns true if it handled the interaction, false otherwise.
// This lets Medusa's router chain to the next handler gracefully.
// ─────────────────────────────────────────────────────────────────────────────
async function handleInteraction_internal(interaction, client) {
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
    await handler(interaction, client);
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND DEFINITIONS
// Spread into Medusa's commands array in registerCommands().
// ─────────────────────────────────────────────────────────────────────────────
// Reuse Medusa's UserInstallSlashCommandBuilder if available,
// or fall back to plain SlashCommandBuilder.
function _cmd(name, desc, BuilderClass = SlashCommandBuilder) {
  const b = new BuilderClass().setName(name).setDescription(desc);
  if (b.setIntegrationTypes) b.setIntegrationTypes(0, 1).setContexts(0, 1, 2);
  return b;
}

// Call this from registerCommands() and spread the result:
//   commands.push(...tz.buildCommands(UserInstallSlashCommandBuilder))
function buildCommands(BuilderClass) {
  return [
    _cmd('tzset', 'Set timezone for a user', BuilderClass)
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption(o => o.setName('timezone').setDescription('e.g. Malaysia, ET, UTC+8, America/New_York').setRequired(true)),
    _cmd('tz', 'Show current time for everyone (or a specific user)', BuilderClass)
      .addUserOption(o => o.setName('user').setDescription('User to check (optional)')),
    _cmd('tzremove', 'Remove timezone for a user', BuilderClass)
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    _cmd('tzbesttime', 'Find the best time for people to meet', BuilderClass)
      .addStringOption(o => o.setName('users').setDescription('Tag people to include (omit = everyone)')),
    _cmd('tzis', 'Look up the current time for any timezone or location', BuilderClass)
      .addStringOption(o => o.setName('location').setDescription('e.g. Malaysia, ET, UTC+8, Michigan').setRequired(true)),
    _cmd('tzwhen', 'Convert a time to everyone\'s timezone', BuilderClass)
      .addStringOption(o => o.setName('time').setDescription('e.g. 9, 14, 9am, 9:42, 18:24:09').setRequired(true))
      .addStringOption(o => o.setName('timezone').setDescription('Source timezone (default: your saved one)'))
      .addUserOption(o => o.setName('user').setDescription('Show conversion for one specific user only')),
  ];
}

export function init(client) {
  // Store client ref so handleInteraction can access it cleanly
  _client = client;
}

// Medusa's dispatcher calls this for every interaction.
// Return true if we handled it, false to let the next handler see it.
export async function handleInteraction(interaction) {
  return _handleInteraction(interaction, _client);
}

let _client = null;
const _handleInteraction = handleInteraction_internal;

export function getSlashCommands() {
  return buildCommands(SlashCommandBuilder).map(c => c.toJSON ? c.toJSON() : c);
}


// ─────────────────────────────────────────────────────────────────────────────
// LOCATION MAP — country/city/abbreviation → IANA timezone(s)
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

  // ── NORTH AMERICA — US ───────────────────────────────────────────────────────
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

  // ── NORTH AMERICA — CANADA ──────────────────────────────────────────────────
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

  // ── MIDDLE EAST ──────────────────────────────────────────────────────────────
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