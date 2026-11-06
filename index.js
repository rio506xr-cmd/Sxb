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
const { spawn, execFile } = require('child_process');
const fs = require('fs');
let ffmpegPath = 'ffmpeg'; // يستخدم ffmpeg المثبت في النظام
try {
  const p = require('ffmpeg-static');
  if (p && fs.existsSync(p)) ffmpegPath = p;
} catch {}
console.log('ffmpeg:', ffmpegPath);

// يجيب الرابط المباشر للصوت من yt-dlp
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

// التوكن: من ملف token.txt (بنفس المجلد) أو من متغير TOKEN
let TOKEN = process.env.TOKEN || '';
try { TOKEN = TOKEN || require('fs').readFileSync(__dirname + '/token.txt', 'utf8'); } catch {}
TOKEN = TOKEN.trim().replace(/^["']|["']$/g, '');
if (!TOKEN || /[^\x20-\x7E]/.test(TOKEN)) {
  console.error('❌ التوكن ناقص او غلط. سوّ ملف اسمه token.txt بنفس مجلد index.js وحط فيه التوكن فقط.');
  process.exit(1);
}
const PREFIX = '!';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// حالة كل سيرفر
const states = new Map();
function getState(guildId) {
  if (!states.has(guildId)) {
    const player = createAudioPlayer();
    const st = { player, queue: [], index: -1, proc: null, msg: null, textChannel: null };
    player.on(AudioPlayerStatus.Idle, () => {
      // انتهت الاغنية طبيعيا -> التالية
      if (st.index + 1 < st.queue.length) playAt(guildId, st.index + 1);
    });
    player.on('error', (e) => console.error('Player error:', e.message));
    states.set(guildId, st);
  }
  return states.get(guildId);
}

function getTitle(url) {
  return new Promise((resolve) => {
    execFile('yt-dlp', ['--no-playlist', '--print', 'title', url], { timeout: 20000 },
      (err, out) => resolve(err || !out.trim() ? url : out.trim().split('\n')[0]));
  });
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

async function playAt(guildId, i) {
  const st = getState(guildId);
  const track = st.queue[i];
  if (!track) return;
  st.index = i;
  killProc(st);

  const myToken = (st.token = (st.token || 0) + 1);
  let direct;
  try {
    direct = await getDirect(track.url);
  } catch (e) {
    console.error('❌ yt-dlp فشل:', e.message);
    if (st.textChannel) st.textChannel.send('❌ ما قدرت اجيب الصوت من الرابط').catch(() => {});
    return;
  }
  if (myToken !== st.token) return; // تغيرت الاغنية اثناء التحميل

  const headerStr = Object.entries(direct.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
  const proc = spawn(ffmpegPath, [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-headers', headerStr,
    '-i', direct.url,
    '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.on('error', (e) => console.error('❌ ffmpeg خطأ:', e.message));
  proc.stderr.on('data', (d) => { const s = d.toString(); if (/error|failed|denied/i.test(s)) console.error('ffmpeg:', s.trim()); });
  st.proc = proc;

  const resource = createAudioResource(proc.stdout, { inputType: StreamType.Raw });
  st.player.play(resource);

  // قائمة التحكم
  if (st.textChannel) {
    if (st.msg) st.msg.edit({ components: [] }).catch(() => {});
    st.msg = await st.textChannel
      .send({ embeds: [nowEmbed(st)], components: [controls(st)] })
      .catch(() => null);
  }
}

client.once('clientReady', () => console.log(`✅ شغال: ${client.user.tag}`));

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
  const [cmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const guildId = message.guild.id;

  // !start <id الروم>
  if (cmd === 'start') {
    const id = (args[0] || '').replace(/\D/g, '');
    const ch = id && (await message.guild.channels.fetch(id).catch(() => null));
    if (!ch || !ch.isVoiceBased()) return message.reply('❌ اكتب ايدي روم صوتي صحيح: `!start ID`');
    try {
      const old = getVoiceConnection(guildId);
      if (old) old.destroy();
      const conn = joinVoiceChannel({
        channelId: ch.id,
        guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      conn.on('stateChange', (a, b) => console.log(`voice: ${a.status} -> ${b.status}`));
      conn.on('debug', (m) => console.log('dbg:', m));
      conn.on('error', (e) => console.error('voice error:', e.message));
      await entersState(conn, VoiceConnectionStatus.Ready, 30000);
      const st = getState(guildId);
      conn.subscribe(st.player);
      st.textChannel = message.channel;
      // اعادة الاتصال تلقائيا لو انقطع
      conn.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(conn, VoiceConnectionStatus.Signalling, 5000),
            entersState(conn, VoiceConnectionStatus.Connecting, 5000),
          ]);
        } catch { conn.destroy(); }
      });
      message.reply(`✅ دخلت **${ch.name}**`);
    } catch (e) {
      console.error(e);
      message.reply('❌ ما قدرت ادخل الروم (تأكد من الصلاحيات)');
    }
  }

  // !song <رابط>
  else if (cmd === 'song') {
    const url = args[0];
    if (!url) return message.reply('❌ اكتب رابط: `!song الرابط`');
    const conn = getVoiceConnection(guildId);
    if (!conn) return message.reply('❌ اكتب `!start ID` اول');
    const st = getState(guildId);
    st.textChannel = message.channel;
    const wait = await message.reply('⏳ جاري التحميل...');
    const title = await getTitle(url);
    st.queue.push({ url, title });
    wait.edit(`➕ انضافت: **${title}**`).catch(() => {});
    const idle = st.player.state.status === AudioPlayerStatus.Idle;
    if (idle && st.index === st.queue.length - 2) playAt(guildId, st.queue.length - 1);
    else if (idle) playAt(guildId, st.queue.length - 1);
  }

  // !stop
  else if (cmd === 'stop') {
    const st = getState(guildId);
    killProc(st);
    st.player.stop(true);
    st.queue = [];
    st.index = -1;
    if (st.msg) st.msg.edit({ components: [] }).catch(() => {});
    st.msg = null;
    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();
    message.reply('👋 طلعت من الروم');
  }
});

// ازرار التحكم
client.on('interactionCreate', async (i) => {
  if (!i.isButton() || !i.guild) return;
  const st = getState(i.guild.id);
  const gid = i.guild.id;

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
    return playAt(gid, st.index + 1);
  }

  if (i.customId === 'prev') {
    if (st.index <= 0) return i.reply({ content: 'هذي اول اغنية', flags: 64 });
    await i.deferUpdate();
    return playAt(gid, st.index - 1);
  }
});

process.on('unhandledRejection', (e) => console.error('Unhandled:', e));
client.login(TOKEN);

// سيرفر بسيط عشان استضافات الويب (Render) ما توقف البوت
if (process.env.PORT) {
  require('http').createServer((_, res) => res.end('ok')).listen(process.env.PORT);
}
