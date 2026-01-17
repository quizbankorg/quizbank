/**
 * QuizBank Supabase Database Manager
 * Handles all database operations with Supabase backend
 */

// ==================== SUPABASE CONFIGURATION ====================

const SUPABASE_URL = 'https://bgfyvqidmxjnyhsklynv.supabase.co';     // https://your-project.supabase.co
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnZnl2cWlkbXhqbnloc2tseW52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkwNzQ5NTAsImV4cCI6MjA3NDY1MDk1MH0.a7dYad377cYyaDn4nCJHUhdXMYSlQF0s-GYSELqkWTI';   // Your anon/public key

// ================================================================

class SupabaseQuizManager {
    constructor() {
        this.supabase = null;
        this.initialized = false;
        this.hasAccess = false;
        this.accessChecked = false;
        this.deviceId = null;
        this.config = {
            url: SUPABASE_URL,
            anonKey: SUPABASE_ANON_KEY
        };
        // Use the same logger instance as the main extension
        this.logger = typeof BrowserLogger !== 'undefined' ? BrowserLogger.getInstance() : null;
    }

    /**
     * Get or create a unique device ID for this installation
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

            // Fallback for non-extension context (content scripts)
            // Use localStorage as fallback
            let deviceId = localStorage.getItem('quizbank_device_id');
            if (!deviceId) {
                deviceId = 'dev_' + crypto.randomUUID();
                localStorage.setItem('quizbank_device_id', deviceId);
            }
            this.deviceId = deviceId;
            return deviceId;
        } catch (e) {
            // Last resort fallback
            if (this.logger) {
                this.logger.warn('⚠️ Could not get device ID, using session ID');
            }
            this.deviceId = 'dev_' + Date.now() + '_' + Math.random().toString(36).substring(2);
            return this.deviceId;
        }
    }

    /**
     * Check if user has valid access via voucher
     */
    async checkAccess() {
        if (this.accessChecked && this.hasAccess) {
            return this.hasAccess;
        }

        try {
            // First check local cache
            let cachedAccess = null;

            if (typeof browser !== 'undefined' && browser.storage) {
                const result = await browser.storage.local.get(['quizbank_access']);
                cachedAccess = result.quizbank_access;
            } else {
                const cached = localStorage.getItem('quizbank_access');
                if (cached) {
                    cachedAccess = JSON.parse(cached);
                }
            }

            if (cachedAccess) {
                const expiresAt = new Date(cachedAccess.expires_at);
                if (expiresAt > new Date() && !cachedAccess.is_revoked) {
                    this.hasAccess = true;
                    this.accessChecked = true;
                    if (this.logger) {
                        this.logger.info('✅ QuizBank access valid (cached)');
                    }
                    return true;
                }
            }

            // Verify with server
            const deviceId = await this.getDeviceId();

            // Initialize Supabase if needed
            if (!this.supabase) {
                this.supabase = supabase.createClient(this.config.url, this.config.anonKey);
            }

            const { data, error } = await this.supabase.rpc('check_access', {
                p_device_id: deviceId
            });

            if (error) {
                if (this.logger) {
                    this.logger.error('❌ Error checking access:', error);
                }
                // Fall back to cached access if server check fails
                this.hasAccess = !!cachedAccess && new Date(cachedAccess.expires_at) > new Date();
            } else if (data && data.length > 0 && data[0].has_access) {
                this.hasAccess = true;

                // Update cache
                const accessData = {
                    expires_at: data[0].access_expires_at,
                    voucher_code: data[0].voucher_code,
                    is_revoked: false
                };

                if (typeof browser !== 'undefined' && browser.storage) {
                    await browser.storage.local.set({ quizbank_access: accessData });
                } else {
                    localStorage.setItem('quizbank_access', JSON.stringify(accessData));
                }

                if (this.logger) {
                    this.logger.info(`✅ QuizBank access valid (${data[0].days_remaining} days remaining)`);
                }
            } else {
                this.hasAccess = false;
                if (this.logger) {
                    this.logger.warn('⚠️ No valid QuizBank access. Please enter a voucher code.');
                }
            }

            this.accessChecked = true;
            return this.hasAccess;

        } catch (e) {
            if (this.logger) {
                this.logger.error('❌ Access check failed:', e);
            }
            this.accessChecked = true;
            return false;
        }
    }

    /**
     * Ensure access before any database operation
     */
    async requireAccess() {
        const hasAccess = await this.checkAccess();
        if (!hasAccess) {
            const error = new Error('QuizBank access required. Please enter a valid voucher code.');
            error.code = 'ACCESS_REQUIRED';
            throw error;
        }
        return true;
    }

    /**
     * Initialize Supabase connection (with access check)
     */
    async init() {
        if (this.initialized) return;

        try {
            // Initialize Supabase client
            this.supabase = supabase.createClient(this.config.url, this.config.anonKey);

            // Check access
            await this.requireAccess();

            this.initialized = true;
            if (this.logger) {
                this.logger.info('✅ QuizBank connected to Supabase');
            }

        } catch (error) {
            if (error.code === 'ACCESS_REQUIRED') {
                if (this.logger) {
                    this.logger.warn('🔐 QuizBank access required - database features disabled');
                }
            } else if (this.logger) {
                this.logger.error('❌ Supabase initialization failed:', error);
            }
            throw error;
        }
    }

