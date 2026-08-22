<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/wordmark-dark.svg"><img src="docs/wordmark-light.svg" alt="career-ops" width="250" height="56"></picture></p>

<div align="center">

[English](README.md) | [Español](README.es.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Português (Brasil)](README.pt-BR.md) | [한국어](README.ko-KR.md) | [日本語](README.ja.md) | [简体中文](README.cn.md) | [繁體中文](README.zh-TW.md) | [Українська](README.ua.md) | [Русский](README.ru.md) | [Polski](README.pl.md) | [Dansk](README.da.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md)

</div>

<p align="center">
  <em>KI-gestützte Automatisierung der Jobsuche — Stellenangebote bewerten, maßgeschneiderte Lebensläufe erstellen und die Pipeline durchgängig verfolgen.</em><br>
  Dies ist ein persönlicher Fork des quelloffenen Projekts <a href="https://github.com/santifer/career-ops">career-ops</a>, ursprünglich erstellt von Santiago Fernández de Valderrama.
</p>

---

<p align="center">
  <img src="docs/demo.gif" alt="career-ops Demo" width="800">
</p>

<p align="center">
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/Built_with-Claude_Code-000?style=for-the-badge&logo=anthropic&logoColor=white" alt="Built with Claude Code"></a>
</p>

<p align="center">
  <sub>Läuft auch mit jeder CLI, die den agent-skill-Standard unterstützt</sub><br>
  <img src="https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white" alt="Claude Code">
  <img src="https://img.shields.io/badge/OpenCode-111827?style=flat&logo=terminal&logoColor=white" alt="OpenCode">
  <img src="https://img.shields.io/badge/Antigravity_CLI-4285F4?style=flat&logo=google&logoColor=white" alt="Antigravity CLI">
  <img src="https://img.shields.io/badge/Codex-412991?style=flat&logo=openai&logoColor=white" alt="Codex">
  <img src="https://img.shields.io/badge/Qwen-615CED?style=flat" alt="Qwen">
  <img src="https://img.shields.io/badge/Kimi-FF4B4B?style=flat" alt="Kimi">
  <img src="https://img.shields.io/badge/GitHub_Copilot-000?style=flat&logo=githubcopilot&logoColor=white" alt="GitHub Copilot">
  <img src="https://img.shields.io/badge/Grok_Build_CLI-000?style=flat&logo=x&logoColor=white" alt="Grok Build CLI">
  <br>
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white" alt="Go">
  <img src="https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white" alt="Playwright">
  <img src="https://img.shields.io/badge/Bubble_Tea-FF75B5?style=flat&logo=go&logoColor=white" alt="Bubble Tea">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT">
</p>

## Was ist das?

career-ops macht jede KI-Coding-CLI zu einer Kommandozentrale für die Jobsuche. Statt Bewerbungen manuell in einer Tabelle zu verfolgen, bekommst du eine KI-gestützte Pipeline, die:

- **Stellenanzeigen mit einer strukturierten A-F-Bewertung bewertet** (fünf Dimensionen, die zu einer Bewertung von 1,0–5,0 führen)
- **maßgeschneiderte PDFs generiert** -- ATS-optimierte Lebensläufe, angepasst an jede Stellenanzeige
- **Portale automatisch scannt** (Greenhouse, Ashby, Lever, Unternehmensseiten)
- **Batch-Verarbeitung** ermöglicht -- 10+ Stellenanzeigen parallel mit Sub-Agents bewerten
- **alles verfolgt** in einer einzigen Source of Truth mit Integritätsprüfungen

> **Wichtig: Das ist KEIN Spray-and-Pray-Tool.** career-ops ist ein Filter: Es hilft dir, aus hunderten Stellenanzeigen die wenigen zu finden, die deine Zeit wert sind. Das System rät deutlich davon ab, sich auf Rollen mit weniger als 4,0/5 zu bewerben. Deine Zeit ist wertvoll, die der Recruiter auch. Prüfe alles, bevor du etwas abschickst.

career-ops ist agentisch: Die KI-Coding-CLI deiner Wahl navigiert mit Playwright durch Karriereseiten, bewertet den Fit zwischen Lebenslauf und Stellenanzeige durch echtes Reasoning statt Keyword-Matching und passt deinen Lebenslauf pro Stellenanzeige an.

> **Hinweis: Die ersten Bewertungen werden nicht perfekt sein.** Das System kennt dich noch nicht. Gib ihm Kontext: deinen Lebenslauf, deinen Werdegang, Proof Points, Präferenzen, Stärken und No-Gos. Je besser du es einarbeitest, desto besser wird es. Denk daran wie an das Onboarding eines neuen Recruiters: In der ersten Woche muss er dich kennenlernen, danach wird er wertvoll.

