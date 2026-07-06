# Health Sync for Google Health (Homey)

*Deutsche Version: [README.de.md](README.de.md)*

Homey Pro app that brings your health data from the [Google Health API v4](https://developers.google.com/health) to Homey — steps, distance, calories, floors, heart rate, resting heart rate, weight, blood oxygen (SpO2), sleep and more.

Built on the API insights from [google-health-cli](https://github.com/Google-Health-API/google-health-cli) and the Homey SDK v3 conventions from [homey-app-skill](https://github.com/dvflw/homey-app-skill).

**Test version:** [homey.app/a/io.github.fbnlrz.healthsync/test](https://homey.app/a/io.github.fbnlrz.healthsync/test/) · **Community forum:** [topic 156934](https://community.homey.app/t/health-sync-for-google-health/156934)

## Features

**"Google Health" device** (one device per Google account) with these sensor capabilities, all with Insights history:

| Capability | Source (Health API) |
|---|---|
| Steps today | `steps` daily-rollup (`countSum`) |
| Distance today (km) | `distance` daily-rollup (`millimetersSum`) |
| Calories today (kcal) | `total-calories` daily-rollup (`kcalSum`) |
| Active calories today (kcal) | `active-energy-burned` daily-rollup (`kcalSum`) |
| Floors today | `floors` daily-rollup (`countSum`) |
| Active zone minutes today | `active-zone-minutes` daily-rollup |
| Heart rate (latest reading) | `heart-rate` list |
| Resting heart rate | `daily-resting-heart-rate` list |
| Heart rate variability (ms) | `daily-heart-rate-variability` list |
| VO2 max | `daily-vo2-max` list |
| Weight (kg) | `weight` list |
| Body fat (%) | `body-fat` list |
| Blood oxygen SpO2 (%) | `oxygen-saturation` list |
| Respiratory rate | `daily-respiratory-rate` list |
| Sleep last night (h) | `sleep` list (`minutesAsleep`, naps excluded) |
| Water intake today (ml) | `hydration-log` daily-rollup |

**Flow cards**

- Triggers: step count changed · daily step goal reached · new heart rate reading · heart rate crossed a threshold · resting heart rate above its 7-day average · new weight measurement · new sleep data · you woke up (with wake time) · a workout ended (with activity, duration, calories, avg. heart rate)
- Conditions: steps today above X · resting heart rate above X bpm · sleep shorter than X h · deep sleep below X min · water intake below X ml · active zone minutes above X · steps increased in the last X min · worked out today
- Actions: synchronize now · log weight · log body fat (both require write access)

## Setup

Google grants Health API access per Google Cloud project, so you bring your own OAuth client — see the **[step-by-step guide (EN/DE)](docs/google-cloud-setup.md)**. In short:

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/) and enable the [Google Health API](https://console.cloud.google.com/apis/api/health.googleapis.com).
2. Under *APIs & Services → Credentials*, create an **OAuth client ID** of type **Web application** with this authorized redirect URI:

   ```
   https://callback.athom.com/oauth2/callback
   ```

3. While the OAuth consent screen is in **Testing** mode, add your Google account as a **test user**. (Note: in testing mode refresh tokens expire after 7 days — run "Repair" on the device, or publish the consent screen for permanent logins.)
4. In Homey: *More → Apps → Health Sync for Google Health → Configure app* — enter Client ID and Client Secret. Optionally enable write access for the "Log weight / body fat" Flow cards.
5. Add the device (*Devices → + → Health Sync for Google Health*) and sign in with Google.

## Behavior notes

- **Poll interval**: 15 minutes by default, configurable from 5 minutes (device settings). Data groups (activity/heart/body/sleep/nutrition) can be toggled individually.
- **Missing days ≠ 0**: if the API has no activity data for today (yet), the app keeps the last value; daily counters reset to 0 only at local midnight. A `countSum: "0"` from the API is a true zero.
- **Number formats**: `int64` fields arrive as strings (protobuf JSON) and are converted defensively via `Number`.
- **Writing** (weight/body fat) additionally uses the `googlehealth.health_metrics_and_measurements` (read/write) scope and is only requested when enabled in the app settings. After changing it, running "Repair" on the device is enough.
- **Google sign-in**: tick **all checkboxes** on the consent screen — Google leaves the granular permissions unchecked by default; missing permissions show up as a device warning.

## Privacy & security

- Runs 100% locally on your Homey Pro; talks only to `health.googleapis.com` and Google's OAuth endpoints. No developer servers, no telemetry.
- The OAuth client belongs to *your* Google Cloud project; tokens are stored in Homey's device store only.
- Read-only by default; write access is opt-in.
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

## License

MIT
