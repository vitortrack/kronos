# Núcleo rápido e eficiente — pesquisa Anthropic e medições

Linha de estudo contínua: o que faz o agente resolver mais rápido e com mais acerto, com base nos textos públicos de engenharia da Anthropic, e o que foi medido no Alien.

**Régua usada:** Card-997 reduzido (critérios 6 e 7, lista de dispositivos), `trackai-runs/card-997-2.txt` e `criterios997-2.py`.
- O critério 7 agora é funcional: executa a consulta escrita pelo agente no banco local, só leitura, para a operadora 1 e para uma sem trackers, e compara os dispositivos com os da consulta do gabarito. Antes, por regex, reprovava soluções certas: decorator antes do `@Get()` e filtro com `::text`, `NOT EXISTS`, `IN` ou dentro do `LATERAL`. Base 0/2, gabarito 2/2.
- Todas as notas abaixo já usam a régua corrigida.
- Sempre conferir o diff antes de concluir que uma rodada falhou.

**Limite das medições:** GLM e MiniMax na nuvem variam entre rodadas, e o GLM ignora temperature e seed. São 1 a 3 rodadas por configuração, então os números indicam direção, não certeza.

## Fontes (públicas)

- Writing tools for agents — anthropic.com/engineering/writing-tools-for-agents
- Effective context engineering for AI agents — anthropic.com/engineering/effective-context-engineering-for-ai-agents
- How we built our multi-agent research system — anthropic.com/engineering/multi-agent-research-system
- Effective harnesses for long-running agents — anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Code execution with MCP — anthropic.com/engineering/code-execution-with-mcp
- Prompting best practices (seção agêntica) — platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- Agent SDK: como o laço funciona — code.claude.com/docs/en/agent-sdk/agent-loop
- Dynamic workflows — claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code

O Claude Agent SDK é "todos os direitos reservados". Por isso o prompt e as descrições de ferramentas do Claude Code não entram no Alien; só os comportamentos medidos e os trechos de prompt que a Anthropic publica para reuso.

## Medições no motor Alien (GLM, 80 passos)

| Configuração | Notas | Tempo | Observação |
|---|---|---|---|
| Motor antigo (índice semântico) | 0/2 | 591 s | 339 s esperando a 1ª busca semântica indexar o repositório |
| Sem índice, prompt antigo (f8f0054) | 0/2, 1/2 | 134–156 s | uma rodada só leu, nunca editou |
| Prompt enxuto (37628ce) | 2/2, 2/2, 2/2 | 181–198 s | duas edições recusadas por engano numa rodada |
| Enxuto + guarda de decorators (c70bf6b) | 2/2, 2/2, 2/2 | 117–147 s | sem recusas |
| Motor Agent SDK (GLM) | 2/2 | 249 s | 51 chamadas ao modelo, 36 ferramentas, parou sozinho |

## (a) ADOTADO — implementado e medido

1. **Busca na hora em vez de índice pré-montado** (context engineering: "just-in-time retrieval", glob/grep/head/tail). `semantic_search` virou opcional. Tirou 339 s de uma rodada de 591 s.
2. **Prompt enxuto com os trechos publicados** (prompting best practices: `default_to_action`, `use_parallel_tool_calls`, `investigate_before_answering`, evitar excesso de engenharia). Saíram as regras que empurravam a explorar mais. Notas foram de 0/2 e 1/2 para 2/2 ×3.
3. **Guarda de sintaxe aceita decorators legados.** Era bug do harness: toda edição de controller NestJS com decorator de parâmetro era recusada. As recusas foram de 2 para 0 e o tempo de 181–198 s para 117–147 s.
4. **Motor Agent SDK como padrão**, com streaming parcial e saída estruturada no motor de decisão. Saída estruturada: ganho não medido.

## (b) MANTER — o Alien já tem e a evidência sustenta

