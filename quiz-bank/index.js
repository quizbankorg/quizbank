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

const AUTO_SELECT_DELAY_MIN_MS = 10_000
const AUTO_SELECT_DELAY_MAX_MS = 20_000
const AUTO_NAVIGATION_DELAY_MS = 500
let autoSelectionGeneration = 0

function scrollQuestionIntoView(questionId) {
  if (!questionId || typeof document === 'undefined') return

  const questionElement = document.getElementById(`question_${questionId}`)
  const scrollTarget = questionElement?.querySelector('.header') || questionElement
  if (!scrollTarget || typeof scrollTarget.getBoundingClientRect !== 'function') return

  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  const { top, bottom } = scrollTarget.getBoundingClientRect()
  if (top < 0 || bottom > viewportHeight) {
    scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  }
}

function mountAutoSelectionCountdown(questionId, delayMs, stealthMode) {
  if (stealthMode || !questionId || typeof document === 'undefined') return null

  const questionElement = document.getElementById(`question_${questionId}`)
  const mountElement = questionElement?.querySelector('.header') || questionElement
  if (!mountElement) return null

  mountElement.querySelectorAll('.quizbank-auto-countdown').forEach(element => element.remove())
  mountElement.classList.add('quizbank-countdown-header')

  const countdown = document.createElement('div')
  countdown.className = 'quizbank-auto-countdown'
  countdown.setAttribute('role', 'status')
  countdown.setAttribute('aria-live', 'polite')
  const questionName = mountElement.querySelector('.question_name')
  if (questionName) {
    questionName.after(countdown)
  } else {
    mountElement.append(countdown)
  }

  const startedAt = Date.now()
  const updateCountdown = () => {
    const remainingMs = Math.max(0, delayMs - (Date.now() - startedAt))
    countdown.textContent = remainingMs > 0
      ? `Auto-selecting in ${Math.ceil(remainingMs / 1000)}s`
      : 'Selecting…'
  }

  updateCountdown()
  const intervalId = setInterval(updateCountdown, 100)

  return () => {
    clearInterval(intervalId)
    countdown.remove()
    mountElement.classList.remove('quizbank-countdown-header')
  }
}

function createAutoSelectionDelay(logger, questionId = null, stealthMode = false) {
  const delayMs = AUTO_SELECT_DELAY_MIN_MS + Math.floor(
    Math.random() * (AUTO_SELECT_DELAY_MAX_MS - AUTO_SELECT_DELAY_MIN_MS + 1)
  )
  logger?.info(`Auto-select delay: ${Math.round(delayMs / 1000)} seconds`)
  scrollQuestionIntoView(questionId)
  const removeCountdown = mountAutoSelectionCountdown(questionId, delayMs, stealthMode)
  return new Promise(resolve => setTimeout(() => {
    removeCountdown?.()
    resolve()
  }, delayMs))
}

