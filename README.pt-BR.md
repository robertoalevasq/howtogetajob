<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/wordmark-dark.svg"><img src="docs/wordmark-light.svg" alt="career-ops" width="250" height="56"></picture></p>

<div align="center">

[English](README.md) | [Español](README.es.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Português (Brasil)](README.pt-BR.md) | [한국어](README.ko-KR.md) | [日本語](README.ja.md) | [简体中文](README.cn.md) | [繁體中文](README.zh-TW.md) | [Українська](README.ua.md) | [Русский](README.ru.md) | [Polski](README.pl.md) | [Dansk](README.da.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md)

</div>

<p align="center">
  <em>Automação de busca de emprego com IA — avalie vagas, gere CVs sob medida e acompanhe seu pipeline do início ao fim.</em><br>
  Este é um fork pessoal do projeto open source <a href="https://github.com/santifer/career-ops">career-ops</a>, criado originalmente por Santiago Fernández de Valderrama.
</p>

---

<p align="center">
  <img src="docs/demo.gif" alt="career-ops Demo" width="800">
</p>

<p align="center">
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/Built_with-Claude_Code-000?style=for-the-badge&logo=anthropic&logoColor=white" alt="Built with Claude Code"></a>
</p>

<p align="center">
  <sub>Também funciona em qualquer CLI compatível com o padrão agent-skill</sub><br>
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

## O que é isso

career-ops transforma qualquer CLI de código com IA em uma central completa de busca de emprego. Em vez de acompanhar candidaturas manualmente em planilha, você tem um pipeline com IA que:

- **Avalia vagas** com uma avaliação estruturada A-F (cinco dimensões que geram uma pontuação de 1.0-5.0)
- **Gera PDFs personalizados** -- CVs otimizados para ATS, ajustados por descrição de vaga
- **Escaneia portais** automaticamente (Greenhouse, Ashby, Lever, páginas de empresas)
- **Processa em lote** -- avalia 10+ vagas em paralelo com subagentes
- **Rastreia tudo** em uma única fonte de verdade com verificações de integridade

> **Importante: isso NÃO é uma ferramenta de disparo em massa.** career-ops é um filtro -- ajuda você a encontrar as poucas vagas que realmente valem seu tempo entre centenas. O sistema recomenda fortemente não se candidatar a nada com nota abaixo de 4.0/5. Seu tempo é valioso, e o do recrutador também. Sempre revise antes de enviar.

career-ops é agentic: Claude Code navega páginas de carreira com Playwright, avalia aderência comparando seu CV com a descrição da vaga (não por simples correspondência de palavras-chave) e adapta seu currículo para cada vaga.

> **Aviso: as primeiras avaliações não vão ser ótimas.** O sistema ainda não conhece você. Dê contexto -- seu CV, sua trajetória profissional, suas provas de resultado, suas preferências, no que você é bom e o que quer evitar. Quanto mais você alimenta, melhor ele fica. Pense nisso como o onboarding de um novo recrutador: na primeira semana ele precisa te conhecer, depois se torna indispensável.

## Funcionalidades

| Funcionalidade                       | Descrição                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auto-Pipeline**                    | Cole uma URL e receba avaliação completa + PDF + entrada no tracker                                                                            |
| **Avaliação em 6 blocos**            | Resumo da vaga, aderência ao CV, estratégia de senioridade, pesquisa de compensação, personalização, preparação para entrevista (STAR+R) -- além de uma verificação de legitimidade da vaga (Bloco G) que sinaliza golpes e vagas-fantasma       |
| **Banco de histórias de entrevista** | Acumula histórias STAR+Reflection ao longo das avaliações -- 5-10 histórias principais que respondem qualquer pergunta comportamental          |
| **Scripts de negociação**            | Frameworks para negociação salarial, resposta a desconto geográfico e alavanca com ofertas concorrentes                                        |
| **Geração de PDF ATS**               | CVs com injeção de palavras-chave usando design com Space Grotesk + DM Sans                                                                    |
| **Scanner de portais**               | 45+ empresas pré-configuradas (Anthropic, OpenAI, ElevenLabs, Retool, n8n...) + consultas customizadas em Ashby, Greenhouse, Lever e Wellfound |
| **Processamento em lote**            | Avaliação paralela com workers `claude -p`                                                                                                     |
| **Dashboard TUI**                    | Interface no terminal para navegar, filtrar e ordenar seu pipeline                                                                             |
| **Humano no loop**                   | A IA avalia e recomenda, você decide e age. O sistema nunca envia candidatura automaticamente -- a decisão final é sempre sua                  |
| **Integridade do pipeline**          | Merge automatizado, deduplicação, normalização de status e health checks                                                                       |

## Início rápido

**Forma mais rápida — um único comando:**

