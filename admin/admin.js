/**
 * QuizBank Admin - Access Code Management
 * With Supabase Authentication
 */

// ==================== SUPABASE CONFIGURATION ====================
// Same configuration as the main extension
const SUPABASE_URL = 'https://bgfyvqidmxjnyhsklynv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnZnl2cWlkbXhqbnloc2tseW52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkwNzQ5NTAsImV4cCI6MjA3NDY1MDk1MH0.a7dYad377cYyaDn4nCJHUhdXMYSlQF0s-GYSELqkWTI';

// ==================== GLOBALS ====================
let supabaseClient = null;
let currentUser = null;

// ==================== DOM ELEMENTS ====================
const elements = {
    // Login elements
    loginScreen: document.getElementById('login-screen'),
    adminDashboard: document.getElementById('admin-dashboard'),
    loginForm: document.getElementById('login-form'),
    loginEmail: document.getElementById('login-email'),
    loginPassword: document.getElementById('login-password'),
    loginBtn: document.getElementById('login-btn'),
    loginError: document.getElementById('login-error'),

    // Dashboard elements
    connectionStatus: document.getElementById('connection-status'),
    userInfo: document.getElementById('user-info'),
    userEmail: document.getElementById('user-email'),
    logoutBtn: document.getElementById('logout-btn'),
    generateBtn: document.getElementById('generate-btn'),
    durationValue: document.getElementById('duration-value'),
    durationUnit: document.getElementById('duration-unit'),
    maxUses: document.getElementById('max-uses'),
    generatedCode: document.getElementById('generated-code'),
    codeDisplay: document.getElementById('code-display'),
    copyBtn: document.getElementById('copy-btn'),
    refreshVouchers: document.getElementById('refresh-vouchers'),
    refreshUsers: document.getElementById('refresh-users'),
    vouchersTbody: document.getElementById('vouchers-tbody'),
    usersTbody: document.getElementById('users-tbody'),
    toast: document.getElementById('toast'),
    modalOverlay: document.getElementById('modal-overlay'),
    modalTitle: document.getElementById('modal-title'),
    modalMessage: document.getElementById('modal-message'),
    modalCancel: document.getElementById('modal-cancel'),
    modalConfirm: document.getElementById('modal-confirm'),
    // Version management
    currentVersion: document.getElementById('current-version'),
    newVersionInput: document.getElementById('new-version'),
    releaseNotesInput: document.getElementById('release-notes'),
    publishVersionBtn: document.getElementById('publish-version-btn'),
    refreshVersion: document.getElementById('refresh-version')
};

// ==================== INITIALIZATION ====================

async function initialize() {
    try {
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        // Check if user is already logged in
        const { data: { session } } = await supabaseClient.auth.getSession();

        if (session && session.user) {
            currentUser = session.user;
            await showDashboard();
        } else {
            showLogin();
        }

        // Listen for auth state changes
        supabaseClient.auth.onAuthStateChange(async (event, session) => {
            if (event === 'SIGNED_IN' && session) {
                currentUser = session.user;
                await showDashboard();
            } else if (event === 'SIGNED_OUT') {
                currentUser = null;
                showLogin();
            }
        });

        // Setup event listeners
        setupEventListeners();

    } catch (error) {
        console.error('Initialization error:', error);
        showLoginError('Failed to initialize. Please refresh the page.');
    }
}

// ==================== AUTHENTICATION ====================

function showLogin() {
    elements.loginScreen.classList.remove('hidden');
    elements.adminDashboard.classList.add('hidden');
}

async function showDashboard() {
    elements.loginScreen.classList.add('hidden');
    elements.adminDashboard.classList.remove('hidden');

    // Update user info
    if (currentUser) {
        elements.userEmail.textContent = currentUser.email;
    }

    updateConnectionStatus('connected', 'Connected');

    // Load data
    await Promise.all([
        loadVouchers(),
        loadUsers(),
        loadCurrentVersion()
    ]);
}

