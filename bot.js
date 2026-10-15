const path = require('node:path');
const fs = require('node:fs');
const {
  Client, GatewayIntentBits, Events, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, EmbedBuilder,
  PermissionFlagsBits, AttachmentBuilder, MessageFlags,
} = require('discord.js');
const { openDb, sanitize, sanitizeBlock, validUrl, fmtId, parseId, toCsv } = require('./db');

const { DISCORD_TOKEN, GUILD_ID, STAFF_ROLE_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID. Set them as environment variables (see README.md).');
  process.exit(1);
}

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = openDb(path.join(dataDir, 'myth.db'));

const DAILY_LIMIT = 3;
const CHANNELS = { lab: 'myth-lab', review: 'myth-review', voting: 'myth-voting', results: 'myth-results' };
// Add GTA VI / Zombies categories here when ready; nothing else needs to change.
const CATEGORIES = [
  { value: 'gtav-fact', game: 'GTA V', category: 'Forgotten fact' },
  { value: 'gtav-myth', game: 'GTA V', category: 'Myth / theory' },
  { value: 'gtav-challenge', game: 'GTA V', category: 'Challenge' },
  // { value: 'gta6-myth', game: 'GTA VI', category: 'Myth / theory' },
  // { value: 'zombies-myth', game: 'CoD Zombies', category: 'Myth / theory' },
];
const OUTCOMES = ['Confirmed', 'Busted', 'Partly true', 'Inconclusive'];
const OPEN_FOR_VOTES = ['APPROVED', 'SELECTED'];
const STATUS_TEXT = {
  APPROVED: '🗳️ Open for votes',
  SELECTED: '🧪 Selected for testing',
  TESTED: '🔬 Tested, video coming',
  PUBLISHED: '📼 Published',
};
const MINE_TEXT = { PENDING: 'in review', REJECTED: 'not taken forward', DUPLICATE: 'duplicate', ...STATUS_TEXT };
const EPH = MessageFlags.Ephemeral;
const catLabel = (c) => `${c.game} — ${c.category}`;
const row = (...c) => new ActionRowBuilder().addComponents(...c);
// Attachment from /myth submit, waiting for the modal. ponytail: in-memory, lost on restart (user just resubmits).
const pendingFiles = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [] }, // the bot never pings anyone, whatever users type
});

// ---------- commands ----------

const idOpt = (o) => o.setName('id').setDescription('Myth ID, e.g. MYTH-0042').setRequired(true);
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check the bot is alive'),
  new SlashCommandBuilder().setName('myth').setDescription('Tinhorn Myth Lab')
    .addSubcommand((s) => s.setName('submit').setDescription('Submit a testable myth, fact or challenge')
      .addStringOption((o) => o.setName('category').setDescription('Game and category').setRequired(true)
        .addChoices(...CATEGORIES.map((c) => ({ name: catLabel(c), value: c.value }))))
      .addAttachmentOption((o) => o.setName('evidence_file').setDescription('Optional clip or screenshot that supports the claim')))
    .addSubcommand((s) => s.setName('mine').setDescription('Your submissions and their status'))
    .addSubcommand((s) => s.setName('top').setDescription('Top myths open for votes'))
    .addSubcommand((s) => s.setName('withdraw').setDescription('Remove one of your submissions (before it is selected)').addStringOption(idOpt))
    .addSubcommand((s) => s.setName('review').setDescription('Staff: list pending submissions'))
    .addSubcommand((s) => s.setName('queue').setDescription('Staff: mark a myth as selected for testing').addStringOption(idOpt))
    .addSubcommand((s) => s.setName('result').setDescription('Staff: record the test result').addStringOption(idOpt)
      .addStringOption((o) => o.setName('outcome').setDescription('Outcome').setRequired(true)
        .addChoices(...OUTCOMES.map((x) => ({ name: x, value: x }))))
      .addStringOption((o) => o.setName('note').setDescription('Short explanation').setRequired(true).setMaxLength(500)))
    .addSubcommand((s) => s.setName('publish').setDescription('Staff: link the finished video and archive the myth').addStringOption(idOpt)
      .addStringOption((o) => o.setName('url').setDescription('Video URL').setRequired(true)))
    .addSubcommand((s) => s.setName('export').setDescription('Owner: download every myth as CSV'))
    .addSubcommand((s) => s.setName('setup').setDescription('Staff: post the how-it-works message with the Submit button in #myth-lab')),
];

