# 🍪 Complete Facebook Cookie Export Guide

## ❌ Problema: Error 1357004 "Session Too Stale"

Ang error na ito means **expired o invalid cookies**, kahit bagong account pa yan. Nangyayari ito kapag:

1. ❌ Nag-logout ka sa browser after export
2. ❌ Matagal nang naka-export yung cookies (30+ minutes)
3. ❌ Wrong export method (hindi complete yung cookies)
4. ❌ Nag-login sa ibang device/browser after export

---

## ✅ TAMANG PARAAN - Step by Step

### Method 1: EditThisCookie Extension (RECOMMENDED)

**Step 1: Install Extension**
- Chrome/Edge: https://chrome.google.com/webstore/detail/editthiscookie/fngmhnnpilhplaeedifhccceomclgfbg
- Firefox: https://addons.mozilla.org/en-US/firefox/addon/etc2/

**Step 2: Login sa Facebook**
```
1. Go to https://www.facebook.com/
2. Login gamit ang bagong account
3. ✅ IMPORTANTE: Wag mag-logout!
```

**Step 3: Export Cookies**
```
1. Click yung EditThisCookie icon (cookie icon sa browser toolbar)
2. Click yung EXPORT icon (📋 clipboard)
3. Cookies automatically copied sa clipboard
4. Paste sa file o sa environment variable
```

**Step 4: Verify**
Dapat may ganito sa export:
```json
[
  {
    "name": "c_user",
    "value": "100xxxxxxxxxx"
  },
  {
    "name": "xs",
    "value": "..."
  },
  {
    "name": "datr",
    "value": "..."
  },
  {
    "name": "sb",
    "value": "..."
  }
]
```

### Method 2: c3c-fbstate Tool

**Install:**
```bash
npm install -g c3c-fbstate
```

**Run:**
```bash
c3c-fbstate
```

Sundin yung prompts. Output: `fbstate.json`

### Method 3: Browser DevTools (Manual)

**Step 1: Open DevTools**
```
1. Login sa https://www.facebook.com/
2. Press F12 (Chrome DevTools)
3. Go to "Application" tab
4. Click "Cookies" → "https://www.facebook.com"
```

**Step 2: Copy Important Cookies**
```
Required cookies:
- c_user
- xs
- datr

Optional pero recommended:
- sb
- fr
- presence
```

**Step 3: Format as AppState**
```json
[
  {
    "key": "c_user",
    "value": "100xxxxxxxxxx",
    "domain": ".facebook.com",
    "path": "/",
    "hostOnly": false,
    "creation": "2024-01-01T00:00:00.000Z",
    "lastAccessed": "2024-01-01T00:00:00.000Z"
  },
  {
    "key": "xs",
    "value": "...",
    "domain": ".facebook.com",
    "path": "/",
    "hostOnly": false,
    "creation": "2024-01-01T00:00:00.000Z",
    "lastAccessed": "2024-01-01T00:00:00.000Z"
  },
  {
    "key": "datr",
    "value": "...",
    "domain": ".facebook.com",
    "path": "/",
    "hostOnly": false,
    "creation": "2024-01-01T00:00:00.000Z",
    "lastAccessed": "2024-01-01T00:00:00.000Z"
  }
]
```

---

## ⚡ CRITICAL: Timing Rules

### ✅ DO THIS:
1. ✅ Export cookies habang naka-login ka pa
2. ✅ Use cookies within 5-10 minutes
3. ✅ Wag mag-logout sa browser after export
4. ✅ Keep browser tab OPEN habang nag-test
5. ✅ Save appstate.json immediately

### ❌ DON'T DO THIS:
1. ❌ Mag-logout after export
2. ❌ Close browser after export
3. ❌ Wait 30+ minutes before using
4. ❌ Login sa ibang device after export
5. ❌ Change password after export

---

## 🔧 Panindigan Automate - Specific Instructions

### Using AppState File

**1. Export cookies gamit EditThisCookie**
```bash
# Save as appstate.json
```

