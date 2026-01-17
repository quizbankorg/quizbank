// ==================== SUPABASE CONFIGURATION ====================
const SUPABASE_URL = 'https://bgfyvqidmxjnyhsklynv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnZnl2cWlkbXhqbnloc2tseW52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkwNzQ5NTAsImV4cCI6MjA3NDY1MDk1MH0.a7dYad377cYyaDn4nCJHUhdXMYSlQF0s-GYSELqkWTI';

// ==================== MESSAGE TYPES ====================

const prefix = 'canvas-quiz-bank';

const BrowserMessageType = {
  DEBUG: `${prefix}-debug`,
  PING: `${prefix}-ping`,
  PONG: `${prefix}-pong`,
  ACCESS_STATUS: `${prefix}-access-status`,
};

// ==================== GLOBALS ====================
let supabaseClient = null;

// ==================== DOM ELEMENTS ====================

const elements = {
  accessGate: document.getElementById('access-gate'),
  mainContent: document.getElementById('main-content'),
  voucherInput: document.getElementById('voucher-input'),
  activateBtn: document.getElementById('activate-btn'),
  voucherError: document.getElementById('voucher-error'),
  accessInfo: document.getElementById('access-info'),
  accessExpires: document.getElementById('access-expires'),
  dropdown: document.querySelector('.dropdown'),
  loggingToggle: document.getElementById('logging-toggle'),
  downloadDebug: document.getElementById('download-debug')
};

// ==================== DEVICE ID MANAGEMENT ====================

/**
 * Get or create a unique device ID for this installation
 */
async function getDeviceId() {
  try {
    const result = await browser.storage.local.get(['quizbank_device_id']);
    if (result.quizbank_device_id) {
      return result.quizbank_device_id;
    }

    // Generate new device ID
    const deviceId = 'dev_' + crypto.randomUUID();
    await browser.storage.local.set({ quizbank_device_id: deviceId });
    return deviceId;
  } catch (e) {
    console.error('Error getting device ID:', e);
    // Fallback to a session-based ID
    return 'dev_' + Date.now() + '_' + Math.random().toString(36).substring(2);
  }
}

// ==================== ACCESS MANAGEMENT ====================

/**
 * Check if user has valid access
 */
async function checkAccess() {
  const deviceId = await getDeviceId();

  try {
    // First check local cache
    const cached = await browser.storage.local.get(['quizbank_access']);
    if (cached.quizbank_access) {
      const access = cached.quizbank_access;
      const expiresAt = new Date(access.expires_at);

      if (expiresAt > new Date() && !access.is_revoked) {
        return {
          hasAccess: true,
          expiresAt: expiresAt,
          daysRemaining: Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24)),
          voucherCode: access.voucher_code
        };
      }
    }

    // Check with server (in case access was revoked or extended)
    if (!supabaseClient) {
      supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }

    const { data, error } = await supabaseClient.rpc('check_access', {
      p_device_id: deviceId
    });

    if (error) {
      console.error('Error checking access:', error);
      // Fall back to cached access if server check fails
      return cached.quizbank_access ? {
        hasAccess: new Date(cached.quizbank_access.expires_at) > new Date(),
        expiresAt: new Date(cached.quizbank_access.expires_at),
        daysRemaining: Math.ceil((new Date(cached.quizbank_access.expires_at) - new Date()) / (1000 * 60 * 60 * 24)),
        voucherCode: cached.quizbank_access.voucher_code
      } : { hasAccess: false };
    }

    if (data && data.length > 0 && data[0].has_access) {
      const accessData = data[0];
      // Update cache
      await browser.storage.local.set({
        quizbank_access: {
          expires_at: accessData.access_expires_at,
          voucher_code: accessData.voucher_code,
          is_revoked: false
        }
      });

      return {
        hasAccess: true,
        expiresAt: new Date(accessData.access_expires_at),
        daysRemaining: accessData.days_remaining,
        voucherCode: accessData.voucher_code
      };
    }

    // No valid access - clear cache
    await browser.storage.local.remove(['quizbank_access']);
    return { hasAccess: false };

  } catch (e) {
    console.error('Access check error:', e);
    return { hasAccess: false };
  }
}

