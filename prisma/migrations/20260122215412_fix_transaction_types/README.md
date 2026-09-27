# Migration: Fix Transaction Types

## Objetivo
Esta migration corrige transações que foram criadas com o tipo `INCOME` (receita) por padrão, mas que deveriam ser `EXPENSE` (despesa) baseado na categoria.

## Segurança
✅ **Esta migration é SEGURA** porque:
- **SOMENTE** atualiza transações com `type = 'INCOME'` que têm categorias de despesa
- **NUNCA** muda `EXPENSE` para `INCOME`
- **NUNCA** afeta transações do tipo `TRANSFER` ou `ALLOCATION`
- Usa apenas categorias conhecidas (whitelist) em vez de blacklist

## Antes de Executar

### 1. Fazer Backup do Banco de Dados
```bash
# Exemplo com pg_dump
pg_dump -h localhost -U seu_usuario -d nome_do_banco > backup_antes_migration.sql
```

### 2. Verificar o que será alterado
Execute as queries em `VERIFY.sql` no pgAdmin ou psql para ver:
- Quantas transações serão corrigidas
- Quais categorias serão afetadas
- Resumo total das mudanças

```bash
# No pgAdmin ou psql
\i prisma/migrations/20260122215412_fix_transaction_types/VERIFY.sql
```

## Como Executar

### Opção 1: Via Prisma CLI (Recomendado)
```bash
cd backend-app
npm run db:migrate
```

### Opção 2: Manualmente no pgAdmin
1. Abra o pgAdmin
2. Conecte ao banco de dados
3. Abra o arquivo `migration.sql`
4. Execute o SQL

## O que a Migration Faz

A migration executa 4 passos:

1. **Sistema de Categorias**: Atualiza transações com categorias de despesa conhecidas (FOOD, TRANSPORTATION, etc.)

2. **Categorias Customizadas**: Atualiza transações com categorias customizadas que estão marcadas como EXPENSE na tabela `categories`

3. **Recorrências (Sistema)**: Atualiza transações geradas por recorrências que têm categorias de despesa do sistema

4. **Recorrências (Custom)**: Atualiza transações geradas por recorrências que têm categorias customizadas marcadas como EXPENSE

## Após Executar

1. Reinicie o backend
2. Verifique se as transações estão aparecendo corretamente
3. Teste criando uma nova transação parcelada ou recorrência para confirmar que o problema não ocorre mais

## Rollback

Se precisar reverter (não recomendado, mas possível):

```sql
-- ATENÇÃO: Isso vai reverter TODAS as correções feitas pela migration
-- Use apenas se tiver certeza absoluta
UPDATE transactions
SET type = 'INCOME'
WHERE type = 'EXPENSE'
  AND category_name IN (
    'FOOD', 'TRANSPORTATION', 'HOUSING', 'HEALTHCARE', 'EDUCATION', 
    'ENTERTAINMENT', 'CLOTHING', 'UTILITIES', 'SUBSCRIPTIONS', 
    'ONLINE_SHOPPING', 'GROCERIES', 'RESTAURANT', 'FUEL', 'PHARMACY', 'OTHER_EXPENSES'
  );
```

**⚠️ NÃO execute o rollback a menos que tenha certeza absoluta de que é necessário!**