**2. Login**
```typescript
import { MessengerClient } from "panindigan-automate";

const client = new MessengerClient();

// Method 1: File path
await client.login("./appstate.json");

// Method 2: Direct array
await client.login([
  { key: "c_user", value: "...", domain: ".facebook.com", path: "/" },
  { key: "xs", value: "...", domain: ".facebook.com", path: "/" },
  { key: "datr", value: "...", domain: ".facebook.com", path: "/" }
]);
```

### Using Environment Variable (Render, Railway, Heroku)

**1. Export cookies as JSON**
```bash
# Get cookies from EditThisCookie
# Copy the entire JSON array
```

**2. Set environment variable**
```bash
# Render/Railway/Heroku dashboard:
# Name: APPSTATE
# Value: [{"key":"c_user",...}]  # paste entire JSON
```

**3. Login**
```typescript
const client = new MessengerClient();
await client.login(process.env.APPSTATE);
```

---

## 🚨 Common Errors & Solutions

### Error: "session too stale to reuse (1357004)"

**Cause:** Cookies expired or invalid

**Solution:**
```bash
1. ✅ Login sa Facebook (fresh browser session)
2. ✅ Export cookies IMMEDIATELY using EditThisCookie
3. ✅ Use within 5 minutes
4. ✅ DON'T logout from browser
5. ✅ Test connection
```

### Error: "Could not read Facebook's session tokens"

**Cause:** Incomplete cookie export

**Solution:**
```bash
1. ✅ Ensure you have c_user, xs, AND datr
2. ✅ Domain should be ".facebook.com" (with dot)
3. ✅ Check JSON format is valid
```

### Error: "Mobile surface yielded no fb_dtsg"

**Cause:** Session is completely dead

**Solution:**
```bash
1. ✅ Clear browser cookies completely
2. ✅ Login fresh to Facebook
3. ✅ Export immediately with EditThisCookie
4. ✅ Use within 1-2 minutes
```

---

## 📋 Checklist Before Deploy

Before deploying to Render/Railway/Heroku:

- [ ] ✅ Logged in to Facebook in browser
- [ ] ✅ Browser tab still OPEN
- [ ] ✅ Exported cookies using EditThisCookie
- [ ] ✅ Cookies copied to clipboard
- [ ] ✅ JSON format verified (valid brackets, quotes)
- [ ] ✅ c_user, xs, datr present
- [ ] ✅ Environment variable set correctly
- [ ] ✅ Will deploy within 5 minutes of export

---

## 🔒 Security Tips

1. ✅ **Never share cookies publicly** - they're like passwords
2. ✅ **Rotate cookies weekly** - export fresh ones regularly
3. ✅ **Use environment variables** - don't commit appstate.json
4. ✅ **Monitor for errors** - re-export if you see 1357004

---

## 🎯 Quick Fix for Your Render Deployment

**RIGHT NOW, do this:**

```bash
# 1. Open Firefox or Chrome
# 2. Go to https://www.facebook.com/
# 3. Login with your bot account
# 4. Install EditThisCookie extension
# 5. Click EditThisCookie icon → Export
# 6. Copy the JSON
# 7. Go to Render dashboard
# 8. Environment variables → APPSTATE
# 9. Paste the ENTIRE JSON (don't modify)
# 10. Redeploy
```

**Timing:** Do steps 1-10 in less than 5 minutes!

---

## 📱 Alternative: Use AL-FCA Method

If Panindigan Automate still fails, try AL-FCA's approach:

```bash
npm install al-fca
```

```javascript
const login = require("al-fca");
const fs = require("fs");

// Export appstate
login({ appState: [] }, (err, api) => {
  if (err) return console.error(err);
  
  fs.writeFileSync("appstate.json", JSON.stringify(api.getAppState(), null, 2));
  console.log("✅ AppState saved!");
});
```

Then use that appstate.json with Panindigan Automate.

---

**Problema solved kapag:**
✅ Fresh cookies exported correctly  
✅ Used within 5 minutes  
✅ Browser still open during first connection  
✅ No logout between export and use

**Kaya yan!** 🚀
