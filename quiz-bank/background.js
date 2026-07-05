// Background service worker: relays clipboard/materials/user-note requests to
// the backend. Gemini requests are fetched directly by the content script -
// Orion iOS never delivers worker responses once the worker suspends.
const CLIPBOARD_API_URL = 'https://quizbankend-production.up.railway.app'

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return

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