async function handleLogin(e) {
    e.preventDefault();

    const email = elements.loginEmail.value.trim();
    const password = elements.loginPassword.value;

    if (!email || !password) {
        showLoginError('Please enter email and password');
        return;
    }

    setLoginLoading(true);
    hideLoginError();

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) {
            throw error;
        }

        currentUser = data.user;
        await showDashboard();

    } catch (error) {
        console.error('Login error:', error);
        showLoginError(error.message || 'Invalid email or password');
    } finally {
        setLoginLoading(false);
    }
}

async function handleLogout() {
    try {
        await supabaseClient.auth.signOut();
        currentUser = null;
        showLogin();
        showToast('Logged out successfully', 'success');
    } catch (error) {
        console.error('Logout error:', error);
        showToast('Error logging out', 'error');
    }
}

function showLoginError(message) {
    elements.loginError.textContent = message;
    elements.loginError.classList.remove('hidden');
}

function hideLoginError() {
    elements.loginError.classList.add('hidden');
}

function setLoginLoading(loading) {
    elements.loginBtn.disabled = loading;
    elements.loginBtn.querySelector('.btn-text').classList.toggle('hidden', loading);
    elements.loginBtn.querySelector('.btn-loading').classList.toggle('hidden', !loading);
}

function updateConnectionStatus(status, text) {
    elements.connectionStatus.className = `connection-status ${status}`;
    elements.connectionStatus.querySelector('.status-text').textContent = text;
}

// ==================== EVENT LISTENERS ====================

function setupEventListeners() {
    // Login form
    elements.loginForm.addEventListener('submit', handleLogin);

    // Logout
    elements.logoutBtn.addEventListener('click', handleLogout);

    // Generate voucher
    elements.generateBtn.addEventListener('click', generateVoucher);

    // Copy code
    elements.copyBtn.addEventListener('click', copyCode);

    // Refresh buttons
    elements.refreshVouchers.addEventListener('click', loadVouchers);
    elements.refreshUsers.addEventListener('click', loadUsers);

    // Modal cancel
    elements.modalCancel.addEventListener('click', hideModal);
    elements.modalOverlay.addEventListener('click', (e) => {
        if (e.target === elements.modalOverlay) hideModal();
    });

    // Version management
    elements.publishVersionBtn.addEventListener('click', publishNewVersion);
    elements.refreshVersion.addEventListener('click', loadCurrentVersion);
}

// ==================== VOUCHER GENERATION ====================

async function generateVoucher() {
    if (!currentUser) {
        showToast('Please log in first', 'error');
        return;
    }

    const value = parseInt(elements.durationValue.value) || 1;
    const unit = parseInt(elements.durationUnit.value);
    const maxUses = parseInt(elements.maxUses.value) || 1;
    const durationDays = value * unit;

    elements.generateBtn.disabled = true;
    elements.generateBtn.innerHTML = '<span class="btn-icon">⏳</span> Generating...';

    try {
        const { data, error } = await supabaseClient.rpc('create_voucher', {
            p_duration_days: durationDays,
            p_max_uses: maxUses,
            p_created_by: currentUser.email
        });

        if (error) throw error;

        if (data && data.length > 0) {
            const voucher = data[0];
            elements.codeDisplay.textContent = voucher.code;
            elements.generatedCode.classList.remove('hidden');
            showToast(`Access code created: ${voucher.code}`, 'success');

            // Refresh vouchers list
            await loadVouchers();
        }

    } catch (error) {
        console.error('Error generating voucher:', error);
        showToast(`Error: ${error.message}`, 'error');
    } finally {
        elements.generateBtn.disabled = false;
        elements.generateBtn.innerHTML = '<span class="btn-icon">✨</span> Generate Access Code';
    }
}

async function copyCode() {
    const code = elements.codeDisplay.textContent;
    try {
        await navigator.clipboard.writeText(code);
        showToast('Code copied to clipboard!', 'success');
    } catch (error) {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = code;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showToast('Code copied to clipboard!', 'success');
    }
}

// ==================== VERSION MANAGEMENT ====================

