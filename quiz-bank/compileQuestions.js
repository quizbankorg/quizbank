// ==================== QUESTION COMPILER CLASS ====================

/**
 * QuestionCompiler - Captures and compiles quiz questions with QuizBank badges
 * Automatically saves question HTML organized by quiz ID and provides export functionality
 */
class QuestionCompiler {
  constructor(logger, supabaseManager = null) {
    this.logger = logger || new NoOpLogger()
    this.supabaseManager = supabaseManager
    this.stealthMode = false // Default to disabled

    if (!this.supabaseManager) {
      this.logger.warn('⚠️ QuestionCompiler initialized without database manager')
    }
  }

  /**
   * Set stealth mode status
   */
  setStealthMode(enabled) {
    this.stealthMode = enabled
  }

  /**
   * Capture a single question's HTML from the DOM
   */
  async captureQuestion(questionId, quizId, courseId) {
    if (this.stealthMode) {
      this.logger.info('🤫 Stealth Mode is ON - skipping question capture')
      return null
    }

    try {
      // Find the question container
      const questionContainer = document.getElementById(`question_${questionId}`)
      if (!questionContainer) {
        this.logger.warn(`Question container not found for question ${questionId}`)
        return null
      }

      // First, build a map of image URLs to data URLs
      const images = questionContainer.querySelectorAll('img')
      const urlToDataUrlMap = new Map()

      if (images.length > 0) {
        this.logger.info(`🖼️ Processing ${images.length} image(s) in question ${questionId}`)

        for (const img of images) {
          const originalSrc = img.src
          if (!originalSrc.startsWith('data:')) {
            this.logger.info(`🔄 Fetching: ${originalSrc.substring(0, 60)}...`)
            const dataUrl = await this.fetchImageAsDataURL(originalSrc)
            if (dataUrl) {
              urlToDataUrlMap.set(originalSrc, dataUrl)
              this.logger.info(`✅ Fetched (${Math.round(dataUrl.length / 1024)}KB)`)
            } else {
              this.logger.warn(`⚠️ Failed to fetch image`)
            }
          }
        }
      }

      // Clone the element
      const clone = questionContainer.cloneNode(true)

      // Clean up unnecessary elements
      const inputs = clone.querySelectorAll('input[type="radio"], input[type="checkbox"]')
      inputs.forEach(input => {
        input.removeAttribute('checked')
      })

      // Remove question number from the question name
      const questionName = clone.querySelector('.question_name')
      if (questionName) {
        questionName.textContent = questionName.textContent.replace(/Question\s+\d+/i, 'Question')
      }

      // Get the HTML string
      let questionHTML = clone.outerHTML

      // Replace image URLs with data URLs in the HTML string
      if (urlToDataUrlMap.size > 0) {
        this.logger.info(`🔧 Replacing ${urlToDataUrlMap.size} image URL(s) with data URLs...`)

        urlToDataUrlMap.forEach((dataUrl, originalUrl) => {
          // Escape special regex characters in the URL
          const escapedUrl = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          // Replace in src attributes
          const regex = new RegExp(`src="${escapedUrl}"`, 'g')
          questionHTML = questionHTML.replace(regex, `src="${dataUrl}"`)
        })

        this.logger.info(`✅ All image URLs replaced with embedded data URLs`)
      }

      // Store the question
      await this.saveQuestion(quizId, courseId, questionId, questionHTML)

      this.logger.info(`📸 Captured question ${questionId} for quiz ${quizId}`)
      return questionHTML
    } catch (error) {
      this.logger.error(`Failed to capture question ${questionId}:`, error)
      return null
    }
  }


  /**
   * Fetch an image and convert it to a data URL using fetch() and FileReader
   * This approach bypasses canvas CORS restrictions
   */
  async fetchImageAsDataURL(imageUrl) {
    try {
      // Fetch the image as a blob
      const response = await fetch(imageUrl)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const blob = await response.blob()

      // Convert blob to data URL using FileReader
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
    } catch (error) {
      this.logger.warn(`Could not fetch image as data URL:`, error.message)
      return null
    }
  }



