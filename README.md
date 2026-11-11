# LinkLite – URL Shortener (SQL Server edition)

A full-stack URL shortener built with **Node.js, Express and Microsoft SQL Server**, managed with **SQL Server Management Studio (SSMS) 2022**.

**Features:** user registration and sign-in · private admin dashboard · password and profile management · shorten URLs · custom endings · searchable link library · click metrics · user and link administration · responsive interface.

---

## 1. What you need

| Tool | Notes |
|------|-------|
| **SQL Server engine** | SSMS is only the *client*. You also need a SQL Server instance running. The free **Express** or **Developer** edition (2019/2022) from https://www.microsoft.com/sql-server/sql-server-downloads is fine. |
| **SSMS 2022** | You already have it. |
| **Node.js 18+** | https://nodejs.org (LTS). Check with `node -v`. |
| **VS Code** | Any recent version. |

**Find your server name:** open SSMS. The *Connect to Server* box shows it, for example `localhost\SQLEXPRESS` or `DESKTOP-ABC123\SQLEXPRESS` (a named instance), or just `localhost` / `DESKTOP-ABC123` (the default instance). You'll need this in step 5.

---

## 2. Prepare SQL Server (one time)

### 2a. Create the database and table in SSMS
1. Open SSMS and connect to your server.
2. **File → Open → File…** and choose `database/schema.sql`.
3. Press **F5** (Execute). It creates the `linklite` database and the `urls` table.
4. In Object Explorer, right-click **Databases → Refresh**. You should see `linklite` with `dbo.urls`, `dbo.users`, and `dbo.auth_sessions`.

### 2b. Turn on SQL Server logins
The Node.js app signs in with a SQL login (username + password), so SQL Server must allow that:
1. In SSMS, right-click your **server name → Properties → Security**.
2. Choose **SQL Server and Windows Authentication mode** → OK.
3. Restart the service: right-click the server name → **Restart**.

### 2c. Create a login for the app
1. Open `database/create-login.sql` in SSMS and copy its contents into a **new, unsaved query window**.
2. Replace `REPLACE_WITH_A_STRONG_SQL_PASSWORD` in that query window with a strong password. Do not save the query with the real password.
3. Press **F5**. This creates `linklite_user` with permission to read and write data only.
4. Put the same password in `.env` as `DB_PASSWORD`. The checked-in SQL file intentionally keeps only the placeholder.

### 2d. Turn on TCP/IP
Node.js connects over the network protocol TCP/IP, which is often off by default on Express.
1. Press the Windows key and search **SQL Server Configuration Manager** (it may be listed as *SQL Server 2022 Configuration Manager*).
2. Go to **SQL Server Network Configuration → Protocols for SQLEXPRESS** (or `MSSQLSERVER` for the default instance).
3. Right-click **TCP/IP → Enable**.
4. Go to **SQL Server Services**, right-click **SQL Server (SQLEXPRESS)** → **Restart**.
5. If you use a **named instance** (like SQLEXPRESS) and want to connect by instance name, also make sure **SQL Server Browser** is *Running* (right-click → Start; set Start Mode to Automatic).

---

## 3. Run it in VS Code

1. Unzip the project. In VS Code choose **File → Open Folder…** and select the project folder.
2. Open the terminal: **Terminal → New Terminal**.
3. Install packages:
   ```bash
   npm install
   ```
4. Copy `.env.example` to a new file named `.env`:
   - Windows PowerShell: `copy .env.example .env`
   - Mac/Linux: `cp .env.example .env`
5. Open `.env` and set your SQL Server values:

   **Named instance (e.g. `localhost\SQLEXPRESS`)**
   ```
   DB_SERVER=localhost
   DB_INSTANCE=SQLEXPRESS
   DB_NAME=linklite
   DB_USER=linklite_user
   DB_PASSWORD=the_password_you_set_in_step_2c
   ```
   **Default instance (just `localhost`)**
   ```
   DB_SERVER=localhost
   DB_INSTANCE=
   DB_PORT=1433
   ```
6. Add a private session signing key to `.env`. Generate one in PowerShell:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
   Copy the output into `SESSION_SECRET`. To provision an administrator, also set `ADMIN_EMAIL` and a strong `ADMIN_PASSWORD`. The first run creates that admin; subsequent runs do not reset its password. Do not commit `.env` or share these values.
7. Start the app:
   ```bash
   npm run dev
   ```
   You should see `LinkLite is running on port 3000`.
8. Open **http://localhost:3000**. Create a standard user account or continue as a guest. Admin accounts are never created through public registration.