    /**
     * Check if access is available (non-throwing version)
     */
    async hasValidAccess() {
        return await this.checkAccess();
    }

    /**
     * Handle ACCESS_DENIED errors by clearing cache and notifying UI
     */
    async handleAccessDenied(error) {
        if (error && error.message && error.message.includes('ACCESS_DENIED')) {
            if (this.logger) {
                this.logger.warn('🔐 Access has been revoked. Clearing cached access.');
            }

            // Clear cached access
            this.hasAccess = false;
            this.accessChecked = false;

            if (typeof browser !== 'undefined' && browser.storage) {
                await browser.storage.local.remove(['quizbank_access']);
            } else {
                localStorage.removeItem('quizbank_access');
            }

            // Dispatch event to notify UI
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('quizbank-access-revoked'));
            }

            return true; // Was ACCESS_DENIED
        }
        return false; // Was not ACCESS_DENIED
    }

    /**
     * Wrap an RPC call with ACCESS_DENIED handling
     */
    async safeRpcCall(rpcName, params) {
        const { data, error } = await this.supabase.rpc(rpcName, params);

        if (error) {
            const wasAccessDenied = await this.handleAccessDenied(error);
            if (wasAccessDenied) {
                // Re-throw with a more user-friendly error
                const accessError = new Error('Your QuizBank access has been revoked. Please enter a new voucher code.');
                accessError.code = 'ACCESS_REVOKED';
                throw accessError;
            }
            throw error;
        }

        return data;
    }


    /**
     * Save course information (secure - requires valid voucher access)
     */
    async saveCourse(courseId, courseName, baseUrl) {
        await this.init();
        const deviceId = await this.getDeviceId();

        return await this.safeRpcCall('qb_save_course', {
            p_device_id: deviceId,
            p_course_id: courseId,
            p_course_name: courseName,
            p_base_url: baseUrl
        });
    }

    /**
     * Save quiz information (secure - requires valid voucher access)
     */
    async saveQuiz(quizId, courseId, quizName, assignmentId) {
        await this.init();
        const deviceId = await this.getDeviceId();

        return await this.safeRpcCall('qb_save_quiz', {
            p_device_id: deviceId,
            p_quiz_id: quizId,
            p_course_id: courseId,
            p_quiz_name: quizName,
            p_assignment_id: assignmentId
        });
    }

    /**
     * Calculate text quality score
     */
    calculateTextQuality(questionText, source) {
        let score = 0;

        // Source quality (higher = better)
        if (source === 'dom') score += 100;           // DOM extraction is best
        else if (source === 'canvas_api') score += 50; // Canvas API is decent
        else if (source === 'placeholder') score += 10; // Placeholder is worst

        // Text length (longer usually better, but cap it)
        const lengthScore = Math.min(questionText.length, 200);
        score += lengthScore;

        // Penalty for obvious placeholders
        if (questionText.match(/^Question \d+$/)) score -= 50;
        if (questionText.includes('Question ID')) score -= 30;

        // Bonus for actual question content
        if (questionText.includes('?')) score += 20;
        if (questionText.length > 20) score += 10;

        return Math.max(0, score); // Ensure non-negative
    }

    /**
     * Save question and generate hash for matching with smart text updates (secure - requires valid voucher access)
     */
    async saveQuestion(questionText, questionType, courseId, quizId, canvasQuestionId, options = null, textSource = 'canvas_api') {
        await this.init();
        const deviceId = await this.getDeviceId();

        const questionHash = this.generateQuestionHash(questionText, questionType, options);
        const textQuality = this.calculateTextQuality(questionText, textSource);

        try {
            const data = await this.safeRpcCall('qb_save_question', {
                p_device_id: deviceId,
                p_question_hash: questionHash,
                p_question_text: questionText,
                p_question_type: questionType,
                p_course_id: courseId,
                p_first_seen_quiz_id: quizId,
                p_text_quality_score: textQuality,
                p_text_source: textSource,
                p_metadata: { options, canvas_question_id: canvasQuestionId }
            });

            if (data && data.action === 'upserted' && this.logger) {
                this.logger.info(`✅ Question saved/updated (score: ${textQuality})`);
            }

            return { question_hash: questionHash, ...data };
        } catch (error) {
            if (this.logger) {
                this.logger.error('❌ saveQuestion failed:', error);
            }
            throw error;
        }
    }

    /**
     * Save submission data (secure - requires valid voucher access)
     */
    async saveSubmission(questionHash, quizId, canvasQuestionId, userAnswer, isCorrect, pointsEarned, pointsPossible, answerFields) {
        await this.init();
        const deviceId = await this.getDeviceId();

        const data = await this.safeRpcCall('qb_save_submission', {
            p_device_id: deviceId,
            p_question_hash: questionHash,
            p_quiz_id: quizId,
            p_canvas_question_id: canvasQuestionId,
            p_user_answer: userAnswer,
            p_is_correct: isCorrect,
            p_points_earned: pointsEarned,
            p_points_possible: pointsPossible,
            p_answer_fields: answerFields
        });

        // Update best answer after saving submission
        const submission = {
            user_answer: userAnswer,
            is_correct: isCorrect,
            points_earned: pointsEarned,
            points_possible: pointsPossible,
            answer_fields: answerFields
        };

        // Use the returned submission ID
        if (data && data.id) {
            await this.updateBestAnswer(questionHash, submission, data.id);
        }

        return data;
    }

    /**
     * Update best answer for a question (secure - requires valid voucher access)
     */
    async updateBestAnswer(questionHash, submission, submissionId) {
        const deviceId = await this.getDeviceId();
        const currentBest = await this.getBestAnswer(questionHash);

        // Calculate confidence score (correct answers get higher score)
        let confidenceScore = submission.is_correct ? 1.0 : 0.0;
        if (submission.points_earned && submission.points_possible && submission.points_possible > 0) {
            confidenceScore = Math.min(1.0, submission.points_earned / submission.points_possible);
        }
        confidenceScore = Math.max(0.0, Math.min(1.0, confidenceScore));

        // Update if this is better than current best
        if (!currentBest || confidenceScore > (currentBest.confidence_score || 0)) {
            await this.safeRpcCall('qb_update_best_answer', {
                p_device_id: deviceId,
                p_question_hash: questionHash,
                p_answer_text: submission.user_answer,
                p_answer_fields: submission.answer_fields,
                p_confidence_score: confidenceScore,
                p_source_submission_id: submissionId
            });

            return { question_hash: questionHash, confidence_score: confidenceScore };
        }
    }

    /**
     * Get best answer for a question (secure - requires valid voucher access)
     */
    async getBestAnswer(questionHash) {
        await this.init();
        const deviceId = await this.getDeviceId();

        return await this.safeRpcCall('qb_get_best_answer', {
            p_device_id: deviceId,
            p_question_hash: questionHash
        });
    }

    /**
     * Get wrong answers for a question (secure - requires valid voucher access)
     */
    async getWrongAnswers(questionHash) {
        await this.init();
        const deviceId = await this.getDeviceId();

        const data = await this.safeRpcCall('qb_get_wrong_answers', {
            p_device_id: deviceId,
            p_question_hash: questionHash
        });

        // Data is already filtered by the SQL function, just process it
        const wrongAnswers = (data || [])
            .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));

        return wrongAnswers;
    }

    /**
     * Get question analysis (best answer + wrong answers + stats)
     */
    async getQuestionAnalysis(questionHash) {
        await this.init();

        const [bestAnswer, wrongAnswers, stats] = await Promise.all([
            this.getBestAnswer(questionHash),
            this.getWrongAnswers(questionHash),
            this.getQuestionStats(questionHash)
        ]);

        return {
            bestAnswer,
            wrongAnswers,
            totalAttempts: stats.total_attempts,
            correctAttempts: stats.correct_attempts
        };
    }

    /**
     * Get question statistics (secure - requires valid voucher access)
     */
    async getQuestionStats(questionHash) {
        await this.init();
        const deviceId = await this.getDeviceId();

        const data = await this.safeRpcCall('qb_get_question_stats', {
            p_device_id: deviceId,
            p_question_hash: questionHash
        });

        return data || { total_attempts: 0, correct_attempts: 0 };
    }

    /**
     * Get all submissions for a question (secure - requires valid voucher access)
     */
    async getAllSubmissions(questionHash) {
        await this.init();
        const deviceId = await this.getDeviceId();

        const data = await this.safeRpcCall('qb_get_all_submissions', {
            p_device_id: deviceId,
            p_question_hash: questionHash
        });

        return data || [];
    }

    /**
     * Get all submissions for a quiz (secure - requires valid voucher access)
     */
    async getAllSubmissionsForQuiz(courseId, quizId) {
        await this.init();
        const deviceId = await this.getDeviceId();

        if (this.logger) {
            this.logger.info(`🔍 Querying submissions for courseId=${courseId}, quizId=${quizId}`);
        }

        const data = await this.safeRpcCall('qb_get_quiz_submissions', {
            p_device_id: deviceId,
            p_course_id: courseId,
            p_quiz_id: quizId
        });

        if (this.logger) {
            this.logger.info(`✅ Query returned ${data?.length || 0} submissions`);
        }
        return data || [];
    }

    /**
     * Find question by content matching (secure - requires valid voucher access)
     */
    async findQuestionByContent(questionText, questionType, courseId, options = null) {
        await this.init();
        const deviceId = await this.getDeviceId();

        const questionHash = this.generateQuestionHash(questionText, questionType, options);

        return await this.safeRpcCall('qb_find_question', {
            p_device_id: deviceId,
            p_question_hash: questionHash
        });
    }

    /**
     * Find question by Canvas Question ID (secure - requires valid voucher access)
     */
    async findQuestionByCanvasId(canvasQuestionId, courseId) {
        await this.init();
        const deviceId = await this.getDeviceId();

        const data = await this.safeRpcCall('qb_find_by_canvas_id', {
            p_device_id: deviceId,
            p_canvas_question_id: canvasQuestionId
        });

        if (data) {
            if (this.logger) {
                this.logger.info(`📝 Found question by Canvas ID ${canvasQuestionId}`);
            }
            return data;
        }

        return null;
    }

    /**
     * Get course knowledge base (secure - requires valid voucher access)
     */
    async getCourseKnowledgeBase(courseId) {
        await this.init();
        const deviceId = await this.getDeviceId();

        const data = await this.safeRpcCall('qb_get_course_knowledge', {
            p_device_id: deviceId,
            p_course_id: courseId
        });

        // Transform to match expected format
        return (data || []).map(item => ({
            question: {
                question_hash: item.question_hash,
                question_text: item.question_text,
                question_type: item.question_type,
                first_seen_quiz_id: item.first_seen_quiz_id
            },
            bestAnswer: item.answer_text ? {
                answer_text: item.answer_text,
                answer_fields: item.answer_fields,
                confidence_score: item.confidence_score,
                updated_at: item.updated_at
            } : null
        }));
    }

    /**
     * Get global knowledge base (secure - requires valid voucher access)
     */
    async getGlobalKnowledgeBase() {
        await this.init();
        const deviceId = await this.getDeviceId();

        const data = await this.safeRpcCall('qb_get_global_knowledge', {
            p_device_id: deviceId
        });

        // Transform to match expected format
        return (data || []).map(item => ({
            question: {
                question_hash: item.question_hash,
                question_text: item.question_text,
                question_type: item.question_type,
                course_id: item.course_id,
                first_seen_quiz_id: item.first_seen_quiz_id
            },
            bestAnswer: item.answer_text ? {
                answer_text: item.answer_text,
                answer_fields: item.answer_fields,
                confidence_score: item.confidence_score,
                updated_at: item.updated_at
            } : null
        }));
    }

    /**
     * Get questions by quiz ID (secure - requires valid voucher access)
     */
    async getQuestionsByQuizId(courseId, quizId) {
        await this.init();
        const deviceId = await this.getDeviceId();

        if (this.logger) {
            this.logger.info(`🔍 Getting questions for quiz ${quizId} in course ${courseId}`);
        }

        const data = await this.safeRpcCall('qb_get_questions_by_quiz', {
            p_device_id: deviceId,
            p_course_id: courseId,
            p_quiz_id: quizId
        });

        if (this.logger) {
            this.logger.info(`✅ Found ${data?.length || 0} questions for quiz ${quizId}`);
        }

        // Transform to match expected format
        return (data || []).map(item => ({
            question: {
                question_hash: item.question_hash,
                question_text: item.question_text,
                question_type: item.question_type,
                first_seen_quiz_id: item.first_seen_quiz_id
            },
            bestAnswer: item.answer_text ? {
                answer_text: item.answer_text,
                answer_fields: item.answer_fields,
                confidence_score: item.confidence_score,
                updated_at: item.updated_at
            } : null,
            canvas_question_id: item.canvas_question_id
        }));
    }

    /**
     * Batch save questions (secure - requires valid voucher access)
     */
    async batchSaveQuestions(questionsData) {
        await this.init();
        const deviceId = await this.getDeviceId();

        if (questionsData.length === 0) return [];

        const data = await this.safeRpcCall('qb_batch_save_questions', {
            p_device_id: deviceId,
            p_questions: questionsData
        });

        if (this.logger) {
            this.logger.info(`📝 Batch saved ${data?.processed || 0} questions`);
        }

        return data;
    }

    /**
     * Sanitize answer fields for database storage
     */
    sanitizeAnswerFields(questionData) {
        if (!questionData || typeof questionData !== 'object') {
            return null;
        }

        // Extract only the answer-related fields and ensure they're JSON-safe
        const answerFields = {};

        // Copy answer fields (Canvas uses answer_* pattern)
        for (const [key, value] of Object.entries(questionData)) {
            if (key.startsWith('answer') && value !== undefined && value !== null) {
                // Ensure the value is JSON-serializable
                try {
                    JSON.stringify(value);
                    answerFields[key] = value;
                } catch (e) {
                    // Skip non-serializable values
                    console.warn(`Skipping non-serializable answer field: ${key}`);
                }
            }
        }

        // Return null if no valid answer fields found
        return Object.keys(answerFields).length > 0 ? answerFields : null;
    }

    /**
     * Batch save submissions (secure - requires valid voucher access)
     */
    async batchSaveSubmissions(submissionsData) {
        await this.init();
        const deviceId = await this.getDeviceId();

        if (submissionsData.length === 0) return [];

        const data = await this.safeRpcCall('qb_batch_save_submissions', {
            p_device_id: deviceId,
            p_submissions: submissionsData
        });

        if (this.logger) {
            this.logger.info(`📝 Batch saved ${data?.processed || 0} submissions`);
        }

        return data;
    }

    /**
     * Batch update best answers (secure - requires valid voucher access)
     */
    async batchUpdateBestAnswers(bestAnswersData) {
        await this.init();
        const deviceId = await this.getDeviceId();

        if (bestAnswersData.length === 0) return [];

        const data = await this.safeRpcCall('qb_batch_update_best_answers', {
            p_device_id: deviceId,
            p_answers: bestAnswersData
        });

        if (this.logger) {
            this.logger.info(`📝 Batch updated ${data?.processed || 0} best answers`);
        }

        return data;
    }

    /**
     * Process Canvas submission history and save to database
     */
    async processCanvasSubmissionsWithQuestionData(courseId, quizId, submissions, quizData, domQuestions) {
        await this.init();
        if (this.logger) {
            this.logger.info('🚀 BATCH Processing', submissions.length, 'submissions with', domQuestions.length, 'DOM questions');
        }

        // Save course and quiz info first
        await this.saveCourse(courseId, quizData.course_name || `Course ${courseId}`, quizData.base_url);
        await this.saveQuiz(quizId, courseId, quizData.quiz_name || `Quiz ${quizId}`, quizData.assignment_id);

        // Create a map of Canvas question ID to DOM question data
        const domQuestionMap = new Map();
        for (const domQuestion of domQuestions) {
            domQuestionMap.set(domQuestion.canvas_question_id, domQuestion);
        }

        // First, get existing questions by Canvas Question ID to check for text updates
        const canvasQuestionIds = [];
        for (const submission of submissions) {
            if (!submission.submission_data) continue;
            for (const questionData of submission.submission_data) {
                if (!canvasQuestionIds.includes(questionData.question_id)) {
                    canvasQuestionIds.push(questionData.question_id);
                }
            }
        }

        // Get existing questions by Canvas Question ID using secure RPC
        const deviceId = await this.getDeviceId();
        const existingQuestionsRaw = await this.safeRpcCall('qb_get_existing_questions_by_canvas_ids', {
            p_device_id: deviceId,
            p_course_id: courseId,
            p_canvas_ids: canvasQuestionIds
        });
        const existingQuestions = existingQuestionsRaw || [];

        // Create map of Canvas Question ID → existing question data
        // CRITICAL FIX: Handle multiple questions with same Canvas ID (different hashes)
        const existingByCanvasId = new Map();
        const allExistingQuestions = [];
        if (existingQuestions && existingQuestions.length > 0) {
            existingQuestions.forEach(q => {
                // The RPC now returns canvas_question_id directly on the question object
                const canvasId = q.canvas_question_id;
                if (canvasId) {
                    allExistingQuestions.push({ canvasId, question: q });

                    // For the map, prefer the question with highest text quality
                    const existing = existingByCanvasId.get(canvasId);
                    if (!existing || (q.text_quality_score || 0) > (existing.text_quality_score || 0)) {
                        existingByCanvasId.set(canvasId, q);
                        if (this.logger && existing) {
                            this.logger.info(`📝 Canvas ID ${canvasId}: Found better quality question ${q.question_hash} (quality ${q.text_quality_score}) vs ${existing.question_hash} (quality ${existing.text_quality_score})`);
                        }
                    }
                }
            });
        }

        if (this.logger && allExistingQuestions.length > 0) {
            const duplicateCanvasIds = {};
            allExistingQuestions.forEach(({ canvasId }) => {
                duplicateCanvasIds[canvasId] = (duplicateCanvasIds[canvasId] || 0) + 1;
            });
            const duplicates = Object.entries(duplicateCanvasIds).filter(([id, count]) => count > 1);
            if (duplicates.length > 0) {
                this.logger.warn(`🚨 Found duplicate Canvas Question IDs: ${duplicates.map(([id, count]) => `${id}(${count}x)`).join(', ')}`);
            }
        }

        // Collect ALL questions and submissions for batch processing
        const questionsToSave = [];
        const submissionsToSave = [];
        const bestAnswersToUpdate = [];
        const processedQuestions = new Map();

        // Flatten all submission data (no individual database calls!)
        for (const submission of submissions) {
            if (!submission.submission_data) continue;

            for (const questionData of submission.submission_data) {
                const questionId = questionData.question_id;

                // Skip if already processed this question in this batch
                if (processedQuestions.has(questionId)) {
                    continue;
                }

                // Get real question text from DOM data if available
                const domQuestion = domQuestionMap.get(questionId);
                const questionText = domQuestion?.questionText || questionData.question_text || `Question ${questionId}`;
                const questionType = domQuestion?.questionType || questionData.question_type || 'unknown';
                const options = domQuestion?.options || null;

                // Determine text source for quality scoring
                let textSource = 'placeholder';
                if (domQuestion?.questionText) {
                    textSource = 'dom';
                } else if (questionData.question_text && !questionData.question_text.match(/^Question \d+$/)) {
                    textSource = 'canvas_api';
                }

                // Calculate quality for new text
                const textQuality = this.calculateTextQuality(questionText, textSource);

                // Check if we have existing question with this Canvas Question ID
                const existingQuestion = existingByCanvasId.get(questionId);
                let questionHash;
                let shouldSaveQuestion = true;
                let oldHashToMerge = null;

                if (existingQuestion) {
                    // Question exists - check if new text is better quality
                    const existingQuality = existingQuestion.text_quality_score || 0;

                    if (textQuality > existingQuality) {
                        // New text is better - determine new hash
                        const oldHash = existingQuestion.question_hash;
                        let newHash;

                        if (textSource === 'placeholder') {
                            // Still placeholder - keep existing hash (even if temporary)
                            newHash = oldHash;
                        } else {
                            // Real content - generate proper content-based hash
                            newHash = this.generateQuestionHash(questionText, questionType, options);
                        }

                        // Check if the hash needs to change
                        if (newHash !== oldHash) {
                            // Hash changed - need to merge records
                            questionHash = newHash;
                            oldHashToMerge = oldHash;

                            // Check if upgrading from temporary to real hash
                            const isUpgradingFromTemp = oldHash.startsWith('canvas_');
                            if (this.logger) {
                                if (isUpgradingFromTemp) {
                                    this.logger.info(`📝 Question ${questionId} upgrading from temporary to content hash: ${oldHash} → ${newHash}`);
                                } else {
                                    this.logger.info(`📝 Question ${questionId} content changed: ${oldHash} → ${newHash} (merging records)`);
                                }
                            }
                        } else {
                            // Same hash, just quality metadata update
                            questionHash = oldHash;
                            if (this.logger) {
                                this.logger.info(`📝 Upgrading question ${questionId} metadata: quality ${existingQuality} → ${textQuality}`);
                            }
                        }
                    } else {
                        // Existing text is better or equal - keep existing, don't update
                        questionHash = existingQuestion.question_hash;
                        shouldSaveQuestion = false;
                        if (this.logger) {
                            this.logger.info(`📝 Keeping existing better text for question ${questionId}: ${existingQuality} >= ${textQuality}`);
                        }
                    }
                } else {
                    // New question - use smart hash generation
                    if (textSource === 'placeholder') {
                        // Don't generate hash from placeholder - use Canvas ID as temporary hash
                        // This will be regenerated when real content becomes available
                        questionHash = `canvas_${questionId}_${courseId}`;
                        if (this.logger) {
                            this.logger.info(`📝 Using temporary hash for placeholder question ${questionId}: ${questionHash}`);
                        }
                    } else {
                        // Real content available - generate proper content-based hash
                        questionHash = this.generateQuestionHash(questionText, questionType, options);
                        if (this.logger) {
                            this.logger.info(`📝 Generated content-based hash for question ${questionId}: ${questionHash}`);
                        }
                    }
                }

                // Store merge info for later processing
                if (oldHashToMerge) {
                    processedQuestions.set(questionId, {
                        newHash: questionHash,
                        oldHash: oldHashToMerge,
                        needsMerge: true
                    });
                } else {
                    processedQuestions.set(questionId, {
                        newHash: questionHash,
                        needsMerge: false
                    });
                }

                // Only save question if it's new or better quality
                if (shouldSaveQuestion) {
                    questionsToSave.push({
                        question_hash: questionHash,
                        question_text: questionText,
                        question_type: questionType,
                        course_id: courseId,
                        first_seen_quiz_id: existingQuestion ? existingQuestion.first_seen_quiz_id : quizId, // Keep original first_seen_quiz_id
                        text_quality_score: textQuality,
                        text_source: textSource,
                        metadata: options ? JSON.stringify(options) : null
                    });
                }

                // Prepare submission data for batch save
                submissionsToSave.push({
                    question_hash: questionHash,
                    quiz_id: quizId,
                    canvas_question_id: questionId,
                    user_answer: questionData.text || null,
                    is_correct: questionData.correct === true ? true : (questionData.correct === false ? false : null),
                    points_earned: typeof questionData.points === 'number' ? questionData.points : 0,
                    points_possible: typeof questionData.points_possible === 'number' ? questionData.points_possible : 1,
                    answer_fields: this.sanitizeAnswerFields(questionData)
                });

                // Calculate confidence score inline (moved from separate method)
                const confidence = questionData.correct ?
                    Math.min(1.0, (questionData.points || 0) / (questionData.points_possible || 1)) : 0;

                // Prepare best answer data for batch update
                bestAnswersToUpdate.push({
                    question_hash: questionHash,
                    answer_text: questionData.text,
                    answer_fields: questionData,
                    confidence_score: confidence,
                    source_submission_id: null // Will be updated after submissions are saved
                });

                processedQuestions.set(questionId, questionHash);
            }
        }

        // CRITICAL FIX: Deduplicate best answers by question_hash, keeping the highest confidence
        const bestAnswersByHash = new Map();
        bestAnswersToUpdate.forEach(bestAnswer => {
            const existing = bestAnswersByHash.get(bestAnswer.question_hash);
            if (!existing || bestAnswer.confidence_score > existing.confidence_score) {
                bestAnswersByHash.set(bestAnswer.question_hash, bestAnswer);
            }
        });
        const deduplicatedBestAnswers = Array.from(bestAnswersByHash.values());

        if (this.logger) {
            this.logger.info('✅ Prepared', questionsToSave.length, 'questions for batch save');
            this.logger.info('✅ Prepared', submissionsToSave.length, 'submissions for batch save');
            this.logger.info('✅ Prepared', bestAnswersToUpdate.length, 'best answers for batch update');
            if (bestAnswersToUpdate.length !== deduplicatedBestAnswers.length) {
                this.logger.info(`🔧 Deduplicated best answers: ${bestAnswersToUpdate.length} → ${deduplicatedBestAnswers.length}`);
            }
        }

        // Execute batch operations (3 queries instead of 54+ individual queries!)
        try {
            await this.batchSaveQuestions(questionsToSave);
            const savedSubmissions = await this.batchSaveSubmissions(submissionsToSave);

            // Update best answers with submission IDs (use deduplicated array)
            if (savedSubmissions.length > 0) {
                // Create a map of question_hash to submission_id for matching
                const submissionIdMap = new Map();
                savedSubmissions.forEach(submission => {
                    if (!submissionIdMap.has(submission.question_hash)) {
                        submissionIdMap.set(submission.question_hash, submission.id);
                    }
                });

                // Update deduplicated best answers with submission IDs
                deduplicatedBestAnswers.forEach(bestAnswer => {
                    const submissionId = submissionIdMap.get(bestAnswer.question_hash);
                    if (submissionId) {
                        bestAnswer.source_submission_id = submissionId;
                    }
                });
            }

            await this.batchUpdateBestAnswers(deduplicatedBestAnswers);

            // Handle record merging for questions that changed content hash
            const mergesToProcess = Array.from(processedQuestions.values()).filter(q => q.needsMerge);
            if (mergesToProcess.length > 0) {
                if (this.logger) {
                    this.logger.info(`🔄 Processing ${mergesToProcess.length} record merges...`);
                }

                for (const merge of mergesToProcess) {
                    await this.mergeQuestionRecords(merge.oldHash, merge.newHash);
                }

                if (this.logger) {
                    this.logger.info('✅ Record merging completed');
                }
            }

            // Handle additional duplicate Canvas Question IDs that weren't processed
            if (allExistingQuestions.length > 0) {
                const duplicateGroups = {};
                allExistingQuestions.forEach(({ canvasId, question }) => {
                    if (!duplicateGroups[canvasId]) duplicateGroups[canvasId] = [];
                    duplicateGroups[canvasId].push(question);
                });

                for (const [canvasId, questions] of Object.entries(duplicateGroups)) {
                    if (questions.length > 1) {
                        // Sort by text quality (highest first)
                        questions.sort((a, b) => (b.text_quality_score || 0) - (a.text_quality_score || 0));
                        const bestQuestion = questions[0];
                        const duplicates = questions.slice(1);

                        if (this.logger) {
                            this.logger.info(`🧹 Cleaning up ${duplicates.length} duplicate questions for Canvas ID ${canvasId}, keeping best: ${bestQuestion.question_hash}`);
                        }

                        for (const duplicate of duplicates) {
                            await this.mergeQuestionRecords(duplicate.question_hash, bestQuestion.question_hash);
                        }
                    }
                }
            }

            if (this.logger) {
                this.logger.info('🚀 BATCH processing completed! Processed', processedQuestions.size, 'unique questions in 3 queries');
            }
        } catch (error) {
            if (this.logger) {
                this.logger.error('❌ Batch processing error:', error);
            }
            throw error;
        }

        return processedQuestions;
    }

    /**
     * Merge question records when content hash changes (secure - requires valid voucher access)
     * Moves all submissions and best answers from old hash to new hash, then deletes old question
     */
    async mergeQuestionRecords(oldHash, newHash) {
        await this.init();
        const deviceId = await this.getDeviceId();

        if (this.logger) {
            this.logger.info(`🔄 Merging question records: ${oldHash} → ${newHash}`);
        }

        try {
            const data = await this.safeRpcCall('qb_merge_question_records', {
                p_device_id: deviceId,
                p_old_hash: oldHash,
                p_new_hash: newHash
            });

            if (data?.success) {
                if (this.logger) {
                    this.logger.info(`✅ Successfully merged ${oldHash} → ${newHash} (${data.updated_submissions} submissions)`);
                }
            } else {
                if (this.logger) {
                    this.logger.warn(`⚠️ Merge failed: ${data?.error}`);
                }
            }

            return data;
        } catch (error) {
            if (this.logger) {
                this.logger.error(`❌ Error merging question records:`, error);
            }
            throw error;
        }
    }

    /**
     * Generate a hash for question matching (EXACT COPY from IndexedDB version)
     * Uses question text and type to identify same questions across quizzes
     */
    generateQuestionHash(questionText, questionType, options = null) {
        // Clean and normalize question text
        const cleanText = questionText
            .replace(/\s+/g, ' ')                    // Normalize whitespace
            .replace(/[^\w\s\?\.!]/g, '')           // Remove special chars except basic punctuation
            .toLowerCase()
            .trim();

        // For multiple choice questions, include options for better matching
        let hashInput = `${questionType}:${cleanText}`;
        if (options && Array.isArray(options)) {
            const sortedOptions = options.map(opt =>
                opt.toLowerCase().replace(/[^\w\s]/g, '').trim()
            ).sort().join('|');
            hashInput += `:${sortedOptions}`;
        }

        // Simple hash function (in production, use crypto.subtle.digest)
        return this.simpleHash(hashInput);
    }

    /**
     * Simple hash function for question matching (EXACT COPY from IndexedDB version)
     */
    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(36);
    }

    // ==================== COMPILED QUESTIONS METHODS ====================

    /**
     * Save compiled question HTML immediately (secure - requires valid voucher access)
     */
    async saveCompiledQuestion(courseId, quizId, canvasQuestionId, questionHTML, hasCorrect, hasWrong) {
        await this.init();
        const deviceId = await this.getDeviceId();

        if (this.logger) {
            this.logger.info(`💾 Saving compiled question ${canvasQuestionId} to database`);
        }

        try {
            const data = await this.safeRpcCall('qb_save_compiled_question', {
                p_device_id: deviceId,
                p_course_id: courseId,
                p_quiz_id: quizId,
                p_canvas_question_id: canvasQuestionId,
                p_question_html: questionHTML,
                p_has_correct: hasCorrect,
                p_has_wrong: hasWrong
            });

            if (this.logger) {
                this.logger.info(`✅ Saved compiled question ${canvasQuestionId} (has correct: ${hasCorrect})`);
            }

            return data;
        } catch (error) {
            if (this.logger) {
                this.logger.error(`❌ Failed to save compiled question ${canvasQuestionId}:`, error);
            }
            throw error;
        }
    }

    /**
     * Get compiled questions for a specific quiz (secure - requires valid voucher access)
     */
    async getCompiledQuestions(courseId, quizId) {
        await this.init();
        const deviceId = await this.getDeviceId();

        try {
            const data = await this.safeRpcCall('qb_get_compiled_questions', {
                p_device_id: deviceId,
                p_course_id: courseId,
                p_quiz_id: quizId
            });

            if (this.logger) {
                this.logger.info(`✅ Retrieved ${data?.length || 0} compiled questions for quiz ${quizId}`);
            }

            return data || [];
        } catch (error) {
            if (this.logger) {
                this.logger.error(`❌ Failed to get compiled questions:`, error);
            }
            throw error;
        }
    }

    /**
     * Get all compiled quizzes summary (secure - requires valid voucher access)
     */
    async getAllCompiledQuizzes() {
        await this.init();
        const deviceId = await this.getDeviceId();

        try {
            const data = await this.safeRpcCall('qb_get_all_compiled_quizzes', {
                p_device_id: deviceId
            });

            // Transform to expected format
            const result = (data || []).map(item => ({
                courseId: item.course_id,
                quizId: item.quiz_id,
                courseName: item.course_name || `Course ${item.course_id}`,
                quizName: item.quiz_name || `Quiz ${item.quiz_id}`,
                questionCount: item.question_count
            }));

            if (this.logger) {
                this.logger.info(`✅ Retrieved ${result.length} compiled quizzes`);
            }

            return result;
        } catch (error) {
            if (this.logger) {
                this.logger.error(`❌ Failed to get compiled quizzes:`, error);
            }
            throw error;
        }
    }

    /**
     * Clear compiled questions for a specific quiz (secure - requires valid voucher access)
     */
    async clearCompiledQuiz(courseId, quizId) {
        await this.init();
        const deviceId = await this.getDeviceId();

        try {
            await this.safeRpcCall('qb_clear_compiled_quiz', {
                p_device_id: deviceId,
                p_course_id: courseId,
                p_quiz_id: quizId
            });

            if (this.logger) {
                this.logger.info(`🗑️ Cleared compiled questions for quiz ${quizId}`);
            }
        } catch (error) {
            if (this.logger) {
                this.logger.error(`❌ Failed to clear compiled quiz:`, error);
            }
            throw error;
        }
    }

    /**
     * Get all compiled questions for a specific course (secure - requires valid voucher access)
     */
    async getCourseCompiledQuestions(courseId) {
        await this.init();
        const deviceId = await this.getDeviceId();

        try {
            const data = await this.safeRpcCall('qb_get_course_compiled', {
                p_device_id: deviceId,
                p_course_id: courseId
            });

            if (this.logger) {
                this.logger.info(`✅ Retrieved ${data?.length || 0} compiled questions for course ${courseId}`);
            }

            return data || [];
        } catch (error) {
            if (this.logger) {
                this.logger.error(`❌ Failed to get course compiled questions:`, error);
            }
            throw error;
        }
    }

    /**
     * Get all compiled questions globally (secure - requires valid voucher access)
     */
    async getGlobalCompiledQuestions() {
        await this.init();
        const deviceId = await this.getDeviceId();

        try {
            const data = await this.safeRpcCall('qb_get_global_compiled', {
                p_device_id: deviceId
            });

            if (this.logger) {
                this.logger.info(`✅ Retrieved ${data?.length || 0} compiled questions globally`);
            }

            return data || [];
        } catch (error) {
            if (this.logger) {
                this.logger.error(`❌ Failed to get global compiled questions:`, error);
            }
            throw error;
        }
    }

}

// Export for use in the extension
window.SupabaseQuizManager = SupabaseQuizManager;
