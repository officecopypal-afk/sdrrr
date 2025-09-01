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
});

async function startProcessing(config) {
    for (let i = 0; i < config.pagesToProcess; i++) {
        if (stopFlag) break;
        
        const currentPage = i + 1;
        let pageUrl = config.startUrl;
        if (currentPage > 1) {
            if (pageUrl.includes('?')) {
                pageUrl += `&page=${currentPage}`;
            } else {
                pageUrl += `?page=${currentPage}`;
            }
        }
        
        updateStatus(`Strona ${currentPage}/${config.pagesToProcess} - Pobieranie linków...`);

        try {
            const adLinks = await getLinksFromPage(pageUrl);
            if (adLinks.length === 0) {
                 updateStatus(`Strona ${currentPage}/${config.pagesToProcess} - Nie znaleziono linków. Kończenie...`, true);
                 break;
            }

            for (let j = 0; j < adLinks.length; j++) {
                if (stopFlag) break;
                 updateStatus(`Strona ${currentPage}/${config.pagesToProcess} - Przetwarzanie ogłoszenia ${j + 1}/${adLinks.length}...`);
                await processSingleAd(adLinks[j], config.formData);
            }
        } catch (error) {
            updateStatus(`Błąd na stronie ${currentPage}: ${error.message}`, true);
        }
    }

    if (stopFlag) {
        isRunning = false;
        sendMessageToPopup({ action: 'stopped' });
    } else {
        isRunning = false;
        sendMessageToPopup({ action: 'finished' });
    }
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
    chrome.runtime.sendMessage(message).catch(err => { /* Ignore errors if popup is not open */ });
}

async function getLinksFromPage(url) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("Nie znaleziono aktywnej karty.");

    const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
             const links = Array.from(document.querySelectorAll('a[data-cy="listing-item-link"]'));
             return links.map(a => a.href);
        },
    });
    return results[0].result;
}

async function processSingleAd(url, formData) {
    let adTab;
    try {
        adTab = await chrome.tabs.create({ url, active: false });
        await new Promise(resolve => {
            const listener = (tabId, changeInfo) => {
                if (tabId === adTab.id && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        });
        
        // Czekaj dodatkowo dla pewności, że strona jest interaktywna
        await new Promise(r => setTimeout(r, 2000));

        const results = await chrome.scripting.executeScript({
            target: { tabId: adTab.id },
            func: async (formData, processedContactsArray) => {
                const processed = new Set(processedContactsArray);
                let userName = 'Nieznany';
                let userPhone = 'Nieznany';

                try {
                    userName = document.querySelector('[data-cy="advertiser-card-name"]').textContent.trim();
                    document.querySelector('[data-cy="ask-about-number"]').click();
                    
                    await new Promise(r => setTimeout(r, 1000)); // Czekaj na numer
                    
                    userPhone = document.querySelector('a[href^="tel:"]').textContent.trim();

                    const contactKey = `${userName}-${userPhone}`;
                    if (processed.has(contactKey)) {
                        return { status: 'skipped', userName, userPhone };
                    }

                    document.querySelector('#name').value = formData.name;
                    document.querySelector('#email').value = formData.email;
                    document.querySelector('#phone').value = formData.phone;
                    document.querySelector('#message').value = formData.message;
                    document.querySelector('input[name="rules_confirmation"] + label').click();

                    // FAKTYCZNA WYSYŁKA - ODKOMENTUJ ABY WŁĄCZYĆ
                    // document.querySelector('button[data-cy="contact-form-send-button"]').click();
                    
                    return { status: 'success', userName, userPhone };

                } catch (e) {
                    return { status: 'error', error: e.message, userName, userPhone };
                }
            },
            args: [formData, Array.from(processedContacts)]
        });

        const result = results[0].result;
        if (result.status === 'success' || result.status === 'skipped') {
            const contactKey = `${result.userName}-${result.userPhone}`;
            processedContacts.add(contactKey);
        }
        addLog(result);

    } catch (error) {
        addLog({ status: 'error', error: `Błąd otwierania karty: ${error.message}` });
    } finally {
        if (adTab) {
            chrome.tabs.remove(adTab.id);
        }
    }
}
