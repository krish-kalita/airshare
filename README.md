# AirShare

Direct, peer-to-peer file transfer in the browser. No upload, no account, no server storage. Built to deploy as a static site (GitHub Pages, Netlify, Vercel, or any static host).

## How it works

Two devices connect directly via **WebRTC**. A free public signaling service ([PeerJS](https://peerjs.com)) is used only to introduce the two browsers to each other — actual file data goes device-to-device, never through a server.

- One device clicks **Create share room** → gets a 6-digit code.
- The other device enters that code and clicks **Join**.
- Once connected, drag files in to send them. Files transfer in 64KB chunks with live progress.

## Deploy to GitHub Pages

1. Push this folder's contents to a GitHub repo (root, or a `/docs` folder).
2. Repo → **Settings → Pages** → set source to your branch/folder.
3. Wait ~1 minute, then visit `https://<your-username>.github.io/<repo-name>/`.

No build step. No environment variables. No backend to deploy.

## Known limitations — read before relying on this for anything important

This is a static-hosted, zero-backend app, which is exactly what was asked for — but that constraint has real consequences worth knowing:

1. **Cross-network reliability isn't guaranteed.** On the same WiFi, devices connect directly almost always. Across different networks (e.g. one device on mobile data, one on WiFi, or either behind a strict corporate/university firewall), WebRTC's direct connection can fail because there's no TURN relay server configured — that would cost real money to run reliably and contradicts the "free static host" requirement. If you need guaranteed cross-network delivery, the fix is adding a paid TURN provider (Twilio, Cloudflare, Xirsys) — it's a config change in `app.js`, not a rewrite, but it's not free.
2. **Large files (500MB+) are held in browser memory**, not streamed to disk, because disk-streaming (File System Access API) only works in Chrome/Edge desktop, not Safari or Firefox. Most modern devices handle 500MB–1GB fine; very large files on low-RAM mobile devices may stall or crash the tab.
3. **Backgrounding the browser tab mid-transfer can pause or break it.** iOS Safari and Android Chrome throttle or suspend background tabs. Keep the tab in the foreground during a transfer.
4. **The signaling broker is a shared free public service.** If it has an outage, new connections can't be established until it's back (already-connected transfers are unaffected, since they don't depend on it).

None of these are bugs — they're the actual tradeoffs of "real file transfer, zero backend, free hosting." Worth deciding if they're acceptable for your use case before depending on this for critical transfers.

## Files

- `index.html` — structure
- `style.css` — all styling, responsive (phone + desktop), respects `prefers-reduced-motion`
- `app.js` — WebRTC connection handling + chunked transfer logic
- `assets/logo.svg` — brand mark (extracted from your reference screenshot; swap this file if you have a real logo asset — it wasn't attached to the request)