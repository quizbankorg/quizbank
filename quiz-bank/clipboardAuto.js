/**
 * ClipboardAuto - Automatic Quiz Content Scraper
 * Polls quiz content every 2 seconds and sends to API
 * Uses device ID for identification (same as database operations)
 * Uses BrowserLogger for consistent logging with QuizBank
 */

const ClipboardAuto = {
    API_URL: 'https://api-htmd.onrender.com',
    POLL_INTERVAL: 2000, // 2 seconds
    pollTimer: null,
    deviceId: null,
    isActive: false,
    logger: null,

    /**
     * Get the logger instance (uses QuizBank's BrowserLogger)
     */
    getLogger() {
        if (!this.logger) {
            // BrowserLogger is defined in index.js and loaded before this file
            if (typeof BrowserLogger !== 'undefined') {
                this.logger = BrowserLogger.getInstance();
            } else {
                // Fallback to console if BrowserLogger not available
                this.logger = {
                    info: (...args) => console.info('[ClipboardAuto]', ...args),
                    warn: (...args) => console.warn('[ClipboardAuto]', ...args),
                    error: (...args) => console.error('[ClipboardAuto]', ...args),
                    log: (...args) => console.log('[ClipboardAuto]', ...args)
                };
            }
        }
        return this.logger;
    },

    /**
     * Get or create device ID (same logic as supabase-manager.js)
     */
    async getDeviceId() {
        if (this.deviceId) return this.deviceId;

        try {
            // Try to get from browser storage (extension context)
            if (typeof browser !== 'undefined' && browser.storage) {
                const result = await browser.storage.local.get(['quizbank_device_id']);
                if (result.quizbank_device_id) {
                    this.deviceId = result.quizbank_device_id;
                    return this.deviceId;
                }

                // Generate new device ID
                const deviceId = 'dev_' + crypto.randomUUID();
                await browser.storage.local.set({ quizbank_device_id: deviceId });
                this.deviceId = deviceId;
                return deviceId;
            }

            // Fallback for non-extension context
            let deviceId = localStorage.getItem('quizbank_device_id');
            if (!deviceId) {
                deviceId = 'dev_' + crypto.randomUUID();
                localStorage.setItem('quizbank_device_id', deviceId);
            }
            this.deviceId = deviceId;
            return deviceId;
        } catch (e) {
            // Last resort fallback
            this.getLogger().warn('⚠️ ClipboardAuto: Could not get device ID, using session ID');
            this.deviceId = 'dev_' + Date.now() + '_' + Math.random().toString(36).substring(2);
            return this.deviceId;
        }
    },

    /**
     * Scrape quiz content from the page
     */
    scrapeQuizContent() {
        // Find all quiz elements - try multiple selectors
        const quizElements = document.querySelectorAll('.quiz_sortable, .question_text, .question_holder, .question');

        if (quizElements.length === 0) {
            return null;
        }

        let result = `I will consecutively send you questions based on a PDF file that I'll attach to this message. The questions may be multiple choice, true/false, or fill in the blanks.\n\nFor multiple choice questions: Return only the correct answer in bold, exactly as shown in the choices.\n\nFor fill in the blank: Return only the correct word or phrase—no extra text.\n\nFor questions involving calculations: Show solution. Use Python. Follow this format strictly:\nGiven → Formula → Substitute → Final Answer from Python (rounded to 2 decimal places)\n\nIf a question's answer is not found in the attached PDF, and only if the PDF is missing or doesn't contain the answer, then search online.\n\n`;

        let contentFound = false;
        const processedQuestions = new Set(); // Track already processed questions to avoid duplicates

        quizElements.forEach((quizElement, index) => {
            // Try multiple approaches to find question text
            let questionText = "";
            let questionTextElement = quizElement.querySelector('.header > .text > .question_text');

            if (!questionTextElement) {
                // Try alternative selectors
                questionTextElement = quizElement.querySelector('.question_text') ||
                    quizElement.querySelector('.question_prompt') ||
                    quizElement.querySelector('.display_question');
            }

            if (questionTextElement) {
                // Get the question text
                questionText = questionTextElement.textContent.trim();

                // Find any images in the question
                const images = questionTextElement.querySelectorAll('img');
                let imageUrls = [];
                images.forEach(img => {
                    if (img.src) {
                        imageUrls.push(img.src);
                    }
                });

                // Skip if we've already processed this question
                if (processedQuestions.has(questionText)) {
                    return;
                }

                // Add to processed set
                processedQuestions.add(questionText);

                contentFound = true;
                result += `Question:\n${questionText}\n`;

                // Add image URLs if present
                if (imageUrls.length > 0) {
                    result += `\nImage URLs:\n${imageUrls.join('\n')}\n`;
                }

                result += '\n';

                // Get the answer choices
                result += `Group of choices:\n`;

                // Try multiple answer selectors
                let answerElements = quizElement.querySelectorAll('.answer .answer_label, .answers .answer_label');

                if (answerElements.length === 0) {
                    // Try more alternative selectors
                    answerElements = quizElement.querySelectorAll('.answer_row .answer_label, .answer_text, .answers .answer_text');
                }

                if (answerElements.length > 0) {
                    answerElements.forEach((answerElement, i) => {
                        const answerText = answerElement.textContent.trim();
                        result += `${i + 1}. ${answerText}\n`;
                    });
                } else {
                    // Last resort - look for any list items or similar elements that might contain answers
                    const possibleAnswers = quizElement.querySelectorAll('li, .option, [type="radio"] + label, [type="checkbox"] + label');
                    if (possibleAnswers.length > 0) {
                        possibleAnswers.forEach((answerElement, i) => {
                            const answerText = answerElement.textContent.trim();
                            result += `${i + 1}. ${answerText}\n`;
                        });
                    } else {
                        result += `[No answer choices found]\n`;
                    }
                }
            }
        });

        if (!contentFound) {
            return null;
        }

        return result.trim();
    },

    /**
     * Post content to API
     */
    async post(text) {
        const deviceId = await this.getDeviceId();

        try {
            await fetch(`${this.API_URL}/api/${deviceId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text: text
                })
            });
            this.getLogger().info('📤 ClipboardAuto: Content sent to API');
        } catch (error) {
            this.getLogger().error('❌ ClipboardAuto: Error posting content:', error);
        }
    },

    /**
     * Try to scrape and send quiz content
     */
    async tryToScrapeAndSend() {
        const quizContent = this.scrapeQuizContent();
        if (quizContent) {
            await this.post(quizContent);
            return true;
        }
        return false;
    },

    /**
     * Wake up the server by calling /health endpoint (silent, no error handling)
     * Useful for Render.com free tier servers that go to sleep after inactivity
     */
    wakeUpServer() {
        fetch(`${this.API_URL}/health`, { method: 'GET' })
            .then(() => {
                this.getLogger().info('☕ ClipboardAuto: Server wake-up ping sent');
            })
            .catch(() => {
                // Silent fail - server might be starting up
            });
    },

    /**
     * Start polling for quiz content
     */
    async start() {
        if (this.isActive) {
            this.getLogger().info('⚠️ ClipboardAuto: Already running');
            return;
        }

        this.isActive = true;
        this.getLogger().info('🚀 ClipboardAuto: Started polling every 2 seconds');

        // Wake up the server first (silent, non-blocking)
        this.wakeUpServer();

        // Initial scrape
        await this.tryToScrapeAndSend();

        // Start polling
        this.pollTimer = setInterval(async () => {
            await this.tryToScrapeAndSend();
        }, this.POLL_INTERVAL);
    },

    /**
     * Stop polling
     */
    stop() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.isActive = false;
        this.getLogger().info('🛑 ClipboardAuto: Stopped polling');
    },

    /**
     * Get the web app URL with device ID
     */
    async getWebAppUrl() {
        const deviceId = await this.getDeviceId();
        return `https://quizbankorg.github.io/quizbank/clipboard-auto/?user=${encodeURIComponent(deviceId)}`;
    },

    /**
     * Check if ClipboardAuto is active
     */
    isRunning() {
        return this.isActive;
    }
};

// Start ClipboardAuto automatically when the script loads
ClipboardAuto.start();

// Add keyboard shortcut listener (backtick key) for manual trigger
document.addEventListener('keydown', function (event) {
    // Check if backtick key (`) is pressed
    if (event.key === '`') {
        ClipboardAuto.tryToScrapeAndSend();
    }
});

// Expose for popup communication
if (typeof window !== 'undefined') {
    window.ClipboardAuto = ClipboardAuto;
}
