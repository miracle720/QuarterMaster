# Warehouse Check-in — deployment guide (FREE plan, no Cloud Functions, no billing)

Everything runs on Firebase's free **Spark** plan. Nothing here needs a card.
Everything was tested offline against a simulation of Firebase; the real thing has not been touched, so go in
the order below and keep a backup: Firebase console → Realtime Database → ⋮ → **Export JSON**.

## What is in the package
| File | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css`, `manifest.json`, `sw.js` | The app (replace your GitHub Pages files) |
| `features.js`, `payroll.js`, `audit.js`, `push.js` | Putaway/SKU/timers, Payroll, Audit log, (optional) push alerts |
| `worker-auth.js`, `worker-emails.js` | Google sign-in for workers; admin screens for worker e-mails |
| `analytics-extra.js` | Extra Analytics sections |
| `server/database.rules.json`, `server/database.rules.transition.json` | Database rules (strict / rollout) |
| `server/tools/migrate-security.js` | One-time admin migration (runs on your computer, free) |
| `server/functions/` | **Not deployed on the free plan.** Only the migration script reads a helper from it. |

Upload **all** app files to the repo root together.

## Step 1 — Prepare your computer (once)
1. Install Node.js (LTS) from nodejs.org.
2. `npm i -g firebase-tools`, then `firebase login` (same Google account as the project).

## Step 2 — Admin logins (once)
1. Firebase console → ⚙ Project settings → **Service accounts** → **Generate new private key**. Keep the file private (never upload it).
2. Terminal in `server/functions`: `npm install`
3. Point at the key — Mac/Linux: `export GOOGLE_APPLICATION_CREDENTIALS=/path/key.json` · Windows PowerShell: `$env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\key.json"`
4. Dry run: `node ../tools/migrate-security.js --db-url https://<project>-default-rtdb.<region>.firebasedatabase.app`
5. Same command + `--apply`: creates a login for every admin with a **new random password** (printed once — hand them out) and moves bank details to the admin-only area.
6. Log in to the app with a new account. Then run the command again with `--apply --finalize` to delete the old plain-text admin data.

## Step 3 — Turn on Google sign-in
1. Firebase console → **Authentication** → Get started → **Sign-in method** → **Google** → Enable → choose a support e-mail → Save.
2. Authentication → **Settings** → **Authorized domains**: make sure `miracle720.github.io` is listed.
3. Authentication → Sign-in method → **Email/Password** must be enabled (admin logins use it).

## Step 4 — Upload the app files to GitHub Pages
Copy every app file into the repo, commit, wait a minute, open the app and refresh once.

## Step 5 — Link worker e-mails (as an admin, in the app)
1. **Workers** tab → *Worker sign-in e-mails*: paste lines `name, email` → **Match names** → check the matches → **Save e-mails**. Or type one e-mail in a worker's *Edit* window.
2. An e-mail only ever attaches to an **existing** worker, so all history stays on that worker.
3. **Type the e-mail exactly as it appears on the worker's Google account** (for Gmail the dots matter here). If a worker is told "not registered", the screen shows the e-mail Google gave — copy that one.
4. The Workers list shows ✓ *has signed in* once a worker has signed in.

## Step 6 — Database rules, in two stages
1. In the `server` folder: `firebase use <your-project-id>` (once). Copy `database.rules.transition.json` over `database.rules.json`, then `firebase deploy --only database`. Old and new phones both keep working.
2. Have every worker open the app and sign in with Google. Wait until all show ✓ *has signed in*.
3. Put the original strict `database.rules.json` back and run `firebase deploy --only database` again. From now on only linked Google accounts can act as workers.
4. Anyone not yet signed in at that moment sees the sign-in screen next time — nothing is lost.

## Step 7 — Admin permissions and new admins
- **Admins** tab: a Super Admin adds admins right in the app (username, password of 8+ characters, role, tabs they may use). The login is created in the browser — no server needed.
- Tick **Putaway**, **HR & Payroll** and **Audit log** for admins who should see those tabs.
- **Forgot an admin password?** An admin can change their *own* password in the app. For someone else: Firebase console → Authentication → Users → delete that login, then **Remove** the admin in the app and add them again.
- Removing an admin in the app locks them out at once; the leftover login (which can reach nothing) can be deleted in Authentication → Users whenever you like.

## Staying inside the free limits
Spark allows 10 GB of database downloads a month and 1 GB stored. The app now keeps downloads small:
- Worker phones load only the last 31 days of check-ins/work/scanner logs, the last 300 messages/reports, and only orders that are still *assigned* or *picked*.
- Admin screens still load full history (payroll and analytics need it). Open them on a fast connection and avoid leaving many admin tabs open.
- Check **Usage and billing** in the Firebase console now and then. If downloads approach the limit, tell me and I'll narrow the admin windows too.

## What is NOT included on the free plan
- **Push alerts** (need server code) — leave `PUSH_VAPID_KEY` empty and the button never appears.
- **Server-side order timers** — an order's running clock is kept by the worker's phone (and corrected when an admin has the app open). A worker who is offline all day may see the clock settle late.
- **Admin password reset for other admins** (see Step 7).
- **Audit entries written by a server** — admin actions are logged by the admin's own app instead.

## Behaviour you should know about
- Rules are verified offline only. Before Stage 2 consider running them in the Firebase emulator; a mistake would lock workers out, and Stage 1 (transition) can be restored at any moment with `firebase deploy --only database`.
- A worker removed in the app loses access immediately (their link is deleted). If you edit the database by hand, delete their entry under `workerLink` too.
- **Start-delay**, **productivity rate**, **absence** and **packing waits** are management indicators (see the Payroll and Analytics screens); phones measure them, so they are not proof.
- Google sign-in inside an installed iPhone web app can be blocked by the phone; the app then falls back to a full-page sign-in. Test on one iPhone and one Android first.