### Test that it works
1. Sign in or continue as a guest, paste a long link, and click **Shorten link**.
2. Click **Copy link**, open it in a new tab. You should land on the original page.
3. Return to LinkLite. The click count goes up.
4. In SSMS run `SELECT * FROM linklite.dbo.urls;` to see your rows and `clicks` values.
5. Click **Delete**. The short link now shows the "This link doesn't exist" page.
6. To promote an already registered user, open `database/promote-admin.sql` in SSMS, set the account email in a new query, and execute it using a trusted database administrator connection. Sign out and sign in again; admins can review usage, search accounts and links, disable standard users, or remove links. Public registration cannot create admins.

From a terminal you can also check the redirect (use your own code):
```bash
curl -I http://localhost:3000/aB3dE9x
# HTTP/1.1 302 Found
# Location: https://…
```

### Troubleshooting

| Message | Fix |
|---------|-----|
| `Login failed for user 'linklite_user'` | Wrong password, or SQL authentication isn't enabled. Redo steps 2b and 2c, and restart SQL Server. |
| `Failed to connect to localhost:1433 … ECONNREFUSED` / `ETIMEOUT` | TCP/IP is off or the port is wrong. Redo step 2d. For the default instance, check the port under *TCP/IP → Properties → IP Addresses → IPAll*. |
| `Could not connect (sequence)` / instance not found | Start the **SQL Server Browser** service, or skip the instance name and set a fixed port instead: in Configuration Manager, TCP/IP → Properties → IPAll: clear *TCP Dynamic Ports*, set *TCP Port* to `1433`, restart, then in `.env` use `DB_INSTANCE=` (empty) and `DB_PORT=1433`. |
| `Cannot open database "linklite"` | Run `database/schema.sql` (step 2a), then `create-login.sql` (step 2c). |
| `Authentication tables are missing` | Run the updated `database/schema.sql` in SSMS, or run `npm run db:init` with a SQL login that can initialize the schema. |
| `Set SESSION_SECRET` | Add a random `SESSION_SECRET` of at least 32 characters to `.env`; do not use the example placeholder. |
| No admin sign-in | Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`, restart the app, and sign in with those values. Admin setup does not reset an existing admin's password. |
| `Invalid object name 'dbo.urls'` | The table wasn't created. Run `database/schema.sql`. |
| `self-signed certificate` error | Make sure `.env` has `DB_TRUST_CERT=true` (local use). |
| `'npm' is not recognized` | Install Node.js, then reopen VS Code. |

> **Windows Authentication:** this project uses SQL logins because they work with a plain `npm install`. Windows Authentication needs an extra native driver and is less portable when you deploy.

*Optional shortcut:* if you have a login that can create databases (such as `sa`), you can put it in `.env` and run `npm run db:init` instead of step 2a.

---

## 4. How it works

```
Browser ──POST /api/urls──▶ Express ──INSERT──▶ SQL Server (dbo.urls)
Visitor ──GET /aB3dE9x────▶ Express ──SELECT──▶ SQL Server ──▶ 302 redirect to original URL
                                    └─UPDATE clicks = clicks + 1
Account ──sign in──▶ SQL-backed session ──▶ private user or admin workspace
```

- Short codes are 7 random letters/numbers. They are case-sensitive (the column uses a `BIN2` collation).
- Redirects use **HTTP 302**, so browsers never cache them and every click is counted.
- Guest visitors get a random ID stored in `localStorage`; registered users have private accounts and only see and delete their own links.
- Passwords are hashed with bcrypt. Authentication uses a server-side SQL session store and an HTTP-only, same-site cookie. Admin access is provisioned privately through environment settings, never through public sign-up.
- Admins can view aggregate metrics, search and disable standard accounts, and search or remove any link. Administrator accounts are protected from user-management actions.
- Links that point back at LinkLite itself are rejected, to prevent redirect loops.
- Protection included: Helmet security headers, rate limiting, input validation, and parameterised queries (no SQL injection).

### Project structure
```
├── server.js                  Express app: API, redirect route, errors
├── config/db.js               SQL Server connection
├── database/schema.sql        Run in SSMS: database + table
├── database/create-login.sql  Run in SSMS: app login
├── database/promote-admin.sql Run in SSMS: grant admin to an existing account
├── scripts/initDb.js          `npm run db:init` (optional)
├── public/                    index.html, style.css, app.js, 404.html
├── .env.example
└── package.json
```

### API
The web page automatically sends the guest ID header. Sign-in endpoints use an HTTP-only session cookie.

| Method | Path | Body | Result |
|--------|------|------|--------|
| POST | `/api/urls` | `{ "url": "https://…", "alias": "optional" }` | `201` new link |
| GET | `/api/urls` | – | Your links, newest first |
| GET | `/api/urls/summary` | – | Your link and click totals |
| DELETE | `/api/urls/:id` | – | `204` |
| POST | `/api/auth/register` | `{ "name": "…", "email": "…", "password": "…" }` | Create standard account |
| POST | `/api/auth/login` | `{ "email": "…", "password": "…" }` | Sign in |
| POST | `/api/auth/logout` | – | Sign out |
| GET | `/api/auth/me` | – | Current account |
| GET | `/api/admin/summary` | Admin session | Workspace totals |
| GET | `/api/admin/users` | Admin session | Search accounts |
| GET | `/api/admin/links` | Admin session | Search links |
| GET | `/:code` | – | `302` redirect |
| GET | `/health` | – | `{ "status": "ok" }` |

---

## 5. Make links publicly shareable (deployment)

**Why localhost links can't be shared:** `http://localhost:3000/abc` only exists on your own computer. For other people to use your links, the app **and** the SQL Server database must run somewhere with a public address, and `BASE_URL` must be set to that address because it is written into every short link.