  /**
   * Capture all questions on the current page
   */
  async captureAllQuestions(quizId, courseId, questionIds) {
    this.logger.info(`📸 Starting batch capture of ${questionIds.length} questions for quiz ${quizId}`)

    let capturedCount = 0
    for (const questionId of questionIds) {
      const result = await this.captureQuestion(questionId, quizId, courseId)
      if (result) capturedCount++
    }

    this.logger.info(`✅ Captured ${capturedCount}/${questionIds.length} questions`)
    return capturedCount
  }

  /**
   * Check if HTML contains correct answer badges
   */
  hasCorrectAnswers(html) {
    // Check for the badge class
    if (html.includes('correct-answer-badge')) return true

    // Check for the checkmark emoji
    if (html.includes('✅')) return true

    // Check for badge text variations
    if (html.includes('Correct</span>')) return true
    if (html.includes('>Correct<')) return true

    // Check for badge-text class with Correct
    if (html.includes('badge-text') && html.includes('Correct')) return true

    return false
  }

  /**
   * Save question HTML to database only
   * Smart override: only override if new capture has correct answers
   */
  async saveQuestion(quizId, courseId, questionId, questionHTML) {
    if (!this.supabaseManager) {
      this.logger.error('Cannot save question: database manager not available')
      return
    }

    try {
      const newHasCorrect = this.hasCorrectAnswers(questionHTML)
      const newHasWrong = questionHTML.includes('wrong-answer-badge') || questionHTML.includes('Previously wrong')

      // Debug logging
      this.logger.info(`📊 Question ${questionId} detection:`, {
        hasCorrect: newHasCorrect,
        hasWrong: newHasWrong,
        hasCorrectBadgeClass: questionHTML.includes('correct-answer-badge'),
        hasCheckmark: questionHTML.includes('✅'),
        hasWrongBadgeClass: questionHTML.includes('wrong-answer-badge')
      })

      // Save to database (smart override logic handled in database method)
      await this.supabaseManager.saveCompiledQuestion(
        courseId,
        quizId,
        questionId,
        questionHTML,
        newHasCorrect,
        newHasWrong
      )

      this.logger.info(`💾 Saved question ${questionId} to database (has correct: ${newHasCorrect})`)
    } catch (error) {
      this.logger.error(`Failed to save question ${questionId}:`, error)
      throw error
    }
  }

  /**
   * Extract quiz name from the page
   */
  extractQuizName() {
    // Try to find quiz title in the page
    const titleElement = document.querySelector('#quiz-title, .quiz-title, h1')
    if (titleElement) {
      return titleElement.textContent.trim()
    }
    return null
  }

  /**
   * Get compiled questions for a specific quiz from database
   */
  async getCompiledQuestions(quizId, courseId) {
    if (!this.supabaseManager) {
      this.logger.error('Cannot get questions: database manager not available')
      return null
    }

    try {
      const questions = await this.supabaseManager.getCompiledQuestions(courseId, quizId)

      if (!questions || questions.length === 0) {
        return null
      }

      // Transform database format to match expected format
      const result = {
        courseId,
        quizId,
        courseName: document.title || `Course ${courseId}`,
        quizName: this.extractQuizName() || `Quiz ${quizId}`,
        questions: {},
        lastUpdated: questions[0]?.updated_at || new Date().toISOString()
      }

      // Convert array to object keyed by canvas_question_id
      questions.forEach(q => {
        result.questions[q.canvas_question_id] = {
          html: q.question_html,
          capturedAt: q.captured_at,
          hasCorrect: q.has_correct,
          hasWrong: q.has_wrong
        }
      })

      return result
    } catch (error) {
      this.logger.error(`Failed to retrieve compiled questions:`, error)
      return null
    }
  }

  /**
   * Get all compiled quizzes from database (for listing)
   */
  async getAllCompiledQuizzes() {
    if (!this.supabaseManager) {
      this.logger.error('Cannot get quizzes: database manager not available')
      return []
    }

    try {
      return await this.supabaseManager.getAllCompiledQuizzes()
    } catch (error) {
      this.logger.error(`Failed to retrieve compiled quizzes:`, error)
      return []
    }
  }