// ---------- helpers ----------

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

function channel(guild, key) {
  const ch = guild.channels.cache.find((c) => c.name === CHANNELS[key] && c.isTextBased());
  return ch ?? fail(`I can't find #${CHANNELS[key]}. Ask an admin to create it and give me access.`);
}

const isStaff = (i) =>
  (STAFF_ROLE_ID && i.member.roles.cache.has(STAFF_ROLE_ID)) || i.memberPermissions.has(PermissionFlagsBits.ManageMessages);
const requireStaff = (i) => isStaff(i) || fail('Only Myth Lab staff can do that.');
const checkLimit = (user) => db.recentCount(user) < DAILY_LIMIT
  || fail(`You've hit the limit of ${DAILY_LIMIT} submissions per 24 hours. Try again later!`);

function mythOrFail(raw) {
  const id = parseId(raw);
  return (id && db.get(id)) || fail(`No myth found with ID \`${sanitize(raw, 30)}\`. IDs look like MYTH-0042.`);
}

const msgLink = (guild, ch, msgId) => `https://discord.com/channels/${guild.id}/${ch.id}/${msgId}`;
const quote = (text) => `> ${text.replace(/\n/g, '\n> ')}`;

async function notify(userId, text) {
  try { await (await client.users.fetch(userId)).send(text); } catch { /* DMs closed: fine */ }
}

async function withMsg(guild, key, msgId, fn) {
  if (!msgId) return;
  try { await fn(await channel(guild, key).messages.fetch(msgId)); } catch (e) { console.warn(`Couldn't update message ${msgId}:`, e.message); }
}
const refreshCard = (guild, id) => {
  const m = db.get(id);
  return withMsg(guild, 'voting', m?.public_message_id, (msg) => msg.edit(publicCard(m)));
};

// ---------- cards ----------

const baseFields = (m) => [
  { name: 'Category', value: `${m.game} — ${m.category}`, inline: true },
  { name: 'Claim', value: m.claim },
  { name: 'How to test it', value: m.test_method },
];

function reviewCard(m, statusNote) {
  const done = m.status !== 'PENDING';
  const embed = new EmbedBuilder()
    .setTitle(`${fmtId(m.id)} · ${m.title}`)
    .setColor(done ? 0x777777 : 0xf1c40f)
    .addFields(
      ...baseFields(m),
      { name: 'Evidence', value: m.evidence?.slice(0, 1024) || '—' },
      { name: 'Submitter', value: `<@${m.submitter_id}>`, inline: true },
      { name: 'Credit', value: m.credit_opt_in ? 'Opted in' : 'No', inline: true },
      { name: 'Status', value: statusNote ?? m.status, inline: true },
    );
  if (m.staff_notes) embed.addFields({ name: 'Staff notes', value: m.staff_notes.slice(0, 1024) });
  const btn = (action, label, style) =>
    new ButtonBuilder().setCustomId(`rev|${action}|${m.id}`).setLabel(label).setStyle(style).setDisabled(done);
  return {
    embeds: [embed],
    components: [row(
      btn('approve', 'Approve', ButtonStyle.Success),
      btn('reject', 'Reject', ButtonStyle.Danger),
      btn('details', 'Needs details', ButtonStyle.Secondary),
      btn('dup', 'Duplicate', ButtonStyle.Secondary),
    )],
  };
}

function publicCard(m) {
  const open = OPEN_FOR_VOTES.includes(m.status);
  const embed = new EmbedBuilder()
    .setTitle(`${fmtId(m.id)} · ${m.title}`)
    .setColor(open ? 0x5865f2 : 0x2ecc71)
    .addFields(...baseFields(m), { name: 'Status', value: STATUS_TEXT[m.status] ?? m.status, inline: true });
  if (m.credit_opt_in) embed.addFields({ name: 'Idea by', value: `<@${m.submitter_id}>`, inline: true });
  if (m.test_result) embed.addFields({ name: 'Result', value: `**${m.test_result}** — ${m.result_note}`.slice(0, 1024) });
  if (m.video_url) embed.addFields({ name: 'Video', value: m.video_url });
  const vote = new ButtonBuilder()
    .setCustomId(`vote|${m.id}`)
    .setEmoji('👍')
    .setLabel(open ? `Vote (${m.votes})` : `${m.votes} votes · closed`)
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!open);
  return { embeds: [embed], components: [row(vote)] };
}

