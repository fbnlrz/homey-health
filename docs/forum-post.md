# [APP][Pro] Health Sync for Google Health

*(Forum post for community.homey.app — Apps category)*

---

![Health Sync for Google Health](https://raw.githubusercontent.com/fbnlrz/homey-health/claude/google-health-homey-plugin-mbtb0u/assets/images/large.png)

**Bring your health data to Homey!** This app connects Homey Pro to the **Google Health API** and turns your steps, heart rate, sleep, weight and more into Homey device capabilities — with full **Insights** history and a rich set of **Flow cards**.

Works with any data source that feeds Google Health (Pixel Watch, Fitbit, and other connected apps/devices).

## 📊 16 sensors, all with Insights

| Activity | Heart | Body | Sleep & more |
|---|---|---|---|
| Steps today | Heart rate (latest) | Weight | Sleep last night (h) |
| Distance today | Resting heart rate | Body fat | Water intake today |
| Calories today | Heart rate variability (HRV) | Blood oxygen (SpO2) | |
| Active calories today | VO2 max | Respiratory rate | |
| Floors today | | | |
| Active zone minutes | | | |

Daily counters reset at local midnight automatically.

## ⚡ Flow cards

**Triggers**
- You woke up *(fires when a freshly ended night's sleep syncs — perfect for morning routines, includes wake time token)*
- A workout ended *(activity type, duration, calories, avg. heart rate)*
- The step count changed / Daily step goal reached
- A new heart rate reading arrived / Heart rate crossed a threshold (above/below X bpm)
- Resting heart rate is more than X bpm above its 7-day average *(early warning for stress/illness/poor recovery)*
- New weight measurement / New sleep data

**Conditions**
- Steps today above X · Steps increased in the last X minutes *(inactivity nudges)*
- Sleep last night shorter than X hours · Deep sleep below X minutes
- Water intake today below X ml · Active zone minutes above X
- Resting heart rate above X bpm · You have worked out today

**Actions**
- Synchronize now
- Log weight / Log body fat back to Google Health *(optional write access)*

## 🔧 Setup

Google grants Health API access per Google Cloud project, so you bring your own (free) OAuth client — the app's settings page walks you through it step by step:

1. Create a (free) project in the [Google Cloud Console](https://console.cloud.google.com/) and enable the [Google Health API](https://console.cloud.google.com/apis/api/health.googleapis.com)
2. Create an OAuth client (type *Web application*) with redirect URI `https://callback.athom.com/oauth2/callback` and add yourself as a test user
3. Paste Client ID + Secret into the app settings, then add the "Google Health" device and sign in
4. **Important:** tick ALL permission checkboxes on Google's consent screen (Google leaves them unchecked by default)

## 🧪 Test version

👉 **[Install the test version](https://homey.app/de-de/app/io.github.fbnlrz.healthsync/Health-Sync-f%C3%BCr-Google-Health/test/)**

Known limitations while testing:
- Data arrives via polling (configurable, 5–1440 min) — no realtime push yet
- While your Google consent screen is in "Testing" mode, Google expires logins after 7 days → just use *Repair* on the device (or publish your consent screen to make logins permanent)

Feedback, bug reports and feature requests are very welcome — either here or on [GitHub](https://github.com/fbnlrz/homey-health/issues).

## 🤖 Credits & sources

This app was built end-to-end with **Claude Fable 5** (Anthropic) in Claude Code — as a real-world test of Fable 5's capabilities: multi-agent code-review workflows with adversarial verification, reverse-engineering the API semantics from CLI source code, logo design rendered via headless Chromium, and live debugging against a real Homey Pro.

Sources used:
- [google-health-cli](https://github.com/Google-Health-API/google-health-cli) (Apache 2.0) — Google Health API v4 endpoints, OAuth scopes, all 40 data types and raw response formats
- [homey-app-skill](https://github.com/dvflw/homey-app-skill) (MIT, by dvflw) — Homey SDK v3 conventions and best practices
- [Homey Apps SDK documentation](https://apps.developer.homey.app/) & [SDK v3 reference](https://apps-sdk-v3.developer.homey.app/)
- [Google OAuth 2.0 documentation](https://developers.google.com/identity/protocols/oauth2)

*This app is not affiliated with Google. Google Health is a trademark of Google LLC.*