async function loadCurrentVersion() {
    if (!currentUser) return;

    elements.currentVersion.textContent = 'Loading...';

    try {
        const { data, error } = await supabaseClient
            .from('app_version')
            .select('version, release_notes, created_at')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (error) throw error;

        if (data) {
            elements.currentVersion.textContent = data.version;
            elements.currentVersion.title = data.release_notes || 'No release notes';
        } else {
            elements.currentVersion.textContent = 'No version found';
        }
    } catch (error) {
        console.error('Error loading version:', error);
        elements.currentVersion.textContent = 'Error loading';
    }
}

async function publishNewVersion() {
    if (!currentUser) {
        showToast('Please log in first', 'error');
        return;
    }

    const newVersion = elements.newVersionInput.value.trim();
    const releaseNotes = elements.releaseNotesInput.value.trim();

    // Validate version format
    if (!newVersion) {
        showToast('Please enter a version number', 'error');
        return;
    }

    if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
        showToast('Invalid version format. Use semver: X.Y.Z', 'error');
        return;
    }

    // Compare with current version
    const currentVersionText = elements.currentVersion.textContent;
    if (currentVersionText && currentVersionText !== 'Loading...' && currentVersionText !== 'No version found') {
        if (compareVersions(newVersion, currentVersionText) <= 0) {
            showToast('New version must be higher than current version', 'error');
            return;
        }
    }

    showModal(
        'Publish New Version',
        `Are you sure you want to publish version ${newVersion}? All users with older versions will see the update notification.`,
        async () => {
            elements.publishVersionBtn.disabled = true;
            elements.publishVersionBtn.innerHTML = '<span class="btn-icon">⏳</span> Publishing...';

            try {
                const { data, error } = await supabaseClient
                    .from('app_version')
                    .insert([{
                        version: newVersion,
                        release_notes: releaseNotes || null
                    }])
                    .select();

                if (error) throw error;

                showToast(`Version ${newVersion} published successfully!`, 'success');
                elements.newVersionInput.value = '';
                elements.releaseNotesInput.value = '';
                await loadCurrentVersion();

            } catch (error) {
                console.error('Error publishing version:', error);
                showToast(`Error: ${error.message}`, 'error');
            } finally {
                elements.publishVersionBtn.disabled = false;
                elements.publishVersionBtn.innerHTML = '<span class="btn-icon">📢</span> Publish New Version';
                hideModal();
            }
        }
    );
}

function compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;

        if (p1 < p2) return -1;
        if (p1 > p2) return 1;
    }

    return 0;
}

// ==================== LOAD DATA ====================

async function loadVouchers() {
    if (!currentUser) return;

    elements.vouchersTbody.innerHTML = '<tr class="loading-row"><td colspan="6">Loading access codes...</td></tr>';

    try {
        // Use secure RPC function instead of view
        const { data, error } = await supabaseClient.rpc('get_voucher_stats');

        if (error) throw error;

        if (!data || data.length === 0) {
            elements.vouchersTbody.innerHTML = '<tr class="loading-row"><td colspan="6">No access codes found</td></tr>';
            return;
        }

        elements.vouchersTbody.innerHTML = data.map(voucher => `
            <tr>
                <td><code style="color: var(--primary); font-weight: 600;">${voucher.code}</code></td>
                <td>${formatDuration(voucher.duration_days)}</td>
                <td>${voucher.times_used} / ${voucher.max_uses}</td>
                <td><span class="status-badge status-${voucher.status.toLowerCase().replace(' ', '-')}">${voucher.status}</span></td>
                <td>${formatDate(voucher.created_at)}</td>
                <td>
                    ${voucher.is_active && voucher.status === 'Available' ?
                `<button class="btn btn-danger btn-sm" onclick="deactivateVoucher('${voucher.code}')">
                            Expire
                        </button>` :
                '-'
            }
                </td>
            </tr>
        `).join('');

    } catch (error) {
        console.error('Error loading vouchers:', error);
        elements.vouchersTbody.innerHTML = `<tr class="loading-row"><td colspan="6">Error: ${error.message}</td></tr>`;
    }
}

