const fs = require('fs');
const { spawn, execFile } = require('child_process');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, StreamType, VoiceConnectionStatus,
  entersState, getVoiceConnection, generateDependencyReport,
} = require('@discordjs/voice');

console.log(generateDependencyReport());

// ---------- ffmpeg ----------
let ffmpegPath = 'ffmpeg';
try {
  const p = require('ffmpeg-static');
  if (p && fs.existsSync(p)) ffmpegPath = p;
} catch {}
console.log('ffmpeg:', ffmpegPath);

// ---------- الاعدادات ----------
function readFile(name) {
  try { return fs.readFileSync(__dirname + '/' + name, 'utf8'); } catch { return ''; }
}
let PREFIX = (process.env.PREFIX || readFile('prefix.txt')).trim() || '!';

// التوكنات: tokens.txt (كل توكن بسطر) او TOKENS (مفصولة بفاصلة) او TOKEN / token.txt
let rawTokens = [];
if (process.env.TOKENS) rawTokens = process.env.TOKENS.split(',');
else if (process.env.TOKEN) rawTokens = [process.env.TOKEN];
else rawTokens = (readFile('tokens.txt') || readFile('token.txt')).split(/\r?\n/);
const TOKENS = [...new Set(rawTokens
  .map((t) => t.trim().replace(/^["']|["']$/g, ''))
  .filter((t) => t && !t.startsWith('#') && !/[^\x20-\x7E]/.test(t)))];
if (!TOKENS.length) {
  console.error('❌ ما لقيت توكنات. افتح tokens.txt وحط كل توكن بسطر.');
  process.exit(1);
}
console.log(`Prefix: ${PREFIX} | Bots: ${TOKENS.length}`);

// ---------- yt-dlp ----------
function getTitle(url) {
  return new Promise((resolve) => {
    execFile('yt-dlp', ['--no-playlist', '--print', 'title', url], { timeout: 20000 },
      (err, out) => resolve(err || !out.trim() ? url : out.trim().split('\n')[0]));
  });
}
function getDirect(url) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', ['--no-playlist', '--no-warnings', '-f', 'bestaudio/best', '--dump-single-json', url],
      { timeout: 45000, maxBuffer: 1024 * 1024 * 50 }, (err, out, errout) => {
        if (err) return reject(new Error(errout || err.message));
        try {
          const j = JSON.parse(out);
          resolve({ url: j.url, headers: j.http_headers || {} });
        } catch (e) { reject(e); }
      });
  });
}

// ---------- البوتات ----------
const bots = [];
const claims = new Map(); // رسالة -> البوت اللي يتولاها (عشان ما يرد اكثر من بوت)

const connOf = (bot, gid) => getVoiceConnection(gid, bot.id);
const inGuild = (bot, gid) => bot.ready && bot.client.guilds.cache.has(gid);

function getState(bot, gid) {
  if (!bot.states.has(gid)) {
    const player = createAudioPlayer();
    const st = { player, queue: [], index: -1, proc: null, msg: null, textChannel: null, token: 0 };
    player.on(AudioPlayerStatus.Idle, () => {
      if (st.index + 1 < st.queue.length) playAt(bot, gid, st.index + 1);
    });
    player.on('error', (e) => console.error(`[${bot.name}] Player error:`, e.message));
    bot.states.set(gid, st);
  }
  return bot.states.get(gid);
}

function killProc(st) {
  if (st.proc) { try { st.proc.kill('SIGKILL'); } catch {} st.proc = null; }
}

function controls(st) {
  const paused = st.player.state.status === AudioPlayerStatus.Paused;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('prev').setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pause').setEmoji(paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('next').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('list').setEmoji('📜').setLabel('القائمة').setStyle(ButtonStyle.Success),
  );
}

function nowEmbed(st) {
  const t = st.queue[st.index];
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎵 يشتغل الحين')
    .setDescription(`**${t.title}**\n${t.url}`)
    .setFooter({ text: `${st.index + 1} / ${st.queue.length}` });
}

