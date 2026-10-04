# 📣 Daily MukhWak → Instagram Reel + YouTube Short (one-time setup)

The robot already makes the videos. After GitHub Pages publishes them each morning, a last step
(`social.mjs`) posts:

- **Instagram:** the 90-second video (`reel`) as a **Reel** with the day's caption. Instagram's API takes Reels up to 90 s.
- **YouTube:** the whole MukhWak sped up to 2:59 (`fit`) as a **Short**, with a Punjabi title, the caption, and the SevaLekh link.

Each platform switches on by itself once its secrets are in GitHub. Until then the step just says "not set up".
It posts on the morning's first scheduled build, or on a manual run with **post** ticked.

Where secrets go: **github.com/gurjaapsingh/sevalekh-media → Settings → Secrets and variables → Actions →
Secrets → New repository secret.** Names must be exactly as written below.

*Checked October 2026 against Meta's and Google's developer docs. If a screen looks different, the official
pages linked below are the reference.*

---

## Instagram (about 30–45 minutes, free, no Facebook Page needed)

Uses **Instagram API with Instagram Login**. Posting to your **own** account works with the app left in
Development mode; Meta's App Review is only for posting on other people's accounts.

1. **Make the SevaLekh Instagram a professional account.** In the Instagram app: Settings → Account type and
   tools → **Switch to professional account** → Creator or Business (either works).
2. **Meta developer account.** Go to **developers.facebook.com** and log in with your Facebook / Meta
   account → **Get started** → accept the terms, verify phone/email. *(Account registration: yours to do.)*
3. **Create the app.** **My Apps → Create app** → name it e.g. *SevaLekh MukhWak* → use case
   **"Manage messaging & content on Instagram"** → no business portfolio needed → **Create app**.
4. **Add the Instagram account.** In the app: **Instagram → API setup with Instagram login** →
   *Generate access tokens* → **Add account** → log in to the SevaLekh Instagram and allow it.
   (If asked, also add the account under **App roles → Roles → Instagram testers**, then accept the invite
   in Instagram: Settings → Website permissions / Apps and websites → Tester invites.)
5. **Generate the token.** Next to the account, press **Generate token** → allow → copy the long token
   (it starts with `IG…` or `EAA…`). It lasts 60 days; the robot **refreshes it every day** it posts,
   and warns in the run if it gets close to expiring.
6. **GitHub secret:** `IG_ACCESS_TOKEN` = that token. *(Pasting keys: yours to do.)*
7. **Permissions check:** the token must include `instagram_business_basic` and
   `instagram_business_content_publish` (the default for this use case).

Optional variables (Variables tab): `IG_VIDEO` (`reel` default; `short` = 1 min), `SOCIAL_LANG` (`pa`).

Official: https://developers.facebook.com/docs/instagram-platform/content-publishing

---

## YouTube (about 45 minutes, free; public posting after Google's audit)

1. **Google Cloud project.** Go to **console.cloud.google.com** (signed in as the account that owns the
   SevaLekh YouTube channel) → project menu → **New project** → *sevalekh-media* → Create.
2. **Turn on the API.** **APIs & Services → Library → "YouTube Data API v3" → Enable.**
3. **Consent screen.** **APIs & Services → OAuth consent screen (Google Auth Platform) → Get started:**
   app name *SevaLekh MukhWak*, your email, audience **External**, contact email → Create.
   Under **Data access → Add scopes** → `.../auth/youtube.upload` → Save.
   Under **Audience → Test users** → add the channel's Google account.
4. **Client ID.** **Clients (Credentials) → Create client → Application type: Web application** → name it →
   **Authorized redirect URIs: `https://developers.google.com/oauthplayground`** → Create.
   Copy the **Client ID** and **Client secret**.
5. **Publish the app** (so the sign-in doesn't expire weekly): **Audience → Publishing status →
   Publish app → Confirm.** It stays "unverified"; that's fine for your own channel (you'll see a warning
   screen once in step 6 — choose *Advanced → Go to SevaLekh MukhWak*).
   *Apps left in "Testing" get sign-ins that expire after 7 days.*
6. **The refresh token (one time).** Open **developers.google.com/oauthplayground** → ⚙ (top right) →
   tick **Use your own OAuth credentials** → paste the Client ID and secret →
   in *Step 1* type the scope `https://www.googleapis.com/auth/youtube.upload` → **Authorize APIs** →
   sign in with the channel's account → allow → **Exchange authorization code for tokens** →
   copy the **Refresh token**.
7. **GitHub secrets:** `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`. *(Yours to paste.)*
8. **The audit — start it early.** Google keeps every API upload from a new project **private** until the
   project passes the free **YouTube API Services audit**:
   https://support.google.com/youtube/contact/yt_api_form → *"YouTube API Services – Audit and Quota
   Extension"*. Describe it as: *a daily robot that uploads one video a day to our own channel (the
   day's MukhWak from Sri Darbar Sahib, with SevaLekh's meanings); no other users*. It can take a few weeks.
   Until then the videos land on the channel as **private** — you can make them public by hand in
   YouTube Studio (one click), and the run's warning says so.

Optional variables: `YT_VIDEO` (`fit` default; `full` = normal speed), `YT_PRIVACY` (`public`, `unlisted`
or `private`), `YT_CATEGORY` (`22` People & Blogs; `10` Music).

Daily quota: one upload uses 1,600 of the free 10,000 units — fine for one video a day.

Official: https://developers.google.com/youtube/v3/docs/videos/insert

---

## Test

**Actions → Daily MukhWak media → Run workflow →** tick **Make again** and **post**. The last job,
**social**, prints e.g. `Instagram: posted the reel video (90 s) as a Reel` and
`YouTube: uploaded the fit video (179 s) — https://youtu.be/…`. Any problem shows as a yellow warning on
the run's summary page, in plain words, and never stops the files or Telegram.