```bash
npx @santifer/career-ops init
```

> 💡 `npx` já vem com o [Node.js](https://nodejs.org) — ele roda o instalador uma vez,
> sem instalar nada globalmente. Ainda não tem Node? Instale-o primeiro.
> (Já usa uma CLI Claude Code / Gemini / Codex? Então você já tem.)

Isso clona o último release em `./career-ops` e instala as dependências. Depois:

```bash
cd career-ops
claude   # ou gemini / codex / qwen / opencode — abra sua CLI de IA aqui
```

**No primeiro uso, o career-ops conduz você pela configuração — seu CV, perfil e vagas-alvo — apenas conversando. Nada para editar à mão.**

<details>
<summary><b>Prefere configurar manualmente? (git clone)</b></summary>

```bash
git clone <repo-url>
cd career-ops && npm install
npx playwright install chromium   # necessário apenas para geração de PDF
claude
```

</details>

> **O sistema foi projetado para ser customizado pelo próprio Claude.** Modos, arquétipos, pesos de pontuação, scripts de negociação -- é só pedir para ele alterar. Ele lê os mesmos arquivos que usa, então sabe exatamente o que editar.

Veja [docs/SETUP.md](docs/SETUP.md) para o guia completo de configuração.

## Uso

career-ops é um único comando slash com múltiplos modos:

```
/career-ops                → Mostrar todos os comandos disponíveis
/career-ops {cole um JD}   → Auto-pipeline completo (avaliar + PDF + tracker)
/career-ops scan           → Escanear portais por novas vagas
/career-ops pdf            → Gerar CV otimizado para ATS
/career-ops batch          → Avaliar múltiplas vagas em lote
/career-ops tracker        → Ver status das candidaturas
/career-ops apply          → Preencher formulários de candidatura com IA
/career-ops pipeline       → Processar URLs pendentes
/career-ops contacto       → Mensagem de outreach no LinkedIn
/career-ops deep           → Pesquisa aprofundada da empresa
/career-ops training       → Avaliar um curso/certificação
/career-ops project        → Avaliar um projeto de portfólio
```

Ou apenas cole uma URL ou descrição de vaga diretamente -- career-ops detecta automaticamente e roda o pipeline completo.

## Como funciona

```
Você cola a URL ou descrição da vaga
        │
        ▼
┌──────────────────┐
│  Detecção de     │  Classifica: LLMOps / Agentic / PM / SA / FDE / Transformation
│  Arquétipo       │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Avaliação A-F   │  Aderência, gaps, pesquisa de compensação, histórias STAR
│  (lê cv.md)      │
└────────┬─────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
 Report  PDF  Tracker
  .md   .pdf   .tsv
```

## Portais pré-configurados

O scanner já vem com **45+ empresas** prontas para escanear e **19 consultas de busca** nos principais job boards. Copie `templates/portals.example.yml` para `portals.yml` e adicione as suas:

**AI Labs:** Anthropic, OpenAI, Mistral, Cohere, LangChain, Pinecone
**Voice AI:** ElevenLabs, PolyAI, Parloa, Hume AI, Deepgram, Vapi, Bland AI
**AI Platforms:** Retool, Airtable, Vercel, Temporal, Glean, Arize AI
**Contact Center:** Ada, LivePerson, Sierra, Decagon, Talkdesk, Genesys
**Enterprise:** Salesforce, Twilio, Gong, Dialpad
**LLMOps:** Langfuse, Weights & Biases, Lindy, Cognigy, Speechmatics
**Automation:** n8n, Zapier, Make.com
**European:** Factorial, Attio, Tinybird, Clarity AI, Travelperk

**Job boards pesquisados:** Ashby, Greenhouse, Lever, Wellfound, Workable, RemoteFront

## Dashboard TUI

O dashboard de terminal integrado permite navegar visualmente pelo seu pipeline:

```bash
npm run serve:dashboard   # launch the TUI
npm run build:dashboard   # optional: build the standalone binary
```

Recursos: 6 abas de filtro, 4 modos de ordenação, visualização agrupada/plana, prévias com carregamento sob demanda e alterações de status inline.

## Estrutura do projeto

```
career-ops/
├── CLAUDE.md                    # Instruções para o agente
├── cv.md                        # Seu CV (crie este arquivo)
├── article-digest.md            # Seus proof points (opcional)
├── config/
│   └── profile.example.yml      # Template para seu perfil
├── modes/                       # 14 modos de skill
│   ├── _shared.md               # Contexto compartilhado (personalize)
│   ├── oferta.md                # Avaliação individual
│   ├── pdf.md                   # Geração de PDF
│   ├── scan.md                  # Scanner de portais
│   ├── batch.md                 # Processamento em lote
│   └── ...
├── templates/
│   ├── cv-template.html         # Template de CV otimizado para ATS
│   ├── portals.example.yml      # Template de configuração do scanner
│   └── states.yml               # Status canônicos
├── batch/
│   ├── batch-prompt.md          # Prompt autocontido para workers
│   └── batch-runner.sh          # Script orquestrador
├── dashboard/                   # Visualizador de pipeline em Go TUI
├── data/                        # Seus dados de rastreamento (gitignored)
├── reports/                     # Relatórios de avaliação (gitignored)
├── output/                      # PDFs gerados (gitignored)
├── fonts/                       # Space Grotesk + DM Sans
├── docs/                        # Setup, customização, arquitetura
└── examples/                    # CV de exemplo, relatório e proof points
```

## Stack de tecnologia

![Claude Code](https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)
![Go](https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white)
![Bubble Tea](https://img.shields.io/badge/Bubble_Tea-FF75B5?style=flat&logo=go&logoColor=white)

- **Agente**: Claude Code com skills e modos customizados
- **PDF**: Playwright/Puppeteer + template HTML
- **Scanner**: Playwright + Greenhouse API + WebSearch
- **Dashboard**: Go + Bubble Tea + Lipgloss (tema Catppuccin Mocha)
- **Dados**: Tabelas em Markdown + configuração YAML + arquivos TSV de lote

## FAQ

**O que é o career-ops?**
O career-ops é um centro de comando para busca de emprego de código aberto e independente de CLI. Ele transforma qualquer CLI de programação com IA em um pipeline que avalia vagas de emprego com base no seu currículo, gera PDFs otimizados para ATS, encontra o contato ideal e rastreia tudo em um só lugar — enquanto você mantém a decisão final.

**Posso rodar o career-ops de graça ou em um modelo local / mais barato?**
Sim. O career-ops é independente de CLI e roda em modelos gratuitos e locais — via modelos gratuitos do OpenRouter, Ollama ou qualquer endpoint compatível com OpenAI — para que você não fique preso a uma assinatura paga. Veja o arquivo [docs/RUNNING_ON_A_BUDGET.md](docs/RUNNING_ON_A_BUDGET.md) para a configuração completa.

**Com quais CLIs de IA o career-ops funciona?**
O career-ops roda em qualquer uma das principais CLIs de programação com IA — Claude Code, Codex, Gemini / Antigravity, OpenCode, Grok, Qwen e mais — por meio do padrão aberto Agent Skill Standard, evitando que você fique preso a um único fornecedor. Use a CLI que você já tem.

**Como faço para instalar o career-ops no Windows?**
O career-ops roda no Windows. Se o carregamento de habilidades falhar com um erro de symlink durante a instalação, a correção está em [docs/FAQ.md](docs/FAQ.md). O passo a passo completo está em [docs/SETUP.md](docs/SETUP.md).

**O career-ops se candidata automaticamente às vagas por mim?**
Não. O career-ops é um filtro, não um disparador automático de candidaturas em massa. A IA avalia, ranqueia e cria rascunhos; você revisa e decide. Ele nunca envia, encaminha ou clica em nada — a palavra final é sempre sua. Esse design com o humano no controle (human-in-the-loop) é o objetivo central do projeto.

**O career-ops é gratuito e de código aberto?**
Sim. O career-ops é gratuito e de código aberto, e sempre será para o candidato.

## Aviso legal

**career-ops é uma ferramenta local e open source — NÃO é um serviço hospedado.** Ao usar este software, você reconhece que:

1. **Você controla seus dados.** Seu CV, informações de contato e dados pessoais ficam na sua máquina e são enviados diretamente para o provedor de IA que você escolher (Anthropic, OpenAI etc.). Nós não coletamos, armazenamos nem temos acesso aos seus dados.
2. **Você controla a IA.** Os prompts padrão instruem a IA a não enviar candidaturas automaticamente, mas modelos de IA podem se comportar de forma imprevisível. Se você modificar os prompts ou usar modelos diferentes, faz isso por sua conta e risco. **Sempre revise o conteúdo gerado por IA antes de enviar.**
3. **Você cumpre os ToS de terceiros.** Você deve usar esta ferramenta em conformidade com os Termos de Serviço dos portais de carreira com os quais interage (Greenhouse, Lever, Workday, LinkedIn etc.). Não use esta ferramenta para spam de empregadores nem para sobrecarregar sistemas ATS.
4. **Sem garantias.** As avaliações são recomendações, não verdades absolutas. Modelos de IA podem alucinar habilidades ou experiências. Os autores não se responsabilizam por resultados profissionais, candidaturas rejeitadas, restrições de conta ou qualquer outra consequência.

Veja [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md) para o aviso completo. Este software é fornecido sob a [Licença MIT](LICENSE) "como está", sem garantia de qualquer tipo.

## Licença

MIT
