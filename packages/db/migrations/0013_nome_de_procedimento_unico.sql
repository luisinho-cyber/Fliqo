-- =====================================================================
-- 0013 — Nome de procedimento é único dentro da clínica.
--
-- A clínica passa a cadastrar os próprios procedimentos pela tela, e nome repetido
-- não é detalhe de interface: é o buraco por onde o preço se perde.
--
-- Duas coisas quebram com nome duplicado. A importação de agenda (0012) acha
-- procedimento POR NOME e, com dois iguais, pega um arbitrário — então metade das
-- consultas de "Limpeza" aponta para o registro com preço e metade para o sem. E o
-- Caixa, que conta "N procedimentos sem preço cadastrado", passa a listar um nome que
-- a clínica jura ter cadastrado, porque ela cadastrou no OUTRO.
--
-- A unicidade mora no banco, e não numa conferência antes do INSERT, pela mesma razão
-- do `no_double_booking`: entre o SELECT e o INSERT a outra recepcionista cadastra. O
-- código trata o 23505 e responde "já existe um procedimento com esse nome".
-- =====================================================================

-- `lower(name)` porque "Limpeza", "limpeza" e "LIMPEZA" são o mesmo procedimento para
-- a clínica, e deixar os três conviverem é a mesma confusão com três nomes.
--
-- Vale para procedimento INATIVO também, de propósito. A alternativa — liberar o nome
-- ao inativar — deixaria dois registros com o mesmo nome no banco, e aí a importação
-- voltaria a escolher um arbitrário. Quem quer o nome de volta reativa o que existe, e
-- a tela diz isso em português em vez de deixar criar uma sombra.
--
-- Sem `where active`: o índice é total.
create unique index procedure_nome_unico_na_clinica
  on app.procedures (clinic_id, lower(name));