  /**
   * Export compiled questions as HTML file with optional filter
   * @param {Object} filterConfig - { includeCorrect, includeWrong, includeNew }
   */
  async exportAsHTML(quizId, courseId, filterConfig = null) {
    try {
      const quizData = await this.getCompiledQuestions(quizId, courseId)

      if (!quizData || Object.keys(quizData.questions).length === 0) {
        throw new Error('No compiled questions found for this quiz')
      }

      const { courseName, quizName, questions, lastUpdated } = quizData

      // Default to include all if no filter provided
      const config = filterConfig || {
        includeCorrect: true,
        includeWrong: true,
        includeNew: true
      }

      // Filter questions based on checkbox selections
      let filteredQuestions = questions
      if (filterConfig) {
        filteredQuestions = Object.fromEntries(
          Object.entries(questions).filter(([_, data]) => {
            const hasCorrect = data.hasCorrect || false
            const hasWrong = data.hasWrong || false
            const isNew = !hasCorrect && !hasWrong

            // Include if matches any selected filter
            if (config.includeCorrect && hasCorrect) return true
            if (config.includeWrong && hasWrong && !hasCorrect) return true
            if (config.includeNew && isNew) return true

            return false
          })
        )
      }

      const questionCount = Object.keys(filteredQuestions).length

      if (questionCount === 0) {
        throw new Error('No questions match the selected filters.')
      }

      // Build filter label for display
      const filterParts = []
      if (config.includeCorrect) filterParts.push('✅ Correct')
      if (config.includeWrong) filterParts.push('🚫 Wrong')
      if (config.includeNew) filterParts.push('✨ New/Partial/Unknown')
      const filterLabel = filterParts.length === 3 ? 'All Questions' : filterParts.join(', ')

      // Generate questions HTML and count stats
      let questionsHTML = ''
      let correctCount = 0
      let wrongCount = 0
      let newCount = 0

      Object.entries(filteredQuestions).forEach(([qId, data]) => {
        questionsHTML += data.html + '\n\n'
        if (data.hasCorrect) correctCount++
        else if (data.hasWrong) wrongCount++
        else newCount++
      })

      // Generate HTML content using shared base template
      const html = this.generateBaseHTMLDocument(
        quizName,
        courseName,
        questionsHTML,
        questionCount,
        correctCount,
        wrongCount,
        newCount,
        false, // isGlobal
        filterLabel
      )

      // Create filename
      const filename = `quiz-${quizId}-compiled.html`

      // Download the file
      this.downloadFile(filename, html, 'text/html')

      this.logger.info(`📥 Exported ${questionCount} questions to ${filename}`)
      return filename
    } catch (error) {
      this.logger.error(`Failed to export questions:`, error)
      throw error
    }
  }

  /**
   * HTML escape utility
   */
  escapeHTML(str) {
    if (!str) return ''
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }

