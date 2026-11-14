# Frequently Asked Questions (FAQ)

---

### Why does Panindigan Automate require cookies instead of email and password?
Meta uses advanced machine learning bot detection, IP reputation scoring, and dynamic CAPTCHAs on their login forms. Attempting programmatic username/password logins trips security checkpoints and locks accounts almost immediately. By reusing an already-authorized browser session (`c_user`, `xs`, `datr`), Panindigan Automate bypasses login friction and operates with the same trust level as an active Chrome tab.

---

### Will my Facebook account get banned for using this library?
Automating personal accounts is against Meta's Terms of Service. While Panindigan Automate faithfully replicates the exact HTTP headers, MQTT topics, and modern GraphQL endpoints of the official Chrome web client, Meta can still detect abnormal human behavior.
**Best Practices to stay safe:**
- Do not spam hundreds of messages per minute.
- Add small, realistic random delays (1–3 seconds) between automated responses.
- Avoid mass-messaging strangers who may click "Report / Spam".
- Use an account you are comfortable experimenting with.

---

### Does it work in Messenger Group Chats?
**Yes, 100%.** Panindigan Automate includes native group chat support:
- Automatic targeting between 1:1 direct threads (`other_user_fbid`) and group threads (`thread_fbid`).
- Clickable `@mentions` with correct zero-width character formatting (`\u200E`).
- Group member additions, removals, admin promotion/demotion, thread renaming, photo changes, emoji customization, and theme changes.
- Group polls and real-time participant events (`participant_join`, `participant_leave`, `admin_change`, `thread_update`).

---

### How do I keep the bot running 24/7?
Use a process manager like **PM2** or run inside a **Docker** container:

#### Using PM2
```bash
# Install PM2 globally
npm install -g pm2

# Run your compiled bot
pm2 start dist/esm/index.js --name "messenger-bot"

# Save process list on system reboot
pm2 save
pm2 startup
```

---

### Can I run Panindigan Automate through a proxy?
**Yes.** Supply your HTTP or SOCKS5 proxy in the client configuration:

```ts
const client = new MessengerClient({
  httpProxy: "socks5://username:password@proxy.example.com:1080",
});
```
Unlike legacy libraries where the MQTT WebSocket bypasses the proxy and leaks your real IP, Panindigan Automate's custom `WsProxyAgent` tunnels both the HTTP requests and the MQTT WebSocket through the proxy.

---

### Can I use Bun instead of Node.js?
**Yes.** Panindigan Automate is tested and fully compatible with **Bun >= 1.1** as well as **Node.js 22 LTS and Node.js 26**.
```bash
bun add panindigan-automate
bun run bot.ts
```