- **Ferramentas de leitura em paralelo.** O artigo de pesquisa multiagente diz que paralelizar cortou até 90% do tempo.
- **Limpar saídas antigas de ferramentas.** Context engineering: "uma das formas mais seguras e leves" de compactação.
- **Descarregar saídas grandes em arquivo.** Acima de 20 mil caracteres, que é mais agressivo que o teto de 25 mil tokens do Claude Code.
- **Subagentes devolvendo resumo.** Context engineering: resumo de 1 a 2 mil tokens.
- **Portão com checagens determinísticas no orquestrador.**

## (c) PRÓXIMOS — evidência pública, ainda não testado no Alien

1. **Parar quando o pedido estiver cumprido.** Hoje o motor Alien usa os 80 passos mesmo depois de acertar, seguindo a skill `verify`. O harness de tarefas longas da Anthropic usa uma lista de critérios em JSON marcados como `passes` só após verificação, o que impede o "pronto" antecipado e também dá um ponto de parada. Teste: rodar com `--gate` (checagens de pronto) e medir passos até parar.
2. **Escala de esforço no prompt.** O artigo multiagente embute regras como "fato simples: 1 agente, 3–10 chamadas" e "comparações: 2–4 subagentes, 10–15 chamadas cada". Para o Alien seria algo como "mudança em 1–3 arquivos: dezenas de chamadas, não centenas". Teste: passos e nota no card.
3. **Orçamento de tokens.** No BrowseComp, o uso de tokens sozinho explicou 80% da variância de desempenho. Medir tokens por nota antes de cortar.
4. **Refinar descrições de ferramentas com um agente de teste.** A reescrita de uma descrição deu 40% menos tempo de tarefa. Teste: transcrições de rodadas → reescrever as descrições de `read_file`, `bash`, `edit_file` → medir.
5. **Código no lugar de chamadas encadeadas.** Code execution with MCP mediu de 150 mil para 2 mil tokens (98,7%) num fluxo de dados. O Alien já tem `run_code` chamando ferramentas por IPC (dfcaf48), sem medição. Teste: tarefa com muita leitura de dados (relatório, banco).
6. **Compactação guardando os 5 arquivos acessados por último** (context engineering). Conferir o que a compactação do Alien guarda.
7. **Rotina de início para tarefas longas** (`pwd`, `git log`, arquivo de progresso, `init.sh`). Só faz sentido em cards grandes, em várias sessões.

## (d) DESCARTAR / CUIDADO

- **Workflows dinâmicos como padrão:** o próprio blog diz que gastam bem mais tokens e não servem para tarefa de rotina.
- **Regras "verifique como um cético" ou "prove cada camada com grep":** empurraram o GLM a explorar sem editar (rodada sem edições, f8f0054).
- **Régua só por regex:** dá falso negativo; conferir o diff.

## Modelos de núcleo

Motor Alien atual (c70bf6b), mesmo card, limite de 80 passos:

| Modelo | Notas | Tempo | Passos | Ferramentas | Tokens de entrada / saída |
|---|---|---|---|---|---|
| glm-5.3-flash:cloud | 2/2, 2/2, 2/2 | 117–147 s | 80 (limite) | 89–100 | 1,5–1,8 M / 9–13 mil |
| minimax-m3.1-flash:cloud | 2/2, 0/2 | 1204 s, 719 s | 80 (limite) | 139–143 | 2,4–2,7 M / 116–172 mil |
| gpt-oss:120b-cloud | 1/2, 2/2 | 259 s, 187 s | 55, 60 (parou sozinho) | 52–57 | 0,7–0,9 M / 11 mil |

Leitura:
- **GLM:** o melhor equilíbrio hoje. Acertou todas e é o mais rápido, mas não para sozinho.
- **MiniMax:** o mais caro e lento nesse laço, com 5 a 10× mais tokens de saída (raciocínio longo). Uma rodada nunca editou. No motor SDK ele foi bem no Card-997 completo, então o laço importa.
- **gpt-oss:** o mais econômico (metade dos tokens) e o único que para sozinho. Mas numa rodada apagou o `FROM devices d` da consulta (o SQL quebra ao rodar, e o type-check não pega porque o SQL é texto) e adicionou `typescript` no `package.json` da raiz sem pedido.

