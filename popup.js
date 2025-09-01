document.addEventListener('DOMContentLoaded', () => {
    const startButton = document.getElementById('startButton');
    const stopButton = document.getElementById('stopButton');
    const statusDiv = document.getElementById('status');
    const logContainer = document.getElementById('logContainer');

    const urlInput = document.getElementById('urlInput');
    const pagesInput = document.getElementById('pagesInput');
    const nameInput = document.getElementById('nameInput');
    const emailInput = document.getElementById('emailInput');
    const phoneInput = document.getElementById('phoneInput');
    const messageInput = document.getElementById('messageInput');

    function setUIState(isRunning) {
        startButton.disabled = isRunning;
        stopButton.disabled = !isRunning;
    }

    startButton.addEventListener('click', () => {
        const url = urlInput.value;
        if (!url || !url.includes('otodom.pl')) {
            updateStatus('Wprowadź poprawny link z Otodom.', true);
            return;
        }
        setUIState(true);
        logContainer.innerHTML = '';
        updateStatus('Rozpoczynanie procesu...');
        chrome.runtime.sendMessage({
            action: 'start',
            config: {
                startUrl: url,
                pagesToProcess: parseInt(pagesInput.value, 10),
                formData: {
                    name: nameInput.value,
                    email: emailInput.value,
                    phone: phoneInput.value,
                    message: messageInput.value
                }
            }
        });
    });

    stopButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'stop' });
    });

    function updateStatus(message, isError = false) {
        statusDiv.textContent = message;
        statusDiv.className = isError ? 'text-sm text-red-400 mb-3' : 'text-sm text-gray-400 mb-3';
    }

    function addLogEntry(log) {
        const entry = document.createElement('div');
        let statusClass = 'log-success';
        if (log.status === 'skipped') statusClass = 'log-skipped';
        if (log.status === 'error') statusClass = 'log-error';

        entry.className = `log-entry p-2 rounded-md bg-gray-800 text-xs ${statusClass}`;
        
        let statusText = 'Wiadomość wysłana';
         if (log.status === 'skipped') statusText = 'Pominięto (duplikat)';
        if (log.status === 'error') statusText = `Błąd: ${log.error}`;

        entry.innerHTML = `
            <div class="flex justify-between items-center">
                <span class="font-bold text-white">${log.userName}</span>
                <span class="text-gray-400">${log.userPhone || ''}</span>
            </div>
            <div class="text-gray-300 mt-1">${statusText}</div>
        `;
        logContainer.appendChild(entry);
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'updateStatus') {
            updateStatus(message.text, message.isError);
        } else if (message.action === 'log') {
            addLogEntry(message.data);
        } else if (message.action === 'finished') {
            setUIState(false);
            updateStatus('Zakończono!');
        } else if (message.action === 'stopped') {
            setUIState(false);
            updateStatus('Proces zatrzymany przez użytkownika.', true);
        }
    });

     // Zapytaj o aktualny stan przy otwarciu popupu
    chrome.runtime.sendMessage({ action: 'getState' }, (response) => {
        if (response) {
            setUIState(response.isRunning);
            updateStatus(response.status);
            response.logs.forEach(log => addLogEntry(log));
        }
    });
});