function submitModal(cat) {
  const input = (id, label, style, { max, required = true, placeholder, value } = {}) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
    if (placeholder) t.setPlaceholder(placeholder);
    if (value) t.setValue(value);
    return row(t);
  };
  return new ModalBuilder()
    .setCustomId(`submit|${cat.value}`)
    .setTitle(`Submit: ${catLabel(cat)}`.slice(0, 45))
    .addComponents(
      input('title', 'Short title', TextInputStyle.Short, { max: 100, placeholder: 'e.g. Bigfoot appears on Mount Chiliad at 3am' }),
      input('claim', 'What is the claim or fact?', TextInputStyle.Paragraph, { max: 1000 }),
      input('test', 'How could Tinhorn test it?', TextInputStyle.Paragraph, { max: 1000 }),
      input('evidence', 'Evidence link (optional)', TextInputStyle.Short, { max: 500, required: false, placeholder: 'https://...' }),
      input('credit', 'Credit you by name if it makes a video?', TextInputStyle.Short, { max: 3, value: 'no', placeholder: 'yes / no' }),
    );
}

const NOTE_MODALS = {
  reject: { title: 'Reject', label: 'Reason (sent privately to submitter)', required: false, done: 'Rejected' },
  details: { title: 'Needs details', label: 'What extra detail do they need?', required: true, done: 'Needs details' },
  dup: { title: 'Duplicate', label: 'Duplicate of which myth? (e.g. MYTH-0012)', required: true, done: 'Duplicate' },
};

// ---------- handlers ----------

