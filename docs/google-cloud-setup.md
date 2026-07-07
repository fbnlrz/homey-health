# Google Cloud Setup — Health Sync for Google Health

**English guide below · Deutsche Anleitung weiter unten**

---

## 🇬🇧 English: Set up Google Cloud for this app

Google grants Health API access **per Google Cloud project**, so every user brings their own (free) project and OAuth client. This takes about 10 minutes, once.

### What you need

- A Google account that has health data (e.g. synced from a Pixel Watch or Fitbit)
- A Homey Pro with the app installed

### Step 1 — Create a Google Cloud project

1. Open [console.cloud.google.com](https://console.cloud.google.com/) and sign in with your Google account.
2. Click the **project picker** (top left, next to the Google Cloud logo) → **New project**.
3. Name it e.g. `homey-health`, leave *Location/Organization* as is → **Create**.
4. Make sure the new project is **selected** in the project picker before continuing.

*Everything is free — the Health API has no paid tier for personal use and no billing account is required.*

### Step 2 — Enable the Google Health API

1. Open [console.cloud.google.com/apis/api/health.googleapis.com](https://console.cloud.google.com/apis/api/health.googleapis.com) (or search for "Google Health API" in *APIs & Services → Library*).
2. Click **Enable**.

### Step 3 — Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen** (in newer console versions this lives under **Google Auth Platform**; if asked, click **Get started / Configure**).
2. **App information**: pick any app name (e.g. `Homey Health Sync`) and select your e-mail as support e-mail.
3. **Audience / User type**: choose **External**.
4. **Contact information**: your e-mail again → finish/create. You can skip the *Scopes* and *Branding* sections — the Homey app requests its scopes at login time.
5. Add yourself as a **test user**: go to **Audience** (or the *Test users* section), click **Add users**, and enter the Google account that holds your health data.

> ⏳ **Note on "Testing" mode:** while the consent screen is in *Testing*, Google expires logins after **7 days** — the Homey device will then show "use Repair". If that annoys you, click **Publish app** on the consent screen. You do **not** need to complete Google's verification: testers will see a one-time "Google hasn't verified this app" warning (continue via *Advanced*), but logins stay valid permanently.

### Step 4 — Create the OAuth client

1. Go to **APIs & Services → Credentials** → **Create credentials → OAuth client ID**.
2. Application type: **Web application** (⚠️ not "Desktop app").
3. Name: e.g. `Homey`.
4. Under **Authorized redirect URIs** click **Add URI** and paste exactly:
   ```
   https://callback.athom.com/oauth2/callback
   ```
5. **Create** → a dialog shows your **Client ID** (`…apps.googleusercontent.com`) and **Client secret**. Copy both (you can re-view them later under *Credentials*).

### Step 5 — Connect Homey

1. In the Homey app: **More → Apps → Health Sync for Google Health → Configure app**.
2. Paste **Client ID** and **Client secret** → **Save**.
3. Add the device: **Devices → + → Health Sync for Google Health** → sign in with the Google account you added as test user.
4. ⚠️ **On Google's consent screen, tick ALL permission checkboxes** — Google leaves them unchecked by default. Unticked permissions show up later as a warning on the device.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Error 400: redirect_uri_mismatch` | The redirect URI on the OAuth client doesn't exactly match `https://callback.athom.com/oauth2/callback` (no trailing slash, no spaces). |
| `Access blocked: … has not completed the Google verification process` | Your Google account isn't added as a **test user** on the consent screen (or you're signed in with a different account). |
| Device warning "No Google permission for: …" | You left consent checkboxes unticked. Run **Repair** on the device and tick everything. |
| "Google login expired" after a week | Consent screen is in *Testing* mode — run **Repair**, or publish the consent screen (see Step 3 note). |
| `API has not been used in project … or it is disabled` | Step 2 was skipped or done in the wrong project — check the project picker. |

---

## 🇩🇪 Deutsch: Google Cloud für diese App einrichten

Google vergibt den Health-API-Zugriff **pro Google-Cloud-Projekt** — deshalb bringt jeder Nutzer sein eigenes (kostenloses) Projekt samt OAuth-Client mit. Das dauert einmalig etwa 10 Minuten.

### Voraussetzungen

- Ein Google-Konto mit Gesundheitsdaten (z. B. von einer Pixel Watch oder Fitbit synchronisiert)
- Ein Homey Pro mit installierter App

### Schritt 1 — Google-Cloud-Projekt anlegen

1. [console.cloud.google.com](https://console.cloud.google.com/) öffnen und mit deinem Google-Konto anmelden.
2. Oben links auf die **Projektauswahl** klicken (neben dem Google-Cloud-Logo) → **Neues Projekt**.
3. Name z. B. `homey-health`, *Speicherort/Organisation* unverändert lassen → **Erstellen**.
4. Sicherstellen, dass das neue Projekt in der Projektauswahl **ausgewählt** ist, bevor du weitermachst.

*Alles ist kostenlos — die Health API hat für den persönlichen Gebrauch keine Kosten, ein Rechnungskonto ist nicht nötig.*

### Schritt 2 — Google Health API aktivieren

1. [console.cloud.google.com/apis/api/health.googleapis.com](https://console.cloud.google.com/apis/api/health.googleapis.com) öffnen (oder in *APIs & Dienste → Bibliothek* nach „Google Health API" suchen).
2. Auf **Aktivieren** klicken.

### Schritt 3 — OAuth-Zustimmungsbildschirm einrichten

1. Zu **APIs & Dienste → OAuth-Zustimmungsbildschirm** gehen (in neueren Console-Versionen unter **Google Auth Platform**; falls gefragt: **Jetzt starten / Konfigurieren**).
2. **App-Informationen**: beliebiger App-Name (z. B. `Homey Health Sync`), deine E-Mail als Support-E-Mail.
3. **Zielgruppe / Nutzertyp**: **Extern** wählen.
4. **Kontaktdaten**: nochmal deine E-Mail → fertigstellen. Die Abschnitte *Scopes/Branding* kannst du überspringen — die Homey-App fragt ihre Berechtigungen beim Login an.
5. Dich selbst als **Testnutzer** hinzufügen: unter **Zielgruppe** (bzw. Abschnitt *Testnutzer*) auf **Nutzer hinzufügen** klicken und das Google-Konto mit deinen Gesundheitsdaten eintragen.

> ⏳ **Hinweis zum Modus „Testen":** Solange der Zustimmungsbildschirm auf *Testen* steht, lässt Google Anmeldungen nach **7 Tagen** ablaufen — das Homey-Gerät zeigt dann „Reparieren ausführen". Wer das vermeiden will, klickt auf dem Zustimmungsbildschirm auf **App veröffentlichen**. Googles Verifizierung ist dafür **nicht** nötig: Beim Login erscheint einmalig die Warnung „Google hat diese App nicht überprüft" (weiter über *Erweitert*), dafür bleiben Anmeldungen dauerhaft gültig.

### Schritt 4 — OAuth-Client erstellen

1. Zu **APIs & Dienste → Anmeldedaten** → **Anmeldedaten erstellen → OAuth-Client-ID**.
2. Anwendungstyp: **Webanwendung** (⚠️ nicht „Desktop-App").
3. Name: z. B. `Homey`.
4. Unter **Autorisierte Weiterleitungs-URIs** auf **URI hinzufügen** klicken und exakt einfügen:
   ```
   https://callback.athom.com/oauth2/callback
   ```
5. **Erstellen** → ein Dialog zeigt **Client-ID** (`…apps.googleusercontent.com`) und **Clientschlüssel** (Client-Secret). Beides kopieren (später jederzeit unter *Anmeldedaten* einsehbar).

### Schritt 5 — Homey verbinden

1. In der Homey-App: **Mehr → Apps → Health Sync für Google Health → App konfigurieren**.
2. **Client-ID** und **Client-Secret** einfügen → **Speichern**.
3. Gerät hinzufügen: **Geräte → + → Health Sync für Google Health** → mit dem Google-Konto anmelden, das du als Testnutzer eingetragen hast.
4. ⚠️ **Auf Googles Zustimmungsbildschirm ALLE Berechtigungs-Häkchen setzen** — Google lässt sie standardmäßig leer. Fehlende Häkchen erscheinen später als Warnung am Gerät.

### Fehlerbehebung

| Symptom | Lösung |
|---|---|
| `Fehler 400: redirect_uri_mismatch` | Die Weiterleitungs-URI am OAuth-Client stimmt nicht exakt mit `https://callback.athom.com/oauth2/callback` überein (kein Slash am Ende, keine Leerzeichen). |
| `Zugriff blockiert: … hat den Google-Überprüfungsprozess nicht abgeschlossen` | Dein Google-Konto ist nicht als **Testnutzer** eingetragen (oder du bist mit einem anderen Konto angemeldet). |
| Geräte-Warnung „Keine Google-Berechtigung für: …" | Beim Login Häkchen leer gelassen. Am Gerät **Reparieren** ausführen und alles anhaken. |
| „Google-Anmeldung abgelaufen" nach einer Woche | Zustimmungsbildschirm steht auf *Testen* — **Reparieren** ausführen oder den Zustimmungsbildschirm veröffentlichen (siehe Hinweis in Schritt 3). |
| `API has not been used in project … or it is disabled` | Schritt 2 übersprungen oder im falschen Projekt ausgeführt — Projektauswahl prüfen. |
