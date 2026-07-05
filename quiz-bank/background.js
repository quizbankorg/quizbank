// Background service worker.
// Runs the Gemini API call here so it is isolated from the quiz page's network
// contention (e.g. ClipboardAuto's polling to a slow/sleeping Render server).

// The Gemini API key lives on the backend now; the worker only relays prompts.
const CLIPBOARD_API_URL = 'https://quizbankend-production.up.railway.app'

// AbortControllers for in-flight Gemini requests, keyed by requestId,
// so the content script can cancel a fetch when the user moves to another question.
const inFlightControllers = new Map()

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return

  if (message.type === 'quizbank-gemini-request') {
    console.log('[QuizBank BG] gemini request received')
    fetchGeminiAnswer(message.prompt, message.deviceId, message.requestId, message.course, message.module, message.userNoteIds)
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

  if (message.type === 'quizbank-get-materials') {
    fetchMaterials(message.deviceId)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error) }))
    return true
  }

  if (message.type === 'quizbank-get-user-notes') {
    fetchUserNotes(message.deviceId)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error) }))
    return true
  }

  if (message.type === 'quizbank-upload-user-note') {
    uploadUserNote(message.deviceId, message.filename, message.content, message.mimeType)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error) }))
    return true
  }

  if (message.type === 'quizbank-delete-user-note') {
    deleteUserNote(message.deviceId, message.id)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error) }))
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

async function fetchGeminiAnswer(prompt, deviceId, requestId, course, module, userNoteIds) {
  // Register an AbortController so an abort message can cancel the fetch mid-flight.
  const controller = new AbortController()
  if (requestId) inFlightControllers.set(requestId, controller)

  const fetchStart = Date.now()
  try {
    const response = await fetch(`${CLIPBOARD_API_URL}/api/gemini`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        deviceId,
        course: course || null,
        module: module || null,
        userNoteIds: userNoteIds || null
      })
    })

    console.log(`[QuizBank BG] gemini fetch took ${Date.now() - fetchStart}ms (worker context)`)

    const data = await response.json().catch(() => ({}))

    if (response.status === 499 || data.aborted) {
      return { ok: false, aborted: true }
    }
    if (!response.ok || !data.ok) {
      return { ok: false, status: response.status, error: data.error }
    }
    return { ok: true, answer: data.answer || null, grounding_type: data.grounding_type || 'general_knowledge' }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('[QuizBank BG] gemini fetch aborted')
      return { ok: false, aborted: true }
    }
    throw error
  } finally {
    if (requestId) inFlightControllers.delete(requestId)
  }
}

async function fetchMaterials(deviceId) {
  const response = await fetch(`${CLIPBOARD_API_URL}/api/materials?deviceId=${encodeURIComponent(deviceId)}`)
  const data = await response.json().catch(() => ({}))
  return data
}

async function fetchUserNotes(deviceId) {
  const response = await fetch(`${CLIPBOARD_API_URL}/api/user-notes?deviceId=${encodeURIComponent(deviceId)}`)
  const data = await response.json().catch(() => ({}))
  return data
}

async function uploadUserNote(deviceId, filename, base64Data, mimeType) {
  try {
    const byteCharacters = atob(base64Data)
    const byteNumbers = new Array(byteCharacters.length)
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i)
    }
    const byteArray = new Uint8Array(byteNumbers)
    const fileBlob = new Blob([byteArray], { type: mimeType })

    const formData = new FormData()
    formData.append('deviceId', deviceId)
    formData.append('file', fileBlob, filename)

    const response = await fetch(`${CLIPBOARD_API_URL}/api/user-notes`, {
      method: 'POST',
      body: formData
    })
    const data = await response.json().catch(() => ({}))
    return data
  } catch (error) {
    console.error('[QuizBank BG] Error uploading user note:', error)
    return { ok: false, error: String(error) }
  }
}

async function deleteUserNote(deviceId, id) {
  const response = await fetch(`${CLIPBOARD_API_URL}/api/user-notes/${id}?deviceId=${encodeURIComponent(deviceId)}`, {
    method: 'DELETE'
  })
  const data = await response.json().catch(() => ({}))
  return data
}