### Option A – Quick demo from your PC (free, temporary)
Keep `npm run dev` running, then expose it with a tunnel:
```bash
cloudflared tunnel --url http://localhost:3000
# or
ngrok http 3000
```
Put the printed `https://…` address in `.env` as `BASE_URL=…` and restart. Links stop working when your PC or the tunnel is off.

### Option B – Azure App Service + Azure SQL Database (natural fit for SQL Server)
Prices and free tiers change, so check Azure's current plans.

1. **Create the database:** in the Azure portal create an **Azure SQL Database** (and its logical server) named `linklite`.
2. **Allow connections:** on the SQL server's *Networking* page, allow Azure services, and add your own IP so you can connect from SSMS.
3. **Create the table:** connect to the Azure database in SSMS (server name looks like `yourserver.database.windows.net`), open `database/schema.sql`, and run **only the `CREATE TABLE … CREATE INDEX` block** (Azure SQL doesn't allow `CREATE DATABASE`/`USE` this way).
4. **Create a web app:** create an **App Service** (Node 20 or 22, Linux or Windows). Deploy from GitHub or with the VS Code *Azure App Service* extension.
5. **Set Application settings** (App Service → Environment variables):
   ```
   NODE_ENV=production
   BASE_URL=https://your-app.azurewebsites.net
   SESSION_SECRET=your_long_random_secret
   ADMIN_EMAIL=admin@your-domain.com
   ADMIN_PASSWORD=your_strong_admin_password
   DB_SERVER=yourserver.database.windows.net
   DB_INSTANCE=
   DB_PORT=1433
   DB_NAME=linklite
   DB_USER=your_sql_admin_or_app_user
   DB_PASSWORD=your_password
   DB_ENCRYPT=true
   DB_TRUST_CERT=false
   ```
   (or one `DB_CONNECTION_STRING`). Set the startup command to `npm start`.
6. Open `https://your-app.azurewebsites.net/health`. You should see `{"status":"ok"}`. Now create a link and share it.

### Option C – Any host that runs Node.js + a SQL Server you can reach
Set the same environment variables with your database's details (`DB_ENCRYPT=true` and `DB_TRUST_CERT=false` if the server has a real certificate). Use build command `npm install` and start command `npm start`. Don't set `PORT`; the host provides it.

### Option D – Your own Windows or Linux server
```bash
npm install --omit=dev
cp .env.example .env     # set NODE_ENV=production, BASE_URL=https://your-domain.com, DB_*
npm i -g pm2
pm2 start server.js --name linklite && pm2 save
```
Put a reverse proxy in front (Nginx, IIS with URL Rewrite/ARR, or Caddy) that forwards to `127.0.0.1:3000` and serves **HTTPS** (for example with a free Let's Encrypt certificate). Open SQL Server's port only to the app server, never to the whole internet.

### Optional: custom short domain
Buy a short domain, add it in your host's custom-domain settings, create the DNS record they show you, then set `BASE_URL=https://your-short-domain.com`.

### View the interface on GitHub Pages

The GitHub Pages preview is deployed from `docs/` by the **Deploy GitHub Pages** workflow. After the first successful workflow run, visit:
https://sudharsanp-dev.github.io/LinkLite/

This is a static interface preview only. Sign-in, URL shortening, and account features require the Node.js server and SQL Server database; run the full app locally with `npm run dev` or deploy its backend separately.

### Before you go public
- Use **https** and set `BASE_URL` to the https address.
- Use a strong password and the limited `linklite_user` login, not `sa`.
- A public shortener can be abused to hide spam or phishing links. Consider adding a blocklist check, account verification, and a report-abuse flow before opening registration to the public. Rate limits help but aren't a complete defence.
- Back up the database regularly. Losing rows breaks every link that was shared.
