import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const EXTRACTION_SYSTEM = `Você analisa uma troca de mensagens entre um usuário e um assistente de inteligência cognitiva.
Sua única função é extrair sinais estruturados. Você NUNCA conversa com o usuário — apenas retorna JSON válido, nada além disso.

Retorne exclusivamente um objeto JSON neste formato:

{
  "candidate_patterns": [
    {
      "type": "ativacao | ciclo | inconsistencia",
      "label": "rótulo curto e específico do padrão",
      "trigger": "o que dispara o comportamento, se identificável, ou null",
      "behavior": "o comportamento observado",
      "evidence_excerpt": "trecho curto (até 200 caracteres) da conversa que sustenta isso",
      "confidence": 0.0
    }
  ],
  "reinforced_pattern_ids": ["id-de-padrao-existente-que-essa-conversa-reforça"],
  "experiment_updates": [
    { "experiment_id": "id", "result": "funcionou | parcial | nao_funcionou", "user_report": "o que o usuário relatou, nas palavras dele resumidas" }
  ]
}

Regras:
- Só inclua um candidate_pattern se houver evidência real e específica na conversa. Não invente, não infira além do que foi dito.
- confidence reflete o quão claro e específico o sinal foi: 0.2–0.4 sutil/ambíguo, 0.5–0.7 claro, 0.8+ muito explícito e repetido pelo próprio usuário.
- Antes de criar um candidate_pattern novo, verifique se ele não é essencialmente o mesmo de um padrão já existente (lista fornecida) — nesse caso, use reinforced_pattern_ids em vez de criar um novo.
- Se nada relevante foi observado nesta troca específica, retorne arrays vazios. Isso é o resultado mais comum — a maioria das mensagens não revela um padrão novo.
- Não inclua nenhum texto fora do JSON, nenhum markdown, nenhuma explicação.`

/**
 * Busca os padrões mais relevantes de um usuário (maior confiança primeiro),
 * já com experimentos relacionados, para injetar no system prompt do chat.
 */
export async function getActivePatterns(userId, limit = 5) {
  if (!userId) return []

  const { data, error } = await supabase
    .from('patterns')
    .select('*, experiments(*)')
    .eq('user_id', userId)
    .neq('status', 'rejeitado')
    .order('confidence', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('getActivePatterns error:', error.message)
    return []
  }
  return data || []
}

/**
 * Lista todos os padrões de um usuário (qualquer status), para uma tela
 * de "seus padrões identificados" no frontend.
 */
export async function listAllPatterns(userId) {
  if (!userId) return []

  const { data, error } = await supabase
    .from('patterns')
    .select('*, experiments(*), pattern_evidence(*)')
    .eq('user_id', userId)
    .order('confidence', { ascending: false })

  if (error) {
    console.error('listAllPatterns error:', error.message)
    return []
  }
  return data || []
}

/**
 * Converte os padrões ativos em texto para injetar no system prompt.
 */
export function buildPatternContext(patterns) {
  if (!patterns || patterns.length === 0) return ''

  const lines = ['\n\nPADRÕES JÁ IDENTIFICADOS PARA ESTE USUÁRIO:']
  for (const p of patterns) {
    lines.push(`\n- [${p.status}, confiança ${Math.round(p.confidence * 100)}%] ${p.label}`)
    if (p.trigger) lines.push(`  Gatilho: ${p.trigger}`)
    if (p.behavior) lines.push(`  Comportamento: ${p.behavior}`)

    const pendingExperiments = (p.experiments || []).filter(e => e.result === 'pendente')
    if (pendingExperiments.length > 0) {
      lines.push(`  Experimento em andamento (id: ${pendingExperiments[0].id}): ${pendingExperiments[0].description}`)
    }
  }
  lines.push(
    '\nUse esses padrões para dar continuidade real à conversa: pergunte sobre experimentos em andamento, ' +
    'reforce padrões já confirmados quando relevante, e não reapresente um padrão confirmado como se fosse uma descoberta nova. ' +
    'Padrões com status "candidato" ainda não foram validados pelo usuário — trate como hipótese a confirmar, não como fato.'
  )
  return lines.join('\n')
}

