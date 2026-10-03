# 📣 Posting the daily MukhWak to social media automatically

Every morning the robot (`make.mjs`) makes the day's MukhWak **pictures, 1-min / 3-min / full videos and sped-up full videos**, plus the **caption** (no audio link) and the **text messages** (with SGPC's audio link). This guide covers how to get those onto each platform without doing it by hand, or with as little hand work as possible.

*Checked October 2026. These platforms change their rules often, so if a step doesn't match what you see, follow the official page linked in that section.*

---

## At a glance

| Platform | Fully automatic? | Cost | Effort | What blocks it |
|---|---|---|---|---|
| **Telegram channel** | ✅ **Yes, already built in** | Free | 10 min | Nothing |
| **Facebook Page** | ✅ Yes (your own Page) | Free | 1–2 h once | Meta developer app + Page token |
| **Instagram Reels** | ✅ Yes (Business account) | Free | 1–2 h once (same app as Facebook) | Needs an Instagram *Business* account linked to the Page; Reels 5–90 s for the Reels tab |
| **YouTube Shorts / videos** | ⚠️ Yes, *after* Google's audit | Free | 2 h + audit wait (weeks) | Before the audit, every API upload is **forced private** |
| **WhatsApp Channel** | ❌ No official way | — | — | Meta has no API for Channels. Unofficial tools risk a ban |
| **WhatsApp groups / people** | ❌ (by design) | — | — | Share from the app: 🖼/🎬 panel → 📥 → 🎬 |
| **X (Twitter)** | ✅ Yes | **Paid**: about $0.01–0.20 per post | 1 h | Free tier closed to new sign-ups (Feb 2026) |
| **TikTok** | ⚠️ After TikTok's audit | Free | Audit | Before the audit, posts are **private only** |
| **Threads / Bluesky** | ✅ Yes | Free | 1 h | Text and links only (no video upload in this guide) |

**Recommended order:** Telegram (today) → Facebook Page + Instagram (one Meta app does both) → YouTube (start the audit early, because it takes weeks) → the rest only if needed.

Where things live:
- **Secrets** (tokens, never shown in logs): GitHub → `sevalekh-media` → **Settings → Secrets and variables → Actions → Secrets → New repository secret**
- **Variables** (plain settings): same page, **Variables** tab

The robot posts only on **scheduled** runs, or on a manual run with **"post"** ticked. So a test run with *force* doesn't post twice.

---

## 1. Telegram channel ✅ (built in, about 10 minutes)

The robot already does this. It uploads the **video file itself** to your channel, not a link, so Telegram plays it in the chat, tall (9:16), with no black bars and no github.io address anywhere. Then it posts the MukhWak **text** (message 1 with the audio link, then the meanings).

1. In Telegram, open **@BotFather** → `/newbot` → give it a name (e.g. *SevaLekh MukhWak*) and a username ending in `bot`. BotFather replies with a **token** like `123456789:AA…`. Keep it secret.
2. Create your channel (or use the existing one). **Channel → Administrators → Add admin →** search your bot's username → allow **Post messages**.
3. The channel ID:
   - Public channel: just `@yourchannelname`.
   - Private channel: forward any channel post to **@userinfobot** (or @RawDataBot). It shows an ID like `-1001234567890`.
4. In GitHub → `sevalekh-media` → Settings → Secrets → Actions, add:
   - `TELEGRAM_BOT_TOKEN` = the token from step 1
   - `TELEGRAM_CHAT_ID` = `@yourchannelname` or `-100…`
5. Optional **Variables**:
   - `TELEGRAM_LANG` = `pa` (default: the first of `LANGS`)
   - `TELEGRAM_VIDEO` = `short` (default). Can be a list, e.g. `short,full-x2.5`. Keys: `short`, `medium`, `full`, `full-x1.25`, `full-x1.5`, `full-x2`, `full-x2.5`. A sped-up key works only if it is ticked in SevaLekh Admin.
   - `TELEGRAM_TEXT` = `0` to post the video only (default `1`: video, then the text messages)