  /**
   * Download file helper
   */
  downloadFile(filename, content, mimeType = 'text/html') {
    const blob = new Blob([content], { type: mimeType })
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
   * Clear questions for a specific quiz from database
   */
  async clearQuiz(quizId, courseId) {
    if (!this.supabaseManager) {
      this.logger.error('Cannot clear quiz: database manager not available')
      return
    }

    try {
      await this.supabaseManager.clearCompiledQuiz(courseId, quizId)
      this.logger.info(`🗑️ Cleared compiled questions for quiz ${quizId}`)
    } catch (error) {
      this.logger.error(`Failed to clear quiz ${quizId}:`, error)
    }
  }

  /**
   * Export all compiled questions for a course as HTML
   */
  async exportCourseAsHTML(courseId, courseName, filterConfig = null) {
    try {
      if (!this.supabaseManager) {
        throw new Error('Database manager not available')
      }

      const questions = await this.supabaseManager.getCourseCompiledQuestions(courseId)

      if (!questions || questions.length === 0) {
        throw new Error('No compiled questions found for this course')
      }

      // Default to include all if no filter provided
      const config = filterConfig || {
        includeCorrect: true,
        includeWrong: true,
        includeNew: true
      }

      // Filter questions based on config
      const filteredQuestions = questions.filter(q => {
        const hasCorrect = q.has_correct || false
        const hasWrong = q.has_wrong || false
        const isNew = !hasCorrect && !hasWrong

        if (config.includeCorrect && hasCorrect) return true
        if (config.includeWrong && hasWrong && !hasCorrect) return true
        if (config.includeNew && isNew) return true

        return false
      })

      if (filteredQuestions.length === 0) {
        throw new Error('No questions match the selected filters')
      }

      // Build filter label for display
      const filterParts = []
      if (config.includeCorrect) filterParts.push('✅ Correct')
      if (config.includeWrong) filterParts.push('🚫 Wrong')
      if (config.includeNew) filterParts.push('✨ New/Partial/Unknown')
      const filterLabel = filterParts.length === 3 ? 'All Questions' : filterParts.join(', ')

      // Group questions by quiz
      const quizGroups = {}
      filteredQuestions.forEach(q => {
        const quizId = q.quiz_id
        if (!quizGroups[quizId]) {
          quizGroups[quizId] = {
            quizName: q.quizzes?.quiz_name || `Quiz ${quizId}`,
            questions: {}
          }
        }
        quizGroups[quizId].questions[q.canvas_question_id] = {
          html: q.question_html,
          capturedAt: q.captured_at,
          hasCorrect: q.has_correct,
          hasWrong: q.has_wrong
        }
      })

      // Generate HTML content
      const html = this.generateCourseHTMLDocument(courseName, quizGroups, filteredQuestions.length, filterLabel)

      // Create filename
      const filename = `course-${courseId}-compiled.html`

      // Download the file
      this.downloadFile(filename, html, 'text/html')

      this.logger.info(`📥 Exported ${filteredQuestions.length} questions for course to ${filename}`)
      return filename
    } catch (error) {
      this.logger.error(`Failed to export course questions:`, error)
      throw error
    }
  }

  /**
   * Export all compiled questions globally as HTML
   */
  async exportGlobalAsHTML(filterConfig = null) {
    try {
      if (!this.supabaseManager) {
        throw new Error('Database manager not available')
      }

      const questions = await this.supabaseManager.getGlobalCompiledQuestions()

      if (!questions || questions.length === 0) {
        throw new Error('No compiled questions found in the knowledge bank')
      }

      // Default to include all if no filter provided
      const config = filterConfig || {
        includeCorrect: true,
        includeWrong: true,
        includeNew: true
      }

      // Filter questions based on config
      const filteredQuestions = questions.filter(q => {
        const hasCorrect = q.has_correct || false
        const hasWrong = q.has_wrong || false
        const isNew = !hasCorrect && !hasWrong

        if (config.includeCorrect && hasCorrect) return true
        if (config.includeWrong && hasWrong && !hasCorrect) return true
        if (config.includeNew && isNew) return true

        return false
      })

      if (filteredQuestions.length === 0) {
        throw new Error('No questions match the selected filters')
      }

      // Group questions by course, then by quiz
      const courseGroups = {}
      filteredQuestions.forEach(q => {
        const courseId = q.course_id
        const quizId = q.quiz_id

        if (!courseGroups[courseId]) {
          courseGroups[courseId] = {
            courseName: q.courses?.course_name || `Course ${courseId}`,
            quizzes: {}
          }
        }

        if (!courseGroups[courseId].quizzes[quizId]) {
          courseGroups[courseId].quizzes[quizId] = {
            quizName: q.quizzes?.quiz_name || `Quiz ${quizId}`,
            questions: {}
          }
        }

        courseGroups[courseId].quizzes[quizId].questions[q.canvas_question_id] = {
          html: q.question_html,
          capturedAt: q.captured_at,
          hasCorrect: q.has_correct,
          hasWrong: q.has_wrong
        }
      })

      // Generate HTML content
      const html = this.generateGlobalHTMLDocument(courseGroups, filteredQuestions.length)

      // Create filename with timestamp
      const timestamp = new Date().toISOString().split('T')[0]
      const filename = `quizbank-vault-${timestamp}.html`

      // Download the file
      this.downloadFile(filename, html, 'text/html')

      this.logger.info(`📥 Exported ${filteredQuestions.length} questions globally to ${filename}`)
      return filename
    } catch (error) {
      this.logger.error(`Failed to export global questions:`, error)
      throw error
    }
  }

  /**
   * Generate HTML document for course export (grouped by quiz)
   */
  generateCourseHTMLDocument(courseName, quizGroups, totalQuestionCount, filterLabel = 'All Questions') {
    let questionsHTML = ''
    let correctCount = 0
    let wrongCount = 0
    let newCount = 0

    Object.entries(quizGroups).forEach(([quizId, quizData]) => {
      questionsHTML += `
        <div class="quiz-section">
          <h2 class="quiz-section-title">📝 ${this.escapeHTML(quizData.quizName)}</h2>
      `

      Object.entries(quizData.questions).forEach(([qId, data]) => {
        questionsHTML += data.html + '\n\n'
        if (data.hasCorrect) correctCount++
        else if (data.hasWrong) wrongCount++
        else newCount++
      })

      questionsHTML += '</div>'
    })

    return this.generateBaseHTMLDocument(
      courseName,
      `${Object.keys(quizGroups).length} Quizzes`,
      questionsHTML,
      totalQuestionCount,
      correctCount,
      wrongCount,
      newCount,
      false, // isGlobal
      filterLabel
    )
  }

  /**
   * Generate HTML document for global export (grouped by course and quiz)
   */
  generateGlobalHTMLDocument(courseGroups, totalQuestionCount) {
    let questionsHTML = ''
    let correctCount = 0
    let wrongCount = 0
    let newCount = 0
    let totalCourses = Object.keys(courseGroups).length
    let totalQuizzes = 0

    Object.entries(courseGroups).forEach(([courseId, courseData]) => {
      questionsHTML += `
        <div class="course-section">
          <h2 class="course-section-title">📚 ${this.escapeHTML(courseData.courseName)}</h2>
      `

      Object.entries(courseData.quizzes).forEach(([quizId, quizData]) => {
        totalQuizzes++
        questionsHTML += `
          <div class="quiz-section">
            <h3 class="quiz-section-title">📝 ${this.escapeHTML(quizData.quizName)}</h3>
        `

        Object.entries(quizData.questions).forEach(([qId, data]) => {
          questionsHTML += data.html + '\n\n'
          if (data.hasCorrect) correctCount++
          else if (data.hasWrong) wrongCount++
          else newCount++
        })

        questionsHTML += '</div>'
      })

      questionsHTML += '</div>'
    })

    return this.generateBaseHTMLDocument(
      'QuizBank Vault',
      `${totalCourses} Courses • ${totalQuizzes} Quizzes`,
      questionsHTML,
      totalQuestionCount,
      correctCount,
      wrongCount,
      newCount,
      true // isGlobal
    )
  }

  /**
   * Generate base HTML document structure
   */
  generateBaseHTMLDocument(title, subtitle, questionsHTML, totalCount, correctCount, wrongCount, newCount, isGlobal = false, filterLabel = 'All Questions') {
    const filterInfoHTML = filterLabel !== 'All Questions' ? `
        <div style="margin-top: 16px; padding: 12px; background: ${isGlobal ? 'rgba(255,255,255,0.1)' : '#e8f4fd'}; border-radius: 6px; border-left: 3px solid ${isGlobal ? 'rgba(255,255,255,0.5)' : '#2196F3'};">
            <div style="font-size: 11px; color: ${isGlobal ? 'rgba(255,255,255,0.8)' : '#1976D2'}; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; margin-bottom: 4px;">
                Export Filter Applied
            </div>
            <div style="font-size: 13px; color: ${isGlobal ? 'white' : '#1565C0'}; font-weight: 500;">
                ${this.escapeHTML(filterLabel)}
            </div>
        </div>
    ` : ''

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.escapeHTML(title)} - QuizBank Export</title>
    <style>
        :root {
            --ic-brand-primary: ${isGlobal ? '#9C27B0' : '#667eea'};
            --ic-brand-font-color-dark: #2D3B45;
        }
        
        body {
            font-family: 'Lato', 'Helvetica Neue', Helvetica, Arial, sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f5f5;
            color: #2D3B45;
            line-height: 1.5;
            max-width: 700px;
            margin-left: auto;
            margin-right: auto;
        }
        
        .quiz-header {
            background: ${isGlobal ? 'linear-gradient(135deg, #9C27B0, #7B1FA2)' : 'white'};
            color: ${isGlobal ? 'white' : '#2D3B45'};
            padding: 24px;
            margin-bottom: 20px;
            border-radius: 12px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        }
        
        .quiz-header h1 {
            margin: 0 0 8px 0;
            font-size: 28px;
            font-weight: 600;
        }
        
        .quiz-header .subtitle {
            opacity: 0.9;
            font-size: 14px;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 8px;
            margin-top: 20px;
        }
        
        .stat-card {
            background: ${isGlobal ? 'rgba(255,255,255,0.15)' : '#f7f9fa'};
            padding: 12px;
            border-radius: 8px;
            text-align: center;
        }
        
        .stat-label {
            font-size: 10px;
            opacity: 0.8;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .stat-value {
            font-size: 24px;
            font-weight: 700;
            margin-top: 4px;
        }
        
        .course-section {
            background: white;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 24px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }
        
        .course-section-title {
            margin: 0 0 16px 0;
            font-size: 20px;
            color: #9C27B0;
            border-bottom: 2px solid #E1BEE7;
            padding-bottom: 8px;
        }
        
        .quiz-section {
            margin-bottom: 20px;
        }
        
        .quiz-section-title {
            margin: 16px 0 12px 0;
            font-size: 16px;
            color: #667eea;
        }
        
        .display_question {
            background: white;
            padding: 0;
            margin-bottom: 16px;
            border-radius: 4px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.05);
            border: 1px solid #c7cdd1;
        }
        
        .display_question .header {
            background: #f7f9fa;
            padding: 12px 16px;
            border-bottom: 1px solid #c7cdd1;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .question_name { font-weight: 600; color: #2D3B45; font-size: 15px; }
        .question_points_holder { font-size: 14px; color: #73818f; }
        .display_question .text { padding: 20px 16px; }
        .question_text { font-size: 15px; line-height: 1.6; margin-bottom: 16px; }
        
        .answer-source-badge, .correct-answer-badge, .wrong-answer-badge {
            display: inline-flex !important;
            align-items: center;
            gap: 4px;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: bold;
            margin-left: 8px;
        }
        
        .knowledge_bank-source { background: linear-gradient(135deg, #4CAF50, #45a049); color: white; }
        .canvas-source { background: linear-gradient(135deg, #2196F3, #1976D2); color: white; }
        .new-source { background: linear-gradient(135deg, #FF9800, #F57C00); color: white; }
        .correct-answer-badge { background: #4CAF50 !important; color: white !important; }
        .wrong-answer-badge { background: #ff5722 !important; color: white !important; }
        
        .answers { margin-top: 12px; }
        fieldset { border: none; padding: 0; margin: 0; }
        .answer { border-bottom: 1px solid #f0f0f0; }
        .answer:last-child { border-bottom: none; }
        .answer_row { display: flex; align-items: flex-start; padding: 10px 12px; }
        .answer_input { margin-right: 10px; }
        .answer_label { flex: 1; font-size: 14px; }
        
        .move, .links, .original_question_text, .screenreader-only { display: none !important; }
        
        .footer {
            text-align: center;
            margin-top: 40px;
            padding: 20px;
            color: #73818f;
            font-size: 13px;
            background: white;
            border-radius: 8px;
        }
        
        @media print {
            body { background: white; }
            .display_question { page-break-inside: avoid; box-shadow: none; }
        }
    </style>
</head>
<body>
    <div class="quiz-header">
        <h1>${isGlobal ? '🏦' : '📚'} ${this.escapeHTML(title)}</h1>
        <div class="subtitle">${this.escapeHTML(subtitle)}</div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Total Questions</div>
                <div class="stat-value">${totalCount}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">✅ Correct</div>
                <div class="stat-value">${correctCount}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">🚫 Wrong</div>
                <div class="stat-value">${wrongCount}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">✨ New</div>
                <div class="stat-value">${newCount}</div>
            </div>
        </div>
        ${filterInfoHTML}
    </div>
    
    <div class="questions-container">
        ${questionsHTML}
    </div>
    
    <div class="footer">
        <strong>Generated by QuizBank</strong><br>
        ${new Date().toLocaleString()}
    </div>
</body>
</html>`
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = QuestionCompiler
}