/**
 * Redeem a voucher code
 */
async function redeemVoucher(code) {
  const deviceId = await getDeviceId();

  if (!supabaseClient) {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }

  const { data, error } = await supabaseClient.rpc('redeem_voucher', {
    p_code: code.toUpperCase().trim(),
    p_device_id: deviceId
  });

  if (error) {
    throw new Error(error.message);
  }

  if (data && data.length > 0) {
    const result = data[0];
    if (result.success) {
      // Save access to local storage
      await browser.storage.local.set({
        quizbank_access: {
          expires_at: result.access_expires_at,
          voucher_code: code.toUpperCase().trim(),
          is_revoked: false
        }
      });
      return result;
    } else {
      throw new Error(result.message);
    }
  }

  throw new Error('Invalid response from server');
}

// ==================== UI MANAGEMENT ====================

function showAccessGate() {
  elements.accessGate.classList.remove('hidden');
  elements.mainContent.classList.add('hidden');
}

function showMainContent(accessInfo) {
  elements.accessGate.classList.add('hidden');
  elements.mainContent.classList.remove('hidden');
  elements.dropdown.classList.remove('hidden'); // Show settings dropdown

  // Update access info display
  if (accessInfo.daysRemaining !== undefined) {
    if (accessInfo.daysRemaining <= 0) {
      elements.accessExpires.textContent = 'Expires today';
    } else if (accessInfo.daysRemaining === 1) {
      elements.accessExpires.textContent = 'Expires tomorrow';
    } else {
      elements.accessExpires.textContent = `${accessInfo.daysRemaining} days remaining`;
    }
  }
}

function showError(message) {
  elements.voucherError.textContent = message;
  elements.voucherError.classList.remove('hidden');
}

function hideError() {
  elements.voucherError.classList.add('hidden');
}

function setLoading(loading) {
  elements.activateBtn.disabled = loading;
  elements.activateBtn.querySelector('.btn-text').classList.toggle('hidden', loading);
  elements.activateBtn.querySelector('.btn-loading').classList.toggle('hidden', !loading);
}

// ==================== DROPDOWN FUNCTIONALITY ====================

function setupDropdown() {
  if (!elements.dropdown) return;

  const gearIcon = elements.dropdown.querySelector('.gear-icon');

  // Toggle dropdown when gear icon is clicked
  if (gearIcon) {
    gearIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      elements.dropdown.classList.toggle('open');
    });
  }

  // Close dropdown if clicked outside
  document.addEventListener('click', (e) => {
    if (!elements.dropdown.contains(e.target)) {
      elements.dropdown.classList.remove('open');
    }
  });
}

// ==================== DEBUG FUNCTIONALITY ====================

function setupDebugDownload() {
  if (!elements.downloadDebug) return;

  elements.downloadDebug.addEventListener('click', async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) {
      console.log('No active tab found');
      return;
    }

    try {
      const response = await browser.tabs.sendMessage(tabs[0].id, { type: BrowserMessageType.DEBUG });
      downloadFile('logs.txt', response);
    } catch (error) {
      console.log('Could not get debug logs from content script:', error);
    }
  });
}