async function playAt(bot, gid, i) {
  const st = getState(bot, gid);
  const track = st.queue[i];
  if (!track) return;
  st.index = i;
  killProc(st);
  const myToken = ++st.token;

  let direct;
  try {
    direct = await getDirect(track.url);
  } catch (e) {
    console.error(`[${bot.name}] ❌ yt-dlp فشل:`, e.message);
    if (st.textChannel) st.textChannel.send('❌ ما قدرت اجيب الصوت من الرابط').catch(() => {});
    return;
  }
  if (myToken !== st.token) return;

  const headerStr = Object.entries(direct.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
  const proc = spawn(ffmpegPath, [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-headers', headerStr, '-i', direct.url,
    '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.on('error', (e) => console.error(`[${bot.name}] ❌ ffmpeg خطأ:`, e.message));
  proc.stderr.on('data', (d) => {
    const s = d.toString();
    if (/error|failed|denied/i.test(s)) console.error(`[${bot.name}] ffmpeg:`, s.trim());
  });
  st.proc = proc;
  st.player.play(createAudioResource(proc.stdout, { inputType: StreamType.Raw }));

  if (st.textChannel) {
    if (st.msg) st.msg.edit({ components: [] }).catch(() => {});
    st.msg = await st.textChannel
      .send({ embeds: [nowEmbed(st)], components: [controls(st)] })
      .catch(() => null);
  }
}

// يختار البوت اللي يتولى الامر
function pickBot(message, cmd) {
  const gid = message.guild.id;
  const here = bots.filter((b) => inGuild(b, gid));
  if (!here.length) return null;
  if (cmd === 'start') {
    const free = here.filter((b) => !connOf(b, gid));
    return free[0] || here[0]; // لو الكل مشغول، اول بوت يرد "مشغولين"
  }
  const vc = message.member?.voice?.channelId;
  const connected = here.filter((b) => connOf(b, gid));
  if (vc) {
    const m = connected.find((b) => connOf(b, gid).joinConfig.channelId === vc);
    if (m) return m;
  }
  if (connected.length === 1) return connected[0];
  return here[0]; // ما عرفنا -> اول بوت يوضح
}

function createBot(token, idx) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  const bot = { client, idx, id: null, name: `bot${idx + 1}`, ready: false, states: new Map() };
  bots.push(bot);

  client.once('clientReady', () => {
    bot.id = client.user.id;
    bot.name = client.user.username;
    bot.ready = true;
    console.log(`✅ شغال: ${client.user.tag}`);
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
    const [cmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
    if (!['start', 'song', 'stop'].includes(cmd)) return;
    const gid = message.guild.id;

    // اتفاق البوتات: بوت واحد فقط يتولى الرسالة
    if (!claims.has(message.id)) {
      const chosen = pickBot(message, cmd);
      claims.set(message.id, chosen ? chosen.idx : -1);
      setTimeout(() => claims.delete(message.id), 60000);
    }
    if (claims.get(message.id) !== idx) return;

    // !start <id الروم>
    if (cmd === 'start') {
      if (connOf(bot, gid)) return message.reply('⚠️ كل البوتات مشغولة بروم، وقّف واحد بـ `' + PREFIX + 'stop`');
      const id = (args[0] || '').replace(/\D/g, '');
      const ch = id && (await message.guild.channels.fetch(id).catch(() => null));
      if (!ch || !ch.isVoiceBased()) return message.reply(`❌ اكتب ايدي روم صوتي صحيح: \`${PREFIX}start ID\``);
      try {
        const conn = joinVoiceChannel({
          channelId: ch.id, guildId: gid, group: bot.id,
          adapterCreator: message.guild.voiceAdapterCreator, selfDeaf: true,
        });
        conn.on('stateChange', (a, b) => console.log(`[${bot.name}] voice: ${a.status} -> ${b.status}`));
        conn.on('error', (e) => console.error(`[${bot.name}] voice error:`, e.message));
        await entersState(conn, VoiceConnectionStatus.Ready, 30000);
        const st = getState(bot, gid);
        conn.subscribe(st.player);
        st.textChannel = message.channel;
        conn.on(VoiceConnectionStatus.Disconnected, async () => {
          try {
            await Promise.race([
              entersState(conn, VoiceConnectionStatus.Signalling, 5000),
              entersState(conn, VoiceConnectionStatus.Connecting, 5000),
            ]);
          } catch { try { conn.destroy(); } catch {} }
        });
        message.reply(`✅ دخلت **${ch.name}**`);
      } catch (e) {
        console.error(`[${bot.name}]`, e);
        const c = connOf(bot, gid); if (c) c.destroy();
        message.reply('❌ ما قدرت ادخل الروم (تأكد من الصلاحيات)');
      }
    }

    // !song <رابط>
    else if (cmd === 'song') {
      const url = args[0];
      if (!url) return message.reply(`❌ اكتب رابط: \`${PREFIX}song الرابط\``);
      if (!connOf(bot, gid)) return message.reply(`❌ ادخل الروم اللي فيه البوت، او اكتب \`${PREFIX}start ID\` اول`);
      const st = getState(bot, gid);
      st.textChannel = message.channel;
      const wait = await message.reply('⏳ جاري التحميل...');
      const title = await getTitle(url);
      st.queue.push({ url, title });
      wait.edit(`➕ انضافت: **${title}**`).catch(() => {});
      if (st.player.state.status === AudioPlayerStatus.Idle) playAt(bot, gid, st.queue.length - 1);
    }

    // !stop
    else if (cmd === 'stop') {
      const conn = connOf(bot, gid);
      if (!conn) return message.reply('⚠️ ما فيه بوت داخل روم');
      const st = getState(bot, gid);
      st.token++;
      killProc(st);
      st.player.stop(true);
      st.queue = [];
      st.index = -1;
      if (st.msg) st.msg.edit({ components: [] }).catch(() => {});
      st.msg = null;
      conn.destroy();
      message.reply('👋 طلعت من الروم');
    }
  });

  // ازرار التحكم (تجي للبوت صاحب الرسالة فقط)
  client.on('interactionCreate', async (i) => {
    if (!i.isButton() || !i.guild) return;
    const gid = i.guild.id;
    const st = getState(bot, gid);

    if (i.customId === 'list') {
      const text = st.queue.length
        ? st.queue.map((t, n) => `${n === st.index ? '▶️' : `${n + 1}.`} ${t.title}`).join('\n').slice(0, 1900)
        : 'القائمة فاضية';
      return i.reply({ content: `📜 **قائمة التشغيل**\n${text}`, flags: 64 });
    }
    if (i.customId === 'pause') {
      if (st.player.state.status === AudioPlayerStatus.Paused) st.player.unpause();
      else st.player.pause();
      return i.update({ components: [controls(st)] });
    }
    if (i.customId === 'next') {
      if (st.index + 1 >= st.queue.length) return i.reply({ content: 'ما فيه اغنية بعدها', flags: 64 });
      await i.deferUpdate();
      return playAt(bot, gid, st.index + 1);
    }
    if (i.customId === 'prev') {
      if (st.index <= 0) return i.reply({ content: 'هذي اول اغنية', flags: 64 });
      await i.deferUpdate();
      return playAt(bot, gid, st.index - 1);
    }
  });

  client.login(token).catch((e) => console.error(`❌ بوت ${idx + 1} فشل تسجيل الدخول:`, e.message));
}

TOKENS.forEach((t, i) => createBot(t, i));

process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

if (process.env.PORT) {
  require('http').createServer((_, res) => res.end('ok')).listen(process.env.PORT);
}
