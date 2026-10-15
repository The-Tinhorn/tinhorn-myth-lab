# Tinhorn Myth Lab

Discord bot for the community myth pipeline: **Submit → Review → Vote → Test → Publish**.
Node.js 22.13+ · one dependency (`discord.js`) · data saved in `data/myth.db` (built-in SQLite).

## 1. Create the Discord bot
1. https://discord.com/developers/applications → **New Application** → name it "Myth Lab".
2. **Bot** tab → **Reset Token** → copy it (this is `DISCORD_TOKEN`). No privileged intents needed.
3. Invite it (replace `APP_ID` with the Application ID from **General Information**):
   `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=117760`
   (View Channels, Send Messages, Embed Links, Attach Files, Read Message History. Nothing else.)
4. Discord → User Settings → Advanced → Developer Mode on → right-click your server → **Copy Server ID** (`GUILD_ID`).

## 2. Create the channels
| Channel | Who can see it |
|---|---|
| `#myth-lab` | everyone |
| `#myth-voting` | everyone (members shouldn't be able to post) |
| `#myth-results` | everyone (members shouldn't be able to post) |
| `#myth-review` | staff + the bot only |

The names must match exactly. Staff = anyone with **Manage Messages**, or the role in `STAFF_ROLE_ID`.

## 3. Run it on CasaOS (Raspberry Pi)
Uses the official `node:22` Docker image with the bot's files mounted from a folder, so there's nothing to build.
Pi 3, 4, 5 or Zero 2 W (64-bit OS recommended).

1. **Put the files on the Pi.** In CasaOS open **Files**, go to `/DATA/AppData/`, create a folder `myth-lab`, open it and upload everything from the zip (`bot.js`, `db.js`, `package.json`, `package-lock.json`, …).
   Over SSH instead: `sudo unzip tinhorn-myth-lab.zip -d /DATA/AppData/myth-lab`
2. **Install the app.** CasaOS → **App Store** → **+** (top right) → **Install a customized app** → **Import** → paste the contents of `docker-compose.yml` → Submit.
3. In the settings screen that opens, fill in the environment variables `DISCORD_TOKEN` and `GUILD_ID` (`STAFF_ROLE_ID` optional) → **Install**.
4. Check it: open the app's **⋮ → Logs**. After about a minute (first start installs the libraries) you should see `Logged in as ... Commands registered in "..."`.

It restarts by itself if it crashes or the Pi reboots. To change a setting later: app **⋮ → Settings**, edit the variable, Save.

**Updating:** upload the new files over the old ones in `/DATA/AppData/myth-lab`, then restart the app. Don't delete `data/`.

**Backups:** your data is `/DATA/AppData/myth-lab/data/myth.db`. SD cards can die, so download a copy from Files now and then (stop the app first), and/or use `/myth export` for a CSV.

Not on CasaOS? Same file works anywhere with Docker: put the token values in `docker-compose.yml` and run `docker compose up -d`.

## 4. First run
- `/ping` → Pong. (Phase 0 check: reboot the Pi and `/ping` again.)
- `/myth setup` in any channel → posts the how-it-works message and **Submit a Myth** button in `#myth-lab`. Pin it.

## Commands
| Command | Who | |
|---|---|---|
| `/myth submit` or the button | members | category, claim, how to test, optional link/file, credit opt-in |
| `/myth mine` | members | own submissions and status |
| `/myth top` | everyone | top 5 open myths per category |
| `/myth withdraw <id>` | submitter | delete before it's selected |
| 👍 Vote button | members | click again to remove your vote |
| Review card buttons | staff | Approve / Reject / Needs details / Duplicate (submitter gets a private DM) |
| `/myth review` | staff | list pending items |
| `/myth queue <id>` | staff | → Selected for testing |
| `/myth result <id> <outcome> <note>` | staff | Confirmed / Busted / Partly true / Inconclusive |
| `/myth publish <id> <url>` | staff | posts to `#myth-results`, closes voting |
| `/myth export` | server owner | CSV of everything |

Limits: 3 submissions per member per 24h, duplicate titles blocked, `@everyone`/role pings stripped, bot never pings anyone.
Attached clips are kept on the staff-only review card as evidence and are never posted publicly.

## Adding categories (GTA VI, Zombies)
Uncomment or add a line in `CATEGORIES` near the top of `bot.js`, then restart. Commands update automatically.

## Local run / test
```
npm install
npm test
node --env-file=.env bot.js
```