Motor SDK, mesmo card (13/11, segunda bateria, 6 rodadas simultâneas):
- **GLM:** 2/2, mas bateu o limite de 80 turnos; o SDK também não parou sozinho desta vez.
- **gpt-oss:** 1/2 (consulta sem filtro de operadora) e 0/2 (faltou o `@CurrentOperator`). No SDK ele foi pior que no motor Alien.

**Atenção:** os tempos dessa bateria (735–986 s) não são comparáveis com os anteriores. Rodar 6 ao mesmo tempo no Ollama na nuvem deixou tudo 4 a 7× mais lento, inclusive o SDK com GLM (249 s → 976 s). Medir tempo com no máximo 3 rodadas simultâneas, e sempre com a mesma carga.

## Item 1 — parar quando pronto (`--gate`)

Motor Alien, GLM, `--gate`, 3 rodadas: 2/2, 2/2, 2/2, com todas as checagens verdes, mas as 3 continuaram até os 80 passos. O `--gate` impede terminar antes da hora, mas não dá ponto de parada: o agente segue verificando depois que tudo passa. Também gerou 7 a 10× mais tokens de saída (85–116 mil contra 9–13 mil). Conclusão: não adotar o `--gate` como forma de parar. O próximo passo seria avisar uma vez, quando todas as checagens passarem, que pode concluir. Mas avisos no meio do trabalho já pioraram o Alien antes (EPFL), então esse aviso precisa de medição própria.

Bug achado nessa bateria: quando o SDK batia o limite de turnos, o motor perdia a resposta e os tokens, e mostrava o erro cru do SDK. Corrigido em `src/sdk-engine.ts` (a175a54).

## Repositórios da Anthropic — o que o Alien não precisa codar (13/11)

Levantamento dos repositórios públicos da organização `anthropics` ligados a agentes.

| Repositório | Licença | O que traz | Relação com o Alien |
|---|---|---|---|
| `single-agent-loop-kit` (`reference_loop/loop.py`, ~280 linhas) | Apache-2.0 | Laço de referência: lote de ferramentas, leituras em paralelo e escritas em seguida na ordem pedida, skills sob demanda, busca de ferramentas, orçamento de turnos e tokens (contando subagentes), teto de chamadas por lote, trava de escrita obrigatória, verificador com uma chance de correção. Também scripts de eval (`compare.py`, `estimate.py`). | O Alien já tem quase tudo. Diferenças: (1) com qualquer escrita no lote, o Alien roda tudo em série, e a referência roda as leituras em paralelo antes; (2) não há teto de chamadas por lote; (3) o verificador da referência para depois de 2 rejeições. Pode copiar com atribuição. |
| `cwc-long-running-agents` | Apache-2.0 | Primitivas para tarefas longas como hooks: contrato que começa em FALHA e só vira "passa" com evidência lida, avaliador em contexto limpo e sem ferramentas de escrita, handoff com `PROGRESS.md` e commit no Stop. Aponta para o `/goal`. | O orquestrador do Alien (contrato, portão e revisão) é a mesma ideia. No motor SDK, tudo isso pode ser hooks e um subagente, sem código nosso no laço. |
| `/goal` (Claude Code, disponível pelo SDK e por `-p`) | — | Após cada turno, um modelo rápido julga a condição: "ainda não" (continua), "cumprida" ou "impossível". | Impede parar ANTES da hora, não ajuda a parar depois de pronto. Não resolve o excesso de verificação que medimos. |
| `sandbox-runtime` (`@anthropic-ai/sandbox-runtime` 0.0.83) | Apache-2.0 | Isolamento de processo no nível do sistema (bubblewrap no Linux): leitura e escrita de arquivos, rede por domínio. | Substitui as listas de regex do Alien (`readsSecrets`, `isDangerous`), que dá para contornar. bwrap e socat já estão instalados aqui. |
| Opção `sandbox` do Agent SDK | — | O mesmo isolamento dentro do motor SDK: `filesystem.denyRead`, `credentials.files` (bloquear ou mascarar), domínios de rede. | No motor SDK, a proteção de `.env` passa a ser do sistema operacional, não do nosso hook por regex. |
| `skills` e o plugin `skill-creator` | — | Formato e skills oficiais; criação e auditoria de skills. | A revisão automática de skills do Alien (`skill-review`) já ensinou erros uma vez. No motor SDK, as skills vêm prontas; a criação pode ficar com o `skill-creator`. |
| `claude-quickstarts/autonomous-coding`, `agent-sdk-workshop` | — | Exemplos de agente de código autônomo no SDK. | Referência para o motor SDK. |

