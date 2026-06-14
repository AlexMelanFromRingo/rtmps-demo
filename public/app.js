// ═══════════════════════════════════════════════════════════════════════════
// STREAMHUB PRO - CLIENT-SIDE JAVASCRIPT
// Professional Streaming Dashboard with Real-time Metrics
// ═══════════════════════════════════════════════════════════════════════════

// Generate new stream key
async function generateKey() {
    const name = document.getElementById('streamName').value || 'Unnamed Stream';

    try {
        const response = await fetch('/api/generate-key', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name })
        });

        if (!response.ok) {
            throw new Error('Failed to generate key');
        }

        const data = await response.json();

        // Display RTMP details
        document.getElementById('rtmpUrl').value = data.rtmpUrl;
        document.getElementById('rtmpStreamKey').value = data.streamKey;

        // Display SRT details
        document.getElementById('srtUrl').value = data.srtUrl;

        // Display watch URL
        document.getElementById('watchUrl').value = data.webPlayerUrl;

        // Show result
        document.getElementById('keyResult').style.display = 'block';

        // Clear input
        document.getElementById('streamName').value = '';

        // Success notification
        showNotification('✅ Ключ трансляции успешно создан!', 'success');

        // Auto-load keys list
        setTimeout(loadKeys, 500);

    } catch (error) {
        console.error('Error:', error);
        showNotification('❌ Ошибка при создании ключа: ' + error.message, 'error');
    }
}

// Switch between SRT and RTMP protocols
function switchProtocol(protocol, evt) {
    // Update tab styles
    const tabs = document.querySelectorAll('.protocol-tab');
    tabs.forEach(tab => tab.classList.remove('active'));
    const target = (evt || window.event)?.target;
    if (target) target.classList.add('active');

    // Show/hide protocol sections
    if (protocol === 'srt') {
        document.getElementById('srtProtocol').style.display = 'block';
        document.getElementById('rtmpProtocol').style.display = 'none';
    } else {
        document.getElementById('srtProtocol').style.display = 'none';
        document.getElementById('rtmpProtocol').style.display = 'block';
    }
}

// Copy to clipboard
async function copyToClipboard(elementId) {
    const input = document.getElementById(elementId);
    const text = input.value;

    try {
        await navigator.clipboard.writeText(text);

        // Visual feedback
        const originalBg = input.style.background;
        input.style.background = 'var(--success)';
        input.style.color = 'var(--bg-primary)';

        setTimeout(() => {
            input.style.background = originalBg;
            input.style.color = '';
        }, 300);

        showNotification('📋 Скопировано в буфер обмена!', 'success');
    } catch (error) {
        console.error('Failed to copy:', error);
        // Fallback
        input.select();
        document.execCommand('copy');
        showNotification('📋 Скопировано!', 'success');
    }
}

// Open watch page
function openWatch() {
    const url = document.getElementById('watchUrl').value;
    window.open(url, '_blank');
}

// Load all stream keys
async function loadKeys() {
    try {
        const response = await fetch('/api/keys');
        const keys = await response.json();

        const keysList = document.getElementById('keysList');

        if (keys.length === 0) {
            keysList.innerHTML = '<p class="placeholder">Нет активных ключей трансляции</p>';
            return;
        }

        keysList.innerHTML = keys.map(key => `
            <div class="key-item ${key.is_live ? 'live' : ''}">
                <h4>
                    ${escapeHtml(key.name)}
                    <span class="status-badge ${key.is_live ? 'status-live' : 'status-offline'}">
                        ${key.is_live ? 'LIVE' : 'Offline'}
                    </span>
                </h4>
                <p><strong>Ключ:</strong> <code>${key.key}</code></p>
                <p><strong>SRT Port:</strong> <code>${key.srt_port}</code></p>
                <p><strong>Создан:</strong> ${formatDate(key.created_at)}</p>
                ${key.is_live ? `<p class="text-success"><strong>▶ Трансляция началась:</strong> ${formatDate(key.started_at)}</p>` : ''}
                ${!key.is_live && key.ended_at ? `<p class="text-tertiary"><strong>Последняя трансляция:</strong> ${formatDate(key.ended_at)}</p>` : ''}
                <div style="margin-top: 12px;">
                    <button onclick="window.open('/watch.html?key=${key.key}', '_blank')" class="btn-watch">
                        📺 Смотреть
                    </button>
                    ${!key.is_live ? `
                        <button onclick="deleteKey('${key.key}')" class="btn-delete">
                            🗑️ Удалить
                        </button>
                    ` : ''}
                </div>
            </div>
        `).join('');

    } catch (error) {
        console.error('Error loading keys:', error);
        showNotification('❌ Ошибка загрузки ключей', 'error');
    }
}

// Delete stream key
async function deleteKey(key) {
    if (!confirm('Вы уверены, что хотите удалить этот ключ трансляции?')) {
        return;
    }

    try {
        const response = await fetch(`/api/key/${key}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete key');
        }

        showNotification('✅ Ключ успешно удален', 'success');
        loadKeys();

    } catch (error) {
        console.error('Error deleting key:', error);
        showNotification('❌ Ошибка: ' + error.message, 'error');
    }
}

// Notification system
function showNotification(message, type = 'info') {
    // Remove existing notifications
    const existing = document.querySelector('.notification');
    if (existing) {
        existing.remove();
    }

    const colors = {
        success: 'var(--success)',
        error: 'var(--error)',
        warning: 'var(--warning)',
        info: 'var(--info)'
    };

    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${colors[type] || colors.info};
        color: white;
        padding: 16px 24px;
        border-radius: 8px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        font-weight: 600;
        z-index: 10000;
        animation: slideIn 0.3s ease-out;
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-in';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Utility functions
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateString) {
    if (!dateString) return 'N/A';
    // SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC — normalise to ISO.
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateString)
        ? dateString.replace(' ', 'T') + 'Z'
        : dateString;
    const date = new Date(iso);
    if (isNaN(date.getTime())) return 'N/A';
    return date.toLocaleString('ru-RU', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(400px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }

    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(400px);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

// Auto-load keys on page load
window.addEventListener('load', () => {
    loadKeys();
    console.log('🚀 StreamHub Pro initialized');
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + K: Focus stream name input
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        document.getElementById('streamName').focus();
    }

    // Ctrl/Cmd + Enter: Generate key
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        generateKey();
    }

    // Ctrl/Cmd + R: Reload keys
    if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
        e.preventDefault();
        loadKeys();
    }
});
