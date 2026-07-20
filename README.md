# Familyboard Whiteboard Card

Lovelace-Karte für ein freies Zeichenbrett: Freihand-Striche (Stift +
Radierer) und frei platzierbare, per Tastatur beschreibbare Text-Notizen –
im gleichen Look wie [Planner](https://github.com/GoDigitalizeMe/familyboard-planner-card)
und [Tasks](https://github.com/GoDigitalizeMe/familyboard-tasks-card).

Diese Karte ist der reine Anzeige-/Zeichen-Layer. Speicherung übernimmt die
zugehörige Python-Integration:
👉 **[familyboard-whiteboard-ha](https://github.com/GoDigitalizeMe/familyboard-whiteboard-ha)**
– dort zuerst installieren und einrichten, bevor diese Karte einen
gültigen `entity`-Wert zur Auswahl hat.

## Funktionen

- **Stift** mit 6 Farben und 3 Strichstärken.
- **Radierer** (löscht wirklich Pixel, nicht nur überdeckt sie farblich).
- **Text-Notizen**: „Text“-Button fügt eine neue, sofort tippbereite
  Notiz hinzu; per Griff (⠿) frei verschiebbar, per ✕ löschbar.
- **Alles löschen** mit Sicherheitsabfrage.
- Speichert automatisch (nach jedem abgeschlossenen Strich, jeder
  verschobenen/bearbeiteten Notiz) und lädt den Stand auf allen Geräten,
  die dieselbe Board-Entity anzeigen.
- Größe/Auflösung passt sich automatisch an die Kartenbreite an – bereits
  Gezeichnetes bleibt dabei proportional erhalten.

## Installation über HACS

1. HACS → Dashboard (bzw. Frontend/Plugin, je nach HACS-Version) →
   benutzerdefiniertes Repository hinzufügen:
   `https://github.com/GoDigitalizeMe/familyboard-whiteboard-card`, Typ
   **Dashboard** (ältere HACS-Versionen: **Plugin**).
2. „Familyboard Whiteboard Card“ in der Liste öffnen und herunterladen.
3. Home Assistant Frontend neu laden (harter Browser-Reload reicht i. d. R.).

## Manuelle Installation

1. `dist/familyboard-whiteboard-card.js` nach
   `config/www/familyboard-whiteboard-card.js` kopieren.
2. Einstellungen → Dashboards → Ressourcen → Ressource hinzufügen:
   URL `/local/familyboard-whiteboard-card.js`, Typ „JavaScript-Modul“.

## Verwendung

Dashboard bearbeiten → Karte hinzufügen → „Familyboard Whiteboard Card“
(visueller Editor) oder manuell per YAML:

```yaml
type: custom:familyboard-whiteboard-card
entity: sensor.whiteboard_whiteboard   # Sensor der familyboard_whiteboard-Integration
title: Whiteboard
height: 480
language: de
```

| Option | Standard | Beschreibung |
| --- | --- | --- |
| `entity` | *(erforderlich)* | Sensor-Entity der Familyboard-Whiteboard-Integration |
| `title` | „Whiteboard“ | Überschrift der Karte |
| `height` | `480` | Höhe der Zeichenfläche in Pixel |
| `language` | `de` | Sprache für Dialogtexte (`de`/`en`) |

## Bekannte Einschränkung

Das Speichern ersetzt bei jeder Änderung den **kompletten** Inhalt eines
Boards (kein Merge). Zeichnen zwei Personen exakt gleichzeitig auf
unterschiedlichen Geräten, gewinnt die zuletzt gespeicherte Version – für
ein Familien-Wandboard ausreichend, aber kein Werkzeug für echtzeitfähiges
gemeinsames Bearbeiten.
