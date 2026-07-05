// ==================== UTILITY FUNCTIONS ====================

function pickBy(obj, predicate) {
  return Object.fromEntries(
    Object.entries(obj).filter(([key, value]) => predicate(value, key))
  )
}

function copyError(error) {
  if (!(error instanceof Error)) return error
  const clone = {}
  Object.getOwnPropertyNames(error).forEach(key => {
    clone[key] = error[key]
  })
  return clone
}

// ==================== CONSTANTS ====================

const QuestionTypes = {
  MULTIPLE_CHOICE: 'multiple_choice_question',
  TRUE_FALSE: 'true_false_question',
  FILL_IN_BLANK: 'short_answer_question',
  FILL_IN_MULTIPLE_BLANKS: 'fill_in_multiple_blanks_question',
  MULTIPLE_ANSWER: 'multiple_answers_question',
  MULTIPLE_DROPDOWN: 'multiple_dropdowns_question',
  MATCHING: 'matching_question',
  NUMERICAL_ANSWER: 'numerical_question',
  FORMULA_QUESTION: 'calculated_question',
  ESSAY_QUESTION: 'essay_question'
}

const Correct = {
  TRUE: 'true',
  FALSE: 'false',
  PARTIAL: 'partial'
}

// ==================== GEMINI AI ====================
// The background service worker (quiz-bank/background.js) relays the prompt to the
// backend (render-server), which holds the Gemini API key and validates voucher
// access. The extension never handles the key.

/**
 * Build a type-aware prompt for Gemini from a question.
 */
function buildGeminiPrompt(questionInfo, quizContext) {
  const { questionText, questionType, options } = questionInfo
  const hasOptions = Array.isArray(options) && options.length > 0

  let instruction
  switch (questionType) {
    case QuestionTypes.MULTIPLE_CHOICE:
    case QuestionTypes.TRUE_FALSE:
      instruction = 'Choose the single correct option. Respond with ONLY the exact text of the correct option, nothing else.'
      break
    case QuestionTypes.MULTIPLE_ANSWER:
      instruction = 'Choose all correct options. Respond with ONLY the exact text of each correct option, separated by " | ", nothing else.'
      break
    case QuestionTypes.ESSAY_QUESTION:
      instruction = 'Write a concise, correct answer (2-4 sentences).'
      break
    default:
      instruction = 'Respond with ONLY the correct answer, as short as possible, nothing else.'
  }

  let prompt = instruction
  if (quizContext) {
    prompt += `\n\nThis question is from the quiz/course: "${quizContext}". Use this as subject context.`
  }
  prompt += `\n\nQuestion: ${questionText}`
  if (hasOptions) {
    prompt += `\n\nOptions:\n${options.map(option => `- ${option}`).join('\n')}`
  }
  return prompt
}

/**
 * Ask Gemini for the answer to a question.
 * Returns the answer text, or null on failure.
 */
/**
 * Ask Gemini for an answer. Returns { status, answer } where status is
 * 'ok' | 'failed' | 'aborted'. requestId lets the caller abort the in-flight fetch.
 */
