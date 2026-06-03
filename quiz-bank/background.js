// Background service worker.
// Runs the Gemini API call here so it is isolated from the quiz page's network
// contention (e.g. ClipboardAuto's polling to a slow/sleeping Render server).

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = 'gemini-flash-lite-latest'
const CLIPBOARD_API_URL = 'https://api-htmd.onrender.com'

// AbortControllers for in-flight Gemini requests, keyed by requestId,
// so the content script can cancel a fetch when the user moves to another question.
const inFlightControllers = new Map()

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return

  if (message.type === 'quizbank-gemini-request') {
    console.log('[QuizBank BG] gemini request received')
    fetchGeminiAnswer(message.prompt, message.apiKey, message.requestId)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error) }))
    return true // keep the channel open for the async response
  }

  if (message.type === 'quizbank-gemini-abort') {
    const controller = inFlightControllers.get(message.requestId)
    if (controller) {
      controller.abort()
      inFlightControllers.delete(message.requestId)
      console.log(`[QuizBank BG] aborted gemini request ${message.requestId}`)
    }
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'quizbank-clipboard-post') {
    postClipboardContent(message.deviceId, message.text)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error) }))
    return true
  }

  if (message.type === 'quizbank-clipboard-wake') {
    wakeClipboardServer()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }))
    return true
  }
  // Not our message - let other listeners handle it
})

async function postClipboardContent(deviceId, text) {
  const response = await fetch(`${CLIPBOARD_API_URL}/api/${deviceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  })
  return { ok: response.ok, status: response.status }
}

async function wakeClipboardServer() {
  await fetch(`${CLIPBOARD_API_URL}/health`, { method: 'GET' })
  return { ok: true }
}

// Round-robin pointer across the configured keys (persists while the worker is alive)
let keyRotationIndex = 0

async function fetchGeminiAnswer(prompt, apiKeyString, requestId) {
  // Supabase value may hold multiple keys, comma-separated
  const apiKeys = (apiKeyString || '')
    .split(',')
    .map(key => key.replace(/\s/g, '')) // strip all whitespace (incl. stray newlines)
    .filter(Boolean)

  if (apiKeys.length === 0) {
    return { ok: false, error: 'missing api key' }
  }

  // Register an AbortController so an abort message can cancel the fetch mid-flight.
  const controller = new AbortController()
  if (requestId) inFlightControllers.set(requestId, controller)

  try {
    // Try each key once, starting at the rotating index, so load is spread
    // and a throttled key falls back to the next one.
    let lastResult = { ok: false, error: 'no attempt' }
    for (let attempt = 0; attempt < apiKeys.length; attempt++) {
      const index = (keyRotationIndex + attempt) % apiKeys.length
      const result = await tryGeminiKey(prompt, apiKeys[index], controller.signal)

      if (result.aborted) return result // user cancelled - stop, don't try more keys

      if (result.ok) {
        // Advance the pointer so the next request starts on a different key
        keyRotationIndex = (index + 1) % apiKeys.length
        return result
      }

      lastResult = result
      console.log(`[QuizBank BG] key #${index} failed (${result.status || result.error}), trying next`)
    }

    return lastResult
  } finally {
    if (requestId) inFlightControllers.delete(requestId)
  }
}

async function tryGeminiKey(prompt, apiKey, signal) {
  const url = `${GEMINI_ENDPOINT}/${GEMINI_MODEL}:generateContent`

  const fetchStart = Date.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [
          { parts: [{ text: prompt }] }
        ],
        // Disable model "thinking" - quiz answers don't need it; faster, far fewer tokens
        generationConfig: {
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    })

    console.log(`[QuizBank BG] gemini fetch took ${Date.now() - fetchStart}ms (worker context)`)

    if (!response.ok) {
      return { ok: false, status: response.status }
    }

    const data = await response.json()
    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    return { ok: true, answer: answer || null }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('[QuizBank BG] gemini fetch aborted')
      return { ok: false, aborted: true }
    }
    throw error
  }
}
