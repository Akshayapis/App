# U APP — website-to-Android-app platform

3 parts:
- `backend/` — Node/Express server. Deploy on **Render** (not Vercel — it needs a real persistent
  disk to temporarily hold downloaded APKs, which serverless functions don't have).
- `android-build-template/` — a **separate** GitHub repo you create once. Its GitHub Actions
  workflow is what actually builds every user's APK on demand. Users never see or touch this repo.
- `backend/public/index.html` + `admin.html` — the user panel and admin panel. Plain HTML/JS,
  no build step (no Vite needed) — the backend serves them directly.

I tested the real logic myself with simulated Firebase/GitHub/email responses (OTP send/verify
incl. resend-cooldown and wrong-code rejection, GitHub dispatch→poll→artifact-download, UPI
order→UTR→admin-approve) — all passed. I could not test against your actual `otpapi-seven.vercel.app`,
a real Firebase project, or a real GitHub repo, because this sandbox has no internet access.

## Why "everything from Admin Panel, only Firebase in env" — and the one exception

Done exactly as asked: UPI ID, OTP settings, GitHub build config, pricing, rate limits — all
live in Firestore (`config/settings`), editable from `admin.html`, nothing invented (UPI ID
starts blank, you paste your real one). Only the Firebase **client** config stays as a literal
value inside `index.html`/`admin.html` (search for `REPLACE_WITH_FIREBASE_API_KEY` etc. and fill
them in) — it has to be there before the page can even talk to Firebase to log in, so it can't
come from the database. It's not a secret either way; Firebase's client keys are public by design.

## 1) Deploy the backend (Render)

1. Push `backend/` to a GitHub repo, create a new **Web Service** on Render from it (Docker or
   Node runtime both work — a `Dockerfile` is included).
2. Set these environment variables on Render:

   | Name | Value |
   |---|---|
   | `APP_URL` | your Render URL, e.g. `https://uapp.onrender.com` |
   | `FIREBASE_ADMIN_PROJECT_ID` / `FIREBASE_ADMIN_CLIENT_EMAIL` / `FIREBASE_ADMIN_PRIVATE_KEY` | from Firebase console → Project settings → Service accounts → Generate new private key |
   | `ADMIN_SETUP_KEY` | any secret phrase you pick — whoever enters it in the admin panel becomes an admin |

3. Firebase console → Authentication → Sign-in method → enable **Email/Password is NOT needed** —
   this app logs in with OTP + Firebase custom tokens, so just make sure **Authentication** is
   enabled at all (any provider toggled on) and Firestore is created (Native mode).
4. Paste `backend/firestore.rules` into Firebase console → Firestore → Rules → Publish.

## 2) Create the Android build repo

1. Create a **new, separate** GitHub repo and push the contents of `android-build-template/` to it.
2. In Admin Panel → Settings, set:
   - GitHub owner = your GitHub username/org
   - GitHub repo = that new repo's name
   - Workflow file = `android-build.yml`
   - Ref = `main`
   - Token = a GitHub **personal access token** (classic, scope `repo` + `workflow`, or a fine-grained
     token with Actions read/write + Contents read on that one repo). Generate it from
     GitHub → Settings → Developer settings → Personal access tokens.

   This token lives only in Firestore (readable by admins through the backend) — users of the
   platform never see or need their own GitHub account/token, exactly as you asked.

## 3) Fill in Firebase client config

In both `backend/public/index.html` and `backend/public/admin.html`, replace the
`REPLACE_WITH_FIREBASE_API_KEY` / `REPLACE...` placeholders with your real Firebase web config
(Firebase console → Project settings → General → "Your apps" → Web app).

## 4) First login as admin

1. Open `https://your-render-url/admin.html`.
2. Enter your email → get a 6-digit code (sent through whatever `otpApiBase`/`otpSendPath` is set
   to — defaults to your `otpapi-seven.vercel.app`, **verify its real request format once you test
   it**; if it expects something other than `POST {base}{path} {email, otp}`, only
   `backend/lib/otp.js`'s `sendEmail()` function needs to change).
3. Enter the code → you're logged in → it'll ask for the admin setup key (`ADMIN_SETUP_KEY`) → admin unlocked.
4. Go to Settings tab, fill in UPI ID, GitHub config, pricing, etc.

## 5) User flow (what actually happens end-to-end)

1. User opens `/` → logs in with email + OTP (same mechanism as admin, just no setup-key gate).
2. Enters website URL, app name, package name, optional icon → "Build my app".
3. If `buildPriceInr` > 0: redirected to a UPI QR payment page → pays → submits 12-digit UTR →
   **you** (the admin) see it under Payments tab and click Approve (no SMS auto-read here — that
   would need a companion Android app on your phone like the earlier UPI Gateway project; say
   the word if you want that built too, it plugs into the same `payments` collection).
4. Once paid (or free), backend's background worker (runs every few seconds inside the same
   process) dispatches your GitHub Actions workflow with their website/app name/package/icon,
   polls until it finishes, downloads the APK artifact, and gives the user a **time-limited**
   download link (`downloadTtlSeconds`, default 9 minutes) — matches `DOWNLOAD_TTL_SECONDS` /
   `UPLOAD_DIR` from your original template.

## 6) Public developer API (matches `VITE_UAPP_API_BASE` / API-key hardening in your template)

A logged-in user can call `POST /api/me/api-key` once to get `apiUser` + `apiKey`, then:
- `POST /api/v1/build` `{username, key, websiteUrl, appName, packageName, iconUrl}`
- `GET /api/v1/status?username=..&key=..&id=BUILD_ID`

No GitHub token ever touches the client — same rule as the web flow.

## Honest limitations / things to verify yourself

- **OTP email contract is a guess** (noted above) — your original `.env` template didn't include
  this API's actual request/response shape, only the AI API earlier had that.
- **Render's free tier sleeps when idle** — the background worker (polls GitHub, cleans up
  expired downloads) only runs while the process is awake; a paid/always-on instance avoids
  builds stalling if nobody visits the site while a build is running.
- GitHub Actions artifacts expire after `retention-days: 1` in the workflow — fine since you
  download them within minutes, but don't rely on them staying on GitHub longer than that.
- I did not stand up a real Firebase project or GitHub repo to click through this myself —
  please test the full loop once deployed and send me any error text if something's off.