async function onCommand(i) {
  const reply = (content, extra = {}) => i.reply({ content, flags: EPH, ...extra });
  if (i.commandName === 'ping') return reply(`Pong! ${client.ws.ping}ms`);

  switch (i.options.getSubcommand()) {
    case 'submit': {
      checkLimit(i.user.id);
      const cat = CATEGORIES.find((c) => c.value === i.options.getString('category')) ?? fail('Unknown category.');
      const file = i.options.getAttachment('evidence_file');
      if (file) pendingFiles.set(i.user.id, file.url); else pendingFiles.delete(i.user.id);
      return i.showModal(submitModal(cat));
    }
    case 'mine': {
      const rows = db.byUser(i.user.id);
      if (!rows.length) return reply("You haven't submitted anything yet. Try `/myth submit`.");
      return reply(rows.map((m) => `**${fmtId(m.id)}** · ${m.title} — ${MINE_TEXT[m.status] ?? m.status}`
        + (m.status === 'REJECTED' && m.staff_notes ? ` (${m.staff_notes})` : '')).join('\n').slice(0, 1900));
    }
    case 'top': {
      const rows = db.byStatus(...OPEN_FOR_VOTES);
      if (!rows.length) return reply('No myths are open for votes yet.');
      const voting = channel(i.guild, 'voting');
      const groups = Map.groupBy(rows, (m) => `${m.game} — ${m.category}`);
      const text = [...groups].map(([label, ms]) => `**${label}**\n` + ms.slice(0, 5).map((m, n) =>
        `${n + 1}. [${fmtId(m.id)}](${msgLink(i.guild, voting, m.public_message_id)}) · ${m.title} — 👍 ${m.votes}`
        + (m.status === 'SELECTED' ? ' 🧪' : '')).join('\n')).join('\n\n');
      return reply(text.slice(0, 1900));
    }
    case 'withdraw': {
      const m = mythOrFail(i.options.getString('id'));
      if (m.submitter_id !== i.user.id) fail('You can only withdraw your own submissions.');
      if (!['PENDING', 'APPROVED'].includes(m.status)) {
        fail(`${fmtId(m.id)} is already ${m.status.toLowerCase()} and can't be withdrawn now. Ask staff if you need it removed.`);
      }
      db.remove(m.id);
      await withMsg(i.guild, 'review', m.review_message_id, (msg) => msg.edit(reviewCard({ ...m, status: 'WITHDRAWN' }, 'Withdrawn by submitter')));
      await withMsg(i.guild, 'voting', m.public_message_id, (msg) => msg.delete());
      return reply(`${fmtId(m.id)} has been withdrawn and deleted.`);
    }
    case 'review': {
      requireStaff(i);
      const rows = db.byStatus('PENDING');
      if (!rows.length) return reply('Review queue is empty. 🎉');
      const ch = channel(i.guild, 'review');
      return reply(`**${rows.length} pending**\n` + rows.map((m) =>
        `[${fmtId(m.id)}](${msgLink(i.guild, ch, m.review_message_id)}) · ${m.title}`).join('\n').slice(0, 1900));
    }
    case 'queue': {
      requireStaff(i);
      const m = mythOrFail(i.options.getString('id'));
      if (!db.transition(m.id, ['APPROVED'], { status: 'SELECTED' })) {
        fail(`${fmtId(m.id)} is ${m.status}; only approved myths can be queued.`);
      }
      await refreshCard(i.guild, m.id);
      await notify(m.submitter_id, `🧪 Your myth **${fmtId(m.id)}** “${m.title}” has been selected for testing!`);
      return reply(`🧪 ${fmtId(m.id)} is now **Selected for testing**.`);
    }
    case 'result': {
      requireStaff(i);
      const m = mythOrFail(i.options.getString('id'));
      const outcome = i.options.getString('outcome');
      const note = sanitizeBlock(i.options.getString('note'), 500);
      if (!db.transition(m.id, ['SELECTED', 'TESTED'], { status: 'TESTED', test_result: outcome, result_note: note })) {
        fail(`${fmtId(m.id)} is ${m.status}; queue it with \`/myth queue\` first.`);
      }
      await refreshCard(i.guild, m.id);
      return reply(`🔬 Recorded **${outcome}** for ${fmtId(m.id)}. Use \`/myth publish\` when the video is live.`);
    }
    case 'publish': {
      requireStaff(i);
      const m = mythOrFail(i.options.getString('id'));
      const url = validUrl(i.options.getString('url')) ?? fail("That doesn't look like a valid video URL.");
      const results = channel(i.guild, 'results');
      if (!db.transition(m.id, ['TESTED'], { status: 'PUBLISHED', video_url: url })) {
        fail(`${fmtId(m.id)} is ${m.status}; record a result with \`/myth result\` first.`);
      }
      const done = db.get(m.id);
      const embed = new EmbedBuilder()
        .setTitle(`${done.test_result.toUpperCase()}: ${done.title}`)
        .setURL(url)
        .setColor(0x2ecc71)
        .setDescription(`${done.result_note}\n\n📼 **Watch:** ${url}`)
        .addFields({ name: 'Myth', value: fmtId(done.id), inline: true }, { name: 'Category', value: `${done.game} — ${done.category}`, inline: true });
      if (done.credit_opt_in) embed.addFields({ name: 'Community idea by', value: `<@${done.submitter_id}>`, inline: true });
      await results.send({ embeds: [embed] });
      await refreshCard(i.guild, m.id);
      await notify(m.submitter_id, `📼 The video for your myth **${fmtId(m.id)}** “${m.title}” is live: ${url}`);
      return reply(`📼 ${fmtId(m.id)} published to #${CHANNELS.results} and archived.`);
    }
    case 'export': {
      if (i.user.id !== i.guild.ownerId) fail('Only the server owner can export.');
      const file = new AttachmentBuilder(Buffer.from(toCsv(db.all()), 'utf8'), { name: `myths-${new Date().toISOString().slice(0, 10)}.csv` });
      return reply('Here is every myth:', { files: [file] });
    }
    case 'setup': {
      requireStaff(i);
      const lab = channel(i.guild, 'lab');
      const embed = new EmbedBuilder()
        .setTitle('🧪 Tinhorn Myth Lab')
        .setColor(0x5865f2)
        .setDescription([
          '**Got a GTA discovery, forgotten fact, theory or challenge you want tested?**',
          '',
          `1. Hit **Submit a Myth** below (or use \`/myth submit\`). Tell us the claim and how to test it. Evidence is optional.`,
          `2. Staff review it. Approved ideas go to #${CHANNELS.voting}.`,
          '3. Vote 👍 for the ones you want tested. Votes help pick, but don\'t guarantee a video.',
          `4. Results and videos land in #${CHANNELS.results}.`,
          '',
          '**Rules**',
          '• Original ideas, or credit your source',
          '• No personal info about anyone',
          `• Max ${DAILY_LIMIT} submissions per 24 hours`,
          '• Clips you attach are only evidence. They won\'t be shown in a video without asking you first',
          '• Changed your mind? `/myth withdraw` before it\'s selected',
        ].join('\n'));
      const button = new ButtonBuilder().setCustomId('lab-submit').setLabel('Submit a Myth').setEmoji('🧪').setStyle(ButtonStyle.Success);
      await lab.send({ embeds: [embed], components: [row(button)] });
      return reply(`Posted in #${CHANNELS.lab}. Pin it so it stays at the top.`);
    }
  }
}

