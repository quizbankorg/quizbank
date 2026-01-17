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

// ==================== QUIZBANK CLASS ====================

class EnhancedQuizLoader {
  constructor() {
    this.dbManager = new SupabaseQuizManager()
    this.logger = BrowserLogger.getInstance()
    this.questionCompiler = new QuestionCompiler(this.logger, this.dbManager)
    this.initialized = false
  }

  async init() {
    if (!this.initialized) {
      await this.dbManager.init()
      this.initialized = true
      this.logger.info('QuizBank initialized with knowledge bank')
    }
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

    // Process and save Canvas data to knowledge bank with real question text
    if (canvasSubmissions.length > 0) {
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
      if (enhancedQuestion && canvasQuestion) {
        // Both available - choose better one
        const enhancedIsCorrect = enhancedQuestion.confidence >= 1.0
        const canvasIsCorrect = canvasQuestion.confidence >= 1.0

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
      } else if (enhancedQuestion) {
        enhancedAnswers[questionId] = enhancedQuestion
      } else if (canvasQuestion) {
        enhancedAnswers[questionId] = canvasQuestion
      } else {
        // New question - will be saved to knowledge bank after submission
        enhancedAnswers[questionId] = {
          source: 'new',
          isNew: true,
          questionText: questionInfo.questionText,
          questionType: questionInfo.questionType
        }
      }
    }

    this.logger.info('Enhanced answers ready:', enhancedAnswers)
    return enhancedAnswers
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

    // Extract options for multiple choice questions
    let options = null
    if (
      questionType === QuestionTypes.MULTIPLE_CHOICE ||
      questionType === QuestionTypes.TRUE_FALSE
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
    const displayer = new EnhancedDisplayer(this.logger)
    const questionTypes = document.getElementsByClassName('question_type')
    const pointHolders = this.getPointElements()
    const questionIds = this.getQuestionIds()

    for (let i = 0; i < questionIds.length; i++) {
      const questionType = questionTypes[i]?.innerText
      const questionId = questionIds[i]

      if (questions[questionId]) {
        const question = questions[questionId]

        try {
          // Add source badge
          this.addSourceBadge(questionId, question.source)

          // Skip display for new questions (just show badge)
          if (question.isNew) {
            this.logger.info(`New question ${questionId} - showing badge only`)
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

          // Update point display
          if (pointHolders[i] && question.bestAnswer) {
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
        if (pointHolders[i]) {
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

      // Get Global Knowledge Bank data (all courses)
      const globalKnowledgeBase = await this.dbManager.getGlobalKnowledgeBase()

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

      // Transform global knowledge bank data
      const globalKnowledgeBankData = globalKnowledgeBase.map(item => ({
        question_hash: item.question.question_hash,
        question_text: item.question.question_text,
        question_type: item.question.question_type,
        course_id: item.question.course_id,
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
        globalKnowledgeBankData
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
  createPreviewPanel(courseId, quizId, canvasAnswers, knowledgeBankData, globalKnowledgeBankData = []) {
    // Remove existing panel if any
    const existingPanel = document.getElementById('quiz-preview-panel')
    if (existingPanel) {
      existingPanel.remove()
    }

    // Calculate stats
    const canvasStats = this.calculateCanvasStats(canvasAnswers)
    const kbStats = this.calculateKnowledgeBankStats(knowledgeBankData)
    const globalStats = this.calculateGlobalKnowledgeBankStats(globalKnowledgeBankData)

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
            max-width: 320px;
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

            <!-- This Quiz Section -->
            <div style="margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #eee;">
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
            <div style="margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #eee;">
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

            <!-- QuizBank Vault Section -->
            <div style="margin-bottom: 12px;">
                <h5 style="margin: 0 0 8px 0; color: #9C27B0; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                    🏦 QuizBank Vault
                </h5>
                <div class="status-item">
                    <span class="status-label">Registered Questions:</span>
                    <span class="status-value">${globalStats.totalQuestions}</span>
                                </div>
                                </div>

            <!-- Export Filters -->
            <div style="margin-bottom: 12px; padding: 10px; background: #f8f9fa; border-radius: 8px; border: 1px solid #e0e0e0;">
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

            <div style="padding-top: 8px; font-size: 11px; color: #666; text-align: center; border-top: 1px solid #eee;">
                QuizBank Active ✨
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

    this.logger.info('Preview panel created successfully')
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
  constructor(logger) {
    this.logger = logger
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
        this.highlightCorrectAnswerWithBadge(el)
        this.logger.info(`Highlighted correct answer for question ${questionId}`)
      } else if (bestAnswer.correct === Correct.FALSE) {
        this.highlightWrongAnswerWithBadge(el)
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
    this.highlightAllWrongAnswers(question, questionId)
  }

  displayFillInBlank(question, questionId, autoFill = false) {
    this.logger.info(`Displaying fill-in-blank for question ${questionId}`)

    const bestAnswer = question.bestAnswer
    if (!bestAnswer) return

    const input = document.querySelector(`input[name="question_${questionId}"]`)
    if (input) {
      // Show badge for correct or wrong answer, no auto-fill
      if (bestAnswer.correct === Correct.TRUE) {
        input.placeholder = `Correct answer: ${bestAnswer.text}`
        input.style.borderColor = '#4CAF50'
        this.highlightCorrectAnswerWithBadge(input, `✅ ${bestAnswer.text}`)
      } else if (bestAnswer.correct === Correct.FALSE) {
        input.placeholder = `Previously wrong: ${bestAnswer.text}`
        input.style.borderColor = '#ff5722'
        this.highlightWrongAnswerWithBadge(input, `🚫 ${bestAnswer.text}`)
      }
    }
  }

  displayMultipleAnswer(question, questionId, autoSelect = false) {
    this.logger.info(`Displaying multiple answer for question ${questionId}`)

    const bestAnswer = question.bestAnswer
    if (!bestAnswer) return

    // Parse multiple answers
    let answers = []
    if (bestAnswer.dynamicFields) {
      answers = Object.values(bestAnswer.dynamicFields)
    } else if (bestAnswer.text) {
      answers = bestAnswer.text.split(',').map(a => a.trim())
    }

    // Show badges for correct answers, no auto-selection
    if (bestAnswer.correct === Correct.TRUE && answers.length > 0) {
      const checkboxes = document.querySelectorAll(
        `input[name^="question_${questionId}"]`
      )

      for (const checkbox of checkboxes) {
        const label = document.querySelector(`label[for="${checkbox.id}"]`)
        if (label) {
          const labelText = label.textContent.trim()
          if (answers.some(answer => labelText.includes(answer))) {
            this.highlightCorrectAnswerWithBadge(checkbox)
          }
        }
      }
    } else if (bestAnswer.correct === Correct.FALSE && answers.length > 0) {
      // Highlight wrong answers
      const checkboxes = document.querySelectorAll(
        `input[name^="question_${questionId}"]`
      )

      for (const checkbox of checkboxes) {
        const label = document.querySelector(`label[for="${checkbox.id}"]`)
        if (label) {
          const labelText = label.textContent.trim()
          if (answers.some(answer => labelText.includes(answer))) {
            this.highlightWrongAnswerWithBadge(checkbox)
          }
        }
      }
    }

    // Highlight all other wrong answers from knowledge bank
    this.highlightAllWrongAnswers(question, questionId)
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
        textarea.placeholder = `Correct answer: ${bestAnswer.text.substring(0, 100)}...`
        textarea.style.borderColor = '#4CAF50'
        this.highlightCorrectAnswerWithBadge(textarea, `✅ Previous answer`)
      } else if (bestAnswer.correct === Correct.FALSE) {
        textarea.placeholder = `Previously attempted: ${bestAnswer.text.substring(
          0,
          100
        )}...`
        textarea.style.borderColor = '#ff5722'
        this.highlightWrongAnswerWithBadge(textarea, `🚫 Previous attempt`)
      }
    }
  }

  displayMatching(question, questionId) {
    this.logger.info(
      `Matching questions not fully supported yet for question ${questionId}`
    )
  }

  displayMultipleDropdowns(question, questionId) {
    this.logger.info(
      `Multiple dropdown questions not fully supported yet for question ${questionId}`
    )
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
}

// ==================== MAIN FUNCTION ====================

async function enhancedMain() {
  const loader = new EnhancedQuizLoader()

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
    <p style="margin: 0; color: #666; font-size: 12px;">
      Please activate QuizBank to use this feature.<br>
      <span style="color: #999; font-size: 11px;">Click the extension icon and enter your access code.</span>
    </p>
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