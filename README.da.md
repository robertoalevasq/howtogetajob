<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/wordmark-dark.svg"><img src="docs/wordmark-light.svg" alt="career-ops" width="250" height="56"></picture></p>

<div align="center">

[English](README.md) | [Español](README.es.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Português (Brasil)](README.pt-BR.md) | [한국어](README.ko-KR.md) | [日本語](README.ja.md) | [简体中文](README.cn.md) | [繁體中文](README.zh-TW.md) | [Українська](README.ua.md) | [Русский](README.ru.md) | [Polski](README.pl.md) | [Dansk](README.da.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md)

</div>

<p align="center">
  <em>AI-drevet automatisering af jobsøgning — vurdér stillinger, generér skræddersyede CV'er, og hold styr på hele din pipeline ét sted.</em><br>
  Dette er en personlig fork af open source-projektet <a href="https://github.com/santifer/career-ops">career-ops</a>, oprindeligt skabt af Santiago Fernández de Valderrama.
</p>

---

<p align="center">
  <img src="docs/demo.gif" alt="career-ops Demo" width="800">
</p>

<p align="center">
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/Built_with-Claude_Code-000?style=for-the-badge&logo=anthropic&logoColor=white" alt="Built with Claude Code"></a>
</p>

<p align="center">
  <sub>Virker også på ethvert CLI, der følger agent-skill-standarden</sub><br>
  <img src="https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white" alt="Claude Code">
  <img src="https://img.shields.io/badge/OpenCode-111827?style=flat&logo=terminal&logoColor=white" alt="OpenCode">
  <img src="https://img.shields.io/badge/Gemini_CLI-4285F4?style=flat&logo=google&logoColor=white" alt="Gemini CLI">
  <img src="https://img.shields.io/badge/Codex-412991?style=flat&logo=openai&logoColor=white" alt="Codex">
  <img src="https://img.shields.io/badge/Qwen-615CED?style=flat" alt="Qwen">
  <img src="https://img.shields.io/badge/GitHub_Copilot-000?style=flat&logo=githubcopilot&logoColor=white" alt="GitHub Copilot">
  <br>
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white" alt="Go">
  <img src="https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white" alt="Playwright">
  <img src="https://img.shields.io/badge/Bubble_Tea-FF75B5?style=flat&logo=go&logoColor=white" alt="Bubble Tea">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT">
</p>

## Hvad er det

career-ops forvandler et hvilket som helst AI-CLI til en komplet kommandocentral for jobsøgning. I stedet for manuelt at spore ansøgninger i et regneark får du en AI-drevet pipeline, der:

- **Vurderer stillinger** med et struktureret A–F-system (fem dimensioner, der giver en score på 1,0-5,0)
- **Genererer skræddersyede PDF'er** — ATS-optimerede CV'er tilpasset hver stilling
- **Skanner portaler** automatisk (Greenhouse, Ashby, Lever, virksomheders karrieresider)
- **Batch-behandler** — vurderer 10+ stillinger parallelt via sub-agenter
- **Sporer alt** i én kilde til sandhed med datakonsistenstjek

> **Vigtigt: dette er IKKE et værktøj til masseudsendelse af ansøgninger.** career-ops er et filter — det hjælper dig med at finde de få stillinger blandt hundredvis, der er din tid værd. Systemet fraråder kraftigt at ansøge stillinger med en vurdering under 4,0/5. Din tid er værdifuld, og det samme er rekrutterens. Tjek altid efter, før du sender.

career-ops arbejder agentisk: Claude Code navigerer karrieresider med Playwright, vurderer match ved at ræsonnere over dit CV kontra stillingsopslaget (ikke via søgeordsmatchning) og tilpasser CV'et til hvert opslag.

> **Bemærk: de første vurderinger bliver ikke perfekte.** Systemet kender dig endnu ikke. Giv det kontekst — dit CV, din karrierehistorik, eksempler på resultater, præferencer, styrker, hvad du vil undgå. Jo mere du giver det, jo bedre virker det. Betragt det som onboarding af en ny rekrutter: i den første uge skal den lære, hvem du er — derefter bliver den uvurderlig.

## Funktioner