async function onButton(i) {
  const [kind, a, b] = i.customId.split('|');

  if (kind === 'lab-submit') {
    checkLimit(i.user.id);
    pendingFiles.delete(i.user.id);
    const select = new StringSelectMenuBuilder().setCustomId('lab-cat').setPlaceholder('Pick a category')
      .addOptions(CATEGORIES.map((c) => ({ label: catLabel(c), value: c.value })));
    return i.reply({ content: 'What kind of submission is it?', components: [row(select)], flags: EPH });
  }

  if (kind === 'vote') {
    const m = db.get(Number(a)) ?? fail('This myth no longer exists.');
    if (!OPEN_FOR_VOTES.includes(m.status)) fail('Voting on this myth is closed.');
    const { voted } = db.toggleVote(m.id, i.user.id);
    await i.update(publicCard(db.get(m.id)));
    return i.followUp({
      content: voted ? `👍 Vote added to ${fmtId(m.id)}. Click again to remove it.` : `Vote removed from ${fmtId(m.id)}.`,
      flags: EPH,
    });
  }

  if (kind === 'rev') {
    requireStaff(i);
    const m = db.get(Number(b)) ?? fail('That submission no longer exists (withdrawn?).');
    if (m.status !== 'PENDING') fail(`Already handled: ${fmtId(m.id)} is ${m.status}.`);

    if (a === 'approve') {
      const voting = channel(i.guild, 'voting');
      if (!db.transition(m.id, ['PENDING'], { status: 'APPROVED' })) fail('Someone else just handled this one.');
      let card;
      try {
        card = await voting.send(publicCard(db.get(m.id)));
      } catch (e) {
        db.update(m.id, { status: 'PENDING' });
        throw e;
      }
      db.update(m.id, { public_message_id: card.id });
      await i.update(reviewCard(db.get(m.id), `Approved by ${i.user.username}`));
      return notify(m.submitter_id, `✅ Your myth **${fmtId(m.id)}** “${m.title}” was approved and is open for votes in #${CHANNELS.voting}.`);
    }

    const cfg = NOTE_MODALS[a] ?? fail('Unknown action.');
    const note = new TextInputBuilder().setCustomId('note').setLabel(cfg.label).setRequired(cfg.required)
      .setStyle(a === 'dup' ? TextInputStyle.Short : TextInputStyle.Paragraph).setMaxLength(500);
    return i.showModal(new ModalBuilder().setCustomId(i.customId).setTitle(`${cfg.title}: ${fmtId(m.id)}`).addComponents(row(note)));
  }
}

async function onSelect(i) {
  if (i.customId !== 'lab-cat') return;
  const cat = CATEGORIES.find((c) => c.value === i.values[0]) ?? fail('Unknown category.');
  return i.showModal(submitModal(cat));
}