/**
 * Roda a extração de sinais estruturados sobre a última troca de mensagens
 * e persiste o resultado no Supabase. Projetado para rodar em background
 * (fire-and-forget) depois que a resposta já foi enviada ao usuário —
 * uma falha aqui nunca deve afetar o que o usuário recebeu no chat.
 */
export async function extractAndStorePatterns(userId, conversationText, existingPatterns = []) {
  if (!userId) return

  try {
    const existingSummary = existingPatterns.map(p => ({
      id: p.id,
      label: p.label,
      status: p.status,
      pending_experiments: (p.experiments || [])
        .filter(e => e.result === 'pendente')
        .map(e => ({ id: e.id, description: e.description }))
    }))

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: EXTRACTION_SYSTEM,
      messages: [{
        role: 'user',
        content: `Padrões já existentes deste usuário (não recrie — se a conversa reforçar algum, use reinforced_pattern_ids):\n${JSON.stringify(existingSummary)}\n\nTroca de mensagens a analisar:\n${conversationText}`
      }]
    })

    const raw = response.content[0]?.text || '{}'
    const cleaned = raw.replace(/```json|```/g, '').trim()
    const extracted = JSON.parse(cleaned)

    // Novos padrões candidatos
    for (const cp of (extracted.candidate_patterns || [])) {
      if (!cp.label || !cp.type) continue

      const { data: newPattern, error: insertErr } = await supabase
        .from('patterns')
        .insert({
          user_id: userId,
          type: cp.type,
          label: cp.label,
          trigger: cp.trigger || null,
          behavior: cp.behavior || null,
          confidence: typeof cp.confidence === 'number' ? cp.confidence : 0.3,
          status: 'candidato'
        })
        .select()
        .single()

      if (insertErr) {
        console.error('insert pattern error:', insertErr.message)
        continue
      }

      if (cp.evidence_excerpt) {
        await supabase.from('pattern_evidence').insert({
          pattern_id: newPattern.id,
          conversation_excerpt: cp.evidence_excerpt
        })
      }
    }

    // Reforço de padrões existentes — confiança sobe, e a partir de um
    // limiar o padrão passa de "candidato" para "confirmado" automaticamente.
    // (A confirmação explícita do usuário, quando você adicionar esse botão
    // no frontend, deve sempre sobrescrever isso — ver confirmPattern abaixo.)
    for (const id of (extracted.reinforced_pattern_ids || [])) {
      const existing = existingPatterns.find(p => p.id === id)
      if (!existing) continue

      const newConfidence = Math.min(1, Number(existing.confidence) + 0.15)
      const newStatus = newConfidence >= 0.75 && existing.status === 'candidato'
        ? 'confirmado'
        : existing.status

      await supabase
        .from('patterns')
        .update({
          confidence: newConfidence,
          status: newStatus,
          last_reinforced: new Date().toISOString()
        })
        .eq('id', id)
    }

    // Atualizações de experimentos relatadas na conversa
    for (const eu of (extracted.experiment_updates || [])) {
      if (!eu.experiment_id || !eu.result) continue

      await supabase
        .from('experiments')
        .update({
          result: eu.result,
          user_report: eu.user_report || null
        })
        .eq('id', eu.experiment_id)
    }

  } catch (err) {
    console.error('extractAndStorePatterns error:', err.message)
  }
}

/**
 * Confirmação explícita pelo usuário (botão "isso é real" no frontend).
 * Sobrescreve o que a extração automática teria decidido.
 */
export async function confirmPattern(patternId, confirmed) {
  const status = confirmed ? 'confirmado' : 'rejeitado'
  const { error } = await supabase
    .from('patterns')
    .update({ status, confidence: confirmed ? 0.9 : 0 })
    .eq('id', patternId)

  if (error) {
    console.error('confirmPattern error:', error.message)
    return false
  }
  return true
}

/**
 * Cria um experimento vinculado a um padrão (chamado pelo backend quando
 * o assistente sugere um experimento durante a conversa, ou manualmente).
 */
export async function createExperiment(patternId, description) {
  const { data, error } = await supabase
    .from('experiments')
    .insert({ pattern_id: patternId, description })
    .select()
    .single()

  if (error) {
    console.error('createExperiment error:', error.message)
    return null
  }
  return data
}