6. Test: **Actions → Daily MukhWak media → Run workflow →** tick **force** and **post**. The log ends with `Telegram: sent pa short video`.

Limits: Telegram bots can upload files up to 50 MB (the robot keeps each video under 44 MB), and a video caption can hold up to 1,024 characters (the caption is the short text, about 280).

> Telegram *groups* work too: add the bot to the group and use the group's `-100…` ID.

---

## 2. Facebook Page + Instagram Reels (one Meta app)

You don't need Meta's **App Review** to post to **your own** Page and Instagram. An app left in **Development mode** can post for anyone who has a role on the app (you). App Review is needed only for posting on *other people's* accounts.

### 2a. One-time set-up

1. **Instagram → Settings → Account type → switch to Professional → Business**, then link it to your Facebook **Page** (Instagram: *Settings → Accounts Center*, or from the Page: *Settings → Linked accounts*).
2. Go to <https://developers.facebook.com> → **My Apps → Create app** → use case **"Other" → type "Business"** (wording changes; pick the option that offers *Facebook Login for Business* / *Instagram Graph API*).
3. In the app, add the products **Facebook Login for Business** and **Instagram** (*Instagram API with Facebook Login*).
4. Open **Tools → Graph API Explorer**:
   - Choose your app. Under *User or Page*, choose **Get User Access Token**.
   - Tick the permissions `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, `business_management`. Click **Generate** and approve.
5. Make it **long-lived** (short tokens die in about an hour):
   - **Tools → Access Token Debugger →** paste the token → **Extend Access Token** (gives a 60-day user token).
   - In Graph API Explorer, with the long-lived user token, run `GET /me/accounts`. Each Page in the result has its own `access_token`. **A Page token taken from a long-lived user token does not expire.** Copy your Page's `id` and `access_token`.
6. Your Instagram business ID: `GET /{page-id}?fields=instagram_business_account` → copy the `id`.
7. GitHub secrets: `FB_PAGE_ID`, `FB_PAGE_TOKEN`, `IG_USER_ID`. The Instagram calls use the same Page token.

### 2b. What the robot would call

The video must be at a **public URL**. The robot's GitHub Pages files are public: `https://<you>.github.io/sevalekh-media/mukhwak/pa/video-short.mp4`. Meta fetches the file itself, and nobody sees that address.

**Facebook Page video / Reel**
```
POST https://graph.facebook.com/v23.0/{FB_PAGE_ID}/videos
  file_url=<public mp4 url>  description=<caption>  access_token=<FB_PAGE_TOKEN>
```
(Facebook Reels have their own 3-step `/{page-id}/video_reels` upload: start → upload with `file_url` → finish. Either works.)

**Instagram Reel** (3 steps)
```
1) POST https://graph.facebook.com/v23.0/{IG_USER_ID}/media
      media_type=REELS  video_url=<public mp4 url>  caption=<caption>  access_token=…
   → returns a container id
2) GET  /{container-id}?fields=status_code      (repeat every ~10 s until FINISHED)
3) POST /{IG_USER_ID}/media_publish  creation_id=<container id>
```
- The Reels tab needs **9:16, 5–90 seconds, H.264**. The robot's videos are 9:16 H.264, so use the **1-minute** video. 3-minute and full videos still post, as ordinary video posts.
- Limit: 50 API posts per 24 h per account.
- Instagram **picture carousels** work the same way (`image_url` per picture, `is_carousel_item=true`, then a `CAROUSEL` container), using `post-01.jpg …` (4:5).

**Robot step:** once the secrets exist, the robot's Telegram section can be copied into a `postMeta()` step with these calls. Ask Claude to "add Facebook + Instagram posting to make.mjs". It runs after the Pages deploy, because Meta must be able to download the file. So it goes in a third workflow job (`needs: deploy`), not in `build`.

### 2c. No-code alternative
**Meta Business Suite** (business.facebook.com → *Planner*) can schedule Facebook + Instagram posts for days ahead, by hand, from a phone or computer. Downloading the 1-min video from the 🖼/🎬 panel and scheduling it takes about a minute.