## Features

| Feature | Beschreibung |
| ------- | ------------ |
| **Auto-Pipeline** | URL einfügen, vollständige Bewertung + PDF + Tracker-Eintrag erhalten |
| **6-Block-Bewertung** | Rollen-Zusammenfassung, Lebenslauf-Match, Level-Strategie, Vergütungsrecherche, Personalisierung, Interview-Vorbereitung (STAR+R) -- plus Block G zur Legitimitätsprüfung gegen Scams und Ghost Jobs |
| **Interview Story Bank** | Sammelt STAR+Reflection-Geschichten über Bewertungen hinweg -- 5-10 Master-Stories für Behavioral Questions |
| **Verhandlungsskripte** | Frameworks für Gehaltsverhandlungen, Pushback gegen geografische Abschläge, Hebel durch konkurrierende Angebote |
| **ATS-PDF-Generierung** | Lebensläufe mit Keyword-Injektion im Space-Grotesk- und DM-Sans-Design |
| **Anschreiben-Generator** | Recherchegestützte Anschreiben mit Keyword-Mirroring, interaktiven Angle-Prompts, Freigabe im Chat und A4-PDF über dieselbe HTML- und Playwright-Pipeline wie Lebensläufe |
| **Portal-Scanner** | 45+ vorkonfigurierte Unternehmen (Anthropic, OpenAI, ElevenLabs, Retool, n8n...) plus eigene Queries über Ashby, Greenhouse, Lever und Wellfound |
| **Batch Processing** | Parallele Bewertung mit headless CLI-Workern (`claude -p` / `opencode run`) |
| **Dashboard TUI** | Terminal-UI zum Durchsuchen, Filtern und Sortieren deiner Pipeline |
| **Human-in-the-Loop** | KI bewertet und empfiehlt, du entscheidest. Das System sendet niemals automatisch Bewerbungen ab |
| **Pipeline-Integrität** | Automatisches Mergen, Deduplizieren, Status-Normalisierung und Health Checks |

## Schnellstart

**Der schnellste Weg -- ein Befehl:**

```bash
npx @santifer/career-ops init
```