Propostas, em ordem de ganho e menor risco:

1. **Motor SDK:** ligar a opção `sandbox`, bloqueando a leitura de `**/.env*` e mascarando credenciais. Proteção de verdade no lugar do regex. Medir se nada legítimo quebra (npm, docker, psql).
2. **Motor Alien:** leituras em paralelo mesmo com escritas no lote, mais teto por lote, como na referência. Mudança pequena em `agent.ts` (`execute`).
3. **Motor Alien:** rodar o `bash` dentro do `sandbox-runtime` no lugar das listas de regex. É mais trabalho: a rede precisa ficar liberada para npm e docker.
4. **Não portar:** `/goal` (não resolve o nosso problema) e workflows dinâmicos (custo).

## Rodada de pesquisa 13/11 (tarde) — o que reescrever no motor Alien

Fontes novas: The components of agent memory (anthropic.com/research/components-of-agent-memory, 06/11/2026), Harness design for long-running apps (anthropic.com/engineering/harness-design-long-running-apps), Scaling Managed Agents (anthropic.com/engineering/managed-agents), postmortem de 23/04/2026 (anthropic.com/engineering/april-23-postmortem; li só a cobertura de terceiros).

Nenhuma proposta abaixo foi medida. Cada uma é uma rodada isolada no card-997-2, com no máximo 3 rodadas simultâneas.

1. **Poda de saída precisa ser reversível** (Managed Agents: trimming é irreversível se o original não ficar guardado). Hoje `ollama.ts` corta a saída antiga e diz "run the tool again". Reescrever: gravar o original em `.alien/outputs/<sessão>/` (o `offload` já existe) e trocar o texto por "conteúdo completo em <caminho>". Assim o modelo usa `read_file` em vez de rodar o bash de novo. Mudança pequena.
2. **Teto de verbosidade no prompt.** "Between tool calls, write at most one short sentence". O postmortem atribui ~3% de queda em evals de código a um prompt que limitava o tamanho da resposta. Teste: remover só essa linha.
3. **Raciocínio de volta no histórico, isolado.** O postmortem: apagar o raciocínio antigo a cada turno degradou a qualidade. O 4816225 reenviava o raciocínio, mas foi revertido (78a1249) junto com lembretes e regras do Hermes, então o efeito nunca foi isolado. Teste: só o campo `thinking` no histórico do Ollama.
4. **Cadeia de fim de tarefa: um componente por vez** (Harness design: tirar um componente por vez; o que não carrega peso sai). Hoje o fim encadeia verify-nudge, requirements-nudge, revisor e checagem de escopo, e cada um devolve o turno ao modelo. Isso é candidato a explicar por que o motor não para. Ablação: 4 variantes, cada uma sem um deles.
5. **Memória episódica não verificada** (Agent memory: nota errada se propaga para toda sessão; o "dreaming" confere contra a transcrição; a camada injetada é pequena e funciona como índice). Hoje `agent.ts` grava como episode o "Outcome" que o próprio modelo declara, sem verificação, e o prompt injeta até 60 facts. Já aconteceu com as skills, que ensinaram erros. Reescrever: gravar o episode só com o portão ou a verificação verdes, ou não gravar episodes. Não adotar a regra "registre só falhas", que o artigo mediu como prejudicial.
6. **Compaction:** o checkpoint diz "Do not explore the project again" e mantém 8 mensagens. Somar a lista dos últimos arquivos lidos (context engineering, item (c)6) e o caminho dos originais da proposta 1.