function downloadFile(name, content) {
  const blob = new Blob([content], { type: 'text/plain' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ==================== LOGGING TOGGLE FUNCTIONALITY ====================

async function loadLoggingPreference() {
  try {
    const result = await browser.storage.local.get(['loggingEnabled']);
    const isEnabled = result.loggingEnabled === true;
    if (elements.loggingToggle) {
      elements.loggingToggle.checked = isEnabled;
    }
    updateDebugLinkVisibility(isEnabled);
    return isEnabled;
  } catch (e) {
    console.log('Could not load logging preference, defaulting to disabled');
    updateDebugLinkVisibility(false);
    return false;
  }
}

function updateDebugLinkVisibility(loggingEnabled) {
  if (elements.downloadDebug) {
    if (loggingEnabled) {
      elements.downloadDebug.classList.remove('hidden');
    } else {
      elements.downloadDebug.classList.add('hidden');
    }
  }
}

async function saveLoggingPreference(enabled) {
  try {
    await browser.storage.local.set({ loggingEnabled: enabled });
    console.log('Logging preference saved:', enabled);
  } catch (e) {
    console.log('Could not save logging preference');
  }
}

function setupLoggingToggle() {
  if (!elements.loggingToggle) return;

  elements.loggingToggle.addEventListener('change', async (e) => {
    const isEnabled = e.target.checked;
    await saveLoggingPreference(isEnabled);
    updateDebugLinkVisibility(isEnabled);

    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0) {
        await browser.tabs.sendMessage(tabs[0].id, {
          type: `${prefix}-set-logging`,
          enabled: isEnabled
        });
        console.log('Logging toggled:', isEnabled ? 'ON' : 'OFF');
      }
    } catch (e) {
      console.log('Could not communicate with content script:', e);
    }
  });
}

// ==================== VOUCHER FORM HANDLING ====================

function setupVoucherForm() {
  // Simple formatting - just uppercase and allow alphanumeric + dashes
  elements.voucherInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    hideError();
  });

  // Handle paste explicitly (some browsers block paste in extension popups)
  elements.voucherInput.addEventListener('paste', (e) => {
    e.preventDefault();
    const pastedText = (e.clipboardData || window.clipboardData).getData('text');
    const cleaned = pastedText.toUpperCase().replace(/[^A-Z0-9-]/g, '');

    // Insert at cursor position or replace selection
    const input = e.target;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const currentValue = input.value;

    const newValue = currentValue.substring(0, start) + cleaned + currentValue.substring(end);
    input.value = newValue.substring(0, 20); // Respect maxlength

    // Move cursor to end of pasted content
    const newCursorPos = Math.min(start + cleaned.length, 20);
    input.setSelectionRange(newCursorPos, newCursorPos);

    hideError();
  });

  // Handle Enter key
  elements.voucherInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleActivate();
    }
  });

  // Handle activate button click
  elements.activateBtn.addEventListener('click', handleActivate);
}

async function handleActivate() {
  const code = elements.voucherInput.value.trim();

  if (!code) {
    showError('Please enter an access code');
    return;
  }

  if (code.length < 5) {
    showError('Access code is too short');
    return;
  }

  setLoading(true);
  hideError();

  try {
    const result = await redeemVoucher(code);

    // Success! Show main content
    const accessInfo = await checkAccess();
    showMainContent(accessInfo);

    // Notify content script about access status
    notifyContentScript(true);

    // Tell content script to re-run QuizBank
    notifyContentScriptActivated();

  } catch (error) {
    showError(error.message || 'Failed to activate voucher');
  } finally {
    setLoading(false);
  }
}

// ==================== CONTENT SCRIPT COMMUNICATION ====================

async function notifyContentScript(hasAccess) {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      await browser.tabs.sendMessage(tabs[0].id, {
        type: BrowserMessageType.ACCESS_STATUS,
        hasAccess: hasAccess
      });
    }
  } catch (e) {
    // Content script might not be loaded on current page
  }
}

async function notifyContentScriptActivated() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      await browser.tabs.sendMessage(tabs[0].id, {
        type: 'canvas-quiz-bank-activated'
      });
    }
  } catch (e) {
    // Content script might not be loaded on current page
  }
}

// ==================== INITIALIZATION ====================

async function initializePopup() {
  // Initialize Supabase client
  supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Always setup dropdown and logging (now outside access gate)
  setupDropdown();
  setupDebugDownload();
  setupLoggingToggle();
  await loadLoggingPreference();

  // Check access status
  const accessInfo = await checkAccess();

  if (accessInfo.hasAccess) {
    showMainContent(accessInfo);
  } else {
    showAccessGate();
    setupVoucherForm();
  }
}

// Start initialization
initializePopup();