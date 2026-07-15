# Health Sync (Homey)

*Deutsche Version: [README.de.md](README.de.md)*

Homey Pro app that brings your health data from the [Google Health API v4](https://developers.google.com/health) to Homey — steps, distance, calories, floors, heart rate, resting heart rate, weight, blood oxygen (SpO2), sleep and more.

Built on the API insights from [google-health-cli](https://github.com/Google-Health-API/google-health-cli) and the Homey SDK v3 conventions from [homey-app-skill](https://github.com/dvflw/homey-app-skill).

**Test version:** [homey.app/a/io.github.fbnlrz.healthsync/test](https://homey.app/a/io.github.fbnlrz.healthsync/test/) · **Community forum:** [topic 156934](https://community.homey.app/t/health-sync-for-google-health/156934)

## Features

**"Google Health" device** (one device per Google account) with these capabilities, all with Insights history:

| Group | Capabilities (Health API type) |
|---|---|
| Activity | Steps (`steps`) · Distance (`distance`) · Calories (`total-calories`) · Active calories (`active-energy-burned`) · Basal calories (`basal-energy-burned`, summed from list) · Floors (`floors`) · Active-zone minutes (`active-zone-minutes`) · Sedentary minutes (`sedentary-period`) |
| Heart | Heart rate (`heart-rate`) · Resting heart rate (`daily-resting-heart-rate`) · HRV (`daily-heart-rate-variability`) · VO2 max (`daily-vo2-max`) |
| Body | Weight (`weight`) · Body fat (`body-fat`) · Blood oxygen SpO2 (`daily-oxygen-saturation`, sample fallback) · Respiratory rate (`daily-respiratory-rate`) · Blood glucose (`blood-glucose`) · Body temperature (`core-body-temperature`) · Skin-temperature variation (`daily-sleep-temperature-derivations`) · Altitude (`altitude`) |
| Sleep | Sleep last night (`sleep`, naps excluded) · Asleep sensor (with automatic wake detection) |
| Nutrition | Water (`hydration-log`) · Calorie intake · Carbs · Protein · Fat (`nutrition-log`) |

Some capabilities only populate if your wearable actually records that data; empty tiles usually mean Google Health has no data of that type for your account.

**Cardiac data (opt-in):** enable "ECG and irregular heart rhythm" in the app settings to add the `electrocardiogram` and `irregular-rhythm-notification` reads (extra Google permissions); this powers the ECG-recorded and irregular-rhythm Flow triggers.

**Dashboard widgets** (native Homey styling, light/dark aware, each metric with a data-type-matched icon and a live sparkline built from a rolling history buffer):

- **Health tiles** — a grid of small square metric tiles; choose which data points appear via checkboxes.
- **Health tile** — a single metric shown large, with a sparkline of recent values.
- **Health overview** — several key values in one compact card.

**Health report:** generate a printable overview of your data (up to 90 days — stats, charts, daily values, optional patient details + BMI). It renders dark on screen and light when printed to PDF, and is served briefly over your LAN with a one-time password (any username, link valid ~5 minutes). Choose which sections and table columns to include right on the page.

**Flow cards**

- Triggers: step count changed · daily step goal reached · new heart rate reading · heart rate crossed a threshold · resting heart rate above its 7-day average · new weight measurement · new glucose measurement · new sleep data · you woke up (with wake time) · a workout ended (activity, duration, calories, avg. heart rate) · ECG recorded (opt-in) · irregular heart rhythm detected (opt-in)
- Conditions: steps today above X · resting heart rate above X bpm · sleep shorter than X h · deep sleep below X min · water intake below X ml · active zone minutes above X · steps increased in the last X min · worked out today · is asleep
- Actions: synchronize now · mark as asleep · mark as awake

## Setup

Google grants Health API access per Google Cloud project, so you bring your own OAuth client — see the **[step-by-step guide (EN/DE)](docs/google-cloud-setup.md)**. In short:

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/) and enable the [Google Health API](https://console.cloud.google.com/apis/api/health.googleapis.com).
2. Under *APIs & Services → Credentials*, create an **OAuth client ID** of type **Web application** with this authorized redirect URI:

   ```
   https://callback.athom.com/oauth2/callback
   ```

3. While the OAuth consent screen is in **Testing** mode, add your Google account as a **test user**. (Note: in testing mode refresh tokens expire after 7 days — run "Repair" on the device, or publish the consent screen for permanent logins.)
4. In Homey: *More → Apps → Health Sync → Configure app* — enter Client ID and Client Secret.
5. Add the device (*Devices → + → Health Sync*) and sign in with Google.

## Behavior notes

- **Poll interval**: 15 minutes by default, configurable from 5 minutes (device settings). Data groups (activity/heart/body/sleep/nutrition) can be toggled individually.
- **Missing days ≠ 0**: if the API has no activity data for today (yet), the app keeps the last value; daily counters reset to 0 only at local midnight. A `countSum: "0"` from the API is a true zero.
- **Number formats**: `int64` fields arrive as strings (protobuf JSON) and are converted defensively via `Number`.
- **Read-only**: the app only reads from Google Health; it never writes data back. The optional cardiac data adds the `ecg.readonly` / `irn.readonly` scopes — after enabling it, run "Repair" on the device.
- **Google sign-in**: tick **all checkboxes** on the consent screen — Google leaves the granular permissions unchecked by default; missing permissions show up as a device warning.

## Privacy & security

- Runs 100% locally on your Homey Pro; talks only to `health.googleapis.com` and Google's OAuth endpoints. No developer servers, no telemetry.
- The OAuth client belongs to *your* Google Cloud project; tokens are stored in Homey's device store only.
- Read-only: the app only ever reads from Google Health. Cardiac (ECG/irregular-rhythm) data is a separate opt-in that requests additional read-only Google scopes.
- The health **report** is served from your Homey over the local network as plain HTTP for at most ~5 minutes, protected by a freshly generated one-time password and a random URL token, then the server is torn down. It never leaves your LAN.
- Zero runtime npm dependencies; empty Homey permission list; MIT-licensed and fully auditable.

## Development

```bash
npm install
npx homey app validate --level publish
npx homey app run    # live-test on your Homey
```

Project follows the Homey Compose structure — `app.json` is generated from `.homeycompose/` and the drivers' `*.compose.json` files; never edit it directly.

## Sources & credits

This app was built end-to-end with **Claude Fable 5** (Anthropic) in Claude Code — as a real-world test of Fable 5's capabilities: multi-agent code-review workflows (4 reviewers + adversarial verification), reverse-engineering the API from CLI source code, logo design rendered via headless Chromium, and iterative debugging against a real Homey Pro.

Sources used:

| Source | Used for |
|---|---|
| [google-health-cli](https://github.com/Google-Health-API/google-health-cli) (Apache 2.0) | Google Health API v4: endpoints, OAuth scopes, data types and raw response shapes — extracted from `README.md`, the agent skills (`skills/ghealth*/SKILL.md`) and the Go source (`pkg/types/registry.go`, `pkg/client/client.go`, `cmd/data.go`, `pkg/auth/auth.go`, `pkg/output/simplify.go`) |
| [homey-app-skill](https://github.com/dvflw/homey-app-skill) (MIT) | Homey SDK v3 conventions: Compose structure, lifecycle rules, OAuth2 pairing pattern, flow card definitions |
| [Homey Apps SDK docs](https://apps.developer.homey.app/) & [SDK v3 reference](https://apps-sdk-v3.developer.homey.app/) | Official API reference for App/Driver/Device, pairing templates, settings |
| [Google Identity / OAuth 2.0](https://developers.google.com/identity/protocols/oauth2) | Authorization code flow, token refresh, granular consent |
| [Homey Developer Tools](https://tools.developer.homey.app/) | Publishing and test-release workflow |

This app is not affiliated with Google. Google Health is a trademark of Google LLC.

## Support the development

If you find this app useful, you can support its development:

- [Ko-fi](https://ko-fi.com/fbnlrz)
- [Buy Me a Coffee](https://buymeacoffee.com/fbnlrz)
- [GitHub Sponsors](https://github.com/sponsors/fbnlrz)

## License

MIT

---

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20me-FF00FF?logo=kofi&logoColor=white)](https://ko-fi.com/fbnlrz) [![Buy Me A Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-Japan%202027-00FFFF?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/fbnlrz)
