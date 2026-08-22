<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/wordmark-dark.svg"><img src="docs/wordmark-light.svg" alt="career-ops" width="250" height="56"></picture></p>

<div align="center">

[English](README.md) | [Español](README.es.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Português (Brasil)](README.pt-BR.md) | [한국어](README.ko-KR.md) | [日本語](README.ja.md) | [简体中文](README.cn.md) | [繁體中文](README.zh-TW.md) | [Українська](README.ua.md) | [Русский](README.ru.md) | [Polski](README.pl.md) | [Dansk](README.da.md) | [தமிழ்](README.ta.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md)

</div>

<p align="center">
  <em>Automatización de búsqueda de empleo con IA — evalúa ofertas, genera CVs a medida y sigue tu pipeline de principio a fin.</em><br>
  Este es un fork personal del proyecto open source <a href="https://github.com/santifer/career-ops">career-ops</a>, creado originalmente por Santiago Fernández de Valderrama.
</p>

---

<p align="center">
  <img src="docs/demo.gif" alt="career-ops Demo" width="800">
</p>

<p align="center">
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/Built_with-Claude_Code-000?style=for-the-badge&logo=anthropic&logoColor=white" alt="Built with Claude Code"></a>
</p>

<p align="center">
  <sub>También funciona en cualquier CLI compatible con el estándar agent-skill</sub><br>
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

## Qué es esto

career-ops convierte cualquier CLI de IA en un centro de mando de búsqueda de empleo. En vez de trackear aplicaciones en un spreadsheet, tienes un pipeline AI que:

- **Evalúa ofertas** con una evaluación estructurada A-F (cinco dimensiones que alimentan una puntuación de 1.0-5.0)
- **Genera PDFs personalizados** -- CVs ATS-optimizados por oferta
- **Escanea portales** automaticamente (Greenhouse, Ashby, Lever, webs de empresas)
- **Procesa en batch** -- evalúa 10+ ofertas en paralelo con sub-agentes
- **Trackea todo** en una fuente de verdad única con checks de integridad

> **Importante: Esto NO es para spamear empresas.** career-ops es un filtro -- te ayuda a encontrar las pocas ofertas que merecen tu tiempo entre cientos. El sistema recomienda encarecidamente no aplicar a nada por debajo de 4.0/5. Tu tiempo es valioso, y el del recruiter también. Siempre revisa antes de enviar.

> **Aviso: las primeras evaluaciones no serán buenas.** El sistema no te conoce todavía. Dale contexto -- tu CV, tu historia profesional, tus proof points, tus preferencias, en qué eres bueno, qué quieres evitar. Cuanto más lo nutras, mejor filtra. Piensa en ello como hacer onboarding a un recruiter nuevo: la primera semana necesita conocerte, luego se vuelve invaluable.

## Features

| Feature                    | Descripción                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Auto-Pipeline**          | Pega una URL, obtiene evaluación + PDF + entrada en tracker                                                                    |
| **Evaluación A-F**         | Resumen del rol, match con CV, estrategia de nivel, research de comp, personalización, prep de entrevista (STAR+R) -- más una verificación de legitimidad de la oferta (Bloque G) que detecta estafas y ofertas fantasma |
| **Banco de historias**     | Acumula historias STAR+Reflexión entre evaluaciones -- 5-10 historias maestras que responden cualquier pregunta behavioral     |
| **Scripts de negociación** | Frameworks de negociación salarial, pushback de descuentos geográficos, leverage de ofertas competidoras                       |
| **PDFs ATS**               | CVs con keywords inyectados, diseño Space Grotesk + DM Sans                                                                    |
| **Scanner de portales**    | 45+ empresas pre-configuradas (Anthropic, OpenAI, ElevenLabs, Retool, n8n...) + queries en Ashby, Greenhouse, Lever, Wellfound |
| **Batch**                  | Evaluación en paralelo con workers `claude -p`                                                                                 |
| **Dashboard TUI**          | Terminal UI para navegar, filtrar y ordenar tu pipeline                                                                        |
| **Human-in-the-Loop**      | La IA evalúa y recomienda, tú decides y actuas. El sistema nunca envía una aplicación -- tú siempre tienes la última palabra   |
| **Integridad de pipeline** | Merge automático, dedup, normalización de estados, health checks                                                               |

## Inicio rápido

