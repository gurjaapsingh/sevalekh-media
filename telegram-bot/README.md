# 🤖 MukhWak Telegram bot — videos for every platform, on request

Tag the bot, message it, or type `@yourbot ` in **any** chat, and it offers today's MukhWak video for wherever it is going:

| Button | Shape | Length |
|---|---|---|
| 📸 Insta Story · 📘 FB Story | 9:16 | 1:00 |
| 📸 Insta Reel · 📘 FB Reel · 🎵 TikTok · 💬 WhatsApp Status | 9:16 | 1:30 |
| ▶️ YouTube Short | 9:16 | 2:59 |
| ▶️ YouTube 16:9 · 📘 FB feed 16:9 | 16:9 | the whole MukhWak |
| 𝕏 X / Twitter 16:9 | 16:9 | 2:20 |
| 🖼 Insta / FB post 4:5 | 4:5 | 2:20 |

Each length is the whole MukhWak sped up just enough (at most ×1.6), or — when even ×1.6 is too long — its start at ×1.6, cut to the length.
| 📖 Whole 9:16 | 9:16 | the whole MukhWak |

Plus the language (ਪੰਜਾਬੀ / English / شاہمکھی / हिंदी) and the size (1080p / 720p / 480p).

- The daily robot's **ready** videos (1080p) are sent at once.
- **Anything else** is made to order by a GitHub Action (`telegram-video.yml` → `telegram-video.mjs`) and arrives in about a minute. That covers another size, or your own length and speed, e.g.:
  - `@yourbot 1.25x 2:00 16:9 720p en`
  - `@yourbot reel 45s`
  - `@yourbot 2x`
- **Chopped (cut-short) videos are ×1.6** unless a speed is given (`1.25x`). A length alone (`45s`, `2:00`, `3 min`) is cut at ×1.6; a speed alone (`2x`) is the whole MukhWak at that speed.
- `/help` lists all of this in the chat.

Bot usernames always end in `bot` (e.g. `@mukhwaak_bot`). The **channel** can still be `@mukhwaak`.

## Set up (about 15 minutes, free)

You can use the same bot the daily robot posts with (secret `TELEGRAM_BOT_TOKEN`).

### 1. BotFather

In Telegram, open **@BotFather**:

1. `/setinline` → your bot → a placeholder like `ਮੁੱਖਵਾਕ… reel / story / youtube / 1.25x 2:00`. This turns on "`@yourbot `" in any chat.
2. `/setprivacy` → your bot → **Disable**. The bot then sees messages that tag it in groups. It only answers when tagged, sent a command, or replied to.
3. Add the bot to your groups.

### 2. The Worker (Cloudflare, free)

1. In **dash.cloudflare.com → Workers & Pages → Create → Worker**, name it, e.g. `mukhwak-bot`, then press **Deploy**.
2. Press **Edit code**, replace everything with [`worker.js`](worker.js), then **Deploy**.
3. Under **Settings → Variables and Secrets**, add:
   - `BOT_TOKEN` (Secret): the bot's token from BotFather.
   - `WEBHOOK_SECRET` (Secret): any long random text, letters and digits only (e.g. from a password generator).
   - `PAGES_URL` (Text): `https://<your-github-name>.github.io/sevalekh-media`
   - `GH_REPO` (Text): `<your-github-name>/sevalekh-media`
   - `GH_REF` (Text): `main`
   - `GH_TOKEN` (Secret): needed only for videos made to order. Create it on GitHub under **Settings → Developer settings → Fine-grained tokens → Generate**, with **Only select repositories →** `sevalekh-media` and **Permissions → Actions: Read and write**.
4. Optional, recommended: under **Storage → KV → Create** make a namespace, e.g. `mukhwak-bot`. Then in the Worker go to **Settings → Bindings → KV namespace** and set variable name `CACHE`. With it, a video already sent goes again instantly (Telegram's own copy), inline results are faster, and nobody can start more than one made-to-order video a minute per chat.
5. Open `https://mukhwak-bot.<your-subdomain>.workers.dev/setup?key=<WEBHOOK_SECRET>` in a browser. It should answer with `"webhook": {"ok": true…}` and the bot's username.

### 3. Try it

Message the bot `/mukhwak`, tag it in a group, or type `@yourbot reel` in any chat.

## Notes

- The made-to-order Action runs in the `sevalekh-media` repository. It's free for public repositories and uses the same `TELEGRAM_BOT_TOKEN` secret as the daily robot.
- Telegram fetches files up to 20 MB from an address itself. Bigger ones (a long whole MukhWak) are downloaded by the Worker and uploaded (bots may send up to 50 MB).
- Nothing about the people who use the bot is stored. With `CACHE`, only Telegram's file ids for today's videos and a one-minute "just asked" mark per chat are kept.
