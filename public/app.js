// Генерация нового ключа трансляции
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

        const data = await response.json();

        // Отображаем результат - RTMP
        document.getElementById('rtmpUrl').value = data.rtmpUrl;
        document.getElementById('rtmpStreamKey').value = data.streamKey;

        // Отображаем результат - SRT
        document.getElementById('srtUrl').value = data.srtUrl;

        // Общее
        document.getElementById('watchUrl').value = data.webPlayerUrl;
        document.getElementById('keyResult').style.display = 'block';

        // Очищаем поле ввода
        document.getElementById('streamName').value = '';

        // Автоматически обновляем список ключей
        loadKeys();

        // Показываем уведомление
        showNotification('✅ Ключ трансляции успешно создан!');
    } catch (error) {
        console.error('Error generating key:', error);
        showNotification('❌ Ошибка при создании ключа', 'error');
    }
}

// Копирование в буфер обмена
function copyToClipboard(elementId) {
    const input = document.getElementById(elementId);
    input.select();
    document.execCommand('copy');

    showNotification('📋 Скопировано в буфер обмена!');
}

// Открыть страницу просмотра
function openWatch() {
    const watchUrl = document.getElementById('watchUrl').value;
    window.open(watchUrl, '_blank');
}

// Загрузка списка ключей
async function loadKeys() {
    try {
        const response = await fetch('/api/keys');
        const keys = await response.json();

        const keysList = document.getElementById('keysList');

        if (keys.length === 0) {
            keysList.innerHTML = '<p class="placeholder">Нет созданных ключей трансляции</p>';
            return;
        }

        keysList.innerHTML = keys.map(key => `
            <div class="key-item ${key.isLive ? 'live' : ''}">
                <h4>
                    ${key.name}
                    ${key.isLive ? '<span class="status-badge status-live">🔴 В ЭФИРЕ</span>' : '<span class="status-badge status-offline">⚫ ОФФЛАЙН</span>'}
                </h4>
                <p><strong>Ключ:</strong> <code>${key.key}</code></p>
                <p><strong>Создан:</strong> ${new Date(key.createdAt).toLocaleString('ru-RU')}</p>
                ${key.isLive && key.startedAt ? `<p><strong>Начало трансляции:</strong> ${new Date(key.startedAt).toLocaleString('ru-RU')}</p>` : ''}
                <p><strong>RTMP URL:</strong> <code>rtmp://localhost:1935/live/${key.key}</code></p>
                <button onclick="window.open('watch.html?key=${key.key}', '_blank')" class="btn-watch">📺 Смотреть</button>
                ${!key.isLive ? `<button onclick="deleteKey('${key.key}')" class="btn-delete">🗑️ Удалить</button>` : ''}
            </div>
        `).join('');
    } catch (error) {
        console.error('Error loading keys:', error);
        showNotification('❌ Ошибка при загрузке ключей', 'error');
    }
}

// Удаление ключа
async function deleteKey(key) {
    if (!confirm('Вы уверены, что хотите удалить этот ключ?')) {
        return;
    }

    try {
        const response = await fetch(`/api/key/${key}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            showNotification('✅ Ключ успешно удален');
            loadKeys();
        } else {
            const error = await response.json();
            showNotification(`❌ ${error.error}`, 'error');
        }
    } catch (error) {
        console.error('Error deleting key:', error);
        showNotification('❌ Ошибка при удалении ключа', 'error');
    }
}

// Показать уведомление
function showNotification(message, type = 'success') {
    // Создаем элемент уведомления
    const notification = document.createElement('div');
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 15px 25px;
        background: ${type === 'success' ? '#4CAF50' : '#f44336'};
        color: white;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        z-index: 10000;
        animation: slideIn 0.3s ease-out;
        font-weight: 600;
    `;

    document.body.appendChild(notification);

    // Удаляем через 3 секунды
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Добавляем CSS анимации
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

// Автоматически загружаем ключи при загрузке страницы
if (window.location.pathname === '/' || window.location.pathname.includes('index.html')) {
    window.addEventListener('load', loadKeys);
}