```bash
git clone <repo-url>
cd career-ops && npm install
npx playwright install chromium   # solo para generar PDFs
claude   # abre tu CLI de IA — te guiará en el primer arranque
```

**En el primer arranque, career-ops te guía en la configuración — tu CV, tu perfil y los roles que buscas — simplemente conversando. No hay nada qué editar a mano.**

> **El sistema está diseñado para que Claude lo personalice.** Modes, arquetipos, scoring, scripts de negociación -- solo pídelo. Claude lee los mismos archivos que usa, así que sabe exactamente qué editar.

Guía completa en [docs/SETUP.md](docs/SETUP.md).

## Uso

career-ops es un único slash command con multiples modos:

```
/career-ops                → Mostrar todos los comandos
/career-ops {pega un JD}   → Pipeline completo (evaluar + PDF + tracker)
/career-ops scan           → Escanear portales
/career-ops pdf            → Generar CV ATS-optimizado
/career-ops batch          → Evaluar ofertas en batch
/career-ops tracker        → Ver estado de aplicaciones
/career-ops apply          → Rellenar formularios con IA
/career-ops pipeline       → Procesar URLs pendientes
/career-ops contacto       → Mensaje LinkedIn outreach
/career-ops deep           → Research profundo de empresa
```

O simplemente pega una URL o descripción de oferta -- career-ops la detecta y ejecuta el pipeline completo.

## Cómo funciona

```
Pegas una URL o descripción de oferta
        │
        ▼
┌──────────────────┐
│  Detección de    │  Clasifica: LLMOps / Agentic / PM / SA / FDE / Transformation
│  Arquetipo       │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Evaluación A-F  │  Match, gaps, comp research, historias STAR
│  (lee cv.md)     │
└────────┬─────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
 Report  PDF  Tracker
  .md   .pdf   .tsv
```

## Portales incluidos

El scanner viene con **45+ empresas** pre-configuradas y **19 queries** en los principales portales de empleo. Copia `templates/portals.example.yml` a `portals.yml` y añade las tuyas:

**AI Labs:** Anthropic, OpenAI, Mistral, Cohere, LangChain, Pinecone
**Voice AI:** ElevenLabs, PolyAI, Parloa, Hume AI, Deepgram, Vapi, Bland AI
**Plataformas AI:** Retool, Airtable, Vercel, Temporal, Glean, Arize AI
**Contact Center:** Ada, LivePerson, Sierra, Decagon, Talkdesk, Genesys
**Enterprise:** Salesforce, Twilio, Gong, Dialpad
**LLMOps:** Langfuse, Weights & Biases, Lindy, Cognigy, Speechmatics
**Automatización:** n8n, Zapier, Make.com
**Europa:** Factorial, Attio, Tinybird, Clarity AI, Travelperk

**Portales de empleo:** Ashby, Greenhouse, Lever, Wellfound, Workable, RemoteFront

## Dashboard TUI

El dashboard integrado en terminal te permite navegar tu pipeline visualmente:

```bash
npm run serve:dashboard   # launch the TUI
npm run build:dashboard   # optional: build the standalone binary
```

Features: 6 pestañas de filtro, 4 modos de ordenación, vista agrupada/plana, previews lazy-loaded, cambios de estado inline.

## Estructura del proyecto

```
career-ops/
├── AGENTS.md                    # Instrucciones canónicas del agente (todos los CLIs)
├── CLAUDE.md                    # Wrapper Claude Code (importa AGENTS.md)
├── cv.md                        # Tu CV (crealo tu)
├── article-digest.md            # Tus proof points (opcional)
├── config/
│   └── profile.example.yml      # Template para tu perfil
├── modes/                       # 14 modos
│   ├── _shared.md               # Contexto compartido (personalizable)
│   ├── oferta.md                # Evaluación individual
│   ├── pdf.md                   # Generación de PDF
│   ├── scan.md                  # Scanner de portales
│   ├── batch.md                 # Procesamiento batch
│   └── ...
├── templates/
│   ├── cv-template.html         # Template de CV ATS-optimizado
│   ├── portals.example.yml      # Config del scanner
│   └── states.yml               # Estados canónicos
├── batch/
│   ├── batch-prompt.md          # Prompt autocontenido del worker
│   └── batch-runner.sh          # Script orquestador
├── dashboard/                   # Visor de pipeline en Go TUI
├── data/                        # Tus datos de tracking (gitignored)
├── reports/                     # Reports de evaluación (gitignored)
├── output/                      # PDFs generados (gitignored)
├── fonts/                       # Space Grotesk + DM Sans
├── docs/                        # Setup, personalización, arquitectura
└── examples/                    # CV de ejemplo, report, proof points
```