Mantém, sem mudança: o laço ReAct (texto → ferramentas → observação) e o `validateInput`, que já converte os tipos e devolve um erro legível. O "think tool" de 2025 não entra: os modelos usados já têm raciocínio nativo.

## Estudo 13/11 (noite) — 11 artigos da Anthropic + 6 repositórios

Fontes novas: Building effective agents, Building a C compiler, Demystifying evals for AI agents, Equipping agents with Agent Skills; código de OpenHands (software-agent-sdk), deepagents, browser-use, ADK; READMEs de LangGraph e crewAI. Os outros 7 artigos já estavam nas rodadas anteriores.

Critério (pedido do Vitor): primeiro o que o Alien já tem; entre o resto, o que as grandes empresas já usam em produção.

### O Alien já tem (não reescrever)

| Técnica | Quem usa | No Alien |
|---|---|---|
| Detector de laço: mesma chamada 3× | OpenHands StuckDetector (limite 3–4), browser-use | Loop guard em `agent.ts` (MAX_IDENTICAL_CALLS = 3), com mensagens diferentes para leitura e escrita |
| Avaliador separado que devolve "precisa revisar" | deepagents RubricMiddleware, crewAI manager, Anthropic evaluator-optimizer | Revisor + conferência PASS/FAIL de requisitos + portão |
| Resultado de chamada órfã após interrupção | deepagents PatchToolCalls | `call()` devolve "Interrupted" e todos os resultados entram no histórico |
| Saída grande em arquivo, pouco texto ao modelo | Anthropic (compilador C: "imprimir poucas linhas, log com ERROR na mesma linha"), deepagents | offload >1500 caracteres, poda reversível |
| Resumo ao encher o contexto, guardando o recente | deepagents (85% → mantém 10%), OpenHands condenser | compactação com pedido fixo e 5 últimos arquivos lidos |
| Argumentos antigos encolhidos | deepagents truncate_args | poda de argumentos em blocos |
| Skills por divulgação progressiva | Anthropic Agent Skills | `skills.ts`: só nome e descrição no prompt; corpo e arquivos sob demanda |
| Retomar de onde parou | LangGraph durable execution | sessões salvas e retomadas, handoff |
| Confirmação humana antes de executar | LangGraph interrupts, ADK tool confirmation, deepagents HITL | `permit()` com confirmação e "sempre" por escopo |
| Erro de ferramenta que diz o que fazer | ADK reflect-and-retry, Anthropic poka-yoke | `validateInput` legível; edit recusado devolve o conteúdo atual |
| Arquivo de progresso entre sessões | Anthropic (compilador C, long-running) | handoff com "Tentado e não funcionou" |

### Implementado agora (SEM commit, medição em andamento)

1. **Bash só de leitura em paralelo e já durante o streaming.** No Claude Code o Bash é "seguro para concorrência" quando o comando é só leitura; o kit de referência da Anthropic faz o mesmo. Nas rodadas pd1–pd3, 40–60% dos `bash` eram leitura (grep, sed -n, cat), rodando em série. Mudança de uma linha em `isRead`, reaproveitando `isReadOnlyCommand`. Medição: rb1–rb3.
2. **Lembrete para rodar o teste criado.** Harness de longa duração da Anthropic ("só marca pronto com verificação"), SWE-agent/OpenHands ("rode o teste que você escreveu"). Nas transcrições, pd1 nunca rodou o spec que criou (só `tsc`), e "specs novos passam" falhou em 4 de 7 rodadas. Reaproveita o lembrete de verificação: se um `*.spec.*`/`*.test.*` editado não aparece num comando depois da última edição, um lembrete com o nome do arquivo (uma vez). Medição: rodadas seguintes.
3. **Placar das rodadas** (`trackai-runs/placar.py`): média, pass@1 e pass^k por versão, como no artigo de evals da Anthropic (várias tentativas; pass^k quando consistência importa).

### Não adotar