---

## 3. YouTube (Shorts and full videos)

**The catch:** an API project made after July 2020 that hasn't passed Google's **YouTube API compliance audit** gets **every uploaded video locked to Private**. The API raises no error; the video simply stays private, and you can't switch it to public afterwards. So: **set it up, then apply for the audit right away** (it's free; approval takes days to weeks).

### 3a. Set-up
1. <https://console.cloud.google.com> → **New project** (e.g. *sevalekh-youtube*). You can also use the existing Firebase project `sttmpure`.
2. **APIs & Services → Library → YouTube Data API v3 → Enable.**
3. **OAuth consent screen**: External, app name *SevaLekh*, your email. Add the scope `https://www.googleapis.com/auth/youtube.upload`. Add yourself as a **test user**. Then **publish** the consent screen ("In production"). Otherwise refresh tokens die after 7 days.
4. **Credentials → Create credentials → OAuth client ID → Desktop app.** Download the JSON (client id + secret).
5. Get a **refresh token** once, on your computer: open <https://developers.google.com/oauthplayground> → ⚙ → *Use your own OAuth credentials* → paste the client id/secret → scope `youtube.upload` → *Authorize* (sign in with the **channel's** Google account) → *Exchange authorization code for tokens* → copy the **refresh_token**.
6. GitHub secrets: `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`.
7. **Apply for the audit**: the *YouTube API Services – Audit and Quota Extension Form* (search that name, or open it from the *Quotas* page of the YouTube Data API in the Cloud console). Describe it as: "Daily upload of our own Gurbani MukhWak videos to our own channel; no other users." Single-channel, own-content uses are routine.

### 3b. What the robot would call
- Exchange the refresh token: `POST https://oauth2.googleapis.com/token` (grant_type=refresh_token) → access token.
- Resumable upload: `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` with title, description (the caption), `categoryId: 29` (Nonprofits & Activism) or `22`, `privacyStatus: public`, `selfDeclaredMadeForKids: false`. Then PUT the mp4 bytes.
- **Shorts**: a 9:16 video **up to 3 minutes** becomes a Short automatically. Use `short`, `medium` (exactly 3:00), or a sped-up full video that is under 3:00 (e.g. ×2.5 for a 7-minute MukhWak). Adding `#Shorts` to the title helps.
- Quota: each upload uses part of the default 10,000 units/day. A few uploads a day fit easily.

### 3c. Until the audit passes
- Videos uploaded through an *unaudited* project stay locked private. Switching them to Public in YouTube Studio doesn't work, so don't let the robot upload yet.
- **By hand (2 minutes):** in the SevaLekh app, open the 🖼/🎬 panel → 📥 → 🎬 Share → **YouTube**. Or open YouTube Studio → Upload, and **schedule** several days ahead.