## Tech Stack

![Claude Code](https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)
![Go](https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white)
![Bubble Tea](https://img.shields.io/badge/Bubble_Tea-FF75B5?style=flat&logo=go&logoColor=white)

- **Agente**: Claude Code con skills y modos personalizados
- **PDF**: Playwright/Puppeteer + template HTML
- **Scanner**: Playwright + Greenhouse API + WebSearch
- **Dashboard**: Go + Bubble Tea + Lipgloss (tema Catppuccin Mocha)
- **Datos**: Tablas Markdown + config YAML + ficheros TSV batch

## Preguntas frecuentes (FAQ)

**¿Qué es career-ops?**
career-ops es un centro de mando de búsqueda de empleo, open source e independiente del CLI. Convierte cualquier CLI de IA en un pipeline que evalúa ofertas contra tu CV, genera PDFs optimizados para ATS, encuentra a la persona adecuada a la que escribir y lo registra todo en un solo sitio — y la decisión final siempre es tuya.

**¿Puedo usar career-ops gratis, o con un modelo más barato o local?**
Sí. career-ops es independiente del CLI y funciona con modelos gratuitos y locales — mediante modelos gratuitos de OpenRouter, Ollama o cualquier endpoint compatible con OpenAI — así no dependes de ninguna suscripción de pago. Consulta [docs/RUNNING_ON_A_BUDGET.md](docs/RUNNING_ON_A_BUDGET.md) para la configuración completa.

**¿Con qué CLIs de IA funciona career-ops?**
career-ops funciona con cualquier CLI de IA importante — Claude Code, Codex, Gemini / Antigravity, OpenCode, Grok, Qwen y más — a través del estándar abierto Agent Skill Standard, así que nunca queda atado a un solo proveedor. Usa el CLI que ya tengas.

**¿Cómo instalo career-ops en Windows?**
career-ops funciona en Windows. Si las skills no cargan por un error de symlink durante la instalación, la solución está en [docs/FAQ.md](docs/FAQ.md). Los pasos completos están en [docs/SETUP.md](docs/SETUP.md).

**¿career-ops aplica a las ofertas por mí automáticamente?**
No. career-ops es un filtro, no un aplicador masivo a ciegas. La IA evalúa, ordena y redacta; tú revisas y decides. Nunca envía, manda ni hace clic en nada — la última palabra siempre es tuya. Ese diseño con supervisión humana es justo el punto.

**¿career-ops es gratis y open source?**
Sí. career-ops es gratis y open source, y para el candidato siempre lo será.

## Documentación

- [SETUP.md](docs/SETUP.md) -- Guía de instalación
- [CUSTOMIZATION.md](docs/CUSTOMIZATION.md) -- Como personalizar
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) -- Cómo funciona el sistema

## Aviso legal

**career-ops es una herramienta local y open source — NO un servicio alojado.** Al usar este software, aceptas que:

1. **Tu controlas tus datos.** Tu CV, datos de contacto e información personal se quedan en tu máquina y se envian directamente al proveedor de IA que elijas (Anthropic, OpenAI, etc.). No recopilamos, almacenamos ni tenemos acceso a tus datos.
2. **Tu controlas la IA.** Los prompts por defecto instruyen a la IA a no enviar aplicaciones automaticamente, pero los modelos pueden comportarse de forma impredecible. Si modificas los prompts o usas otros modelos, lo haces bajo tu responsabilidad. **Revisa siempre el contenido generado antes de enviarlo.**
3. **Tu cumples con los terminos de terceros.** Debes usar esta herramienta de acuerdo con los Terminos de Servicio de los portales de empleo (Greenhouse, Lever, Workday, LinkedIn, etc.). No uses esta herramienta para spamear empresas.
4. **Sin garantias.** Las evaluaciones son recomendaciones, no verdad absoluta. Los modelos pueden inventar habilidades o experiencia. Los autores no son responsables de resultados laborales, candidaturas rechazadas, restricciones de cuenta ni ninguna otra consecuencia.

Ver [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md) para más detalles. Este software se proporciona bajo la [Licencia MIT](LICENSE) "tal cual", sin garantia de ningun tipo.

## Licencia

MIT