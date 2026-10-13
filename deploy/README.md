# Hosting for friends at play.kylemair.com

Each friend gets their own RuneLite with its own password, settings and plugins, at
their own address:

```
 kylemair.com (existing site, unchanged) ──link──►  https://play.kylemair.com
                                                     │  landing page: pick your name
                                                     ▼
                                    ┌─────────── your server ───────────┐
                                    │ Caddy (HTTPS, automatic certs)     │
                                    │  /kyle/        → rl-kyle      ┐    │
                                    │  /friend-one/  → rl-friend-one ├ one RuneLite
                                    │  /…/           → …             ┘ container each
                                    └────────────────────────────────────┘
```

## Why a subdomain and not "inside" kylemair.com

Website hosts (Squarespace, Wix, WordPress hosting, GitHub Pages, Netlify and so on)
only serve pages. This app needs a machine that keeps a full RuneLite running for every
player. So the game lives on a server you control, under the subdomain
`play.kylemair.com`. Your main site stays where it is and just links to it. This works
no matter how kylemair.com is hosted.

## 1. Pick the server

The game server is the only part that costs anything. See
[cheap and free options](#cheap-and-free-hosting) below.

- **A home PC or mini-PC (recommended):** your friends' game traffic leaves from a
  home internet connection, like normal play. It must stay on.
- **A VPS (cloud server):** simpler networking, but every account connects from a
  data-centre IP address. Jagex treats those with more suspicion (see the risks below).

Rough sizing (an estimate; check with `docker stats`): about **1 CPU core and 1.5–2 GB
of RAM for each player online at the same time**. Each container is capped at 2 GB
(`--memory` in step 4 changes this). The server needs Linux with
[Docker](https://docs.docker.com/engine/install/) and the Compose plugin. x86-64 and
ARM64 both work.

## 2. Open ports 80 and 443

- **Home:** in your router, forward TCP 80 and TCP+UDP 443 to the server's local IP.
- **VPS:** allow 80 and 443 in the provider's firewall.

Nothing else needs to be reachable. Each RuneLite container is only reachable through
Caddy.

## 3. Point play.kylemair.com at the server

Wherever the DNS for kylemair.com is managed (your registrar, Cloudflare, Squarespace
Domains and so on), add one record:

| Type | Name | Value |
|---|---|---|
| A | `play` | your server's public IPv4 address (search "what is my IP" from the server) |

- If your home IP changes, use your router's dynamic DNS feature (or a service like
  DuckDNS). Then make `play` a **CNAME** to that hostname instead of an A record.
- On Cloudflare, set the record to **DNS only** (grey cloud).

Don't change the existing records for `kylemair.com` or `www`. The current site keeps
working.

## 4. Install and start

On the server:

```sh
git clone https://github.com/rairair1/Web-based-rl.git && cd Web-based-rl
cp deploy/players.example.txt deploy/players.txt
nano deploy/players.txt                       # one name per line: kyle, sam, alex...
python3 deploy/setup.py play.kylemair.com     # prints each player's link and password
docker compose -f deploy/compose.yml up -d --build
```

The first start builds the image, which takes a few minutes. Caddy then gets an HTTPS
certificate automatically, which only works once DNS from step 3 points at the server.
Open `https://play.kylemair.com`; you should see the landing page with everyone's names.

## 5. Link it from kylemair.com

Add a link or button to your site, using the site builder's "button"/"link" block or
plain HTML:

```html
<a href="https://play.kylemair.com">Play OSRS (RuneLite)</a>
```

## 6. Send each friend their link and password

`setup.py` prints them. Rerun it at any time to see them again; they are stored in
`deploy/.env`. Each friend:

1. Opens their link (for example `https://play.kylemair.com/sam/`) and signs in.
2. Uses **Add to Home Screen** for a full-screen app.
3. Logs in to OSRS on RuneLite's login screen.

**Jagex Accounts** load their login once from their phone (⚙ Settings → **Jagex
Account** → **Load credentials file**). The [main README](../README.md#logging-in-to-the-game)
explains how to create that file on a Windows or Mac PC. The login stays on the friend's
phone; your server only holds it in memory while their RuneLite runs and never saves it.
You never need to handle it.

## Managing players

| Task | How |
|---|---|
| Add or remove a player | Edit `players.txt`, rerun `setup.py`, then `docker compose -f deploy/compose.yml up -d --build --remove-orphans` |
| Reset someone's password | Delete their line from `deploy/.env`, rerun `setup.py`, `docker compose -f deploy/compose.yml up -d`. This signs them out everywhere |
| Update RuneLite | Players use Settings → **Restart RuneLite**. To update the launcher itself, run `docker compose -f deploy/compose.yml build --pull && docker compose -f deploy/compose.yml up -d` |
| See resource use | `docker stats` |
| Delete a removed player's data | `docker volume rm runelite-web_rl-<name>` |

## Risks to understand before inviting people

- **You can reach their accounts.** Logins stay on friends' phones, but while a friend
  plays, their RuneLite runs on your server with their session in memory. Anyone with
  admin access to the server could use it. Keep the server updated, keep
  `deploy/.env` private, and only host people who trust you.
- **Jagex's position.** RuneLite is an approved client, but Jagex hasn't said anything
  about streaming it from a shared server. Several accounts playing from the same IP
  (especially a data-centre IP) may draw extra scrutiny. Each friend accepts that risk
  for their own account. Never use this for anything automated.
- **Bandwidth.** Each active player streams video. Expect a few Mbit/s each (an
  estimate), which matters on a home upload connection.

## Cheap and free hosting

There are two separate pieces:

1. **The game server** (this project) needs a real machine that's always on.
2. **The main kylemair.com site** is ordinary web pages and can be hosted for free.

### Game server options

| Option | Cost | Fits (estimate) | Catches |
|---|---|---|---|
| **A PC at home** (old laptop, mini-PC) | Free, plus electricity | Depends on the PC; a 4-core / 8 GB machine fits about 3–4 players | Must stay on. Needs ports 80/443 forwarded and dynamic DNS. Upload speed limits how many can stream at once |
| **Oracle Cloud Always Free** (Ampere A1, ARM) | Free | 2 CPUs / 12 GB, about 1–2 players | Oracle halved the free A1 allowance to 2 OCPU / 12 GB in 2026. Oracle says it can reclaim Always Free instances that sit idle for 7 days. Data-centre IP. Sign-up needs a card; free capacity is sometimes unavailable |
| **Hetzner Cloud CAX11 / CAX21** (ARM) | About €6 / €10.50 a month | 2 vCPU / 4 GB about 1–2 players; 4 vCPU / 8 GB about 3–4 | Data-centre IP. Prices rose in June 2026, and some reports say these plans have limited availability. Check before ordering |

My recommendation is **a PC at home**. It's free, and your friends' accounts connect
from a normal home internet connection instead of a data centre, which looks more like
regular play to Jagex. This image runs on both x86 and ARM, so all three options work.

The "players" numbers are rough estimates of how many people can play **at the same
time**. Check real usage with `docker stats` once it's running.

### No port forwarding?

Cloudflare Tunnel can publish a home server without opening router ports, and it's
free. But Cloudflare's terms restrict serving video on its free plans, and it's unclear
whether a game stream counts. Don't rely on it for this. If your router can't forward
ports, a cheap VPS is the simpler fix.

### The main site and the domain

- **Hosting the main site:** GitHub Pages, Cloudflare Pages and Netlify all host simple
  sites for free and support custom domains. Point `kylemair.com` there, and point
  `play.kylemair.com` at the game server (step 3).
- **The domain:** `kylemair.com` doesn't currently resolve. If you don't own it yet,
  registering a `.com` typically costs about $10–15 a year (check the registrar's
  renewal price, not just the first year).
- **Or skip the main site:** the landing page at `play.kylemair.com` works on its own.