| Funktion                       | Beskrivelse                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auto-Pipeline**              | Indsæt URL → fuld vurdering + PDF + tracker-post                                                                                                |
| **6-bloks vurdering**          | Rolleresumé, CV-match, niveaustrategi, lønundersøgelse, personalisering, interviewforberedelse (STAR+R)                                          |
| **Interviewhistoriebank**      | Samler STAR+Reflection-historier — 5–10 mesterhistorier, der besvarer ethvert adfærdsspørgsmål                                                  |
| **Forhandlingsscripts**        | Frameworks til lønforhandling, imødegåelse af geografisk rabat, udnyttelse af konkurrerende tilbud                                              |
| **ATS-optimeret PDF**          | CV med søgeordsindsprøjtning, Space Grotesk + DM Sans-design                                                                                    |
| **Portalskanner**              | 45+ virksomheder konfigureret (Anthropic, OpenAI, ElevenLabs, Retool, n8n…) + forespørgsler via Ashby, Greenhouse, Lever, Wellfound            |
| **Batch-behandling**           | Parallel vurdering via `claude -p`-workers                                                                                                      |
| **TUI-dashboard**              | Terminal-UI til at gennemse, filtrere og sortere pipelinen                                                                                       |
| **Human-in-the-Loop**          | AI vurderer og anbefaler, du beslutter og handler. Systemet sender aldrig ansøgninger — det sidste ord er altid dit                            |
| **Pipeline-integritet**        | Automatisk merge, deduplikering, statusnormalisering, datakvalitetstjek                                                                          |

## Hurtig start

**Hurtigste måde — én kommando:**

```bash
npx @santifer/career-ops init
```

