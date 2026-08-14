# AGENTS.md

## Projeto

Este repositório é a base para o Senior Fullstack Engineer Take-Home Challenge.
O objetivo é construir um agente de geração de código que receba uma especificação
em linguagem natural e produza uma aplicação React + TypeScript executável dentro
do boilerplate existente.

O agente deve ser reutilizável para pequenas variações de aplicações frontend,
mas a demonstração principal será o Car Inventory Manager.

## Stack existente

- React 19 + TypeScript
- Vite
- Apollo Client + GraphQL
- Material UI
- MSW para mock da API GraphQL
- Vitest + Testing Library
- Node.js/TypeScript para o CLI do agente
- OpenAI Agents SDK é uma opção recomendada para a orquestração do agente

## Estrutura atual

- `src/App.tsx`: shell inicial da aplicação; atualmente é um placeholder.
- `src/types.ts`: interface `Car`.
- `src/graphql/queries.ts`: queries `GET_CARS`, `GET_CAR` e mutation `ADD_CAR`.
- `src/graphql/client.ts`: Apollo Client configurado para `/graphql`.
- `src/mocks/`: dados seed e handlers MSW para GraphQL.
- `src/components/Example.tsx`: exemplo de uso de Apollo + MUI.
- `src/__tests__/`: testes de referência.
- `public/mockServiceWorker.js`: service worker do MSW.

## Requisitos do agente

O agente deve:

1. Aceitar uma especificação por arquivo ou argumento de CLI.
2. Inspecionar o boilerplate antes de gerar código.
3. Planejar a implementação em tarefas ordenadas e com dependências.
4. Gerar ou editar arquivos individualmente.
5. Usar ferramentas explícitas para leitura/escrita de arquivos e execução de comandos.
6. Copiar o boilerplate para o diretório de saída, sem gerar um projeto do zero.
7. Executar `npm run typecheck`, `npm test` e, quando apropriado, `npm run build`.
8. Ler a saída de erros e tentar corrigir falhas automaticamente pelo menos uma vez.
9. Produzir um diretório final que possa ser executado com `npm install` e `npm run dev`.

## Aplicação de demonstração

O sample spec deve gerar um Car Inventory Manager que:

- busca carros via Apollo Client usando `GET_CARS`;
- usa os handlers GraphQL simulados pelo MSW;
- permite pesquisar por modelo;
- permite ordenar por ano e fabricante;
- possui testes para os comportamentos principais.

Funcionalidades recomendadas para a demonstração:

- hook `useCars()` para encapsular a lógica GraphQL;
- cards MUI para os carros;
- imagens responsivas usando `mobile`, `tablet` e `desktop`;
- formulário `Add Car` usando `ADD_CAR`;
- filtro por ano ou hook `useCarFilters()`.

## Instruções persistentes para alterações

- Preserve a stack e a configuração existentes, salvo quando uma alteração for necessária.
- Não crie backend real, banco de dados, Docker, autenticação, deploy ou CI/CD.
- Não coloque os requisitos específicos de carros nas instruções genéricas do agente.
- Mantenha a especificação da aplicação separada das instruções operacionais do agente.
- Prefira componentes pequenos, hooks testáveis e tipos explícitos.
- Use o alias `@/` configurado pelo Vite para imports dentro de `src`.
- Não remova os mocks GraphQL existentes sem substituí-los por comportamento equivalente.
- Não considere o trabalho concluído sem executar as validações relevantes.

## Organização esperada do agente

Uma implementação simples e aceitável pode conter:

```text
agent/
├── src/
│   ├── cli.ts
│   ├── planner.ts
│   ├── generator.ts
│   ├── validator.ts
│   └── tools/
├── prompts/
│   ├── agent-instructions.md
│   ├── planner-instructions.md
│   ├── generator-instructions.md
│   └── repair-instructions.md
├── specs/
│   └── sample-spec.txt
└── generated-app/
```

O `AGENTS.md` descreve o repositório e as regras de trabalho. Os arquivos em
`prompts/` orientam o agente em tempo de execução. O `sample-spec.txt` descreve
o produto que deve ser gerado e pode ser substituído por outra especificação.

## Comandos de validação

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Estado inicial conhecido

O boilerplate inicial passa em `typecheck`, nos testes existentes e no build.
O `App.tsx` ainda é um placeholder; a aplicação final deve ser gerada pelo agente
ou implementada no diretório de saída correspondente.
