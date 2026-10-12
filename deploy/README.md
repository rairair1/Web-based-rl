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

**Jagex Accounts** can't type a password into RuneLite. They need the session file
described in the [main README](../README.md#logging-in-to-the-game): the friend creates
`credentials.properties` on their own Windows or Mac PC, gives it to you, and you
install it into their container:

```sh
docker compose -f deploy/compose.yml cp credentials.properties rl-sam:/data/home/.runelite/credentials.properties
docker compose -f deploy/compose.yml exec -u root rl-sam chown runelite: /data/home/.runelite/credentials.properties
docker compose -f deploy/compose.yml restart rl-sam
```

That file works like a password to their account. They should only give it to you if
they trust you and your server. They can cancel it at any time with **End sessions** in
their account settings on runescape.com.

## Managing players

| Task | How |
|---|---|
| Add or remove a player | Edit `players.txt`, rerun `setup.py`, then `docker compose -f deploy/compose.yml up -d --build --remove-orphans` |
| Reset someone's password | Delete their line from `deploy/.env`, rerun `setup.py`, `docker compose -f deploy/compose.yml up -d`. This signs them out everywhere |
| Update RuneLite | Players use Settings → **Restart RuneLite**. To update the launcher itself, run `docker compose -f deploy/compose.yml build --pull && docker compose -f deploy/compose.yml up -d` |
| See resource use | `docker stats` |
| Delete a removed player's data | `docker volume rm runelite-web_rl-<name>` |

## Risks to understand before inviting people

- **You hold their accounts.** Whoever controls the server can reach every player's
  logged-in game. A Jagex Account session file is a working login. Keep the server
  updated, keep `deploy/.env` private, and only host people who trust you.
- **Jagex's position.** RuneLite is an approved client, but Jagex hasn't said anything
  about streaming it from a shared server. Several accounts playing from the same IP
  (especially a data-centre IP) may draw extra scrutiny. Each friend accepts that risk
  for their own account. Never use this for anything automated.
- **Bandwidth.** Each active player streams video. Expect a few Mbit/s each (an
  estimate), which matters on a home upload connection.