> 💡 `npx` følger med [Node.js](https://nodejs.org) — det kører installationsprogrammet én gang uden at installere noget globalt. Har du ikke Node.js endnu? Installer det først.
> (Bruger du allerede Claude Code / Gemini / Codex CLI? Så har du det allerede.)

Dette kloner den nyeste version til `./career-ops` og installerer afhængighederne. Derefter:

```bash
cd career-ops
claude   # eller gemini / codex / qwen / opencode — åbn dit AI-CLI her
```

**Ved første kørsel guider career-ops dig gennem opsætningen — CV, profil og målstillinger — udelukkende via samtale. Intet skal redigeres manuelt.**

<details>
<summary><b>Foretrækker du manuel opsætning? (git clone)</b></summary>

```bash
git clone <repo-url>
cd career-ops && npm install
npx playwright install chromium   # kun nødvendigt til PDF-generering
claude   # åbn dit AI-CLI — første kørsel guider dig gennem onboarding
```

</details>

> **Systemet er designet til, at Claude tilpasser det.** Tilstande, arketyper, vurderingsvægte, forhandlingsscripts — bed blot Claude om ændringer. Den læser de samme filer, den bruger, så den ved præcis, hvad der skal redigeres.

Fuld opsætningsguide: [docs/SETUP.md](docs/SETUP.md).

## Brug

career-ops er én slash-kommando med flere tilstande:

```text
/career-ops                    → Vis alle tilgængelige kommandoer
/career-ops {indsæt stilling}  → Fuld auto-pipeline (vurdering + PDF + tracker)
/career-ops scan               → Skan portaler for nye stillinger
/career-ops pdf                → Generér ATS-optimeret CV
/career-ops batch              → Batch-vurdering af flere stillinger
/career-ops tracker            → Se status på ansøgninger
/career-ops apply              → AI-assisteret udfyldning af ansøgningsformularer
/career-ops pipeline           → Behandl kø af URL'er
/career-ops contacto           → LinkedIn-besked
/career-ops deep               → Dybdegående virksomhedsundersøgelse
/career-ops training           → Vurdering af kursus/certificering
/career-ops project            → Vurdering af porteføljeprojekt
```

Du kan også blot indsætte en stillings-URL eller dens tekst — career-ops registrerer det automatisk og kører hele pipelinen.

## Sådan virker det

```diagram
Du indsætter en stillings-URL eller -beskrivelse
        │
        ▼
┌──────────────────┐
│  Arketype-       │  Klassificering: Frontend / Backend / DevOps / PM / SA / ML
│  registrering    │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  A–F-vurdering   │  Match, mangler, lønundersøgelse, STAR-historier
│  (læser cv.md)   │
└────────┬─────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
 Rapport PDF Tracker
  .md   .pdf  .tsv
```

## Forudkonfigurerede portaler

Skanneren leveres med **45+ virksomheder** klar til skanning og **19 forespørgsler** via de største jobportaler. Kopiér `templates/portals.example.yml` til `portals.yml`, og tilføj dine egne:

**AI Labs:** Anthropic, OpenAI, Mistral, Cohere, LangChain, Pinecone
**Voice AI:** ElevenLabs, PolyAI, Parloa, Hume AI, Deepgram, Vapi, Bland AI
**AI Platforms:** Retool, Airtable, Vercel, Temporal, Glean, Arize AI
**Contact Center:** Ada, LivePerson, Sierra, Decagon, Talkdesk, Genesys
**Enterprise:** Salesforce, Twilio, Gong, Dialpad
**LLMOps:** Langfuse, Weights & Biases, Lindy, Cognigy, Speechmatics
**Automation:** n8n, Zapier, Make.com
**European:** Factorial, Attio, Tinybird, Clarity AI, Travelperk

**Gennemsøgte portaler:** Ashby, Greenhouse, Lever, Wellfound, Workable, RemoteFront

Som standard stoler `node core/scan.mjs` (`npm run scan`) på det, hvert ATS-feed returnerer. Nogle virksomheder lader forældede opslag blive stående, selv efter rekrutteringen er lukket. Brug `--verify` for at køre Playwright efter API-fasen og frasortere udløbne stillinger, før de tilføjes pipelinen:

```bash
node core/scan.mjs --verify          # token-fri søgning + liveness-verifikation via Playwright
```

Verifikationen er sekventiel og gælder kun nye stillinger (efter deduplikering), så omkostningen er begrænset.

## Dashboard TUI

Indbygget terminal-dashboard til visuel gennemgang af pipelinen:

```bash
cd dashboard
go build -o career-dashboard .
./career-dashboard --path ..
```

Funktioner: 6 filterfaner, 4 sorteringstilstande, grupperet/flad visning, doven indlæsning af forhåndsvisninger, statusændring inline.

## Projektstruktur

```text
career-ops/
├── AGENTS.md                    # Kanoniske instruktioner til agenten (alle CLI'er)
├── CLAUDE.md                    # Claude Code-wrapper (importerer AGENTS.md)
├── cv.md                        # Dit CV (opret denne fil)
├── article-digest.md            # Dine resultatbeviser (valgfrit)
├── config/
│   └── profile.example.yml      # Profilskabelon
├── modes/                       # 14 skill-tilstande
│   ├── _shared.md               # Fælles kontekst (tilpas denne fil)
│   ├── oferta.md                # Vurdering af én stilling
│   ├── pdf.md                   # PDF-generering
│   ├── scan.md                  # Portalskanner
│   ├── batch.md                 # Batch-behandling
│   └── ...
├── templates/
│   ├── cv-template.html         # ATS-optimeret CV-skabelon
│   ├── portals.example.yml      # Konfigurationsskabelon til skanneren
│   └── states.yml               # Kanoniske statusser
├── batch/
│   ├── batch-prompt.md          # Selvstændig worker-prompt
│   └── batch-runner.sh          # Orkestratorscript
├── dashboard/                   # Go TUI-viewer til pipelinen
├── data/                        # Dine sporingsdata (gitignored)
├── reports/                     # Vurderingsrapporter (gitignored)
├── output/                      # Genererede PDF'er (gitignored)
├── fonts/                       # Space Grotesk + DM Sans
├── docs/                        # Dokumentation: opsætning, tilpasning, arkitektur
└── examples/                    # Eksempel-CV, -rapport, -resultatbeviser
```

## Teknologistak

![Claude Code](https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)
![Go](https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white)
![Bubble Tea](https://img.shields.io/badge/Bubble_Tea-FF75B5?style=flat&logo=go&logoColor=white)

- **Agent**: Claude Code med brugerdefinerede skills og tilstande
- **PDF**: Playwright/Puppeteer + HTML-skabelon
- **Skanner**: Playwright + Greenhouse API + WebSearch
- **Dashboard**: Go + Bubble Tea + Lipgloss (Catppuccin Mocha-tema)
- **Data**: Markdown-tabeller + YAML-konfiguration + TSV-filer til batches

## Juridisk ansvarsfraskrivelse

**career-ops er et lokalt open source-værktøj, IKKE en hostingtjeneste.** Ved at bruge denne software anerkender du:

1. **Du kontrollerer dine data.** Dit CV, dine kontaktoplysninger og personlige data forbliver på din computer og sendes direkte til den AI-udbyder, du vælger (Anthropic, OpenAI osv.). Vi indsamler, opbevarer eller har ikke adgang til dine data.
2. **Du kontrollerer AI'en.** Standardprompterne instruerer AI'en i ikke at sende ansøgninger automatisk, men AI-modeller kan opføre sig uforudsigeligt. Du ændrer prompter på eget ansvar. **Tjek altid AI-genereret indhold, før du sender.**
3. **Du overholder tredjeparters vilkår.** Brug værktøjet i overensstemmelse med servicevilkårene for de tjenester, du interagerer med (Greenhouse, Lever, jobindex.dk, LinkedIn osv.). Brug det ikke til at spamme arbejdsgivere.
4. **Ingen garanti.** Vurderinger er anbefalinger, ikke sandheder. AI-modeller kan hallucinere. Forfatterne er ikke ansvarlige for rekrutteringsresultater, afviste ansøgninger, kontobegrænsninger eller andre konsekvenser.

Detaljer: [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md). Softwaren leveres under [MIT-licensen](LICENSE) "som den er", uden nogen form for garanti.

## Licens

Koden er licenseret under [MIT](LICENSE).
