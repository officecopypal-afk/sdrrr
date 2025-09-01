let isRunning = false;
let stopFlag = false;
let logs = [];
let currentStatus = 'Oczekiwanie na rozpoczęcie...';
let processedContacts = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'start') {
        if (isRunning) return;
        isRunning = true;
        stopFlag = false;
        logs = [];
        processedContacts.clear();
        startProcessing(message.config);
    } else if (message.action === 'stop') {
        stopFlag = true;
    } else if (message.action === 'getState') {
        sendResponse({ isRunning, status: currentStatus, logs });
    }
    return true; // Keep the message channel open for async response
});

async function startProcessing(config) {
    let workerTab;
    try {
        workerTab = await chrome.tabs.create({ url: 'about:blank', active: false });

        for (let i = 0; i < config.pagesToProcess; i++) {
            if (stopFlag) break;
            
            const currentPage = i + 1;
            let pageUrl = config.startUrl;
            if (currentPage > 1) {
                pageUrl = pageUrl.replace(/&?page=\d+/, '');
                if (pageUrl.includes('?')) {
                    pageUrl += `&page=${currentPage}`;
                } else {
                    pageUrl += `?page=${currentPage}`;
                }
            }
            
            updateStatus(`Strona ${currentPage}/${config.pagesToProcess} - Nawigowanie do listy...`);
            
            await chrome.tabs.update(workerTab.id, { url: pageUrl });
            await waitForTabLoad(workerTab.id);
            await new Promise(r => setTimeout(r, 2000));

            updateStatus(`Strona ${currentPage}/${config.pagesToProcess} - Pobieranie linków...`);
            const adLinks = await getLinksFromPage(workerTab.id);

            if (adLinks.length === 0) {
                 updateStatus(`Strona ${currentPage}/${config.pagesToProcess} - Nie znaleziono linków.`, true);
                 await new Promise(r => setTimeout(r, 3000));
                 continue;
            }

            for (let j = 0; j < adLinks.length; j++) {
                if (stopFlag) break;
                 updateStatus(`Strona ${currentPage}/${config.pagesToProcess} - Przetwarzanie ogłoszenia ${j + 1}/${adLinks.length}...`);
                await processSingleAd(adLinks[j], config.formData);
            }
        }
    } catch (error) {
        updateStatus(`Krytyczny błąd: ${error.message}`, true);
    } finally {
        if (workerTab) {
            try { await chrome.tabs.remove(workerTab.id); } catch(e) {}
        }
        
        if (stopFlag) {
            isRunning = false;
            sendMessageToPopup({ action: 'stopped' });
            currentStatus = 'Proces zatrzymany przez użytkownika.';
        } else {
            isRunning = false;
            sendMessageToPopup({ action: 'finished' });
            currentStatus = 'Zakończono!';
        }
    }
}

async function waitForTabLoad(tabId) {
    return new Promise((resolve, reject) => {
        const listener = (updatedTabId, changeInfo, tab) => {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                if (tab.status === 'complete') {
                    resolve();
                } else {
                    reject(new Error("Karta uległa awarii podczas ładowania."));
                }
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
    });
}

function updateStatus(text, isError = false) {
    currentStatus = text;
    sendMessageToPopup({ action: 'updateStatus', text, isError });
}

function addLog(data) {
    logs.push(data);
    sendMessageToPopup({ action: 'log', data });
}

function sendMessageToPopup(message) {
    chrome.runtime.sendMessage(message).catch(err => {});
}

async function getLinksFromPage(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => Array.from(document.querySelectorAll('a[data-cy="listing-item-link"]')).map(a => a.href),
        });
        return (results && results[0] && results[0].result) ? results[0].result : [];
    } catch (e) {
        throw new Error(`Nie udało się wykonać skryptu na stronie listy: ${e.message}`);
    }
}

async function processSingleAd(url, formData) {
    let adTab;
    try {
        adTab = await chrome.tabs.create({ url, active: false });
        await waitForTabLoad(adTab.id);
        await new Promise(r => setTimeout(r, 2000));

        const results = await chrome.scripting.executeScript({
            target: { tabId: adTab.id },
            func: async (formData, processedContactsArray) => {
                const processed = new Set(processedContactsArray);
                let userName = 'Nieznany';
                let userPhone = 'Nieznany';

                try {
                    // --- NEW, UPDATED SELECTORS BASED ON SCREENSHOT ---
                    const userNameEl = document.querySelector('h2[data-testid="aside-author-name"] a');
                    const phoneEl = document.querySelector('a[data-testid="aside-author-phone-number"]');
                    
                    if (!userNameEl) throw new Error("Nie znaleziono nazwy użytkownika (nowy selektor).");
                    userName = userNameEl.textContent.trim();

                    if (!phoneEl) throw new Error("Nie znaleziono numeru telefonu (prawdopodobnie ukryty lub brak).");
                    userPhone = phoneEl.href.replace('tel:', '').trim();
                    // --- END OF NEW SELECTORS ---

                    const contactKey = `${userName}-${userPhone}`;
                    if (processed.has(contactKey)) {
                        return { status: 'skipped', userName, userPhone };
                    }
                    
                    // Clear the default message first
                    const messageTextarea = document.querySelector('#message');
                    if (!messageTextarea) throw new Error("Nie znaleziono pola wiadomości.");
                    messageTextarea.value = ''; // Clear content

                    // Fill the form
                    document.querySelector('#name').value = formData.name;
                    document.querySelector('#email').value = formData.email;
                    document.querySelector('#phone').value = formData.phone;
                    messageTextarea.value = formData.message;
                    
                    const checkbox = document.querySelector('input[name="rules_confirmation-aside"] + label');
                    if (!checkbox) throw new Error("Nie znaleziono checkboxa zgody.");
                    checkbox.click();

                    // FAKTYCZNA WYSYŁKA - ODKOMENTUJ ABY WŁĄCZYĆ
                    // document.querySelector('button[data-testid="contact-form-send-button"]').click();
                    
                    return { status: 'success', userName, userPhone };

                } catch (e) {
                    return { status: 'error', error: e.message, userName: userName || 'Nieznany', userPhone: 'Błąd' };
                }
            },
            args: [formData, Array.from(processedContacts)]
        });

        if (!results || !results[0] || !results[0].result) {
            throw new Error("Skrypt na stronie ogłoszenia nie zwrócił wyniku.");
        }

        const result = results[0].result;
        if (result.status === 'success' || (result.status === 'skipped' && result.userPhone !== 'Błąd')) {
            const contactKey = `${result.userName}-${result.userPhone}`;
            processedContacts.add(contactKey);
        }
        addLog(result);

    } catch (error) {
        addLog({ status: 'error', userName: 'Błąd Krytyczny', error: `Błąd przetwarzania karty: ${error.message}` });
    } finally {
        if (adTab) {
            try { await chrome.tabs.remove(adTab.id); } catch(e) {}
        }
    }
}