function createAutoNavigationDelay(logger) {
  logger?.info(`Auto-navigation readiness delay: ${AUTO_NAVIGATION_DELAY_MS / 1000} seconds`)
  return new Promise(resolve => setTimeout(resolve, AUTO_NAVIGATION_DELAY_MS))
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
async function askGemini(questionInfo, quizContext, deviceId, logger, requestId) {
  const prompt = buildGeminiPrompt(questionInfo, quizContext)
  logger?.info('🤖 Gemini prompt:', prompt)

  const payload = {
    prompt,
    deviceId,
    requestId
  }

  try {
    // Fetch the backend directly from the content script. The old background-
    // worker relay is gone: Orion iOS never delivers worker responses once the
    // worker suspends, freezing the UI. The backend holds the Gemini key,
    // validates the device's voucher, and allows CORS from page context.
    const startTime = performance.now()
    const result = await fetchGeminiDirect(payload)
    if (!result?.ok && result?.error) logger?.warn(`Gemini direct fetch failed: ${result.error}`)
    logger?.info(`🤖 Gemini network time: ${Math.round(performance.now() - startTime)}ms`)

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
    return { status: 'failed' }
  }
}

// Backend that relays prompts to Gemini.
const QUIZBANK_API_URL = 'https://quizbankend-production.up.railway.app'

// AbortControllers for in-flight Gemini fetches, keyed by requestId.
const directGeminiControllers = new Map()

/**
 * Fetch the Gemini answer from the backend, abortable via abortGeminiRequest.
 * Returns { ok, answer?, aborted?, error? }.
 */
async function fetchGeminiDirect({ prompt, deviceId, requestId }) {
  const controller = new AbortController()
  if (requestId) directGeminiControllers.set(requestId, controller)

  try {
    const response = await fetch(`${QUIZBANK_API_URL}/api/gemini`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, deviceId })
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
 * Abort an in-flight Gemini fetch.
 */
function abortGeminiRequest(requestId) {
  if (!requestId) return
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
    this.autoSelectAnswers = false // Default to badges-only behavior
    this.isRenderingAnswers = false
    this.pendingSingleQuestionNavigation = false
    this.pendingAllQuestionsSubmit = false
    this.singleQuestionNavigationClicked = false
    this.allQuestionsSubmitClicked = false
    this.singleQuestionNavigationPending = false
    this.allQuestionsSubmitPending = false
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

      // Load answer selection preference (default disabled)
      try {
        const result = await browser.storage.local.get(['autoSelectAnswers'])
        this.autoSelectAnswers = result.autoSelectAnswers === true
        this.logger.info(`Auto-select answers: ${this.autoSelectAnswers ? 'ON' : 'OFF'}`)
      } catch (e) {
        this.logger.warn('Failed to load auto-select preference')
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
        // No known-correct answer: offer Ask AI, or auto-run when auto-select is enabled.
        const knownWrongAnswers = [
          ...(enhancedQuestion?.wrongAnswers || []),
          ...(canvasQuestion?.wrongAnswers || [])
        ]

        enhancedAnswers[questionId] = {
          source: 'ai_pending',
          aiPending: true,
          questionText: questionInfo.questionText,
          questionType: questionInfo.questionType,
          options: questionInfo.options,
          wrongAnswers: knownWrongAnswers
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
    const questionIds = this.getQuestionIds()
    const questionTypes = document.getElementsByClassName('question_type')
    const quizContext = this.getQuizContext()

    // Cleanup existing badges/highlights if any
    this.cleanupDOM()
    const displayer = new EnhancedDisplayer(this.logger, this.stealthMode)
    const autoAIQuestionIds = []
    this.isRenderingAnswers = true
    this.pendingSingleQuestionNavigation = false
    this.pendingAllQuestionsSubmit = false

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
            const selectedAutomatically = await displayer.displayAIAnswer(
              question,
              questionId,
              questionType,
              this.autoSelectAnswers
            )
            this.queueQuestionNavigation(selectedAutomatically)
            continue
          }

          // No known answer - flag prior wrong answers and register AI.
          // Auto-select mode also starts AI requests automatically.
          if (question.aiPending) {
            if (!this.stealthMode && question.wrongAnswers && question.wrongAnswers.length > 0) {
              displayer.highlightAllWrongAnswers(question, questionId)
            }
            this.registerAIQuestion(questionId, question, questionType, displayer, quizContext)
            if (this.autoSelectAnswers) {
              autoAIQuestionIds.push(questionId)
            }
            continue
          }

          // Display using enhanced displayer (badges only, no auto-selection)
          let selectedAutomatically = false
          switch (questionType) {
            case QuestionTypes.ESSAY_QUESTION:
              await displayer.displayEssay(question, questionId, false) // No auto-fill, badges only
              break
            case QuestionTypes.MATCHING:
              await displayer.displayMatching(question, questionId)
              break
            case QuestionTypes.MULTIPLE_DROPDOWN:
              await displayer.displayMultipleDropdowns(question, questionId)
              break
            case QuestionTypes.MULTIPLE_ANSWER:
              selectedAutomatically = await displayer.displayMultipleAnswer(
                question,
                questionId,
                this.autoSelectAnswers
              )
              break
            case QuestionTypes.MULTIPLE_CHOICE:
            case QuestionTypes.TRUE_FALSE:
              selectedAutomatically = await displayer.displayMultipleChoice(
                question,
                questionId,
                this.autoSelectAnswers
              )
              break
            case QuestionTypes.FILL_IN_BLANK:
            case QuestionTypes.FORMULA_QUESTION:
            case QuestionTypes.NUMERICAL_ANSWER:
              await displayer.displayFillInBlank(question, questionId, false) // No auto-fill, badges only
              break
            case QuestionTypes.FILL_IN_MULTIPLE_BLANKS:
              await displayer.displayFillInMultipleBlank(question, questionId)
              break
          }
          this.queueQuestionNavigation(selectedAutomatically)

        } catch (e) {
          this.logger.error(`Failed to display question ${questionId}:`, e)
        }
      }
    }

    // Run AI-pending questions sequentially when auto-select is enabled.
    for (const questionId of autoAIQuestionIds) {
      await this.triggerAI(questionId)
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

    this.isRenderingAnswers = false
    if (this.pendingSingleQuestionNavigation) {
      this.pendingSingleQuestionNavigation = false
      await this.clickSingleQuestionNavigation()
    }
    if (this.pendingAllQuestionsSubmit) {
      this.pendingAllQuestionsSubmit = false
      await this.clickAllQuestionsSubmit()
    }
  }

  isSingleQuestionAtATimePage() {
    return Boolean(document.querySelector('.one_question_at_a_time'))
  }

  isAllQuestionsPage() {
    return Boolean(document.querySelector('.all_questions'))
  }

  findSingleQuestionNavigationButton() {
    const isVisible = element => {
      if (!element || element.disabled || element.hidden) return false
      const style = window.getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }

    const findVisible = selectors => {
      for (const selector of selectors) {
        const element = document.querySelector(selector)
        if (isVisible(element)) return element
      }
      return null
    }

    const nextButton = findVisible([
      '#next_question_button',
      '#next_question',
      '.next-question',
      '.next_question',
      '[data-action="next"]'
    ])
    if (nextButton) return nextButton

    const textButtons = Array.from(
      document.querySelectorAll('button, input[type="button"], input[type="submit"]')
    )
    const nextByText = textButtons.find(button => {
      const label = (button.value || button.textContent || '').trim().toLowerCase()
      return isVisible(button) && /^(next|next question|continue)\b/.test(label)
    })
    if (nextByText) return nextByText

    if (!this.isSingleQuestionAtATimePage()) return null

    return findVisible([
      '#submit_quiz_button',
      '.submit_button.quiz_submit',
      'button.quiz_submit'
    ])
  }

  findAllQuestionsSubmitButton() {
    const candidates = [
      '#submit_quiz_button',
      '.submit_button.quiz_submit',
      'button.quiz_submit'
    ]
    for (const selector of candidates) {
      const button = document.querySelector(selector)
      if (button && !button.disabled && !button.hidden) {
        const style = window.getComputedStyle(button)
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          return button
        }
      }
    }
    return null
  }

  queueQuestionNavigation(selectedAutomatically) {
    if (!selectedAutomatically) return

    if (this.isAllQuestionsPage()) {
      if (this.isRenderingAnswers) {
        this.pendingAllQuestionsSubmit = true
      } else {
        this.clickAllQuestionsSubmit()
      }
      return
    }

    if (!this.isSingleQuestionAtATimePage()) return

    if (this.isRenderingAnswers) {
      this.pendingSingleQuestionNavigation = true
      return
    }

    this.clickSingleQuestionNavigation()
  }

  async clickSingleQuestionNavigation() {
    if (this.singleQuestionNavigationClicked || this.singleQuestionNavigationPending) return false

    this.singleQuestionNavigationPending = true
    await createAutoNavigationDelay(this.logger)
    this.singleQuestionNavigationPending = false

    if (this.singleQuestionNavigationClicked) return false

    const navigationButton = this.findSingleQuestionNavigationButton()
    if (!navigationButton) {
      this.logger.warn('Single-question navigation button not found')
      return false
    }

    this.singleQuestionNavigationClicked = true
    this.logger.info(`Clicking single-question navigation: ${navigationButton.textContent?.trim() || navigationButton.value || navigationButton.id}`)
    navigationButton.click()
    return true
  }

  async clickAllQuestionsSubmit() {
    if (this.allQuestionsSubmitClicked || this.allQuestionsSubmitPending) return false

    this.allQuestionsSubmitPending = true
    await createAutoNavigationDelay(this.logger)
    this.allQuestionsSubmitPending = false

    if (this.allQuestionsSubmitClicked) return false

    const submitButton = this.findAllQuestionsSubmitButton()
    if (!submitButton) {
      this.logger.warn('All-questions submit button not found')
      return false
    }

    this.allQuestionsSubmitClicked = true
    this.logger.info('Clicking all-questions submit button')
    submitButton.click()
    return true
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

      let iconName, badgeText, badgeColor
      switch (source) {
        case 'knowledge_bank':
          iconName = 'landmark'
          badgeText = 'Knowledge Bank'
          badgeColor = '#4CAF50'
          break
        case 'canvas':
          iconName = 'clock'
          badgeText = 'Your History'
          badgeColor = '#2196F3'
          break
        case 'new':
          iconName = 'sparkles'
          badgeText = 'New Question'
          badgeColor = '#FF9800'
          break
        case 'ai':
          iconName = 'bot'
          badgeText = 'AI'
          badgeColor = '#9C27B0'
          break
        default:
          iconName = 'circle-question-mark'
          badgeText = 'Unknown'
          badgeColor = '#666'
      }

      // Safe HTML creation to prevent XSS
      const iconSpan = document.createElement('span')
      iconSpan.className = 'badge-icon'
      iconSpan.appendChild(QuizBankIcons.create(iconName, 12))

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
   * Register a question that has no known answer for AI.
   * Trigger is automatic when enabled, or manual otherwise.
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
    button.append(
      QuizBankIcons.create('bot', 14),
      document.createTextNode('Ask AI')
    )
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
  setAIButtonState(entry, iconName, text, color, disabled) {
    if (!entry.button) return
    const iconClass = iconName === 'loader-circle' ? 'qb-icon-spin' : ''
    entry.button.replaceChildren(
      QuizBankIcons.create(iconName, 14, iconClass),
      document.createTextNode(text)
    )
    entry.button.style.background = color
    entry.button.style.cursor = disabled ? 'wait' : 'pointer'
    entry.button.disabled = disabled
  }

  /**
   * Trigger the AI request for a question. In-flight -> ignored; failed -> retry.
   * Starting a question aborts any other still-in-flight request.
   */
  async triggerAI(questionId) {
    const entry = this.aiRegistry.get(questionId)
    if (!entry) return

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
    this.setAIButtonState(entry, 'loader-circle', 'Asking AI…', '#7B1FA2', true)

    const questionInfo = {
      questionText: entry.question.questionText,
      questionType: entry.question.questionType,
      options: entry.question.options
    }

    const deviceId = await this.dbManager.getDeviceId()
    const aiUsesChoiceSelection = [
      QuestionTypes.MULTIPLE_CHOICE,
      QuestionTypes.TRUE_FALSE,
      QuestionTypes.MULTIPLE_ANSWER
    ].includes(entry.questionType)
    const selectionDelay = this.autoSelectAnswers && aiUsesChoiceSelection
      ? createAutoSelectionDelay(this.logger, questionId, this.stealthMode)
      : null
    const result = await askGemini(
      questionInfo,
      entry.quizContext,
      deviceId,
      this.logger,
      requestId
    )

    // Discard if this request was superseded/aborted (entry reused or registry cleared).
    if (entry.requestId !== requestId) {
      return
    }
    if (result.status === 'aborted') {
      entry.state = 'idle'
      this.setAIButtonState(entry, 'bot', 'Ask AI', '#9C27B0', false)
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
      const selectedAutomatically = await entry.displayer.displayAIAnswer(
        aiQuestion,
        questionId,
        entry.questionType,
        this.autoSelectAnswers,
        selectionDelay
      )
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

      this.queueQuestionNavigation(selectedAutomatically)
    } else {
      // Failed - allow retry (button turns red; right-click re-triggers in stealth).
      entry.state = 'failed'
      entry.requestId = null
      this.setAIButtonState(entry, 'rotate-cw', 'Retry AI', '#D32F2F', false)
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
        this.setAIButtonState(entry, 'bot', 'Ask AI', '#9C27B0', false)
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
    autoSelectionGeneration += 1

    // Abort any in-flight AI requests and clear the registry before a re-render
    this.abortAllAIRequests()
    this.aiRegistry.clear()

    // Remove automatic selections from a previous render.
    document
      .querySelectorAll('[data-quizbank-auto-selected="true"]')
      .forEach(input => {
        input.checked = false
        input.classList.remove('auto-selected')
        input.removeAttribute('data-quizbank-auto-selected')
      })

    // Remove source badges
    document.querySelectorAll('.answer-source-badge').forEach(el => el.remove())

    // Remove active selection countdowns
    document.querySelectorAll('.quizbank-auto-countdown').forEach(el => el.remove())
    document
      .querySelectorAll('.quizbank-countdown-header')
      .forEach(el => el.classList.remove('quizbank-countdown-header'))

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
    const revYardReviewUrl = `${QUIZBANK_API_URL}/revyard?quizbank_course_id=${encodeURIComponent(courseId)}&quizbank_quiz_id=${encodeURIComponent(quizId)}`

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

    // Inline Lucide SVG paths; license notice lives in THIRD-PARTY-LICENSES.md.
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
                        ${QuizBankIcons.svg('target', 16)} This Quiz (You)
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
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
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
                        ${QuizBankIcons.svg('download', 14)} Export This Quiz Questions
                    </button>
                    <a id="review-revyard-btn" href="${revYardReviewUrl}" target="_blank" rel="noopener" style="
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                        width: 100%;
                        box-sizing: border-box;
                        background: linear-gradient(135deg, #9C27B0, #7B1FA2);
                        color: white;
                        border: none;
                        padding: 8px 12px;
                        border-radius: 6px;
                        font-size: 11px;
                        font-weight: bold;
                        cursor: pointer;
                        text-decoration: none;
                        transition: all 0.2s ease;
                        margin-top: 8px;
                    " onmouseover="this.style.opacity='0.9';"
                       onmouseout="this.style.opacity='1';">
                        ${QuizBankIcons.svg('book-open', 14)} Review
                    </a>
                </div>
                
                <!-- This Course Section -->
                <div style="flex: 1; min-width: 200px;">
                    <h5 style="margin: 0 0 8px 0; color: #4CAF50; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                        ${QuizBankIcons.svg('book-open', 16)}
                        This Course (Everyone)
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
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
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
                        ${QuizBankIcons.svg('download', 14)} Export This Course Questions
                    </button>
                </div>
            </div>

            <!-- Export Filters -->
            <div style="margin-bottom: 16px; padding: 10px; background: #f8f9fa; border-radius: 8px; border: 1px solid #e0e0e0;">
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 6px; font-weight: 600;">
                    ${QuizBankIcons.svg('list-filter', 14)} Export Filter:
                </label>
                <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
                    <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer;">
                        <input type="checkbox" id="filter-correct" checked style="cursor: pointer; width: 13px; height: 13px;">
                        <span>${QuizBankIcons.svg('circle-check', 14)} Correct</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer;">
                        <input type="checkbox" id="filter-wrong" checked style="cursor: pointer; width: 13px; height: 13px;">
                        <span>${QuizBankIcons.svg('circle-x', 14)} Wrong</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer;">
                        <input type="checkbox" id="filter-new" checked style="cursor: pointer; width: 13px; height: 13px;">
                        <span>${QuizBankIcons.svg('sparkles', 14)} New/Partial/Unknown</span>
                    </label>
                </div>
            </div>

            <!-- QuizBank Vault Section -->
            <div style="margin-bottom: 16px;">
                <h5 style="margin: 0 0 8px 0; color: #9C27B0; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                    ${QuizBankIcons.svg('users', 16)}
                    QuizBank Vault (Everyone)
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
                <span>${QuizBankIcons.svg('sparkles', 16)}</span>
                <span>New Update Available</span>
            </a>

            <div style="padding-top: 8px; font-size: 11px; color: #666; text-align: center; border-top: 1px solid #eee;">
                QuizBank Active ${QuizBankIcons.svg('sparkles', 12)} <span style="color: #999;">v${browser.runtime.getManifest().version}</span>
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

    // Get course name for exports
    const courseName = document.title || `Course ${courseId}`

    // Helper function to get filter config from checkboxes
    const getFilterConfig = () => ({
      includeCorrect: document.getElementById('filter-correct')?.checked ?? true,
      includeWrong: document.getElementById('filter-wrong')?.checked ?? true,
      includeNew: document.getElementById('filter-new')?.checked ?? true
    })
    const setExportButtonContent = (button, iconName, label) => {
      const iconClass = iconName === 'loader-circle' ? 'qb-icon-spin' : ''
      button.replaceChildren(
        QuizBankIcons.create(iconName, 14, iconClass),
        document.createTextNode(label)
      )
    }

    // Quiz export button
    const quizExportBtn = document.getElementById('export-quiz-btn')
    if (quizExportBtn) {
      quizExportBtn.addEventListener('click', async () => {
        quizExportBtn.disabled = true
        setExportButtonContent(quizExportBtn, 'loader-circle', 'Downloading...')

        try {
          const filterConfig = getFilterConfig()
          await this.questionCompiler.exportAsHTML(quizId, courseId, filterConfig)
          this.logger.info(`✅ Quiz questions exported successfully`)
          setExportButtonContent(quizExportBtn, 'circle-check', 'Downloaded!')
          setTimeout(() => {
            setExportButtonContent(quizExportBtn, 'download', 'Export This Quiz Questions')
          }, 2000)
        } catch (error) {
          this.logger.error('Quiz export failed:', error)
          setExportButtonContent(quizExportBtn, 'circle-x', error.message)
          quizExportBtn.style.background = '#f44336'
          setTimeout(() => {
            setExportButtonContent(quizExportBtn, 'download', 'Export This Quiz Questions')
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
        setExportButtonContent(courseExportBtn, 'loader-circle', 'Downloading...')

        try {
          const filterConfig = getFilterConfig()
          await this.questionCompiler.exportCourseAsHTML(courseId, courseName, filterConfig)
          this.logger.info(`✅ Course questions exported successfully`)
          setExportButtonContent(courseExportBtn, 'circle-check', 'Downloaded!')
          setTimeout(() => {
            setExportButtonContent(courseExportBtn, 'download', 'Export This Course Questions')
          }, 2000)
        } catch (error) {
          this.logger.error('Course export failed:', error)
          setExportButtonContent(courseExportBtn, 'circle-x', error.message)
          courseExportBtn.style.background = '#f44336'
          setTimeout(() => {
            setExportButtonContent(courseExportBtn, 'download', 'Export This Course Questions')
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
    this.selectionGeneration = autoSelectionGeneration
  }

  resolveChoiceInput(element) {
    return element?.matches?.('input[type="radio"], input[type="checkbox"]')
      ? element
      : element?.querySelector?.('input[type="radio"], input[type="checkbox"]')
        || element?.closest?.('.answer')?.querySelector('input[type="radio"], input[type="checkbox"]')
  }

  markAutoSelected(input) {
    input.classList.add('auto-selected')
    input.setAttribute('data-quizbank-auto-selected', 'true')
  }

  async selectChoiceInputs(elements, delayPromise = null) {
    const inputs = Array.from(
      new Set(elements.map(element => this.resolveChoiceInput(element)))
    ).filter(input => input && !input.disabled)
    const pendingInputs = inputs.filter(input => !input.checked)

    if (pendingInputs.length > 0) {
      await (delayPromise || createAutoSelectionDelay(this.logger))

      if (this.selectionGeneration !== autoSelectionGeneration) return false

      for (const input of pendingInputs) {
        if (input.isConnected && !input.checked) input.click()
      }
    }

    for (const input of inputs) {
      if (input.checked) this.markAutoSelected(input)
    }

    return inputs.length > 0 && inputs.every(input => input.checked)
  }

  async selectChoiceInput(element, delayPromise = null) {
    return this.selectChoiceInputs([element], delayPromise)
  }

  async displayMultipleChoice(question, questionId, autoSelect = false) {
    this.logger.info(`Displaying multiple choice for question ${questionId}`)

    if (!question) return

    const bestAnswer = question.bestAnswer
    if (!bestAnswer) return

    const selectionDelay = autoSelect && bestAnswer.correct === Correct.TRUE
      ? createAutoSelectionDelay(this.logger, questionId, this.stealthMode)
      : null

    // Use the original working approach: direct element ID lookup
    const answerId = `question_${questionId}_answer_${bestAnswer.text}`
    this.logger.info(`Looking for element with ID: ${answerId}`)
    const el = document.getElementById(answerId)

    if (el) {
      this.logger.info(`✅ Found element for question ${questionId}`)
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

    if (autoSelect && bestAnswer.correct === Correct.TRUE && el) {
      return this.selectChoiceInput(el, selectionDelay)
    }

    return false
  }

  /**
   * Display a Gemini AI answer. Matches by option text (AI has no Canvas answer ids).
   */
  async displayAIAnswer(question, questionId, questionType, autoSelect = false, selectionDelay = null) {
    const answerText = question.bestAnswer?.text
    if (!answerText) return

    let selectedAutomatically = false

    const isChoiceQuestion = [
      QuestionTypes.MULTIPLE_CHOICE,
      QuestionTypes.TRUE_FALSE,
      QuestionTypes.MULTIPLE_ANSWER
    ].includes(questionType)
    if (autoSelect && isChoiceQuestion && !selectionDelay) {
      selectionDelay = createAutoSelectionDelay(this.logger, questionId, this.stealthMode)
    }

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
        if (autoSelect) {
          selectedAutomatically = await this.selectChoiceInputs(matchedLabels, selectionDelay)
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
        if (autoSelect) {
          selectedAutomatically = await this.selectChoiceInputs(
            Array.from(matchedLabels),
            selectionDelay
          )
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
          this.highlightAIAnswerWithBadge(textarea, 'AI suggestion')
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
          this.highlightAIAnswerWithBadge(input, answerText)
        }
      }
    }

    return selectedAutomatically
  }

  highlightAIAnswerWithBadge(element, customMessage = null) {
    const badge = document.createElement('span')
    badge.className = 'ai-answer-badge'

    const iconSpan = document.createElement('span')
    iconSpan.className = 'badge-icon'
    iconSpan.appendChild(QuizBankIcons.create('bot', 12))

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
          this.highlightCorrectAnswerWithBadge(input, bestAnswer.text)
        }
      } else if (bestAnswer.correct === Correct.FALSE) {
        if (!this.stealthMode) {
          input.placeholder = `Previously wrong: ${bestAnswer.text}`
          input.style.borderColor = '#ff5722'
          this.highlightWrongAnswerWithBadge(input, bestAnswer.text)
        }
      }
    }
  }

  async displayMultipleAnswer(question, questionId, autoSelect = false) {
    this.logger.info(`Displaying multiple answer for question ${questionId}`)

    const bestAnswer = question.bestAnswer
    if (!bestAnswer) return

    const isCorrect = bestAnswer.correct === Correct.TRUE
    // Stealth only ever marks correct answers (never wrong).
    if (this.stealthMode && !isCorrect) return

    const selectionDelay = autoSelect && isCorrect
      ? createAutoSelectionDelay(this.logger, questionId, this.stealthMode)
      : null

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

    if (autoSelect && isCorrect) {
      return this.selectChoiceInputs(selectedInputs, selectionDelay)
    }

    return false
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
        const input = document.getElementById(
          `question_${questionId}_answer_${answerId}`
        )
        const questionElement = document.getElementById(`question_${questionId}`)
        if (
          input?.type === 'checkbox' &&
          questionElement?.contains(input)
        ) {
          inputs.push(input)
        }
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
          const input = label.closest('.answer')?.querySelector('input[type="checkbox"]')
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
          this.highlightCorrectAnswerWithBadge(textarea, 'Previous answer')
        }
      } else if (bestAnswer.correct === Correct.FALSE) {
        if (!this.stealthMode) {
          textarea.placeholder = `Previously attempted: ${bestAnswer.text.substring(
            0,
            100
          )}...`
          textarea.style.borderColor = '#ff5722'
          this.highlightWrongAnswerWithBadge(textarea, 'Previous attempt')
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
              this.highlightCorrectAnswerWithBadge(select, 'Previous answer')
            }
          } else if (bestAnswer.correct === Correct.FALSE) {
            if (!this.stealthMode) {
              select.style.borderColor = '#ff5722'
              this.highlightWrongAnswerWithBadge(select, 'Previous attempt')
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
    // Safe HTML creation to prevent XSS
    const iconSpan = document.createElement('span')
    iconSpan.className = 'badge-icon'
    iconSpan.appendChild(QuizBankIcons.create('circle-check', 12))

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
    // Safe HTML creation to prevent XSS
    const iconSpan = document.createElement('span')
    iconSpan.className = 'badge-icon'
    iconSpan.appendChild(QuizBankIcons.create('circle-x', 12))

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
    if (question.wrongAnswers) {
      for (const wrongAnswer of question.wrongAnswers) {
        const questionElement = document.getElementById(`question_${questionId}`)
        const hasCheckboxChoices = questionElement?.querySelector('input[type="checkbox"]')
        const answerFields = wrongAnswer.dynamicFields || wrongAnswer.answer_fields

        if (hasCheckboxChoices && answerFields) {
          const wrongInputs = this.resolveMultipleAnswerInputs(
            {
              dynamicFields: answerFields,
              text: wrongAnswer.answer_text || wrongAnswer.text
            },
            questionId
          )

          for (const input of wrongInputs) {
            this.highlightWrongAnswerWithBadge(input)
          }

          if (wrongInputs.length > 0) continue
        }

        // Keep ID-based behavior for non-checkbox question types.
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
      <h4 style="margin: 0; color: #333; font-size: 16px; display: flex; align-items: center; gap: 6px;">${QuizBankIcons.svg('landmark', 16)} QuizBank</h4>
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

  if (message.type === `${prefix}-set-auto-select`) {
    const logger = BrowserLogger.getInstance()
    logger.info(`Auto-select answers toggled to ${message.enabled ? 'ON' : 'OFF'} - re-running...`)
    if (currentLoader) {
      currentLoader.abortAllAIRequests()
      currentLoader.autoSelectAnswers = message.enabled === true
    }

    // Re-run QuizBank to apply or remove automatic selections.
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