- Detector de monólogo e de padrão alternado (OpenHands): nas transcrições há 3–18 erros por rodada e o loop guard já cobre a repetição. Nenhuma falha real pede isso.
- Workflows em grafo (LangGraph, ADK Workflow, crewAI Flows): o artigo da Anthropic manda começar simples; o Alien já tem orquestrador por contrato para tarefa grande.
- Papéis com backstory (crewAI): o prompt enxuto mediu melhor que regras extras.
- Agentes paralelos com trava por arquivo (compilador C): serve para milhares de testes independentes, não para um card.

### Cookbooks da Anthropic e Agent SDK (13/11 noite)

- **Evaluator-optimizer:** gera → avalia (PASS / NEEDS_IMPROVEMENT / FAIL + feedback) → gera de novo com "Previous attempts" + feedback, até PASS. O Alien já tem: portão (checagens que falham voltam ao agente) e revisor. Diferença: o cookbook não limita as voltas; o Alien limita (MAX_REVIEWS, 3 tentativas por fatia), que é o mais seguro.
- **Orchestrator-workers:** orquestrador quebra em tarefas (XML), workers recebem tarefa + contexto original. É o `--orchestrate` do Alien (contrato em fatias).
- **Async multi-agent (padrão do system card do Opus 4.8):** mensagens entre agentes chegam anexadas ao resultado da próxima ferramenta ("the key line"); subagentes assíncronos com create/status/kill. O Alien já faz o primeiro com a fila de mensagens durante a tarefa (cbf94f1). Subagente assíncrono: o `delegate` do Alien espera o resultado; só ajudaria com várias explorações independentes, o que o Card-997 não pede.
- **RAG e contextual retrieval:** menos 49–67% de falha de recuperação, mas exige índice. O Alien mediu que o índice custava 339 s numa rodada de 591 s e trocou por grep/glob na hora, que é o que o Claude Code faz. Não voltar.
- **ReAct do LlamaIndex:** Thought/Action/Observation em texto. O Alien usa chamada de ferramenta nativa, que é o padrão atual da Anthropic e da OpenAI. Nada a trocar.
- **Agent SDK overview, termos:** "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." A extensão publicada (0.1.25) deixa escolher modelo Claude sem chave e cai no login do Claude Code. Para distribuir, exigir ANTHROPIC_API_KEY. Marca: "Claude Agent" ou "Alien Powered by Claude" são permitidos; "Claude Code" no produto não é.

### Fidelidade às docs (13/11 noite) — pedido do Vitor: implementação muito próxima das docs

| Padrão (doc) | Como a doc faz | Alien antes | Ação |
|---|---|---|---|
| Evaluator-optimizer (cookbook) | `<evaluation>PASS, NEEDS_IMPROVEMENT, or FAIL</evaluation>` + `<feedback>`; "You should be evaluating only and not attempting to solve the task"; só PASS encerra | revisor com APPROVED/CHANGES_REQUESTED e **desligado por padrão** (`alien.review=false`, driver também) | formato igual ao cookbook (prompts.ts critic, session.review: só PASS aprova); medir ligado (rv1–rv3) |
| Harness design (apps longos) | avaliador separado, porque o agente elogia o próprio trabalho | só a autoconferência de requisitos do próprio agente rodava | idem acima |
| Latency multi-agent (cookbook) | `[elapsed Ns]` anexado ao fim da última mensagem antes de cada chamada (não quebra o cache); frase TIME_MATTERS no fim do pedido: "Time matters here: do not spend time that can be avoided, and the earlier a correct result is obtained, the better." Testado no Fable 5.1; efeito varia em outros modelos | nada; o motor não sabe o tempo e não para sozinho | próximo experimento, copiado literal |
| Orchestrator-workers | XML com tarefas; worker recebe tarefa original + a sua | contrato JSON (saída estruturada) | manter: saída estruturada é a forma atual recomendada |
| Agent SDK | login do claude.ai proibido para terceiros sem aprovação | extensão 0.1.25 usa login sem chave | aguarda decisão do Vitor |