// ==================== TEMP DEBUG OVERLAY (mobile diagnosis) ====================
// On-page log panel - remove once the Orion iOS AI-path stall is diagnosed.
function debugOverlay(message) {
  let panel = document.getElementById('qb-debug-overlay')
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'qb-debug-overlay'
    panel.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 999999;
      max-height: 40vh; overflow-y: auto; background: rgba(0,0,0,0.85);
      color: #0f0; font: 10px/1.4 monospace; padding: 6px; pointer-events: none;
    `
    document.documentElement.appendChild(panel)
  }
  const line = document.createElement('div')
  line.textContent = `${new Date().toISOString().slice(11, 23)} ${message}`
  panel.appendChild(line)
  panel.scrollTop = panel.scrollHeight
}

// Probe every worker response-delivery mechanism; overlay-log which arrive.
// Temp (Orion diagnosis) - tells us in one install which channel is viable.
async function probeWorkerChannels() {
  const timed = (name, promise) =>
    Promise.race([
      promise.then(r => debugOverlay(`probe ${name}: ✅ ${JSON.stringify(r)}`)),
      new Promise(resolve => setTimeout(resolve, 3000)).then(() => debugOverlay(`probe ${name}: ❌ timeout`))
    ]).catch(e => debugOverlay(`probe ${name}: ❌ threw ${e?.message || e}`))

  debugOverlay('--- worker channel probes ---')
  await timed('sync', browser.runtime.sendMessage({ type: 'quizbank-probe-sync' }))
  await timed('microtask', browser.runtime.sendMessage({ type: 'quizbank-probe-microtask' }))
  await timed('timeout250', browser.runtime.sendMessage({ type: 'quizbank-probe-timeout' }))
  await timed('promise-return', browser.runtime.sendMessage({ type: 'quizbank-probe-promise' }))

  await timed('port', new Promise((resolve, reject) => {
    try {
      const port = browser.runtime.connect({ name: 'quizbank-probe-port' })
      port.onMessage.addListener(response => { resolve(response); port.disconnect() })
      port.onDisconnect.addListener(() => reject(new Error('port disconnected')))
      port.postMessage({ ping: true })
    } catch (e) { reject(e) }
  }))

  // The real question: does a worker-side fetch's response make it back?
  await timed('real-fetch(health)', browser.runtime.sendMessage({ type: 'quizbank-clipboard-wake' }))
  debugOverlay('--- probes done ---')
}

async function askGemini(questionInfo, quizContext, deviceId, logger, requestId) {
  const prompt = buildGeminiPrompt(questionInfo, quizContext)
  logger?.info('🤖 Gemini prompt:', prompt)
  debugOverlay('askGemini: prompt built')

  // Read the user's selected AI context (course/module) and Supabase-synced note selection
  let aiContext = { course: '', module: '' }
  let selectedNoteIds = []
  let selectedNoteNames = []
  try {
    const stored = await browser.storage.local.get([
      'quizbank_ai_context',
      'quizbank_user_notes',
      'quizbank_selected_user_files'
    ])
    if (stored.quizbank_ai_context) {
      aiContext = stored.quizbank_ai_context
    }
    const allNotes = stored.quizbank_user_notes || []
    const rawSelectedIds = (stored.quizbank_selected_user_files || []).map(Number)

    // Filter to only include IDs that exist in the active user notes list
    selectedNoteIds = rawSelectedIds.filter(id => allNotes.some(n => Number(n.id) === id))
    selectedNoteNames = allNotes
      .filter(n => selectedNoteIds.includes(Number(n.id)))
      .map(n => n.filename)

    if (selectedNoteNames.length > 0) {
      logger?.info(`📂 Grounding prompt with selected notes: ${selectedNoteNames.join(', ')}`)
    }
  } catch (e) { /* default to empty */ }
  debugOverlay('askGemini: storage read done, sending to worker')

  const payload = {
    prompt,
    deviceId,
    course: aiContext.course || null,
    module: aiContext.module || null,
    userNoteIds: selectedNoteIds.length > 0 ? selectedNoteIds.join(',') : null,
    requestId
  }

  try {
    // Run the request in the background service worker - isolated from the page's
    // network contention (ClipboardAuto polling etc.) which was stalling it badly.
    // The worker relays the prompt to the backend, which holds the Gemini key
    // and validates the device's voucher before answering.
    //
    // Some browsers (Orion iOS) suspend the worker mid-request and never deliver
    // the response, so race it against a timeout and fall back to fetching the
    // backend directly from the content script (backend CORS allows it).
    const startTime = performance.now()
    const result = await askGeminiViaWorkerOrDirect(payload, logger)
    logger?.info(`🤖 Gemini network time: ${Math.round(performance.now() - startTime)}ms`)
    debugOverlay(`askGemini: worker responded in ${Math.round(performance.now() - startTime)}ms ok=${result?.ok} aborted=${result?.aborted} err=${result?.error || '-'}`)

    if (result?.aborted) {
      logger?.info('🤖 Gemini request aborted (moved to another question)')
      return { status: 'aborted' }
    }

    if (!result || !result.ok) {
      logger?.warn(`Gemini request failed: ${result?.status || result?.error || 'no response'}`)
      return { status: 'failed' }
    }

    if (!result.answer) {
      logger?.warn('Gemini returned no answer')
      return { status: 'failed' }
    }
    logger?.info(`🤖 Gemini answer [Grounding: ${result.grounding_type || 'general_knowledge'}]:`, result.answer)
    return { status: 'ok', answer: result.answer }
  } catch (error) {
    logger?.warn('Gemini request error:', error)
    debugOverlay(`askGemini: sendMessage threw: ${error?.message || error}`)
    return { status: 'failed' }
  }
}

// Backend that relays prompts to Gemini (same one the background worker uses).
const QUIZBANK_API_URL = 'https://quizbankend-production.up.railway.app'

// AbortControllers for direct (content-script) Gemini fetches, keyed by requestId.
const directGeminiControllers = new Map()

/**
 * Send the Gemini request straight to the backend from the content script.
 * Returns the same shape the worker returned: { ok, answer?, aborted?, error? }.
 */
async function askGeminiViaWorkerOrDirect(payload, logger) {
  // Worker relay abandoned: Orion iOS drops every worker->page response channel
  // (sync/async sendResponse, promise-return, ports - all probed dead), and
  // liveness detection proved unreliable. Backend CORS allows page-context
  // fetches, so the content script always calls the backend directly.
  debugOverlay('route: direct fetch (worker relay bypassed)')
  const direct = await fetchGeminiDirect(payload)
  debugOverlay(`route: direct fetch done ok=${direct?.ok} err=${direct?.error || '-'}`)
  if (!direct?.ok && direct?.error) logger?.warn(`Gemini direct fetch failed: ${direct.error}`)
  return direct
}

/**
 * Direct content-script fetch to the backend (fallback when the worker is dead).
 * Mirrors background.js fetchGeminiAnswer, abortable via abortGeminiRequest.
 */
async function fetchGeminiDirect({ prompt, deviceId, course, module: moduleName, userNoteIds, requestId }) {
  const controller = new AbortController()
  if (requestId) directGeminiControllers.set(requestId, controller)

  try {
    const response = await fetch(`${QUIZBANK_API_URL}/api/gemini`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, deviceId, course, module: moduleName, userNoteIds })
    })

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
      return { ok: false, aborted: true }
    }
    return { ok: false, error: String(error) }
  } finally {
    if (requestId) directGeminiControllers.delete(requestId)
  }
}

/**
 * Abort an in-flight Gemini fetch - both the worker's and any direct fallback.
 */
function abortGeminiRequest(requestId) {
  if (!requestId) return
  browser.runtime.sendMessage({ type: 'quizbank-gemini-abort', requestId }).catch(() => { })
  const controller = directGeminiControllers.get(requestId)
  if (controller) {
    controller.abort()
    directGeminiControllers.delete(requestId)
  }
}

// Module-level ref to the active loader so global key/selection handlers can reach it.
let currentLoader = null
let aiListenersAttached = false

/**
 * Attach the global AI triggers once per content-script load:
 *  - right-click on a pending question triggers/retries its AI answer
 *  - page navigation aborts anything still running
 */
function attachAIGlobalListeners() {
  if (aiListenersAttached) return
  aiListenersAttached = true

  document.addEventListener('contextmenu', (event) => {
    currentLoader?.handleRightClick(event)
  })

  // Mobile: double-tap mirrors right-click (no contextmenu on most touch browsers).
  let lastTapTime = 0
  let lastTapTarget = null
  document.addEventListener('touchend', (event) => {
    const now = Date.now()
    const target = event.target
    const isDoubleTap =
      now - lastTapTime < 350 && lastTapTarget === target
    lastTapTime = now
    lastTapTarget = target
    if (isDoubleTap) {
      currentLoader?.handleDoubleTap(event)
    }
  })

  window.addEventListener('beforeunload', () => {
    currentLoader?.abortAllAIRequests()
  })
}

// ==================== QUIZBANK CLASS ====================

class EnhancedQuizLoader {
  constructor() {
    this.dbManager = new SupabaseQuizManager()
    this.logger = BrowserLogger.getInstance()
    this.questionCompiler = new QuestionCompiler(this.logger, this.dbManager)
    this.initialized = false
    this.stealthMode = false // Default to disabled
    this.aiMode = true // Default to enabled
    // Pending/in-flight AI questions keyed by questionId.
    // Entry: { question, questionType, displayer, quizContext, button, state, requestId }
    this.aiRegistry = new Map()
  }

  async init() {
    if (!this.initialized) {
      await this.dbManager.init()

      // Load stealth mode preference
      try {
        const result = await browser.storage.local.get(['stealthMode'])
        this.stealthMode = result.stealthMode === true
        this.logger.info(`Stealth mode: ${this.stealthMode ? 'ON' : 'OFF'}`)

        // Update body class
        document.body.classList.toggle('quizbank-stealth', this.stealthMode)

        // Sync with compiler
        this.questionCompiler.setStealthMode(this.stealthMode)
      } catch (e) {
        this.logger.warn('Failed to load stealth mode preference')
      }

      // Load AI mode preference (default enabled)
      try {
        const result = await browser.storage.local.get(['aiMode'])
        this.aiMode = result.aiMode !== false
        this.logger.info(`AI mode: ${this.aiMode ? 'ON' : 'OFF'}`)
      } catch (e) {
        this.logger.warn('Failed to load AI mode preference')
      }

      // Gemini calls now go through the backend, which holds the API key and
      // validates voucher access - the content script never handles the key.

      this.initialized = true
      this.logger.info('QuizBank initialized with knowledge bank')
    }
  }

  setStealthMode(enabled) {
    this.stealthMode = enabled
    document.body.classList.toggle('quizbank-stealth', enabled)
    this.questionCompiler.setStealthMode(enabled)
    this.logger.info(`Stealth mode updated: ${enabled ? 'ON' : 'OFF'}`)
  }

  /**
   * Main function that combines Canvas API with Knowledge Bank
   */
  async getEnhancedCorrectAnswers(courseId, quizId, baseUrl) {
    await this.init()

    // Get Canvas submissions (original functionality)
    const canvasSubmissions = await this.getQuizSubmissions(
      courseId,
      quizId,
      baseUrl
    )

    // Get current quiz questions from DOM FIRST
    const currentQuestions = this.getCurrentQuizQuestions()
    this.logger.info('Extracted current quiz questions:', currentQuestions)

    // Process and save Canvas data to knowledge bank with real question text (skip if stealth)
    if (canvasSubmissions.length > 0 && !this.stealthMode) {
      const quizData = {
        course_name: document.title || `Course ${courseId}`,
        quiz_name: `Quiz ${quizId}`,
        assignment_id: null,
        base_url: baseUrl
      }

      await this.dbManager.processCanvasSubmissionsWithQuestionData(
        courseId,
        quizId,
        canvasSubmissions,
        quizData,
        currentQuestions
      )
      this.logger.info(
        'Canvas submissions saved to knowledge bank with real question text'
      )
    } else if (this.stealthMode) {
      this.logger.info('🤫 Stealth Mode is ON - skipping Knowledge Bank updates')
    }

    // Build enhanced answers combining Canvas + Knowledge Bank
    this.logger.info('Building enhanced answers...')
    const enhancedAnswers = {}

    // Process Canvas answers first (original format)
    const canvasAnswers = this.getCorrectAnswers(canvasSubmissions)
    this.logger.info('Canvas answers found:', canvasAnswers ? Object.keys(canvasAnswers).length : 0, 'questions')

    this.logger.info('Processing', currentQuestions.length, 'questions for enhancement')
    for (const questionInfo of currentQuestions) {
      const questionId = questionInfo.questionId

      // Check Knowledge Bank for this question (two-stage lookup)
      let dbQuestion = await this.dbManager.findQuestionByContent(
        questionInfo.questionText,
        questionInfo.questionType,
        courseId,
        questionInfo.options
      )

      // If not found by content and we have real content, try Canvas Question ID fallback
      if (!dbQuestion && questionId && !questionInfo.questionText.match(/^Question \d+$/)) {
        dbQuestion = await this.dbManager.findQuestionByCanvasId(questionId, courseId)
        if (dbQuestion && this.logger) {
          this.logger.info(`📝 Found question ${questionId} via Canvas ID fallback (temporary hash: ${dbQuestion.question_hash})`)
        }
      }

      this.logger.info(`Question ${questionId}: DB lookup result:`, dbQuestion ? 'FOUND' : 'NOT FOUND')

      let enhancedQuestion = null

      if (dbQuestion) {
        // Get knowledge bank analysis
        const analysis = await this.dbManager.getQuestionAnalysis(
          dbQuestion.question_hash
        )

        if (analysis.bestAnswer) {
          enhancedQuestion = {
            source: 'knowledge_bank',
            questionHash: dbQuestion.question_hash,
            bestAnswer: {
              text: analysis.bestAnswer.answer_text,
              correct: this.scoreToCorrect(
                analysis.bestAnswer.confidence_score
              ),
              points: analysis.bestAnswer.confidence_score,
              dynamicFields: analysis.bestAnswer.answer_fields || {}
            },
            latestAnswer: {
              text: analysis.bestAnswer.answer_text,
              correct: this.scoreToCorrect(
                analysis.bestAnswer.confidence_score
              ),
              points: analysis.bestAnswer.confidence_score,
              dynamicFields: analysis.bestAnswer.answer_fields || {}
            },
            attempts: [],
            wrongAnswers: analysis.wrongAnswers || [],
            totalAttempts: analysis.totalAttempts,
            confidence: analysis.bestAnswer.confidence_score
          }
        }
      }

      // Check Canvas answer
      let canvasQuestion = null
      if (canvasAnswers && canvasAnswers[questionId]) {
        canvasQuestion = {
          source: 'canvas',
          ...canvasAnswers[questionId],
          confidence: this.correctToScore(
            canvasAnswers[questionId].bestAnswer.correct
          ),
          wrongAnswers: canvasAnswers[questionId].attempts
            ? canvasAnswers[questionId].attempts.filter(
              attempt => attempt.correct === Correct.FALSE
            )
            : []
        }
      }

      // Choose the best answer (prioritize correct answers, then confidence)
      const enhancedIsCorrect = enhancedQuestion && enhancedQuestion.confidence >= 1.0
      const canvasIsCorrect = canvasQuestion && canvasQuestion.confidence >= 1.0

      if (enhancedIsCorrect || canvasIsCorrect) {
        // A known-correct answer exists - use it (don't ask AI)
        if (enhancedQuestion && canvasQuestion) {
          if (enhancedIsCorrect && !canvasIsCorrect) {
            enhancedAnswers[questionId] = enhancedQuestion
          } else if (canvasIsCorrect && !enhancedIsCorrect) {
            enhancedAnswers[questionId] = canvasQuestion
          } else if (enhancedQuestion.confidence >= canvasQuestion.confidence) {
            enhancedAnswers[questionId] = enhancedQuestion
            // Add canvas wrong answers too
            enhancedAnswers[questionId].wrongAnswers = [
              ...enhancedQuestion.wrongAnswers,
              ...canvasQuestion.wrongAnswers
            ]
          } else {
            enhancedAnswers[questionId] = canvasQuestion
            // Add knowledge bank wrong answers too
            enhancedAnswers[questionId].wrongAnswers = [
              ...canvasQuestion.wrongAnswers,
              ...enhancedQuestion.wrongAnswers
            ]
          }
        } else {
          enhancedAnswers[questionId] = enhancedQuestion || canvasQuestion
        }
      } else {
        // No known-correct answer: brand new OR only previous wrong attempts.
        // AI is manual - offer an "Ask AI" button instead of calling Gemini now.
        const knownWrongAnswers = [
          ...(enhancedQuestion?.wrongAnswers || []),
          ...(canvasQuestion?.wrongAnswers || [])
        ]

        if (this.aiMode) {
          // AI is manual (right-click / button) and works in stealth too.
          enhancedAnswers[questionId] = {
            source: 'ai_pending',
            aiPending: true,
            questionText: questionInfo.questionText,
            questionType: questionInfo.questionType,
            options: questionInfo.options,
            wrongAnswers: knownWrongAnswers
          }
        } else if (enhancedQuestion || canvasQuestion) {
          // AI off - show previous (wrong) record
          enhancedAnswers[questionId] = enhancedQuestion || canvasQuestion
        } else {
          // Brand new question - will be saved to knowledge bank after submission
          enhancedAnswers[questionId] = {
            source: 'new',
            isNew: true,
            questionText: questionInfo.questionText,
            questionType: questionInfo.questionType
          }
        }
      }
    }

    this.logger.info('Enhanced answers ready:', enhancedAnswers)
    return enhancedAnswers
  }

  /**
   * Extract quiz/course context (title) from the DOM for AI prompts.
   * Returns a short string, or empty string if nothing useful is found.
   */
  getQuizContext() {
    const titleElement = document.querySelector('#quiz-title, .quiz-title, h1')
    const quizTitle = titleElement?.textContent.trim()
    const pageTitle = document.title?.trim()
    return (quizTitle || pageTitle || '').replace(/\s+/g, ' ').trim()
  }

  /**
   * Extract question information from current DOM
   */
  getCurrentQuizQuestions() {
    const questions = []
    const questionIds = this.getQuestionIds()

    for (const questionId of questionIds) {
      const questionInfo = this.extractQuestionFromDOM(questionId)
      if (questionInfo) {
        questions.push({
          ...questionInfo,
          questionId
        })
      }
    }

    return questions
  }

  /**
   * Extract question details from DOM element
   */
  extractQuestionFromDOM(questionId) {
    const questionElement = document.getElementById(
      `question_${questionId}_question_text`
    )
    if (!questionElement) return null

    const questionText = questionElement.textContent.trim()

    // Get question type with safe array access
    const questionTypeElements =
      document.getElementsByClassName('question_type')
    const questionIds = this.getQuestionIds()
    const questionIndex = questionIds.indexOf(questionId)
    const questionType =
      (questionIndex >= 0 && questionIndex < questionTypeElements.length)
        ? questionTypeElements[questionIndex]?.innerText || 'unknown'
        : 'unknown'

    // Extract options for choice-based questions (incl. multiple-answer, so the
    // AI knows the exact options it must pick from)
    let options = null
    if (
      questionType === QuestionTypes.MULTIPLE_CHOICE ||
      questionType === QuestionTypes.TRUE_FALSE ||
      questionType === QuestionTypes.MULTIPLE_ANSWER
    ) {
      const optionElements = document.querySelectorAll(
        `#question_${questionId} .answer_label`
      )
      options = Array.from(optionElements).map(el => el.textContent.trim())
    }

    return {
      questionText,
      questionType,
      options,
      canvas_question_id: questionId
    }
  }

  /**
   * Enhanced display function with knowledge bank integration
   */
  async displayEnhancedAnswers(questions) {
    const pointHolders = this.getPointElements()
    const questionIds = this.getQuestionIds()
    const questionTypes = document.getElementsByClassName('question_type')
    const displayer = new EnhancedDisplayer(this.logger, this.stealthMode)
    const quizContext = this.getQuizContext()

    // Store original point text if not already stored (to restore later in cleanup)
    for (let holder of pointHolders) {
      if (holder && !holder.getAttribute('data-original-points')) {
        holder.setAttribute('data-original-points', holder.textContent.trim())
      }
    }

    // Cleanup existing badges/highlights if any
    this.cleanupDOM()

    for (let i = 0; i < questionIds.length; i++) {
      const questionType = questionTypes[i]?.innerText
      const questionId = questionIds[i]

      if (questions[questionId]) {
        const question = questions[questionId]

        try {
          // Add source badge (skip if stealth mode, and for ai_pending which uses a button)
          if (!this.stealthMode && question.source !== 'ai_pending') {
            this.addSourceBadge(questionId, question.source)
          }

          // Skip display for new questions (just show badge)
          if (question.isNew) {
            this.logger.info(`New question ${questionId} - showing badge only`)
            continue
          }

          // AI-answered question - match by option text, not Canvas answer id
          if (question.source === 'ai') {
            displayer.displayAIAnswer(question, questionId, questionType)
            continue
          }

          // No known answer - flag any prior wrong answers and register for manual AI
          // (right-click trigger, plus an "Ask AI" button when not in stealth).
          if (question.aiPending) {
            if (!this.stealthMode && question.wrongAnswers && question.wrongAnswers.length > 0) {
              displayer.highlightAllWrongAnswers(question, questionId)
            }
            this.registerAIQuestion(questionId, question, questionType, displayer, quizContext)
            continue
          }

          // Display using enhanced displayer (badges only, no auto-selection)
          switch (questionType) {
            case QuestionTypes.ESSAY_QUESTION:
              displayer.displayEssay(question, questionId, false) // No auto-fill, badges only
              break
            case QuestionTypes.MATCHING:
              displayer.displayMatching(question, questionId)
              break
            case QuestionTypes.MULTIPLE_DROPDOWN:
              displayer.displayMultipleDropdowns(question, questionId)
              break
            case QuestionTypes.MULTIPLE_ANSWER:
              displayer.displayMultipleAnswer(question, questionId, false) // No auto-selection, badges only
              break
            case QuestionTypes.MULTIPLE_CHOICE:
            case QuestionTypes.TRUE_FALSE:
              displayer.displayMultipleChoice(question, questionId, false) // No auto-selection, badges only
              break
            case QuestionTypes.FILL_IN_BLANK:
            case QuestionTypes.FORMULA_QUESTION:
            case QuestionTypes.NUMERICAL_ANSWER:
              displayer.displayFillInBlank(question, questionId, false) // No auto-fill, badges only
              break
            case QuestionTypes.FILL_IN_MULTIPLE_BLANKS:
              displayer.displayFillInMultipleBlank(question, questionId)
              break
          }

          // Update point display (skip if stealth mode)
          if (!this.stealthMode && pointHolders[i] && question.bestAnswer) {
            const points = question.bestAnswer.points || 0
            const earnedPoints = Math.round(points * 100) / 100
            const sourceClass =
              question.source === 'knowledge_bank'
                ? 'knowledge-bank-answer'
                : question.source === 'canvas'
                  ? 'canvas-answer'
                  : 'new-question'
            pointHolders[i].classList.add(sourceClass)

            // Safe HTML creation to prevent XSS
            const sourceSpan = document.createElement('span')
            sourceSpan.className = 'answer-source'
            sourceSpan.textContent = `[${question.source.toUpperCase()}]`

            const confidencePercent = (question.confidence * 100).toFixed(0)
            const pointsText = document.createTextNode(` ${earnedPoints} pts (${confidencePercent}% confidence)`)

            pointHolders[i].innerHTML = '' // Clear existing content
            pointHolders[i].appendChild(sourceSpan)
            pointHolders[i].appendChild(pointsText)
          }
        } catch (e) {
          this.logger.error(`Failed to display question ${questionId}:`, e)
        }
      } else {
        // New question
        if (!this.stealthMode && pointHolders[i]) {
          pointHolders[
            i
          ].innerText = `(New Question) ${pointHolders[i].innerText}`
        }
      }
    }

    // Auto-capture all questions after displaying (compile questions with badges)
    this.logger.info('📸 Auto-capturing questions for compilation...')
    const courseId = this.extractCourseIdFromURL()
    if (courseId) {
      await this.questionCompiler.captureAllQuestions(
        this.extractQuizIdFromURL(),
        courseId,
        questionIds
      )
    }
  }

  /**
   * Add source badge to question
   */
  addSourceBadge(questionId, source) {
    const questionElement = document.getElementById(
      `question_${questionId}_question_text`
    )
    if (
      questionElement &&
      !questionElement.querySelector('.answer-source-badge')
    ) {
      const badge = document.createElement('div')
      badge.className = `answer-source-badge ${source}-source`

      let badgeIcon, badgeText, badgeColor
      switch (source) {
        case 'knowledge_bank':
          badgeIcon = '🏦'
          badgeText = 'Knowledge Bank'
          badgeColor = '#4CAF50'
          break
        case 'canvas':
          badgeIcon = '🎯'
          badgeText = 'Your History'
          badgeColor = '#2196F3'
          break
        case 'new':
          badgeIcon = '✨'
          badgeText = 'New Question'
          badgeColor = '#FF9800'
          break
        case 'ai':
          badgeIcon = '🤖'
          badgeText = 'AI'
          badgeColor = '#9C27B0'
          break
        default:
          badgeIcon = '❓'
          badgeText = 'Unknown'
          badgeColor = '#666'
      }

      // Safe HTML creation to prevent XSS
      const iconSpan = document.createElement('span')
      iconSpan.className = 'badge-icon'
      iconSpan.textContent = badgeIcon

      const textSpan = document.createElement('span')
      textSpan.className = 'badge-text'
      textSpan.textContent = badgeText

      badge.appendChild(iconSpan)
      badge.appendChild(textSpan)

      badge.style.cssText = `
                display: inline-flex;
                align-items: center;
                gap: 4px;
                background: ${badgeColor};
                color: white;
                padding: 2px 8px;
                border-radius: 12px;
                font-size: 11px;
                font-weight: bold;
                margin-left: 8px;
                vertical-align: middle;
            `
      questionElement.appendChild(badge)
    }
  }

  /**
   * Register a question that has no known answer for manual AI.
   * Trigger is a right-click (always) plus an "Ask AI" button when not in stealth.
   * Gemini is only called on trigger, so requests are user-paced (avoids 503 bursts).
   */
  registerAIQuestion(questionId, question, questionType, displayer, quizContext) {
    if (this.aiRegistry.has(questionId)) return

    const entry = {
      question,
      questionType,
      displayer,
      quizContext,
      button: null,
      state: 'idle', // idle | asking | done | failed
      requestId: null
    }
    this.aiRegistry.set(questionId, entry)

    // Visible button only when not in stealth.
    if (this.stealthMode) return

    const questionElement = document.getElementById(
      `question_${questionId}_question_text`
    )
    if (!questionElement || questionElement.querySelector('.ai-ask-button')) {
      return
    }

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ai-ask-button answer-source-badge'
    button.textContent = '🤖 Ask AI'
    button.style.cssText = `
                display: inline-flex;
                align-items: center;
                gap: 4px;
                background: #9C27B0;
                color: white;
                border: none;
                padding: 3px 10px;
                border-radius: 12px;
                font-size: 11px;
                font-weight: bold;
                margin-left: 8px;
                vertical-align: middle;
                cursor: pointer;
            `
    button.addEventListener('click', () => this.triggerAI(questionId))
    questionElement.appendChild(button)
    entry.button = button
  }

  /**
   * Update an AI entry's button appearance (no-op in stealth where there is no button).
   */
  setAIButtonState(entry, text, color, disabled) {
    if (!entry.button) return
    entry.button.textContent = text
    entry.button.style.background = color
    entry.button.style.cursor = disabled ? 'wait' : 'pointer'
    entry.button.disabled = disabled
  }

  /**
   * Trigger the AI request for a question. In-flight -> ignored; failed -> retry.
   * Starting a question aborts any other still-in-flight request.
   */
  async triggerAI(questionId) {
    debugOverlay(`triggerAI: ${questionId}`)
    const entry = this.aiRegistry.get(questionId)
    if (!entry) {
      debugOverlay('triggerAI: no registry entry - exiting')
      return
    }

    if (entry.state === 'asking') {
      this.logger.info(`AI already running for ${questionId} - ignoring`)
      return
    }
    if (entry.state === 'done') {
      this.logger.info(`AI already answered ${questionId} - ignoring`)
      return
    }

    // Moving to (asking) another question cancels any other in-flight request.
    this.abortAllAIRequests(questionId)

    const requestId = crypto.randomUUID()
    entry.requestId = requestId
    entry.state = 'asking'
    this.setAIButtonState(entry, '🤖 Asking AI…', '#7B1FA2', true)

    const questionInfo = {
      questionText: entry.question.questionText,
      questionType: entry.question.questionType,
      options: entry.question.options
    }

    debugOverlay('triggerAI: state=asking, getting deviceId')
    const deviceId = await this.dbManager.getDeviceId()
    debugOverlay(`triggerAI: deviceId ${deviceId ? 'ok' : 'MISSING'}`)
    const result = await askGemini(
      questionInfo,
      entry.quizContext,
      deviceId,
      this.logger,
      requestId
    )

    debugOverlay(`triggerAI: askGemini returned status=${result.status}`)
    // Discard if this request was superseded/aborted (entry reused or registry cleared).
    if (entry.requestId !== requestId) {
      debugOverlay('triggerAI: request superseded - discarding')
      return
    }
    if (result.status === 'aborted') {
      entry.state = 'idle'
      this.setAIButtonState(entry, '🤖 Ask AI', '#9C27B0', false)
      return
    }

    if (result.status === 'ok') {
      entry.state = 'done'
      entry.requestId = null
      const aiQuestion = {
        source: 'ai',
        bestAnswer: {
          text: result.answer,
          correct: Correct.TRUE,
          points: 0,
          dynamicFields: {}
        },
        wrongAnswers: entry.question.wrongAnswers || []
      }
      if (entry.button) {
        entry.button.remove()
        entry.button = null
      }
      debugOverlay('triggerAI: displaying AI answer in DOM')
      entry.displayer.displayAIAnswer(aiQuestion, questionId, entry.questionType)
      debugOverlay('triggerAI: DOM updated')
      // Badge only when not in stealth (stealth uses the divider-fade tell).
      if (!this.stealthMode) {
        this.addSourceBadge(questionId, 'ai')
      }

      // Re-snapshot this question so the AI answer is captured for export
      try {
        const captureStart = performance.now()
        await this.questionCompiler.captureQuestion(
          questionId,
          this.extractQuizIdFromURL(),
          this.extractCourseIdFromURL()
        )
        this.logger.info(`📸 AI question re-capture: ${Math.round(performance.now() - captureStart)}ms`)
      } catch (e) {
        this.logger.warn(`Failed to re-capture AI question ${questionId}:`, e)
      }
    } else {
      // Failed - allow retry (button turns red; right-click re-triggers in stealth).
      entry.state = 'failed'
      entry.requestId = null
      this.setAIButtonState(entry, '🔄 Retry AI', '#D32F2F', false)
    }
  }

  /**
   * Abort all in-flight AI requests, optionally skipping one questionId.
   */
  abortAllAIRequests(exceptQuestionId = null) {
    for (const [id, entry] of this.aiRegistry) {
      if (id === exceptQuestionId) continue
      if (entry.state === 'asking' && entry.requestId) {
        abortGeminiRequest(entry.requestId)
        entry.requestId = null
        entry.state = 'idle'
        this.setAIButtonState(entry, '🤖 Ask AI', '#9C27B0', false)
      }
    }
  }

  /**
   * Right-click handler: trigger/retry a question's AI answer.
   * One question per page -> right-click anywhere triggers the single pending one.
   * Multiple on page -> must right-click on the target question. If the click
   * isn't on a pending AI question, do nothing and let the native menu show.
   */
  handleRightClick(event) {
    // One question per page: right-click anywhere suppresses the native menu.
    // Triggers AI if pending; otherwise silently ignored (answered/fetching).
    if (this.getQuestionIds().length <= 1) {
      event.preventDefault()
      const onlyId = [...this.aiRegistry.keys()][0]
      if (onlyId) this.triggerAI(onlyId)
      return
    }

    // Multiple questions on page: only over a question element. Right-clicking a
    // question suppresses its menu whether or not AI is needed; acts only if pending.
    const container = event.target?.closest?.('.display_question, .question')
    if (!container) return // not on a question - let the native menu show

    event.preventDefault()
    const questionId = container.id?.replace('question_', '')
    if (questionId && this.aiRegistry.has(questionId)) {
      this.triggerAI(questionId)
    }
  }

  /**
   * Mobile double-tap: same targeting as right-click.
   * One question per page -> double-tap anywhere; multiple -> on the question block.
   * preventDefault only when triggering, so normal taps (inputs, links) still work.
   */
  handleDoubleTap(event) {
    if (this.getQuestionIds().length <= 1) {
      const onlyId = [...this.aiRegistry.keys()][0]
      if (onlyId) {
        event.preventDefault() // suppress double-tap zoom / synthesized click
        this.triggerAI(onlyId)
      }
      return
    }

    const container = event.target?.closest?.('.display_question, .question')
    if (!container) return

    const questionId = container.id?.replace('question_', '')
    if (questionId && this.aiRegistry.has(questionId)) {
      event.preventDefault()
      this.triggerAI(questionId)
    }
  }

  /**
   * Cleanup badges and highlights from the DOM
   */
  cleanupDOM() {
    this.logger.info('🧹 Cleaning up DOM badges and highlights...')

    // Abort any in-flight AI requests and clear the registry before a re-render
    this.abortAllAIRequests()
    this.aiRegistry.clear()

    // Remove source badges
    document.querySelectorAll('.answer-source-badge').forEach(el => el.remove())

    // Remove correct/wrong answer badges
    document
      .querySelectorAll('.correct-answer-badge, .wrong-answer-badge, .ai-answer-badge')
      .forEach(el => el.remove())

    // Remove source highlights from point holders
    const pointHolders = this.getPointElements()
    for (let holder of pointHolders) {
      holder.classList.remove(
        'knowledge-bank-answer',
        'canvas-answer',
        'new-question'
      )
      // Reset point holder text if it was modified
      const originalPoints = holder.getAttribute('data-original-points')
      if (originalPoints && holder.querySelector('.answer-source')) {
        holder.textContent = originalPoints
        holder.innerHTML = originalPoints // Ensure any inner spans are gone
      } else if (holder.querySelector('.answer-source')) {
        // Fallback if data attribute missing
        holder.innerHTML = holder.textContent
          .replace(/\[.*\]\s*/, '')
          .replace(/\s*\(.*confidence\)/, '')
      }
    }

    // Remove stealth divider fades (restore Canvas's default answer border)
    document.querySelectorAll('.stealth-fade-cover').forEach(el => el.remove())
    document.querySelectorAll('.answer').forEach(answer => {
      if (answer.style.borderImage) {
        answer.style.borderImage = ''
        answer.style.borderTopStyle = ''
        answer.style.position = ''
      }
    })

    // Reset input styles
    document.querySelectorAll('input, textarea').forEach(el => {
      el.style.borderColor = ''
      // We don't easily know the original placeholder, but we can clear it if it contains our markers
      if (
        el.placeholder &&
        (el.placeholder.includes('Correct answer:') ||
          el.placeholder.includes('Previously wrong:') ||
          el.placeholder.includes('Previously attempted:'))
      ) {
        el.placeholder = ''
      }
    })

    // Remove preview panel if any
    const panel = document.getElementById('quiz-preview-panel')
    if (panel) panel.remove()
  }

  // ==================== HELPER FUNCTIONS ====================

  scoreToCorrect(score) {
    if (score >= 1.0) return Correct.TRUE
    if (score >= 0.3) return Correct.PARTIAL
    return Correct.FALSE
  }

  correctToScore(correct) {
    switch (correct) {
      case Correct.TRUE:
        return 1.0
      case Correct.PARTIAL:
        return 0.5
      case Correct.FALSE:
        return 0.0
      default:
        return 0.0
    }
  }

  getQuestionIds() {
    const questionIds = []
    const questionTextEls = document.getElementsByClassName(
      'original_question_text'
    )
    for (let el of questionTextEls) {
      // Safe DOM element access with null checks
      const nextEl = el.nextElementSibling
      if (nextEl && nextEl.id && typeof nextEl.id === 'string') {
        const idParts = nextEl.id.split('_')
        if (idParts.length > 1 && idParts[1]) {
          const questionId = parseInt(idParts[1])
          if (!isNaN(questionId)) {
            questionIds.push(questionId)
          }
        }
      }
    }
    return questionIds
  }

  getPointElements() {
    const pointHolders = document.getElementsByClassName(
      'question_points_holder'
    )
    let cleanPointHolders = []
    for (let pointHolder of pointHolders) {
      const classList = pointHolder.parentElement.classList
      for (let i = 0; i < classList.length; i++) {
        if (classList[i] == 'header') {
          cleanPointHolders.push(pointHolder)
          break
        }
      }
    }
    return cleanPointHolders
  }

  extractCourseIdFromURL() {
    const match = window.location.href.match(/courses\/(\d+)/)
    return match ? parseInt(match[1]) : null
  }

  extractQuizIdFromURL() {
    const match = window.location.href.match(/quizzes\/(\d+)/)
    return match ? parseInt(match[1]) : null
  }

  // ==================== ORIGINAL API FUNCTIONS ====================

  async getQuizSubmissions(courseId, quizId, baseUrl) {
    const quizUrl = `${baseUrl}api/v1/courses/${courseId}/quizzes/${quizId}/`
    const submissionsURL = quizUrl + 'submissions'

    this.logger.info('🌐 Canvas API Call 1: Fetching quiz details and submissions...')
    this.logger.info(`Quiz URL: ${quizUrl}`)
    this.logger.info(`Submissions URL: ${submissionsURL}`)

    const [resQuiz, resSubmissions] = await Promise.all([
      fetch(quizUrl),
      fetch(submissionsURL)
    ])

    this.logger.info(`📊 Canvas API Response 1: Quiz status ${resQuiz.status}, Submissions status ${resSubmissions.status}`)

    const [rawQuiz, rawSubmissions] = await Promise.all([
      resQuiz.text(),
      resSubmissions.text()
    ])

    let quiz, submissions
    try {
      quiz = JSON.parse(rawQuiz)
      submissions = JSON.parse(rawSubmissions).quiz_submissions

      this.logger.info('✅ Canvas API Call 1 Success:')
      this.logger.info(`- Quiz title: "${quiz.title || 'Unknown'}"`)
      this.logger.info(`- Assignment ID: ${quiz.assignment_id || 'None (practice quiz)'}`)
      this.logger.info(`- Total submissions found: ${submissions?.length || 0}`)

    } catch (error) {
      this.logger.error('❌ Failed to parse Canvas API response:', error)
      this.logger.error('Raw quiz response:', rawQuiz.substring(0, 200) + '...')
      this.logger.error('Raw submissions response:', rawSubmissions.substring(0, 200) + '...')
      return []
    }

    if (!submissions?.length) {
      this.logger.info('📭 No submissions found for this quiz')
      return []
    }

    const assignmentId = quiz.assignment_id
    const userId = submissions.at(-1).user_id

    if (!assignmentId) {
      this.logger.info('🎯 No assignment id found. This is a practice quiz')
      return []
    } else if (!userId) {
      this.logger.error('❌ Unable to retrieve userId from submissions')
      throw new Error('Unable to retrieve userId')
    }

    this.logger.info(`👤 Found user ID: ${userId} for assignment ${assignmentId}`)

    const submissionsHistoryUrl = `${baseUrl}api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}?include[]=submission_history`

    this.logger.info('🌐 Canvas API Call 2: Fetching submission history...')
    this.logger.info(`Submission History URL: ${submissionsHistoryUrl}`)

    return fetch(submissionsHistoryUrl)
      .then(res => {
        this.logger.info(`📊 Canvas API Response 2: Submission history status ${res.status}`)
        return res.text()
      })
      .then(res => {
        try {
          const submissionHistory = JSON.parse(res).submission_history
          this.logger.info('✅ Canvas API Call 2 Success:')
          this.logger.info(`- Submission history entries: ${submissionHistory?.length || 0}`)

          if (submissionHistory?.length > 0) {
            const totalQuestions = submissionHistory.reduce((total, submission) => {
              return total + (submission.submission_data?.length || 0)
            }, 0)
            this.logger.info(`- Total question attempts found: ${totalQuestions}`)
          }

          return submissionHistory
        } catch (error) {
          this.logger.error('❌ Failed to parse submission history:', error)
          this.logger.error('Raw submission history response:', res.substring(0, 200) + '...')
          return []
        }
      })
  }

  getCorrectAnswers(submissions) {
    if (!submissions || !submissions.length || !submissions[0]?.submission_data) {
      return null
    }

    const questions = {}
    for (let i = 0; i < submissions.length; i++) {
      const submission = submissions[i]
      for (let questionSubmissionRaw of submission.submission_data) {
        const questionId = questionSubmissionRaw.question_id
        let correct

        if (questionSubmissionRaw.correct === true) correct = Correct.TRUE
        else if (questionSubmissionRaw.correct === false)
          correct = Correct.FALSE
        else if (questionSubmissionRaw.correct === 'partial')
          correct = Correct.PARTIAL

        const questionSubmission = {
          correct: correct,
          text: questionSubmissionRaw.text,
          points: questionSubmissionRaw.points,
          dynamicFields: pickBy(questionSubmissionRaw, (value, key) =>
            key.startsWith('answer')
          )
        }

        if (!(questionId in questions)) {
          questions[questionId] = {
            attempts: [],
            bestAnswer: questionSubmission,
            latestAnswer: questionSubmission
          }
        }

        const question = questions[questionId]
        question.attempts.push(questionSubmission)

        if (
          questionSubmissionRaw.correct === true ||
          question.bestAnswer.points < questionSubmissionRaw.points
        ) {
          question.bestAnswer = questionSubmission
        }
      }
    }

    return questions
  }

  // ==================== PREVIEW PANEL METHODS ====================

  /**
   * Show preview panel on quiz description pages
   */
  async showPreviewPanel(courseId, quizId, baseUrl) {
    try {
      await this.init()

      // Skip preview panel in stealth mode
      if (this.stealthMode) {
        this.logger.info('Stealth mode is ON - skipping preview panel')
        return
      }

      this.logger.info('Showing preview panel for quiz:', quizId)

      // Validate inputs
      if (!courseId || !quizId || !baseUrl) {
        throw new Error('Missing required parameters for preview panel')
      }
      // Get Canvas submissions with error handling
      let canvasSubmissions = []
      let canvasAnswers = {}

      try {
        canvasSubmissions = await this.getQuizSubmissions(
          courseId,
          quizId,
          baseUrl
        )
        canvasAnswers = canvasSubmissions
          ? this.getCorrectAnswers(canvasSubmissions) || {}
          : {}
      } catch (canvasError) {
        this.logger.warn('Failed to fetch Canvas submissions:', canvasError.message)
        // Continue with empty Canvas data - preview panel will still show knowledge bank data
      }

      // Populate knowledge bank with Canvas submissions (optimized batch processing)
      if (canvasSubmissions && canvasSubmissions.length > 0) {
        this.logger.info('Populating knowledge bank from quiz description page...')
        const quizData = {
          course_name: document.title || `Course ${courseId}`,
          quiz_name: `Quiz ${quizId}`,
          assignment_id: null,
          base_url: baseUrl
        }

        // Note: We don't have DOM questions on description page, so pass empty array
        // The batch processing will use fallback question text from Canvas API
        await this.dbManager.processCanvasSubmissionsWithQuestionData(
          courseId,
          quizId,
          canvasSubmissions,
          quizData,
          [] // Empty DOM questions array - will use Canvas fallback text
        )
        this.logger.info('Knowledge bank populated from description page')
      }

      // Get Knowledge Bank data for the course
      const courseKnowledgeBase = await this.dbManager.getCourseKnowledgeBase(
        courseId
      )

      // Get Global Knowledge Bank question count (fast)
      const globalQuestionCount = await this.dbManager.getGlobalQuestionCount()

      // Filter for questions that might be related to this quiz (or show all course knowledge)
      const knowledgeBankData = courseKnowledgeBase.map(item => ({
        question_hash: item.question.question_hash,
        question_text: item.question.question_text,
        question_type: item.question.question_type,
        confidence_score: item.bestAnswer
          ? item.bestAnswer.confidence_score
          : 0,
        answer_text: item.bestAnswer ? item.bestAnswer.answer_text : null
      }))

      // Create preview panel
      this.createPreviewPanel(
        courseId,
        quizId,
        canvasAnswers,
        knowledgeBankData,
        globalQuestionCount
      )
    } catch (error) {
      this.logger.error('Error showing preview panel:', error)
      // Re-throw ACCESS_REVOKED errors so outer handler can show activation panel
      if (error.code === 'ACCESS_REVOKED' || (error.message && error.message.includes('access has been revoked'))) {
        throw error
      }
    }
  }

  /**
   * Create and display the preview panel
   */
  createPreviewPanel(courseId, quizId, canvasAnswers, knowledgeBankData, globalQuestionCount = 0) {
    // Remove existing panel if any
    const existingPanel = document.getElementById('quiz-preview-panel')
    if (existingPanel) {
      existingPanel.remove()
    }

    // Calculate stats
    const canvasStats = this.calculateCanvasStats(canvasAnswers)
    const kbStats = this.calculateKnowledgeBankStats(knowledgeBankData)
    const globalStats = { totalQuestions: typeof globalQuestionCount === 'number' ? globalQuestionCount : 0 }

    // Create panel element
    const panel = document.createElement('div')
    panel.id = 'quiz-preview-panel'
    panel.className = 'database-status'
    panel.style.cssText = `
                    position: fixed;
            top: 10px;
            right: 10px;
            background: rgba(255, 255, 255, 0.98);
            border: 2px solid #ddd;
            border-radius: 12px;
            padding: 16px;
            font-size: 13px;
            width: 460px;
            max-width: 90vw;
            z-index: 1000;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
            backdrop-filter: blur(5px);
        `

    panel.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                <h4 style="margin: 0; color: #333; font-size: 16px; display: flex; align-items: center; gap: 8px;">
                    QuizBank
                </h4>
                <button id="close-preview-panel" style="
                    background: none;
                    border: none;
                    font-size: 18px;
                    cursor: pointer;
                    color: #666;
                    padding: 2px;
                    line-height: 1;
                    border-radius: 4px;
                    transition: all 0.2s ease;
                " onmouseover="this.style.background='#f0f0f0'; this.style.color='#333';" 
                   onmouseout="this.style.background='none'; this.style.color='#666';"
                   title="Close panel">✕</button>
                                </div>

            <!-- Stats Columns Wrapper (2 Columns) -->
            <div style="display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 12px;">
                <!-- This Quiz Section -->
                <div style="flex: 1; min-width: 200px;">
                    <h5 style="margin: 0 0 8px 0; color: #2196F3; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                        🎯 This Quiz
                    </h5>
                    <div class="status-item">
                        <span class="status-label">Questions Attempted:</span>
                        <span class="status-value">${canvasStats.totalQuestions}</span>
                    </div>
                    <div class="status-item">
                        <span class="status-label">Correct Answers:</span>
                        <span class="status-value" style="color: #4CAF50;">${canvasStats.correctAnswers}</span>
                    </div>
                    <div class="status-item">
                        <span class="status-label">Wrong Answers:</span>
                        <span class="status-value" style="color: #F44336;">${canvasStats.wrongAnswers}</span>
                    </div>
                    <div class="status-item">
                        <span class="status-label">Success Rate:</span>
                        <span class="status-value">${canvasStats.successRate}%</span>
                    </div>
                    <button id="export-quiz-btn" style="
                        width: 100%;
                        background: linear-gradient(135deg, #2196F3, #1976D2);
                        color: white;
                        border: none;
                        padding: 8px 12px;
                        border-radius: 6px;
                        font-size: 11px;
                        font-weight: bold;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        margin-top: 10px;
                    " onmouseover="this.style.opacity='0.9';" 
                       onmouseout="this.style.opacity='1';">
                        📥 Export This Quiz Questions
                    </button>
                </div>
                
                <!-- This Course Section -->
                <div style="flex: 1; min-width: 200px;">
                    <h5 style="margin: 0 0 8px 0; color: #4CAF50; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                        🏦 This Course
                    </h5>
                    <div class="status-item">
                        <span class="status-label">Known Questions:</span>
                        <span class="status-value">${kbStats.totalQuestions}</span>
                    </div>
                    <div class="status-item">
                        <span class="status-label">High Confidence:</span>
                        <span class="status-value" style="color: #4CAF50;">${kbStats.highConfidence}</span>
                    </div>
                    <div class="status-item">
                        <span class="status-label">Medium Confidence:</span>
                        <span class="status-value" style="color: #FF9800;">${kbStats.mediumConfidence}</span>
                    </div>
                    <div class="status-item">
                        <span class="status-label">Low Confidence:</span>
                        <span class="status-value" style="color: #F44336;">${kbStats.lowConfidence}</span>
                    </div>
                    <button id="export-course-btn" style="
                        width: 100%;
                        background: linear-gradient(135deg, #4CAF50, #45a049);
                        color: white;
                        border: none;
                        padding: 8px 12px;
                        border-radius: 6px;
                        font-size: 11px;
                        font-weight: bold;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        margin-top: 10px;
                    " onmouseover="this.style.opacity='0.9';" 
                       onmouseout="this.style.opacity='1';">
                        📥 Export This Course Questions
                    </button>
                </div>
            </div>

            <!-- Export Filters -->
            <div style="margin-bottom: 16px; padding: 10px; background: #f8f9fa; border-radius: 8px; border: 1px solid #e0e0e0;">
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 6px; font-weight: 600;">
                    📚 Export Filter:
                </label>
                <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
                    <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer;">
                        <input type="checkbox" id="filter-correct" checked style="cursor: pointer; width: 13px; height: 13px;">
                        <span>✅ Correct</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer;">
                        <input type="checkbox" id="filter-wrong" checked style="cursor: pointer; width: 13px; height: 13px;">
                        <span>🚫 Wrong</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer;">
                        <input type="checkbox" id="filter-new" checked style="cursor: pointer; width: 13px; height: 13px;">
                        <span>✨ New/Partial/Unknown</span>
                    </label>
                </div>
            </div>

            <!-- AI Source Material Context Section -->
            <div id="panel-ai-context-section" style="display: ${this.aiMode ? 'block' : 'none'}; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #eee;">
                <h5 style="margin: 0 0 8px 0; color: #ff9800; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                    🧠 AI Source Material
                </h5>
                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <div style="flex: 1; min-width: 0;">
                        <select id="panel-ai-context-course" style="
                            width: 100%;
                            padding: 6px;
                            border-radius: 6px;
                            border: 1px solid #ccc;
                            font-size: 11px;
                            background: white;
                            color: #333;
                            cursor: pointer;
                        ">
                            <option value="">General knowledge (no material)</option>
                        </select>
                    </div>
                    <div id="panel-ai-context-module-container" style="display: none; flex: 1; min-width: 0;">
                        <select id="panel-ai-context-module" style="
                            width: 100%;
                            padding: 6px;
                            border-radius: 6px;
                            border: 1px solid #ccc;
                            font-size: 11px;
                            background: white;
                            color: #333;
                            cursor: pointer;
                        ">
                            <option value="">Add module...</option>
                        </select>
                    </div>
                </div>
                <!-- Selected Module Badges -->
                <div id="panel-ai-context-module-badges" style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px;"></div>
                <div id="panel-ai-context-hint" style="font-size: 10px; color: #666; font-style: italic;">
                    Loading course materials...
                </div>

                <!-- Own Uploads Section -->
                <div style="border-top: 1px dashed #cbd5e1; padding-top: 10px; margin-top: 10px;">
                    <h6 style="margin: 0 0 6px 0; color: #475569; font-size: 11px; font-weight: 600; display: flex; align-items: center; justify-content: space-between;">
                        <span>📁 Own Uploads (PDF Notes)</span>
                        <label style="cursor: pointer; color: #2196F3; font-weight: bold; font-size: 11px; display: flex; align-items: center; gap: 4px; margin: 0;">
                            📤 Upload PDF
                            <input type="file" id="panel-own-uploads-input" multiple accept=".pdf" style="display: none;">
                        </label>
                    </h6>
                    <div id="panel-own-uploads-list" style="max-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding-right: 4px; margin-top: 6px;">
                        <!-- Files will be listed here -->
                    </div>
                </div>
            </div>

            <!-- QuizBank Vault Section -->
            <div style="margin-bottom: 16px;">
                <h5 style="margin: 0 0 8px 0; color: #9C27B0; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                    🏦 QuizBank Vault
                </h5>
                <div class="status-item">
                    <span class="status-label">Registered Questions:</span>
                    <span class="status-value">${globalStats.totalQuestions}</span>
                </div>
            </div>

            <!-- Update Available Button (hidden by default) -->
            <a href="https://quizbankorg.github.io/quizbank/" target="_blank" id="panel-update-btn" style="
                display: none;
                align-items: center;
                justify-content: center;
                gap: 8px;
                margin-bottom: 12px;
                padding: 10px 18px;
                background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
                color: white;
                text-decoration: none;
                border-radius: 8px;
                font-size: 13px;
                box-shadow: 0 2px 8px rgba(245, 158, 11, 0.3);
            ">
                <span>🆕</span>
                <span>New Update Available</span>
            </a>

            <div style="padding-top: 8px; font-size: 11px; color: #666; text-align: center; border-top: 1px solid #eee;">
                QuizBank Active ✨ <span style="color: #999;">v${browser.runtime.getManifest().version}</span>
            </div>
                            </div>
        `

    // Add to page
    document.body.appendChild(panel)

    // Add close button functionality
    const closeButton = document.getElementById('close-preview-panel')
    if (closeButton) {
      closeButton.addEventListener('click', () => {
        panel.style.transition = 'all 0.3s ease'
        panel.style.opacity = '0'
        panel.style.transform = 'translateX(20px)'
        setTimeout(() => {
          panel.remove()
        }, 300)
      })
    }

    // Setup AI Context Picker on the panel (async)
    (async () => {
      const courseSelect = document.getElementById('panel-ai-context-course')
      const moduleSelect = document.getElementById('panel-ai-context-module')
      const moduleContainer = document.getElementById('panel-ai-context-module-container')
      const hint = document.getElementById('panel-ai-context-hint')

      if (!courseSelect || !moduleSelect) return
      if (!this.aiMode) return

      let catalog = []

      try {
        const deviceId = await this.dbManager.getDeviceId()
        const response = await browser.runtime.sendMessage({
          type: 'quizbank-get-materials',
          deviceId
        })
        catalog = (response && response.ok && Array.isArray(response.courses)) ? response.courses : []
      } catch (e) {
        this.logger.error('Error fetching materials catalog:', e)
      }

      if (catalog.length === 0) {
        hint.textContent = 'No course materials available yet.'
        return
      }

      // Populate courses
      courseSelect.innerHTML = '<option value="">General knowledge (no material)</option>' +
        catalog.map(item => `<option value="${item.course}">${item.course}</option>`).join('')

      // Restore saved selection
      const saved = await browser.storage.local.get(['quizbank_ai_context'])
      const savedContext = saved.quizbank_ai_context || { course: '', module: '' }

      const badgesContainer = document.getElementById('panel-ai-context-module-badges')
      let selectedModules = []

      if (savedContext.module) {
        selectedModules = savedContext.module.split(',').map(m => m.trim()).filter(Boolean)
      }

      const persist = () => {
        browser.storage.local.set({
          quizbank_ai_context: {
            course: courseSelect.value,
            module: selectedModules.join(',')
          }
        })
      }

      const renderModuleBadges = (course) => {
        if (!badgesContainer) return
        badgesContainer.innerHTML = ''

        selectedModules.forEach(mod => {
          const badge = document.createElement('span')
          badge.style.cssText = `
            background: #f1f5f9;
            border: 1px solid #cbd5e1;
            border-radius: 4px;
            padding: 2px 6px;
            font-size: 10px;
            color: #475569;
            display: flex;
            align-items: center;
            gap: 4px;
            user-select: none;
          `
          badge.innerHTML = `
            Module ${mod}
            <span class="remove-module" data-module="${mod}" style="cursor: pointer; font-weight: bold; color: #94a3b8; line-height: 1;">✕</span>
          `

          badge.querySelector('.remove-module').addEventListener('click', (e) => {
            const modToRemove = e.target.getAttribute('data-module')
            selectedModules = selectedModules.filter(m => m !== modToRemove)
            renderModuleBadges(course)
            renderModuleDropdown(course)
            persist()
          })

          badgesContainer.appendChild(badge)
        })
      }

      const renderModuleDropdown = (course) => {
        const entry = catalog.find(item => item.course === course)
        const allModules = entry ? entry.modules : []
        const availableModules = allModules.filter(m => !selectedModules.includes(m))

        moduleSelect.innerHTML = '<option value="">Add module...</option>' +
          availableModules.map(module => `<option value="${module}">Module ${module}</option>`).join('')

        moduleSelect.value = ''
        moduleContainer.style.display = (course && allModules.length > 0) ? 'block' : 'none'
      }

      if (savedContext.course) {
        courseSelect.value = savedContext.course
        renderModuleDropdown(savedContext.course)
        renderModuleBadges(savedContext.course)
        hint.textContent = 'The AI will use this material as context.'
      } else {
        hint.textContent = 'Pick a course to have the AI use your uploaded material.'
      }

      courseSelect.addEventListener('change', () => {
        selectedModules = []
        renderModuleDropdown(courseSelect.value)
        renderModuleBadges(courseSelect.value)
        hint.textContent = courseSelect.value
          ? 'The AI will use this material as context.'
          : 'Pick a course to have the AI use your uploaded material.'
        persist()
      })

      moduleSelect.addEventListener('change', () => {
        const chosen = moduleSelect.value
        if (chosen) {
          if (!selectedModules.includes(chosen)) {
            selectedModules.push(chosen)
            selectedModules.sort()
          }
          renderModuleDropdown(courseSelect.value)
          renderModuleBadges(courseSelect.value)
          persist()
        }
      })

      // --- Local Notes Own Uploads Logic ---
      const fileInput = document.getElementById('panel-own-uploads-input')
      const uploadsList = document.getElementById('panel-own-uploads-list')

      const loadOwnUploads = async () => {
        if (!uploadsList) return
        
        try {
          const deviceId = await this.dbManager.getDeviceId()
          
          uploadsList.innerHTML = '<div style="font-size: 10px; color: #94a3b8; font-style: italic; text-align: center; padding: 6px 0;">Loading notes...</div>'

          const response = await browser.runtime.sendMessage({
            type: 'quizbank-get-user-notes',
            deviceId
          })

          const files = (response && response.ok && Array.isArray(response.notes)) ? response.notes : []
          await browser.storage.local.set({ quizbank_user_notes: files })
          const stored = await browser.storage.local.get(['quizbank_selected_user_files'])
          const selectedIds = (stored.quizbank_selected_user_files || []).map(Number)

          if (files.length === 0) {
            uploadsList.innerHTML = '<div style="font-size: 10px; color: #94a3b8; font-style: italic; text-align: center; padding: 6px 0;">No uploads yet.</div>'
            return
          }

          uploadsList.innerHTML = files.map(file => {
            const isChecked = selectedIds.includes(Number(file.id)) ? 'checked' : ''
            return `
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 6px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 11px; margin-bottom: 2px;">
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; flex: 1; min-width: 0; margin: 0; font-weight: normal; color: #334155;">
                  <input type="checkbox" class="own-upload-checkbox" data-id="${file.id}" ${isChecked} style="cursor: pointer; width: 13px; height: 13px; margin: 0;">
                  <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px;" title="${file.filename}">${file.filename}</span>
                </label>
                <span class="delete-own-upload" data-id="${file.id}" style="cursor: pointer; font-size: 12px; color: #94a3b8; transition: color 0.2s;" onmouseover="this.style.color='#ef4444'" onmouseout="this.style.color='#94a3b8'">🗑️</span>
              </div>
            `
          }).join('')

          // Add change listeners to checkboxes
          uploadsList.querySelectorAll('.own-upload-checkbox').forEach(cb => {
            cb.addEventListener('change', async () => {
              const currentSelected = Array.from(uploadsList.querySelectorAll('.own-upload-checkbox:checked'))
                .map(el => Number(el.getAttribute('data-id')))
              await browser.storage.local.set({ quizbank_selected_user_files: currentSelected })
            })
          })

          // Add click listeners to delete buttons
          uploadsList.querySelectorAll('.delete-own-upload').forEach(btn => {
            btn.addEventListener('click', async () => {
              const id = Number(btn.getAttribute('data-id'))
              btn.innerHTML = '⏳'
              
              const delResponse = await browser.runtime.sendMessage({
                type: 'quizbank-delete-user-note',
                deviceId,
                id
              })

              if (delResponse && delResponse.ok) {
                const storedDelete = await browser.storage.local.get(['quizbank_selected_user_files'])
                const updatedSelected = (storedDelete.quizbank_selected_user_files || []).filter(sid => Number(sid) !== id)
                await browser.storage.local.set({ quizbank_selected_user_files: updatedSelected })
              }
              loadOwnUploads()
            })
          })
        } catch (e) {
          this.logger.error('Error loading own uploads:', e)
          uploadsList.innerHTML = '<div style="font-size: 10px; color: #f43f5e; font-style: italic; text-align: center; padding: 6px 0;">Error loading notes.</div>'
        }
      }

      if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
          const files = Array.from(e.target.files)
          if (files.length === 0) return

          try {
            const deviceId = await this.dbManager.getDeviceId()
            
            const originalHint = hint.textContent
            hint.innerHTML = '<span style="color: #2196F3; font-weight: 500;">⏳ Uploading and indexing notes...</span>'

            const storedUpload = await browser.storage.local.get(['quizbank_selected_user_files'])
            const existingSelected = storedUpload.quizbank_selected_user_files || []

            for (const file of files) {
              const base64Data = await new Promise((resolve) => {
                const reader = new FileReader()
                reader.onload = (evt) => {
                  const result = evt.target.result
                  const base64 = result.split(',')[1]
                  resolve(base64)
                }
                reader.onerror = () => resolve('')
                reader.readAsDataURL(file)
              })

              if (base64Data) {
                const upResponse = await browser.runtime.sendMessage({
                  type: 'quizbank-upload-user-note',
                  deviceId,
                  filename: file.name,
                  content: base64Data,
                  mimeType: file.type
                })

                if (upResponse && upResponse.ok && upResponse.note) {
                  existingSelected.push(Number(upResponse.note.id))
                }
              }
            }

            await browser.storage.local.set({
              quizbank_selected_user_files: existingSelected
            })

            hint.textContent = originalHint
          } catch (e) {
            this.logger.error('Error uploading note:', e)
          }

          fileInput.value = ''
          loadOwnUploads()
        })
      }

      loadOwnUploads()
    })()

    // Get course name for exports
    const courseName = document.title || `Course ${courseId}`

    // Helper function to get filter config from checkboxes
    const getFilterConfig = () => ({
      includeCorrect: document.getElementById('filter-correct')?.checked ?? true,
      includeWrong: document.getElementById('filter-wrong')?.checked ?? true,
      includeNew: document.getElementById('filter-new')?.checked ?? true
    })

    // Quiz export button
    const quizExportBtn = document.getElementById('export-quiz-btn')
    if (quizExportBtn) {
      quizExportBtn.addEventListener('click', async () => {
        quizExportBtn.disabled = true
        quizExportBtn.innerHTML = '⏳ Downloading...'

        try {
          const filterConfig = getFilterConfig()
          await this.questionCompiler.exportAsHTML(quizId, courseId, filterConfig)
          this.logger.info(`✅ Quiz questions exported successfully`)
          quizExportBtn.innerHTML = '✅ Downloaded!'
          setTimeout(() => {
            quizExportBtn.innerHTML = '📥 Export This Quiz Questions'
          }, 2000)
        } catch (error) {
          this.logger.error('Quiz export failed:', error)
          quizExportBtn.innerHTML = `❌ ${error.message}`
          quizExportBtn.style.background = '#f44336'
          setTimeout(() => {
            quizExportBtn.innerHTML = '📥 Export This Quiz Questions'
            quizExportBtn.style.background = 'linear-gradient(135deg, #2196F3, #1976D2)'
          }, 3000)
        } finally {
          quizExportBtn.disabled = false
        }
      })
    }

    // Course export button
    const courseExportBtn = document.getElementById('export-course-btn')
    if (courseExportBtn) {
      courseExportBtn.addEventListener('click', async () => {
        courseExportBtn.disabled = true
        courseExportBtn.innerHTML = '⏳ Downloading...'

        try {
          const filterConfig = getFilterConfig()
          await this.questionCompiler.exportCourseAsHTML(courseId, courseName, filterConfig)
          this.logger.info(`✅ Course questions exported successfully`)
          courseExportBtn.innerHTML = '✅ Downloaded!'
          setTimeout(() => {
            courseExportBtn.innerHTML = '📥 Export This Course Questions'
          }, 2000)
        } catch (error) {
          this.logger.error('Course export failed:', error)
          courseExportBtn.innerHTML = `❌ ${error.message}`
          courseExportBtn.style.background = '#f44336'
          setTimeout(() => {
            courseExportBtn.innerHTML = '📥 Export This Course Questions'
            courseExportBtn.style.background = 'linear-gradient(135deg, #4CAF50, #45a049)'
          }, 3000)
        } finally {
          courseExportBtn.disabled = false
        }
      })
    }

    // Check for updates and show button if needed
    this.checkForUpdatesInPanel()

    this.logger.info('Preview panel created successfully')
  }

  /**
   * Check for updates and show the panel update button if a new version is available
   */
  async checkForUpdatesInPanel() {
    try {
      const { data, error } = await this.dbManager.supabase
        .from('app_version')
        .select('version')
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (error) {
        this.logger.error('Error checking for updates:', error)
        return
      }

      if (data && data.version) {
        const currentVersion = browser.runtime.getManifest().version
        const latestVersion = data.version

        if (this.compareVersions(currentVersion, latestVersion) < 0) {
          // Current version is lower than latest - show update button
          const updateBtn = document.getElementById('panel-update-btn')
          if (updateBtn) {
            updateBtn.style.display = 'flex'
          }
        }
      }
    } catch (e) {
      this.logger.error('Update check error:', e)
    }
  }

  /**
   * Compare two semver version strings
   * Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
   */
  compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number)
    const parts2 = v2.split('.').map(Number)

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0
      const p2 = parts2[i] || 0

      if (p1 < p2) return -1
      if (p1 > p2) return 1
    }

    return 0
  }

  /**
   * Get questions for a specific quiz from the knowledge bank
   */
  async getQuizQuestionsFromKnowledgeBank(courseId, quizId) {
    try {
      await this.init()
      this.logger.info(
        `🚀 Optimized query: Getting questions for quiz ${quizId} in course ${courseId}`
      )

      // Use the new optimized direct query method
      const questionsData = await this.dbManager.getQuestionsByQuizId(courseId, quizId)

      this.logger.info(
        `✅ Found ${questionsData?.length || 0} questions directly from quiz ${quizId}`
      )

      if (!questionsData || questionsData.length === 0) {
        this.logger.info('No questions found for this specific quiz')
        return []
      }

      // Transform to expected format
      const result = questionsData.map(item => ({
        question_hash: item.question.question_hash,
        question_text: item.question.question_text,
        question_type: item.question.question_type,
        confidence_score: item.bestAnswer?.confidence_score || 0,
        answer_text: item.bestAnswer?.answer_text || '',
        answer_fields: item.bestAnswer?.answer_fields || {},
        total_attempts: 1,
        last_updated: item.bestAnswer?.updated_at,
        canvas_question_id: item.canvas_question_id
      }))

      this.logger.info(`✅ Retrieved ${result.length} questions for export (optimized - no loops!)`)
      return result
    } catch (error) {
      this.logger.error('Error querying knowledge bank:', error)
      throw new Error(`Knowledge bank query failed: ${error.message}`)
    }
  }

  /**
   * Export current quiz questions from knowledge bank only
   */
  async exportCurrentQuizFromKnowledgeBank(
    courseId,
    quizId,
    knowledgeBankData
  ) {
    try {
      this.logger.info(`Starting export of quiz ${quizId} from knowledge bank`)

      // Get quiz-specific questions directly from the knowledge bank
      const currentQuizKnowledgeData =
        await this.getQuizQuestionsFromKnowledgeBank(courseId, quizId)

      this.logger.info(
        `Retrieved ${currentQuizKnowledgeData.length} questions for export`
      )

      // Export knowledge bank data only (Canvas API not accessible)
      this.logger.info('Exporting knowledge bank data only')

      let exportData = {
        metadata: {
          exportDate: new Date().toISOString(),
          courseId: courseId,
          quizId: quizId,
          generatedBy: 'QuizBank',
          foundInKnowledgeBank: currentQuizKnowledgeData.length,
          description:
            'Export contains only questions from the current quiz as found in the knowledge bank'
        },
        quizQuestions: []
      }

      // Export knowledge bank questions
      for (const kbItem of currentQuizKnowledgeData) {
        const exportQuestion = {
          // Question identification
          questionHash: kbItem.question_hash,
          canvasQuestionId: kbItem.canvas_question_id || null,

          // Question info (from knowledge bank)
          questionText: kbItem.question_text || 'Question text not available',
          questionType: kbItem.question_type || 'unknown',

          // Answer data
          bestAnswer: {
            text: kbItem.answer_text || '',
            confidenceScore: kbItem.confidence_score || 0,
            totalAttempts: kbItem.total_attempts || 1,
            lastUpdated: kbItem.last_updated
          },

          // Additional fields
          answerFields: kbItem.answer_fields || {},
          source: 'knowledge_bank'
        }

        exportData.quizQuestions.push(exportQuestion)
      }

      // Generate filename with timestamp
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .split('T')[0]
      const filename = `quiz-${quizId}-export-${timestamp}.json`

      // Create and download file
      const jsonContent = JSON.stringify(exportData, null, 2)
      this.downloadFile(filename, jsonContent)

      this.logger.info(
        `Export completed: ${filename} (${currentQuizKnowledgeData.length} questions)`
      )
    } catch (error) {
      this.logger.error('Export function failed:', error)
      throw new Error(`Export failed: ${error.message}`)
    }
  }

  /**
   * Download file helper function
   */
  downloadFile(filename, content) {
    const blob = new Blob([content], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  /**
   * Calculate Canvas submission statistics
   */
  calculateCanvasStats(canvasAnswers) {
    if (!canvasAnswers || typeof canvasAnswers !== 'object') {
      return {
        totalQuestions: 0,
        correctAnswers: 0,
        wrongAnswers: 0,
        successRate: 0
      }
    }
    const questions = Object.values(canvasAnswers)
    const totalQuestions = questions.length
    const correctAnswers = questions.filter(
      q => q.bestAnswer?.correct === Correct.TRUE
    ).length
    const wrongAnswers = totalQuestions - correctAnswers
    const successRate =
      totalQuestions > 0
        ? Math.round((correctAnswers / totalQuestions) * 100)
        : 0

    return {
      totalQuestions,
      correctAnswers,
      wrongAnswers,
      successRate
    }
  }

  /**
   * Calculate Knowledge Bank statistics
   */
  calculateKnowledgeBankStats(knowledgeBankData) {
    const totalQuestions = knowledgeBankData.length
    const highConfidence = knowledgeBankData.filter(
      q => q.confidence_score >= 1.0
    ).length
    const mediumConfidence = knowledgeBankData.filter(
      q => q.confidence_score >= 0.3 && q.confidence_score < 1.0
    ).length
    const lowConfidence = knowledgeBankData.filter(
      q => q.confidence_score < 0.3
    ).length

    return {
      totalQuestions,
      highConfidence,
      mediumConfidence,
      lowConfidence
    }
  }

  /**
   * Calculate Global Knowledge Bank statistics (all courses)
   */
  calculateGlobalKnowledgeBankStats(globalKnowledgeBankData) {
    const totalQuestions = globalKnowledgeBankData.length

    // Count unique courses
    const uniqueCourses = new Set(globalKnowledgeBankData.map(q => q.course_id))
    const totalCourses = uniqueCourses.size

    const highConfidence = globalKnowledgeBankData.filter(
      q => q.confidence_score >= 1.0
    ).length
    const mediumConfidence = globalKnowledgeBankData.filter(
      q => q.confidence_score >= 0.3 && q.confidence_score < 1.0
    ).length
    const lowConfidence = globalKnowledgeBankData.filter(
      q => q.confidence_score < 0.3
    ).length

    return {
      totalQuestions,
      totalCourses,
      highConfidence,
      mediumConfidence,
      lowConfidence
    }
  }
}

// ==================== DISPLAYER CLASS ====================

class EnhancedDisplayer {
  constructor(logger, stealthMode = false) {
    this.logger = logger
    this.stealthMode = stealthMode
  }

  displayMultipleChoice(question, questionId, autoSelect = false) {
    this.logger.info(`Displaying multiple choice for question ${questionId}`)

    if (!question) return

    const bestAnswer = question.bestAnswer
    if (!bestAnswer) return

    // Use the original working approach: direct element ID lookup
    const answerId = `question_${questionId}_answer_${bestAnswer.text}`
    this.logger.info(`Looking for element with ID: ${answerId}`)
    const el = document.getElementById(answerId)

    if (el) {
      this.logger.info(`✅ Found element for question ${questionId}`)
      // Show badge for correct or wrong answer, no auto-selection
      if (bestAnswer.correct === Correct.TRUE) {
        if (this.stealthMode) {
          this.applyStealthDividerFade(el)
        } else {
          this.highlightCorrectAnswerWithBadge(el)
        }
        this.logger.info(`Highlighted correct answer for question ${questionId}`)
      } else if (bestAnswer.correct === Correct.FALSE) {
        if (!this.stealthMode) {
          this.highlightWrongAnswerWithBadge(el)
        }
        this.logger.info(`Highlighted wrong answer for question ${questionId}`)
      }
    } else {
      this.logger.warn(`❌ Could not find element with ID: ${answerId}`)
      // Keep the debugging info for troubleshooting
      const radioButtons = document.querySelectorAll(
        `input[name="question_${questionId}"]`
      )
      this.logger.info(`Available radio button IDs for question ${questionId}:`)
      for (const radio of radioButtons) {
        this.logger.info(`- ${radio.id}`)
      }
    }

    // Highlight all wrong answers from knowledge bank
    if (!this.stealthMode) {
      this.highlightAllWrongAnswers(question, questionId)
    }
  }

  /**
   * Display a Gemini AI answer. Matches by option text (AI has no Canvas answer ids).
   */
  displayAIAnswer(question, questionId, questionType) {
    const answerText = question.bestAnswer?.text
    if (!answerText) return

    // Clean up any existing AI badges for this question to prevent duplicates on rerun
    const questionEl = document.getElementById(`question_${questionId}`)
    if (questionEl) {
      questionEl.querySelectorAll('.ai-answer-badge').forEach(b => b.remove())
    }

    const labels = document.querySelectorAll(`#question_${questionId} .answer_label`)
    if (labels.length === 0 && questionType !== QuestionTypes.ESSAY_QUESTION && questionType !== 'default') return

    const findMatchingLabels = (targetText) => {
      const normalize = text => text.toLowerCase().replace(/\s+/g, ' ').trim()
      const labelTexts = Array.from(labels).map(l => ({ label: l, text: normalize(l.textContent) }))
      const normalizedTarget = normalize(targetText)

      const exact = labelTexts.filter(item => item.text === normalizedTarget)
      if (exact.length > 0) {
        return exact.map(item => item.label)
      }

      return labelTexts
        .filter(item => item.text.includes(normalizedTarget) || normalizedTarget.includes(item.text))
        .map(item => item.label)
    }

    switch (questionType) {
      case QuestionTypes.MULTIPLE_CHOICE:
      case QuestionTypes.TRUE_FALSE: {
        const matchedLabels = findMatchingLabels(answerText)
        for (const label of matchedLabels) {
          if (this.stealthMode) {
            this.applyStealthDividerFade(label)
          } else {
            this.highlightAIAnswerWithBadge(label)
          }
        }
        if (!this.stealthMode) {
          this.highlightAllWrongAnswers(question, questionId)
        }
        break
      }

      case QuestionTypes.MULTIPLE_ANSWER: {
        const aiAnswers = answerText.split(/\s*\|\s*|,/).map(a => a.trim()).filter(Boolean)
        const matchedLabels = new Set()
        for (const aiAnswer of aiAnswers) {
          findMatchingLabels(aiAnswer).forEach(l => matchedLabels.add(l))
        }
        for (const label of matchedLabels) {
          if (this.stealthMode) {
            this.applyStealthDividerFade(label)
          } else {
            this.highlightAIAnswerWithBadge(label)
          }
        }
        if (!this.stealthMode) {
          this.highlightAllWrongAnswers(question, questionId)
        }
        break
      }

      case QuestionTypes.ESSAY_QUESTION: {
        // Essay has no divider tell - stealth shows nothing.
        if (this.stealthMode) break
        const textarea = document.querySelector(`textarea[name="question_${questionId}"]`)
        if (textarea) {
          textarea.placeholder = `AI suggestion: ${answerText.substring(0, 200)}`
          textarea.style.borderColor = '#9C27B0'
          this.highlightAIAnswerWithBadge(textarea, '🤖 AI suggestion')
        }
        break
      }

      default: {
        // Fill-in/numerical have no divider tell - stealth shows nothing.
        if (this.stealthMode) break
        const input = document.querySelector(`input[name="question_${questionId}"]`)
        if (input) {
          input.placeholder = `AI answer: ${answerText}`
          input.style.borderColor = '#9C27B0'
          this.highlightAIAnswerWithBadge(input, `🤖 ${answerText}`)
        }
      }
    }
  }

  highlightAIAnswerWithBadge(element, customMessage = null) {
    const badge = document.createElement('span')
    badge.className = 'ai-answer-badge'

    const iconSpan = document.createElement('span')
    iconSpan.className = 'badge-icon'
    iconSpan.textContent = '🤖'

    const textSpan = document.createElement('span')
    textSpan.className = 'badge-text'
    textSpan.textContent = customMessage || 'AI'

    badge.appendChild(iconSpan)
    badge.appendChild(textSpan)
    badge.style.cssText = `
            display: inline-flex;
            align-items: center;
            gap: 4px;
            background: #9C27B0;
            color: white;
            padding: 2px 6px;
            border-radius: 8px;
            font-size: 10px;
            font-weight: bold;
            margin-left: 6px;
            opacity: 0.9;
        `

    const label = element.closest('label') || element.parentElement
    if (label && !label.querySelector('.ai-answer-badge')) {
      label.appendChild(badge)
    }
  }

  displayFillInBlank(question, questionId, autoFill = false) {
    this.logger.info(`Displaying fill-in-blank for question ${questionId}`)

    const bestAnswer = question.bestAnswer
    if (!bestAnswer) return

    const input = document.querySelector(`input[name="question_${questionId}"]`)
    if (input) {
      // Show badge for correct or wrong answer, no auto-fill
      if (bestAnswer.correct === Correct.TRUE) {
        if (this.stealthMode) {
          input.placeholder = this.applyStealthItalicsToText(bestAnswer.text)
        } else {
          input.placeholder = `Correct answer: ${bestAnswer.text}`
          input.style.borderColor = '#4CAF50'
          this.highlightCorrectAnswerWithBadge(input, `✅ ${bestAnswer.text}`)
        }
      } else if (bestAnswer.correct === Correct.FALSE) {
        if (!this.stealthMode) {
          input.placeholder = `Previously wrong: ${bestAnswer.text}`
          input.style.borderColor = '#ff5722'
          this.highlightWrongAnswerWithBadge(input, `🚫 ${bestAnswer.text}`)
        }
      }
    }
  }

  displayMultipleAnswer(question, questionId, autoSelect = false) {
    this.logger.info(`Displaying multiple answer for question ${questionId}`)

    const bestAnswer = question.bestAnswer
    if (!bestAnswer) return

    const isCorrect = bestAnswer.correct === Correct.TRUE
    // Stealth only ever marks correct answers (never wrong).
    if (this.stealthMode && !isCorrect) return

    // Resolve the selected option inputs.
    const selectedInputs = this.resolveMultipleAnswerInputs(bestAnswer, questionId)
    this.logger.info(`Multiple-answer ${questionId}: matched ${selectedInputs.length} option(s)`)

    for (const input of selectedInputs) {
      if (isCorrect) {
        if (this.stealthMode) {
          this.applyStealthDividerFade(input)
        } else {
          this.highlightCorrectAnswerWithBadge(input)
        }
      } else if (!this.stealthMode) {
        this.highlightWrongAnswerWithBadge(input)
      }
    }

    // Highlight all other wrong answers from knowledge bank
    if (!this.stealthMode) {
      this.highlightAllWrongAnswers(question, questionId)
    }
  }

  /**
   * Resolve which option <input>s a multiple-answer record refers to.
   * Canvas stores dynamicFields as { answer_<id>: "1" | "0" } (selection flags),
   * so the selected options are the keys whose value is truthy. Knowledge-bank
   * records may instead store a comma-separated text list, matched by label text.
   */
  resolveMultipleAnswerInputs(bestAnswer, questionId) {
    const inputs = []
    const dynamicFields = bestAnswer.dynamicFields

    if (dynamicFields && Object.keys(dynamicFields).length > 0) {
      const selectedIds = Object.entries(dynamicFields)
        .filter(([, value]) => value === '1' || value === 1 || value === true)
        .map(([key]) => key.replace(/^answer_/, ''))

      for (const answerId of selectedIds) {
        const input = document.querySelector(
          `#question_${questionId} input[value="${answerId}"]`
        )
        if (input) inputs.push(input)
      }
      if (inputs.length > 0) return inputs
    }

    // Fallback: match by option label text (e.g. comma-separated text records)
    if (bestAnswer.text) {
      const answers = bestAnswer.text.split(',').map(a => a.trim()).filter(Boolean)
      const labels = document.querySelectorAll(`#question_${questionId} .answer_label`)
      for (const label of labels) {
        const labelText = label.textContent.trim()
        if (answers.some(answer => labelText.includes(answer) || answer.includes(labelText))) {
          const input = label.closest('.answer')?.querySelector('input')
          if (input) inputs.push(input)
        }
      }
    }

    return inputs
  }

  displayEssay(question, questionId, autoFill = false) {
    const bestAnswer = question.bestAnswer
    if (!bestAnswer) return

    const textarea = document.querySelector(
      `textarea[name="question_${questionId}"]`
    )
    if (textarea) {
      // Show badge for correct or wrong answer, no auto-fill
      if (bestAnswer.correct === Correct.TRUE) {
        if (this.stealthMode) {
          textarea.placeholder = this.applyStealthItalicsToText(bestAnswer.text.substring(0, 100)) + '...'
        } else {
          textarea.placeholder = `Correct answer: ${bestAnswer.text.substring(0, 100)}...`
          textarea.style.borderColor = '#4CAF50'
          this.highlightCorrectAnswerWithBadge(textarea, `✅ Previous answer`)
        }
      } else if (bestAnswer.correct === Correct.FALSE) {
        if (!this.stealthMode) {
          textarea.placeholder = `Previously attempted: ${bestAnswer.text.substring(
            0,
            100
          )}...`
          textarea.style.borderColor = '#ff5722'
          this.highlightWrongAnswerWithBadge(textarea, `🚫 Previous attempt`)
        }
      }
    }
  }

  displayMatching(question, questionId) {
    this.logger.info(`Displaying matching for question ${questionId}`)

    const bestAnswer = question.bestAnswer
    if (!bestAnswer) return

    const fields = bestAnswer.dynamicFields || {}

    // Find all dropdowns for this question
    const selects = document.querySelectorAll(
      `select[name^="question_${questionId}"]`
    )

    for (const select of selects) {
      // The name might be "question_22401888_answer_3390"
      // Fields usually contain "answer_3390": "7730"
      const answerKey = select.name.replace(`question_${questionId}_`, '')
      let matchValue = fields[answerKey] || fields[select.name]

      if (matchValue !== undefined && matchValue !== null) {
        // Find if this value exists in options by value
        const optionExists = Array.from(select.options).some(opt => opt.value == matchValue)

        let matched = false
        if (optionExists) {
          select.value = matchValue
          matched = true
        } else {
          // Fallback: matchValue might be text content
          const optionByText = Array.from(select.options).find(opt => opt.text.trim() === String(matchValue).trim() || opt.text.includes(String(matchValue)))
          if (optionByText) {
            select.value = optionByText.value
            matched = true
          }
        }

        if (matched) {
          if (bestAnswer.correct === Correct.TRUE) {
            if (!this.stealthMode) {
              select.style.borderColor = '#4CAF50'
              this.highlightCorrectAnswerWithBadge(select, '✅ Previous answer')
            }
          } else if (bestAnswer.correct === Correct.FALSE) {
            if (!this.stealthMode) {
              select.style.borderColor = '#ff5722'
              this.highlightWrongAnswerWithBadge(select, '🚫 Previous attempt')
            }
          }
        }
      }
    }
  }

  displayMultipleDropdowns(question, questionId) {
    this.logger.info(`Displaying multiple dropdowns for question ${questionId}`)
    this.displayMatching(question, questionId)
  }

  displayFillInMultipleBlank(question, questionId) {
    this.logger.info(
      `Fill in multiple blanks not fully supported yet for question ${questionId}`
    )
  }

  highlightCorrectAnswerWithBadge(element, customMessage = null) {
    const badge = document.createElement('span')
    badge.className = 'correct-answer-badge'

    const badgeText = customMessage || 'Correct'
    const badgeIcon = '✅'

    // Safe HTML creation to prevent XSS
    const iconSpan = document.createElement('span')
    iconSpan.className = 'badge-icon'
    iconSpan.textContent = badgeIcon

    const textSpan = document.createElement('span')
    textSpan.className = 'badge-text'
    textSpan.textContent = badgeText

    badge.appendChild(iconSpan)
    badge.appendChild(textSpan)
    badge.style.cssText = `
            display: inline-flex;
            align-items: center;
            gap: 4px;
            background: #4CAF50;
            color: white;
            padding: 2px 6px;
            border-radius: 8px;
            font-size: 10px;
            font-weight: bold;
            margin-left: 6px;
            opacity: 0.9;
        `

    const label = element.closest('label') || element.parentElement
    if (label && !label.querySelector('.correct-answer-badge')) {
      label.appendChild(badge)
    }
  }

  highlightWrongAnswerWithBadge(element, customMessage = null) {
    const badge = document.createElement('span')
    badge.className = 'wrong-answer-badge'

    const badgeText = customMessage || 'Previously wrong'
    const badgeIcon = '🚫'

    // Safe HTML creation to prevent XSS
    const iconSpan = document.createElement('span')
    iconSpan.className = 'badge-icon'
    iconSpan.textContent = badgeIcon

    const textSpan = document.createElement('span')
    textSpan.className = 'badge-text'
    textSpan.textContent = badgeText

    badge.appendChild(iconSpan)
    badge.appendChild(textSpan)
    badge.style.cssText = `
            display: inline-flex;
            align-items: center;
            gap: 4px;
            background: #ff5722;
            color: white;
            padding: 2px 6px;
            border-radius: 8px;
            font-size: 10px;
            font-weight: bold;
            margin-left: 6px;
            opacity: 0.8;
        `

    const label = element.closest('label') || element.parentElement
    if (label && !label.querySelector('.wrong-answer-badge')) {
      label.appendChild(badge)
    }
  }

  highlightAllWrongAnswers(question, questionId) {
    // Use the same direct ID approach for wrong answers
    if (question.wrongAnswers) {
      for (const wrongAnswer of question.wrongAnswers) {
        const wrongAnswerId = `question_${questionId}_answer_${wrongAnswer.answer_text || wrongAnswer.text
          }`
        const wrongEl = document.getElementById(wrongAnswerId)

        if (wrongEl) {
          this.highlightWrongAnswerWithBadge(wrongEl)
        }
      }
    }
  }

  /**
   * Stealth Mode (OLD): Randomly choose one character in correct choice and italicize it.
   * Disabled — italic changes glyph width, causing a visible flicker on render.
   * Replaced by applyStealthDividerFade below.
   */
  // applyStealthItalics(element) {
  //   const label = element.closest('label') || element.parentElement
  //   if (!label) return
  //
  //   // Find the text node(s) within the label
  //   const findTextNodes = (node) => {
  //     let textNodes = []
  //     for (let child of node.childNodes) {
  //       if (child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0) {
  //         textNodes.push(child)
  //       } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'INPUT' && child.tagName !== 'I') {
  //         textNodes = textNodes.concat(findTextNodes(child))
  //       }
  //     }
  //     return textNodes
  //   }
  //
  //   const textNodes = findTextNodes(label)
  //   if (textNodes.length === 0) return
  //
  //   // Choose a random text node and a random character within it
  //   const randomNodeIndex = Math.floor(Math.random() * textNodes.length)
  //   const targetNode = textNodes[randomNodeIndex]
  //   const text = targetNode.textContent
  //
  //   // Find index of first non-whitespace character to avoid italicizing spaces if possible
  //   const trimmedText = text.trim()
  //   const firstCharIndex = text.indexOf(trimmedText[0])
  //   const lastCharIndex = text.lastIndexOf(trimmedText[trimmedText.length - 1])
  //
  //   if (lastCharIndex < firstCharIndex) return // Should not happen with trim check
  //
  //   const randomCharIndex = firstCharIndex + Math.floor(Math.random() * (lastCharIndex - firstCharIndex + 1))
  //
  //   // Split text and inject <i> tag
  //   const before = text.substring(0, randomCharIndex)
  //   const char = text.substring(randomCharIndex, randomCharIndex + 1)
  //   const after = text.substring(randomCharIndex + 1)
  //
  //   const span = document.createElement('span')
  //   span.innerHTML = `${before}<i>${char}</i>${after}`
  //
  //   targetNode.parentNode.replaceChild(span, targetNode)
  // }

  /**
   * Stealth Mode: Fade the divider directly above the correct choice.
   * The divider is the `border-top: 1px #ddd` on each `.answer` row, so the
   * top border above the correct choice is faded left-to-transparent.
   * Paint-only (border-image): same 1px width, no layout shift, no flicker.
   * A knower scans for the divider that thins out on its left side.
   */
  applyStealthDividerFade(element) {
    const answer = element.closest('.answer')
    if (!answer) return

    // Apply the faded gap immediately (left 10px -> transparent).
    answer.style.borderTopStyle = 'solid'
    answer.style.borderImage =
      'linear-gradient(to right, transparent 0px, rgb(221, 221, 221) 10px) 1'

    // border-image can't be CSS-transitioned, so animate the reveal: lay a tiny
    // #ddd cover over the gap (line looks full), then fade the cover out so the
    // gap appears gradually instead of flicking in.
    if (getComputedStyle(answer).position === 'static') {
      answer.style.position = 'relative'
    }
    const cover = document.createElement('div')
    cover.className = 'stealth-fade-cover'
    cover.style.cssText = `
      position: absolute;
      top: -1px;
      left: 0;
      width: 10px;
      height: 1px;
      background: rgb(221, 221, 221);
      opacity: 1;
      transition: opacity 0.6s ease;
      pointer-events: none;
    `
    answer.appendChild(cover)
    requestAnimationFrame(() => { cover.style.opacity = '0' })
    setTimeout(() => cover.remove(), 700)
  }

  /**
   * For text inputs (placeholders), we can't use HTML.
   */
  applyStealthItalicsToText(text) {
    // True stealth: for fill-in-blanks, we don't show anything special in stealth mode
    // as italicizing placeholder text is impossible with standard HTML.
    return text
  }
}

// ==================== MAIN FUNCTION ====================

async function enhancedMain() {
  const loader = new EnhancedQuizLoader()
  currentLoader = loader // expose for global right-click/unload handlers
  attachAIGlobalListeners()
  probeWorkerChannels() // temp: Orion channel diagnosis (fire-and-forget)

  // Wait for BYUI if needed
  if (isByui()) await wait(2)

  const currentURL = window.location.href

  // Safe URL parsing with proper error handling
  if (!currentURL || typeof currentURL !== 'string') {
    loader.logger.error('Invalid URL - cannot proceed')
    return
  }

  const courseMatch = currentURL.match(/courses\/(\d+)/)
  const quizMatch = currentURL.match(/quizzes\/(\d+)/)
  const courseId = courseMatch ? parseInt(courseMatch[1]) : null
  const quizId = quizMatch ? parseInt(quizMatch[1]) : null

  const urlTokens = currentURL.split('/')
  if (urlTokens.length < 3) {
    loader.logger.error('Invalid URL format - cannot extract base URL')
    return
  }
  const baseUrl = `${urlTokens[0]}//${urlTokens[2]}/`

  if (!courseId) {
    loader.logger.error('Unable to retrieve course id from URL:', currentURL)
    return
  } else if (!quizId) {
    loader.logger.error('Unable to retrieve quiz id from URL:', currentURL)
    return
  }

  loader.logger.info('Starting QuizBank for course:', courseId, 'quiz:', quizId)

  // Detect page type
  const isQuizTakingPage = currentURL.includes('/take')
  const isQuizDescriptionPage =
    !isQuizTakingPage &&
    currentURL.includes('/quizzes/') &&
    !currentURL.includes('/submissions')

  // Check access first before any operations
  const hasAccess = await loader.dbManager.hasValidAccess()

  if (!hasAccess) {
    loader.logger.info('No valid access - showing activation panel')
    showActivationRequiredPanel()
    return
  }

  try {
    if (isQuizTakingPage) {
      // Quiz taking page - show enhanced answers
      loader.logger.info('Detected quiz taking page')

      // Get enhanced answers (Knowledge Bank + Canvas)
      const enhancedAnswers = await loader.getEnhancedCorrectAnswers(
        courseId,
        quizId,
        baseUrl
      )

      loader.logger.info('Enhanced answers result:', enhancedAnswers)

      if (Object.keys(enhancedAnswers).length === 0) {
        loader.logger.info('No previous submission data available')
        return
      }

      // Display enhanced answers
      await loader.displayEnhancedAnswers(enhancedAnswers)

      loader.logger.info('QuizBank completed successfully')
    } else if (isQuizDescriptionPage) {
      // Quiz description page - show preview panel
      loader.logger.info('Detected quiz description page')

      // Show preview panel with stats
      await loader.showPreviewPanel(courseId, quizId, baseUrl)
    } else {
      loader.logger.info('Page type not recognized for enhancement')
    }
  } catch (error) {
    // If access was revoked during operation, show activation panel
    if (error.code === 'ACCESS_REVOKED' || (error.message && error.message.includes('access has been revoked'))) {
      loader.logger.info('Access revoked during operation - showing activation panel')
      showActivationRequiredPanel()
    } else {
      loader.logger.error('QuizBank operation failed:', error)
    }
  }
}

/**
 * Show a simple panel when activation is required
 */
function showActivationRequiredPanel() {
  // Remove existing panel if any
  const existingPanel = document.getElementById('quiz-activation-panel')
  if (existingPanel) {
    existingPanel.remove()
  }

  const panel = document.createElement('div')
  panel.id = 'quiz-activation-panel'
  panel.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: rgba(255, 255, 255, 0.98);
    border: 2px solid #ddd;
    border-radius: 12px;
    padding: 16px;
    font-size: 13px;
    max-width: 280px;
    z-index: 1000;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
    text-align: left;
  `

  panel.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
      <h4 style="margin: 0; color: #333; font-size: 16px;">🏦 QuizBank</h4>
      <button id="close-activation-panel" style="
        background: none;
        border: none;
        font-size: 18px;
        cursor: pointer;
        color: #666;
        padding: 2px;
        line-height: 1;
      ">✕</button>
    </div>
    <p style="margin: 0 0 8px 0; color: #666; font-size: 12px;">
      Please activate QuizBank to use this feature.<br>
      <span style="color: #999; font-size: 11px;">Click the extension icon and enter your access code.</span>
    </p>
    <div style="font-size: 10px; color: #999; text-align: center; padding-top: 8px; border-top: 1px solid #eee;">
      v${browser.runtime.getManifest().version}
    </div>
  `

  document.body.appendChild(panel)

  // Add close button functionality
  const closeButton = document.getElementById('close-activation-panel')
  if (closeButton) {
    closeButton.addEventListener('click', () => {
      panel.remove()
    })
  }
}

// ==================== HELPER FUNCTIONS ====================

function wait(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

function isByui() {
  return window.location.hostname.includes('byui')
}

// ==================== LOGGER CLASSES ====================

class NoOpLogger {
  info() { }
  error() { }
  warn() { }
  log() { }
  getLogs() {
    return []
  }
  clearLogs() { }
}

class BrowserLogger {
  static instance = null

  static getInstance() {
    if (!this.instance) {
      this.instance = new BrowserLogger()
    }
    return this.instance
  }

  constructor() {
    this.logs = []
    this.loggingEnabled = false // Default to disabled
    this.loadLoggingPreference()
  }

  loadLoggingPreference() {
    // Use synchronous approach to avoid race conditions
    try {
      browser.storage.local
        .get(['loggingEnabled'])
        .then(result => {
          this.loggingEnabled = result.loggingEnabled === true // Default to false, only enable if explicitly set
        })
        .catch(() => {
          this.loggingEnabled = false // Default to disabled if storage fails
        })
    } catch (e) {
      this.loggingEnabled = false // Default to disabled
    }
  }

  setLoggingEnabled(enabled) {
    this.loggingEnabled = enabled
  }

  info(...args) {
    if (this.loggingEnabled) {
      console.info(...args)
    }
    this.logs.push({
      type: 'info',
      message: args,
      timestamp: new Date().toISOString()
    })
  }

  error(...args) {
    if (this.loggingEnabled) {
      console.error(...args)
    }
    this.logs.push({
      type: 'error',
      message: args,
      timestamp: new Date().toISOString()
    })
  }

  warn(...args) {
    if (this.loggingEnabled) {
      console.warn(...args)
    }
    this.logs.push({
      type: 'warn',
      message: args,
      timestamp: new Date().toISOString()
    })
  }

  log(...args) {
    if (this.loggingEnabled) {
      console.log(...args)
    }
    this.logs.push({
      type: 'log',
      message: args,
      timestamp: new Date().toISOString()
    })
  }

  getLogs() {
    return this.logs
  }

  clearLogs() {
    this.logs = []
  }
}

// ==================== MESSAGE LISTENERS ====================

// Listen for logging toggle messages from popup
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const prefix = 'canvas-quiz-bank'

  if (message.type === `${prefix}-set-logging`) {
    const logger = BrowserLogger.getInstance()
    logger.setLoggingEnabled(message.enabled)
    sendResponse({ success: true })
    return true
  }

  if (message.type === `${prefix}-set-stealth`) {
    const logger = BrowserLogger.getInstance()
    logger.info(`Stealth mode toggled to ${message.enabled ? 'ON' : 'OFF'} - re-running...`)

    // Re-run the main function to apply/remove badges
    enhancedMain().catch(error => {
      logger.error('QuizBank re-run failed:', error)
    })

    sendResponse({ success: true })
    return true
  }

  if (message.type === `${prefix}-set-ai`) {
    const logger = BrowserLogger.getInstance()
    logger.info(`AI mode toggled to ${message.enabled ? 'ON' : 'OFF'} - re-running...`)
    if (currentLoader) {
      currentLoader.aiMode = message.enabled
    }

    // Re-run the main function to apply/remove AI answers
    enhancedMain().catch(error => {
      logger.error('QuizBank re-run failed:', error)
    })

    sendResponse({ success: true })
    return true
  }

  if (message.type === `${prefix}-debug`) {
    const logger = BrowserLogger.getInstance()
    const logs = logger.getLogs()
    const logText = logs
      .map(
        log =>
          `[${log.timestamp}] ${log.type.toUpperCase()}: ${log.message.join(
            ' '
          )}`
      )
      .join('\n')
    sendResponse(logText)
    return true
  }

  if (message.type === `${prefix}-ping`) {
    sendResponse(`${prefix}-pong`)
    return true
  }

  // Re-run QuizBank after successful activation
  if (message.type === `${prefix}-activated`) {
    const logger = BrowserLogger.getInstance()
    logger.info('QuizBank activated - re-running...')

    // Remove activation panel if present
    const activationPanel = document.getElementById('quiz-activation-panel')
    if (activationPanel) {
      activationPanel.remove()
    }

    // Re-run the main function
    enhancedMain().catch(error => {
      logger.error('QuizBank re-run failed:', error)
    })

    sendResponse({ success: true })
    return true
  }
})

// ==================== INITIALIZATION ====================

// Initialize quizbank with proper logging setup
const logger = BrowserLogger.getInstance()

// Wait a moment for logging preference to load before starting
setTimeout(() => {
  logger.info('QuizBank initializing...')

  // Check if required dependencies are loaded
  if (typeof SupabaseQuizManager === 'undefined') {
    logger.error(
      'SupabaseQuizManager not loaded - check if supabase-manager.js is included in manifest'
    )
  } else {
    logger.info('Database manager loaded successfully')
    enhancedMain().catch(error => {
      logger.error('QuizBank failed:', error)
    })
  }
}, 100) // Small delay to let preference load