async function loadUsers() {
    if (!currentUser) return;

    elements.usersTbody.innerHTML = '<tr class="loading-row"><td colspan="6">Loading users...</td></tr>';

    try {
        // Use secure RPC function instead of view
        const { data, error } = await supabaseClient.rpc('get_active_users');

        if (error) throw error;

        if (!data || data.length === 0) {
            elements.usersTbody.innerHTML = '<tr class="loading-row"><td colspan="6">No users found</td></tr>';
            return;
        }

        elements.usersTbody.innerHTML = data.map(user => `
            <tr>
                <td><span class="device-id" title="${user.device_id}">${user.device_id.substring(0, 16)}...</span></td>
                <td><code style="color: var(--primary);">${user.voucher_code}</code></td>
                <td>${formatDate(user.access_granted_at)}</td>
                <td>${formatDate(user.access_expires_at)} ${user.days_remaining > 0 ? `<br><small>(${user.days_remaining}d left)</small>` : ''}</td>
                <td><span class="status-badge status-${user.status.toLowerCase()}">${user.status}</span></td>
                <td>
                    ${user.status === 'Active' ?
                `<button class="btn btn-danger btn-sm" onclick="revokeAccess('${user.device_id}')">
                            Revoke
                        </button>` :
                '-'
            }
                </td>
            </tr>
        `).join('');

    } catch (error) {
        console.error('Error loading users:', error);
        elements.usersTbody.innerHTML = `<tr class="loading-row"><td colspan="6">Error: ${error.message}</td></tr>`;
    }
}

// ==================== ACTIONS ====================

async function deactivateVoucher(code) {
    if (!currentUser) {
        showToast('Please log in first', 'error');
        return;
    }

    showModal(
        'Deactivate Access Code',
        `Are you sure you want to deactivate access code "${code}"? This cannot be undone.`,
        async () => {
            try {
                const { data, error } = await supabaseClient.rpc('deactivate_voucher', {
                    p_code: code
                });

                if (error) throw error;

                showToast(`Access code ${code} has been deactivated`, 'success');
                await loadVouchers();

            } catch (error) {
                console.error('Error deactivating voucher:', error);
                showToast(`Error: ${error.message}`, 'error');
            }
            hideModal();
        }
    );
}

async function revokeAccess(deviceId) {
    if (!currentUser) {
        showToast('Please log in first', 'error');
        return;
    }

    showModal(
        'Revoke Access',
        `Are you sure you want to revoke access for this device? The user will need a new access code to regain access.`,
        async () => {
            try {
                const { data, error } = await supabaseClient.rpc('revoke_access', {
                    p_device_id: deviceId,
                    p_reason: `Revoked by ${currentUser.email}`
                });

                if (error) throw error;

                showToast('Access has been revoked', 'success');
                await loadUsers();

            } catch (error) {
                console.error('Error revoking access:', error);
                showToast(`Error: ${error.message}`, 'error');
            }
            hideModal();
        }
    );
}

// ==================== UI HELPERS ====================

function formatDuration(days) {
    if (days >= 30) {
        const months = Math.floor(days / 30);
        return `${months} month${months > 1 ? 's' : ''}`;
    } else if (days >= 7) {
        const weeks = Math.floor(days / 7);
        return `${weeks} week${weeks > 1 ? 's' : ''}`;
    } else {
        return `${days} day${days > 1 ? 's' : ''}`;
    }
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function showToast(message, type = 'success') {
    elements.toast.className = `toast ${type}`;
    elements.toast.querySelector('.toast-message').textContent = message;
    elements.toast.classList.remove('hidden');

    setTimeout(() => {
        elements.toast.classList.add('hidden');
    }, 3000);
}

let modalConfirmCallback = null;

function showModal(title, message, onConfirm) {
    elements.modalTitle.textContent = title;
    elements.modalMessage.textContent = message;
    elements.modalOverlay.classList.remove('hidden');
    modalConfirmCallback = onConfirm;

    // Update confirm button handler
    elements.modalConfirm.onclick = () => {
        if (modalConfirmCallback) modalConfirmCallback();
    };
}

function hideModal() {
    elements.modalOverlay.classList.add('hidden');
    modalConfirmCallback = null;
}

// ==================== START ====================
initialize();
