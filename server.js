import express from 'express'
import Anthropic from '@anthropic-ai/sdk'
import 'dotenv/config'

const app = express()
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const SERPER_KEY = process.env.SERPER_API_KEY || ''

const SYSTEM = [
  "You are Neuxon AI, a personalized cognitive intelligence system.",
  "Your purpose: understand how this specific person thinks, identify patterns they cannot see, and help them change those patterns using science.",
  "",
  "CORE BEHAVIOR:",
  "- You are a cognitive mirror, not a chatbot",
  "- Observe everything the person shares and build a map of their mind",
  "- Ask for specifics about their day, routines, triggers, patterns",
  "- After collecting data, identify patterns they cannot see themselves",
  "- Example: 'I noticed on days you have morning meetings you procrastinate more in the afternoon. Does that resonate?'",
  "- Use neuroscience to explain patterns in simple terms",
  "- Cite real researchers and studies. Distinguish well-established science from emerging research",
  "- Give one concrete specific experiment to test, not generic advice",
  "- Remember what the person told you. Track whether experiments worked. Evolve with them",
  "",
  "COMMUNICATION:",
  "- Speak like a trusted friend who understands cognitive science",
  "- Direct and specific. Never vague",
  "- One question at a time maximum",
  "- Detect language and always respond in that language",
  "- Use clear formatting: headers, bold for key insights, short paragraphs",
  "",
  "FIRST CONVERSATION:",
  "Introduce yourself briefly and ask about one specific challenge they are facing right now",
  "",
  "SEARCH RESULTS:",
  "When search results are provided, integrate them naturally and cite sources",
  "",
  "LIMITS:",
  "- Never diagnose medical or psychiatric conditions",
  "- Never replace a doctor or psychologist",
  "- Never recommend medications",
  "- If crisis signs appear, redirect to professional help immediately"
].join("\n")

async function shouldSearch(message) {
  if (!SERPER_KEY) return false
  const keywords = ['study','research','science','proven','evidence','protocol','technique','how to','what is','why does','estudo','pesquisa','comprovado','protocolo','tecnica','como','por que']
  return keywords.some(k => message.toLowerCase().includes(k))
}

async function searchWeb(query) {
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query + ' neuroscience cognitive science research', num: 3 })
    })
    const data = await res.json()
    if (!data.organic) return null
    return data.organic.slice(0, 3).map(r => `Source: ${r.title}\nSummary: ${r.snippet}`).join('\n\n')
  } catch (err) {
    console.error('Serper error:', err.message)
    return null
  }
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

app.use(express.json())
app.get('/health', (_, res) => res.json({ status: 'ok' }))

app.post('/api/chat', async (req, res) => {
  const { messages, userProfile } = req.body
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request.' })
  }

  let systemPrompt = SYSTEM
  if (userProfile && Object.keys(userProfile).length > 0) {
    systemPrompt += '\n\nUSER CONTEXT:\n' + JSON.stringify(userProfile)
  }

  const lastUserMsg = messages.filter(m => m.role === 'user').slice(-1)[0]
  if (lastUserMsg && await shouldSearch(lastUserMsg.content)) {
    const results = await searchWeb(lastUserMsg.content)
    if (results) systemPrompt += '\n\nSEARCH RESULTS:\n' + results
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  try {
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: systemPrompt,
      messages
    })

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ text })}\n\n`)
    })

    stream.on('finalMessage', (msg) => {
      res.write(`data: ${JSON.stringify({ done: true, fullText: msg.content[0]?.text || '' })}\n\n`)
      res.end()
    })

    stream.on('error', (err) => {
      console.error('Stream error:', err.message)
      res.write(`data: ${JSON.stringify({ error: true })}\n\n`)
      res.end()
    })

  } catch (err) {
    console.error('API error:', err.message)
    res.write(`data: ${JSON.stringify({ error: true })}\n\n`)
    res.end()
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Neuxon AI running on port ${PORT}`))