> `npx` wird mit [Node.js](https://nodejs.org) ausgeliefert. Es führt den Installer einmal aus, ohne global etwas zu installieren. Noch kein Node? Installiere es zuerst. Wenn du bereits Claude Code, Gemini oder Codex nutzt, hast du Node wahrscheinlich schon.

Das klont die neueste Version nach `./career-ops` und installiert die Abhängigkeiten. Danach:

```bash
cd career-ops
claude   # oder gemini / codex / qwen / opencode / agy / grok -- öffne deine KI-CLI hier
```

**Beim ersten Start führt dich career-ops per Chat durch die Einrichtung: Lebenslauf, Profil und Zielrollen. Du musst nichts von Hand bearbeiten.**

<details>
<summary><b>Lieber manuell einrichten? (git clone)</b></summary>

```bash
git clone <repo-url>
cd career-ops && npm install
npx playwright install chromium   # nur für PDF-Generierung nötig

# 2. Setup prüfen
npm run doctor                     # validiert alle Voraussetzungen

# 3. Konfigurieren
cp config/profile.example.yml config/profile.yml  # mit deinen Daten bearbeiten
cp templates/portals.example.yml portals.yml       # Unternehmen anpassen

# 4. Lebenslauf hinzufügen
# Erstelle cv.md im Projekt-Root mit deinem Lebenslauf in Markdown

# 5. KI-CLI in diesem Verzeichnis öffnen
claude   # oder codex / opencode / gemini / qwen / agy / grok
```

</details>

> **Das System ist darauf ausgelegt, von deiner KI-Coding-CLI selbst angepasst zu werden.** Modi, Archetypen, Scoring-Gewichte, Verhandlungsskripte -- frag einfach danach. Die CLI liest dieselben Dateien, die sie nutzt, und weiß daher genau, was zu ändern ist.

Siehe [docs/SETUP.md](docs/SETUP.md) für die vollständige Setup-Anleitung und [docs/RUNNING_ON_A_BUDGET.md](docs/RUNNING_ON_A_BUDGET.md) für günstige Nutzung mit eigenen oder lokalen Modellen.

## Nutzung

career-ops verwendet einen gemeinsamen Command-Router. In CLIs mit Slash-Command-Registrierung sieht das so aus:

```text
/career-ops                → alle verfügbaren Befehle anzeigen
/career-ops {JD einfügen}  → vollständige Auto-Pipeline (Bewertung + PDF + Tracker)
/career-ops scan           → Portale nach neuen Angeboten scannen
/career-ops pdf            → ATS-optimierten Lebenslauf generieren
/career-ops cover          → Anschreiben-Generator (JD einfügen oder /career-ops cover {slug})
/career-ops batch          → mehrere Stellenanzeigen im Batch bewerten
/career-ops tracker        → Bewerbungsstatus anzeigen
/career-ops apply          → Bewerbungsformulare mit KI ausfüllen
/career-ops pipeline       → ausstehende URLs verarbeiten
/career-ops contacto       → LinkedIn-Outreach-Nachricht
/career-ops deep           → tiefgehende Unternehmensrecherche
/career-ops training       → Kurs/Zertifikat bewerten
/career-ops project        → Portfolio-Projekt bewerten
```

Oder füge einfach eine Stellenanzeigen-URL oder Stellenbeschreibung ein -- career-ops erkennt sie automatisch und startet die komplette Pipeline.

In Codex sind Slash Commands nicht garantiert. Nutze stattdessen dieselben Modusnamen in einem normalen Prompt oder über `codex exec`.

## Wie es funktioniert

```text
Du fügst eine Stellenanzeigen-URL oder Stellenbeschreibung ein
        |
        v
Archetyp-Erkennung
        |
        v
A-F-Bewertung (liest cv.md)
        |
        +-- Report
        +-- PDF
        +-- Tracker
```

## Vorkonfigurierte Portale

Der Scanner bringt **45+ Unternehmen** und **19 Suchabfragen** über große Jobbörsen mit. Kopiere `templates/portals.example.yml` nach `portals.yml` und ergänze deine eigenen Quellen:

**AI Labs:** Anthropic, OpenAI, Mistral, Cohere, LangChain, Pinecone
**Voice AI:** ElevenLabs, PolyAI, Parloa, Hume AI, Deepgram, Vapi, Bland AI
**AI Platforms:** Retool, Airtable, Vercel, Temporal, Glean, Arize AI
**Contact Center:** Ada, LivePerson, Sierra, Decagon, Talkdesk, Genesys
**Enterprise:** Salesforce, Twilio, Gong, Dialpad
**LLMOps:** Langfuse, Weights & Biases, Lindy, Cognigy, Speechmatics
**Automation:** n8n, Zapier, Make.com
**European:** Factorial, Attio, Tinybird, Clarity AI, Travelperk

**Durchsuchte Jobbörsen:** 21 Provider-Module decken ATS-APIs, boardweite Feeds, XML/RSS-Feeds, Markdown-Feeds und lokale Parser ab. Siehe [Supported job boards](docs/SUPPORTED_JOB_BOARDS.md) für die vollständige Tabelle.

Standardmäßig vertraut `node core/scan.mjs` (alias `npm run scan`) den Rückgaben der ATS-Feeds. Einige Unternehmen lassen alte Stellenanzeigen öffentlich verfügbar, obwohl Rollen bereits geschlossen sind. Mit `--verify` startet Playwright nach dem API-Lauf und entfernt abgelaufene Stellenanzeigen, bevor sie in `pipeline.md` landen:

```bash
node core/scan.mjs --verify          # Zero-Token-Discovery + Playwright-Liveness-Check
```

## Dashboard TUI

Das integrierte Terminal-Dashboard lässt dich deine Pipeline visuell durchsuchen:

```bash
cd dashboard
go build -o career-dashboard .
./career-dashboard --path ..
```

Features: 6 Filter-Tabs, 4 Sortiermodi, gruppierte/flache Ansicht, lazy-loaded Previews, Statusänderungen inline.

## Projektstruktur

```text
career-ops/
├── AGENTS.md                    # kanonische Agent-Anweisungen für alle CLIs
├── CLAUDE.md                    # Claude-Code-Wrapper (importiert AGENTS.md)
├── CODEX.md                     # Codex-Wrapper (importiert AGENTS.md)
├── OPENCODE.md                  # OpenCode-Wrapper (importiert AGENTS.md)
├── cv.md                        # dein Lebenslauf (selbst erstellen)
├── article-digest.md            # deine Proof Points (optional)
├── config/
│   └── profile.example.yml      # Vorlage für dein Profil
├── modes/                       # Skill-Modi
├── templates/                   # CV-Template, Portal-Template, Statuswerte
├── batch/                       # Batch-Orchestrierung
├── dashboard/                   # Go-TUI für die Pipeline
├── data/                        # deine Tracking-Daten (gitignored)
├── reports/                     # Bewertungsberichte (gitignored)
├── output/                      # generierte PDFs (gitignored)
├── fonts/                       # Space Grotesk + DM Sans
├── docs/                        # Setup, Anpassung, Budget-Guide, Architektur
└── examples/                    # Beispiel-CV, Report, Proof Points
```

## Tech Stack

![Claude Code](https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)
![Go](https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white)
![Bubble Tea](https://img.shields.io/badge/Bubble_Tea-FF75B5?style=flat&logo=go&logoColor=white)

- **Agent:** KI-Coding-CLI mit gemeinsamen Skills und Modi (`AGENTS.md` + CLI-Wrapper)
- **PDF:** Playwright/Puppeteer + HTML-Template
- **Anschreiben:** HTML-Template + Playwright (A4-PDF, gleiche Pipeline wie Lebensläufe)
- **Scanner:** Playwright + Greenhouse API + WebSearch
- **Dashboard:** Go + Bubble Tea + Lipgloss (Catppuccin-Mocha-Theme)
- **Daten:** Markdown-Tabellen + YAML-Konfiguration + TSV-Batch-Dateien

## FAQ

**Was ist career-ops?**
career-ops ist ein quelloffenes, CLI-unabhängiges Kommandozentrum für die Jobsuche. Es macht aus jeder KI-Coding-CLI eine Pipeline, die Stellenangebote gegen deinen Lebenslauf bewertet, ATS-optimierte PDFs erzeugt, die richtige Kontaktperson findet und alles an einem Ort trackt — während du die finale Entscheidung behältst.

**Kann ich career-ops kostenlos oder mit einem günstigeren / lokalen Modell nutzen?**
Ja. career-ops ist CLI-unabhängig und läuft mit kostenlosen und lokalen Modellen — über kostenlose OpenRouter-Modelle, Ollama oder jeden OpenAI-kompatiblen Endpoint — sodass du nicht an ein kostenpflichtiges Abo gebunden bist. Die vollständige Einrichtung findest du in [docs/RUNNING_ON_A_BUDGET.md](docs/RUNNING_ON_A_BUDGET.md).

**Mit welchen KI-CLIs funktioniert career-ops?**
career-ops läuft mit jeder gängigen KI-Coding-CLI — Claude Code, Codex, Gemini / Antigravity, OpenCode, Grok, Qwen und mehr — über den offenen Agent Skill Standard, ist also nie an einen einzelnen Anbieter gebunden. Nutze einfach die CLI, die du bereits hast.

**Wie installiere ich career-ops unter Windows?**
career-ops läuft unter Windows. Falls Skills während der Installation mit einem Symlink-Fehler nicht laden, steht die Lösung in [docs/FAQ.md](docs/FAQ.md). Die vollständigen Schritte findest du in [docs/SETUP.md](docs/SETUP.md).

**Bewirbt sich career-ops automatisch für mich?**
Nein. career-ops ist ein Filter, kein Spray-and-Pray-Auto-Bewerber. Die KI bewertet, priorisiert und entwirft; du prüfst und entscheidest. Sie reicht nie etwas ein, sendet oder klickt nichts — die finale Entscheidung liegt immer bei dir. Genau dieses Human-in-the-Loop-Design ist der ganze Sinn.

**Ist career-ops kostenlos und Open Source?**
Ja. career-ops ist kostenlos und Open Source, und für dich als Bewerber:in wird es das immer bleiben.

## Haftungsausschluss

**career-ops ist ein lokales Open-Source-Tool, kein gehosteter Service.** Mit der Nutzung dieser Software erkennst du an:

1. **Du kontrollierst deine Daten.** Dein Lebenslauf, Kontaktdaten und persönliche Daten bleiben auf deinem Rechner und werden direkt an den KI-Anbieter gesendet, den du auswählst. Wir sammeln, speichern oder sehen diese Daten nicht.
2. **Du kontrollierst die KI.** Die Standard-Prompts weisen die KI an, Bewerbungen nicht automatisch abzusenden. KI-Modelle können sich trotzdem unvorhersehbar verhalten. Wenn du Prompts änderst oder andere Modelle nutzt, tust du das auf eigenes Risiko. **Prüfe KI-generierte Inhalte immer auf Richtigkeit, bevor du sie einreichst.**
3. **Du hältst dich an Drittanbieter-AGB.** Nutze dieses Tool im Einklang mit den Nutzungsbedingungen der Karriereportale, mit denen du interagierst. Verwende es nicht, um Arbeitgeber zu spammen oder ATS-Systeme zu überlasten.
4. **Keine Garantien.** Bewertungen sind Empfehlungen, keine Wahrheit. KI-Modelle können Kenntnisse oder Erfahrungen halluzinieren. Die Autor:innen haften nicht für Beschäftigungsergebnisse, Ablehnungen, Kontosperren oder andere Folgen.

Siehe [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md) für Details. Diese Software wird unter der [MIT License](LICENSE) ohne Gewährleistung bereitgestellt.

## Lizenz

Der Code steht unter der [MIT](LICENSE)-Lizenz.