### ⚠️ Audio rights
The recording is SGPC's. YouTube's Content ID may flag it, and a channel that re-uploads it daily is more visible. **Ask SGPC (or Sri Darbar Sahib's media office) for written permission** before automating YouTube. This also strengthens the audit application.

---

## 4. WhatsApp

- **WhatsApp Channels have no official API.** Meta's *WhatsApp Business Cloud API* sends messages only to people who wrote to you or opted in, mostly using pre-approved templates. It can't post to a Channel or a group.
- Unofficial "WhatsApp Channel API" services (WAHA, Whapi and similar) work by logging in as your phone (a linked device). They work, but break WhatsApp's terms, **so the number can be banned**. Not recommended for SevaLekh's main number. If you try one anyway, use a separate number.
- **Best workaround:** in the app's 🖼/🎬 panel, tap **📥** and then **🎬 Share the video** → WhatsApp → your Channel / groups. That sends the **file**, which plays in the chat, and the caption is copied to paste. Or forward the robot's **Telegram** post to WhatsApp: long-press the video in Telegram → Share → WhatsApp.

---

## 5. X (Twitter)

- Since **February 2026**, X's API is **pay-per-use** for new developers. The old free tier is closed. A post costs about **$0.01**, and a post **with a link** costs more (reported around $0.20). A daily post is a few dollars a month at most. Check the current prices at <https://developer.x.com> before you fund it.
- Set-up: developer.x.com → create a Project + App → *User authentication*: **Read and write**, OAuth 1.0a → generate the **Access Token & Secret** for your account → secrets `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`.
- Calls: upload the video with the v2 media upload endpoint (chunked: INIT → APPEND → FINALIZE), then `POST /2/tweets` with the media id and the short caption (≤280. The app's ✂ Short text is already built for that).
- **Free alternative:** the app's ✂ Short button → 𝕏 opens a ready post. Tap Post.

---

## 6. TikTok

- The **Content Posting API** needs a TikTok developer app. Until TikTok **audits** it, every post is **private only** (SELF_ONLY), and only up to 5 accounts can post per day. Apply for the audit after testing.
- Set-up: developers.tiktok.com → Create app → add *Content Posting API* and *Login Kit* → scope `video.publish` → OAuth to get a refresh token → secrets.
- Until the audit: **by hand**: 🖼/🎬 panel → 📥 → 🎬 Share → TikTok. That takes about 30 seconds.

---

## 7. Threads and Bluesky (text and links)

- **Bluesky**: free, easy. Make an **App Password** (Settings → Privacy and security → App passwords). The robot logs in with `com.atproto.server.createSession` and posts with `com.atproto.repo.createRecord`. Secrets `BSKY_HANDLE`, `BSKY_APP_PASSWORD`. Videos are possible too (up to 3 min).
- **Threads**: the Threads API uses its own Meta app (*Threads API* product, `threads_basic` + `threads_content_publish`). It works the same way as Instagram: create a container with `video_url`, then publish.

---

## 8. "Do it all for me" services (no code, monthly fee)

If keeping tokens alive becomes a chore, these services hold the platform connections for you. Several already passed the YouTube/TikTok audits, so public posting works at once:

- **Buffer**, **Publer**, **Metricool**: schedule to Facebook, Instagram, YouTube, TikTok, X, Threads, Bluesky. Free or cheap plans exist. Some accept posts from **RSS** or a **Zapier/Make** step.
- **Make.com / Zapier / n8n**: a daily scenario reads `https://<you>.github.io/sevalekh-media/mukhwak/latest.json`, takes the `video-short.mp4` URL and the `caption`, and posts through their built-in connectors. n8n can run free on your own computer.

Typical flow: *Schedule 07:30 IST → HTTP GET latest.json → (date is today?) → post the video URL plus caption to each network.*

---

## 9. Hiding the GitHub address

- **Links**: the app's 🔗 button now shares **`granth.web.app/v/?…`**, SevaLekh's own video page. The address bar shows SevaLekh. The video still streams from GitHub Pages, so it costs Firebase nothing. Someone who opens the browser's developer tools can still find the real file address.
- **Files**: 📥 → 🎬 shares the **video file itself**, so no address is shown at all. Chat apps play it in place. This is the best option for WhatsApp and Telegram.
- **Fully hidden:** give GitHub Pages a **custom domain** (e.g. `media.sevalekh.org`). In the repository: Settings → Pages → Custom domain. At your domain registrar: a `CNAME` record → `<you>.github.io`. Then change the address in SevaLekh Admin → Ready-made pictures & videos. A domain costs about $10/year. The same domain can also serve the app through Firebase Hosting → *Add custom domain*.

---

## 10. Telegram / chat apps: why a link opens full-screen with black bars

- A **link** to an mp4 opens Telegram's **full-screen player**. That player always fills the screen, so a square (1:1) video gets black bands above and below, and a tall 9:16 video fits a phone exactly. Telegram doesn't let a link choose a different player.
- A **file** (sent by the robot, or shared with 📥 → 🎬) plays **inside the chat**, at its own shape, and opens full-screen only when tapped. The robot also tells Telegram the size (1080×1920), so it shows tall right away.
- So: share **files**, and keep the **9:16** videos for chats. The 4:5 pictures suit Instagram/Facebook feed posts.
