# Google Health für Homey

Homey-App, die Gesundheitsdaten aus der [Google Health API v4](https://developers.google.com/health) auf Homey holt — Schritte, Distanz, Kalorien, Etagen, Herzfrequenz, Ruhepuls, Gewicht, Blutsauerstoff (SpO2) und Schlaf.

Basiert auf den API-Erkenntnissen aus der [google-health-cli](https://github.com/Google-Health-API/google-health-cli) und den Homey-SDK-v3-Konventionen aus dem [homey-app-skill](https://github.com/dvflw/homey-app-skill).

## Funktionen

**Gerät „Google Health"** (ein Gerät pro Google-Konto) mit diesen Capabilities, alle mit Insights-Verlauf:

| Gruppe | Capabilities (Health-API-Typ) |
|---|---|
| Aktivität | Schritte (`steps`) · Distanz (`distance`) · Kalorien (`total-calories`) · Aktivkalorien (`active-energy-burned`) · Grundumsatz-Kalorien (`basal-energy-burned`, aus Liste summiert) · Etagen (`floors`) · Aktivzonen-Minuten (`active-zone-minutes`) · Sitzminuten (`sedentary-period`) |
| Herz | Herzfrequenz (`heart-rate`) · Ruhepuls (`daily-resting-heart-rate`) · HRV (`daily-heart-rate-variability`) · VO2 max (`daily-vo2-max`) |
| Körper | Gewicht (`weight`) · Körperfett (`body-fat`) · Blutsauerstoff SpO2 (`daily-oxygen-saturation`) · Atemfrequenz (`daily-respiratory-rate`) · Blutzucker (`blood-glucose`) · Körpertemperatur (`core-body-temperature`) · Hauttemperatur-Abweichung (`daily-sleep-temperature-derivations`) · Höhe (`altitude`) |
| Schlaf | Schlaf letzte Nacht (`sleep`, Naps ausgenommen) · Schläft-Sensor (mit automatischer Aufwach-Erkennung) |
| Ernährung | Wasser (`hydration-log`) · Kalorienaufnahme · Kohlenhydrate · Protein · Fett (`nutrition-log`) |

Manche Capabilities füllen sich nur, wenn dein Wearable diese Daten wirklich aufzeichnet; leere Kacheln bedeuten meist, dass Google Health für dein Konto keine Daten dieses Typs hat.

**Herzdaten (optional):** Aktiviere „EKG und Herzrhythmus" in den App-Einstellungen für die Typen `electrocardiogram` und `irregular-rhythm-notification` (zusätzliche Google-Berechtigungen) — dies versorgt die EKG- und Herzrhythmus-Flow-Auslöser.

**Dashboard-Widgets** (native Homey-Optik, Light/Dark automatisch, jede Metrik mit datentyp-passendem Icon und Live-Sparkline aus einem rollierenden Verlaufspuffer):

- **Health-Kacheln** — Raster kleiner quadratischer Metrik-Kacheln; Auswahl per Häkchen.
- **Health-Kachel** — eine Metrik groß, mit Sparkline der letzten Werte.
- **Health-Übersicht** — mehrere Kernwerte in einer kompakten Karte.

**Gesundheitsbericht:** Erstelle eine druckfertige Übersicht (bis 90 Tage — Statistik, Charts, Tageswerte, optional Patientendaten + BMI). Dunkel am Bildschirm, hell beim PDF-Druck; wird kurzzeitig über dein Heimnetz mit Einmal-Passwort bereitgestellt (Benutzername beliebig, Link ~5 Minuten gültig). Abschnitte und Tabellenspalten wählst du direkt auf der Seite.

**Flow-Karten**

- Auslöser: Schrittzahl geändert · Tägliches Schrittziel erreicht · Neue Herzfrequenz-Messung · Herzfrequenz über/unter Schwellenwert · Ruhepuls über 7-Tage-Durchschnitt · Neue Gewichtsmessung · Neue Glukose-Messung · Neue Schlafdaten · Du bist aufgewacht (mit Aufwachzeit) · Training beendet (Aktivität, Dauer, Kalorien, Ø Puls) · EKG aufgezeichnet (optional) · Unregelmäßiger Herzrhythmus erkannt (optional)
- Bedingungen: Schritte heute über X · Ruhepuls über X bpm · Schlaf kürzer als X h · Tiefschlaf unter X min · Wasseraufnahme unter X ml · Aktivzonen-Minuten über X · Schritte in den letzten X min gestiegen · Heute trainiert · Schläft
- Aktionen: Jetzt synchronisieren · Als schlafend markieren · Als wach markieren · Gewicht protokollieren · Körperfett protokollieren (die letzten beiden erfordern Schreibzugriff)

## Einrichtung

Die Google Health API wird pro Google-Cloud-Projekt freigeschaltet, deshalb brauchst du einen eigenen OAuth-Client:

1. [Google Cloud Console](https://console.cloud.google.com/) öffnen, Projekt anlegen oder auswählen.
2. Die [Google Health API](https://console.cloud.google.com/apis/api/health.googleapis.com) für das Projekt aktivieren.
3. Unter *APIs & Dienste → Anmeldedaten* eine **OAuth-Client-ID** vom Typ **Webanwendung** erstellen und als autorisierte Weiterleitungs-URI eintragen:

   ```
   https://callback.athom.com/oauth2/callback
   ```

4. Solange der OAuth-Zustimmungsbildschirm im Modus **Testen** ist: dein Google-Konto als **Testnutzer** hinzufügen. (Achtung: Im Testmodus laufen Refresh-Tokens nach 7 Tagen ab — dann in Homey einfach „Reparieren" ausführen oder den Zustimmungsbildschirm veröffentlichen.)
5. In Homey: *Mehr → Apps → Google Health → App konfigurieren* — Client-ID und Client-Secret eintragen. Optional „Schreiben erlauben" aktivieren, wenn du die Flow-Karte „Gewicht protokollieren" nutzen willst.
6. Gerät hinzufügen (*Geräte → + → Google Health*) und mit Google anmelden.

## Hinweise zum Verhalten

- **Abrufintervall**: Standard 15 Minuten, einstellbar ab 5 Minuten (Geräteeinstellungen). Datengruppen (Aktivität/Herz/Körper/Schlaf/Ernährung) lassen sich einzeln abschalten.
- **Fehlende Tage ≠ 0**: Liefert die API für heute (noch) keine Aktivitätsdaten, behält die App den letzten Wert; nur beim Tageswechsel wird der Schrittzähler auf 0 gesetzt. Ein `countSum: "0"` der API ist dagegen eine echte Null.
- **Zahlenformate**: `int64`-Felder kommen als Strings (protobuf-JSON) und werden defensiv nach `Number` konvertiert.
- **Schreiben** (Gewicht) nutzt zusätzlich den Scope `googlehealth.health_metrics_and_measurements` (read/write) und wird nur angefragt, wenn in den App-Einstellungen aktiviert. Nach einer Scope-Änderung genügt „Reparieren" am Gerät.
- **Google-Login**: Beim Zustimmungsbildschirm **alle Häkchen setzen** — Google lässt die granularen Berechtigungen standardmäßig leer; fehlende Berechtigungen zeigt das Gerät als Warnung an.

## Entwicklung

```bash
npm install
npx homey app validate --level publish
npx homey app run    # live auf deinem Homey testen
```

Projektstruktur nach Homey Compose — `app.json` wird aus `.homeycompose/` und den `*.compose.json`-Dateien der Driver generiert, nie direkt editieren.

## Quellen & Credits

Diese App wurde vollständig mit **Claude Fable 5** (Anthropic) in Claude Code gebaut — als Praxistest der Fable-5-Fähigkeiten: Multi-Agent-Review-Workflows (4 Reviewer + adversariale Verifikation), API-Reverse-Engineering aus CLI-Quellcode, Logo-Design mit Chromium-Rendering und iteratives Debugging gegen einen echten Homey Pro.

Genutzte Quellen:

| Quelle | Verwendung |
|---|---|
| [google-health-cli](https://github.com/Google-Health-API/google-health-cli) (Apache 2.0) | Google Health API v4: Endpunkte, OAuth-Scopes, Datentypen und Roh-Response-Formate — extrahiert aus `README.md`, den Agent-Skills (`skills/ghealth*/SKILL.md`) und dem Go-Quellcode (`pkg/types/registry.go`, `pkg/client/client.go`, `cmd/data.go`, `pkg/auth/auth.go`, `pkg/output/simplify.go`) |
| [homey-app-skill](https://github.com/dvflw/homey-app-skill) (MIT) | Homey-SDK-v3-Konventionen: Compose-Struktur, Lifecycle-Regeln, OAuth2-Pairing-Muster, Flow-Card-Definitionen |
| [Homey Apps SDK Doku](https://apps.developer.homey.app/) & [SDK-v3-Referenz](https://apps-sdk-v3.developer.homey.app/) | Offizielle API-Referenz für App/Driver/Device, Pairing-Templates, Einstellungen |
| [Google Identity / OAuth 2.0](https://developers.google.com/identity/protocols/oauth2) | Authorization-Code-Flow, Token-Refresh, granulare Consent-Berechtigungen |
| [Homey Developer Tools](https://tools.developer.homey.app/) | Publishing- und Test-Release-Workflow |

Diese App ist nicht mit Google verbunden. Google Health ist eine Marke von Google LLC.

## Lizenz

MIT