async function onSubmit(i) {
  const cat = CATEGORIES.find((c) => c.value === i.customId.split('|')[1]) ?? fail('That category is no longer available.');
  checkLimit(i.user.id);
  const get = (id) => i.fields.getTextInputValue(id) ?? '';
  const title = sanitize(get('title'), 100);
  const claim = sanitizeBlock(get('claim'), 1000);
  const test = sanitizeBlock(get('test'), 1000);
  if (!title || !claim || !test) fail('Title, claim and how-to-test are all required.');
  const rawUrl = get('evidence').trim();
  const link = rawUrl ? (validUrl(rawUrl) ?? fail("That evidence link isn't a valid http(s) URL. Leave it blank if you don't have one.")) : null;
  const dup = db.duplicateOf(title);
  if (dup) fail(`That looks like **${fmtId(dup.id)}** “${dup.title}”, which is already in the lab. Try a different angle or title.`);
  const file = pendingFiles.get(i.user.id);
  pendingFiles.delete(i.user.id);

  await i.deferReply({ flags: EPH });
  const reviewCh = channel(i.guild, 'review');
  const m = db.create({
    submitter_id: i.user.id, title, game: cat.game, category: cat.category, claim, test_method: test,
    evidence: link, credit_opt_in: /^y/i.test(get('credit').trim()),
  });

  try {
    // Attach the clip to the staff-only review card so it outlives Discord's temporary upload link.
    let msg;
    try {
      msg = await reviewCh.send({ ...reviewCard(m), files: file ? [file] : [] });
    } catch (e) {
      if (!file) throw e;
      msg = await reviewCh.send(reviewCard(m)); // file too big for the server's upload limit: keep the raw link
    }
    const fileRef = file && (msg.attachments.size ? `Attached file: ${msgLink(i.guild, reviewCh, msg.id)}` : file);
    db.update(m.id, { review_message_id: msg.id, evidence: [link, fileRef].filter(Boolean).join('\n') || null });
    await msg.edit(reviewCard(db.get(m.id)));
  } catch (e) {
    db.remove(m.id);
    throw e;
  }

  return i.editReply(
    `✅ Submitted as **${fmtId(m.id)}**. Staff will review it, and you'll get a DM when it's approved or needs changes (if your DMs are open). `
    + 'Check its status anytime with `/myth mine`.\n'
    + '-# Submitting doesn\'t guarantee a video, and evidence links can stop working over time.',
  );
}

async function onReviewNote(i) {
  requireStaff(i);
  const [, action, idStr] = i.customId.split('|');
  const cfg = NOTE_MODALS[action] ?? fail('Unknown action.');
  const m = db.get(Number(idStr)) ?? fail('That submission no longer exists (withdrawn?).');
  const note = sanitizeBlock(i.fields.getTextInputValue('note'), 500);
  const ref = `**${fmtId(m.id)}** “${m.title}”`;

  let status = 'REJECTED';
  let staffNote = note || null;
  let dm = `Thanks for submitting ${ref}. It won't be taken forward this time${note ? `:\n${quote(note)}` : '.'}`;
  if (action === 'details') {
    staffNote = `Needs details: ${note}`;
    dm = `Staff need a bit more detail on ${ref} before it can go to voting:\n${quote(note)}\nFeel free to resubmit it with \`/myth submit\`.`;
  } else if (action === 'dup') {
    const orig = db.get(parseId(note));
    if (!orig || orig.id === m.id) fail(`Couldn't find myth \`${note}\`. Enter the original's ID, e.g. MYTH-0012.`);
    status = 'DUPLICATE';
    staffNote = `Duplicate of ${fmtId(orig.id)}`;
    dm = `Your submission ${ref} matches an existing idea, **${fmtId(orig.id)}** “${orig.title}”.`
      + (OPEN_FOR_VOTES.includes(orig.status) ? ` You can vote for it in #${CHANNELS.voting}.` : '');
  }

  if (!db.transition(m.id, ['PENDING'], { status, staff_notes: staffNote })) fail('Someone else just handled this one.');
  await i.update(reviewCard(db.get(m.id), `${cfg.done} by ${i.user.username}`));
  return notify(m.submitter_id, dm);
}

client.on(Events.InteractionCreate, async (i) => {
  if (!i.inGuild()) return;
  try {
    if (i.isChatInputCommand()) await onCommand(i);
    else if (i.isButton()) await onButton(i);
    else if (i.isStringSelectMenu()) await onSelect(i);
    else if (i.isModalSubmit()) await (i.customId.startsWith('submit|') ? onSubmit(i) : onReviewNote(i));
  } catch (e) {
    const content = e instanceof UserError ? e.message : 'Something went wrong. Staff can check the bot logs.';
    if (!(e instanceof UserError)) console.error(e);
    try {
      if (i.deferred && !i.replied) await i.editReply(content);
      else if (i.replied) await i.followUp({ content, flags: EPH });
      else await i.reply({ content, flags: EPH });
    } catch { /* interaction expired */ }
  }
});

client.once(Events.ClientReady, async () => {
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.commands.set(commands.map((c) => c.toJSON()));
  console.log(`Logged in as ${client.user.tag}. Commands registered in "${guild.name}".`);
});

client.login(DISCORD_TOKEN);
