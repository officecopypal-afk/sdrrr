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
        // Create a dedicated worker tab
        workerTab = await chrome.tabs.create({ url: 'about:blank', active: false });

        for (let i = 0; i < config.pagesToProcess; i++) {
            if (stopFlag) break;
            
            const currentPage = i + 1;
            let pageUrl = config.startUrl;
            if (currentPage > 1) {
                // Remove existing page parameter if it exists
                pageUrl = pageUrl.replace(/&?page=\d+/, '');
                if (pageUrl.includes('?')) {
                    pageUrl += `&page=${currentPage}`;
                } else {
                    pageUrl += `?page=${currentPage}`;
                }
            }
            
            updateStatus(`Strona ${currentPage}/${config.pagesToProcess} - Nawigowanie do listy...`);
            
            // Navigate the worker tab and wait for it to load completely
            await chrome.tabs.update(workerTab.id, { url: pageUrl });
            await new Promise((resolve, reject) => {
                const listener = (tabId, changeInfo, tab) => {
                    if (tabId === workerTab.id && changeInfo.status === 'complete') {
                        // Check if the tab didn't crash
                        if (tab.status === 'complete') {
                             chrome.tabs.onUpdated.removeListener(listener);
                             resolve();
                        } else {
                             chrome.tabs.onUpdated.removeListener(listener);
                             reject(new Error("Karta uległa awarii podczas ładowania."));
                        }
                    }
                };
                chrome.tabs.onUpdated.addListener(listener);
            });
            await new Promise(r => setTimeout(r, 2000)); // Extra wait for dynamic content

            updateStatus(`Strona ${currentPage}/${config.pagesToProcess} - Pobieranie linków...`);
            const adLinks = await getLinksFromPage(workerTab.id);

            if (adLinks.length === 0) {
                 updateStatus(`Strona ${currentPage}/${config.pagesToProcess} - Nie znaleziono linków. Sprawdź link lub selektory.`, true);
                 await new Promise(r => setTimeout(r, 3000)); // wait for user to read
                 continue; // Try next page
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
            chrome.tabs.remove(workerTab.id);
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


function updateStatus(text, isError = false) {
    currentStatus = text;
    sendMessageToPopup({ action: 'updateStatus', text, isError });
}

function addLog(data) {
    logs.push(data);
    sendMessageToPopup({ action: 'log', data });
}

function sendMessageToPopup(message) {
    // Send to popup
    chrome.runtime.sendMessage(message).catch(err => {});
    // Also send to any other open extension pages (like options page if you add one)
    chrome.tabs.query({ url: chrome.runtime.getURL('*.html') }, tabs => {
        tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, message).catch(err => {});
        });
    });
}


async function getLinksFromPage(tabId) {
    if (!tabId) throw new Error("Nie podano ID karty roboczej.");

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => {
                const links = Array.from(document.querySelectorAll('a[data-cy="listing-item-link"]'));
                return links.map(a => a.href);
            },
        });
        
        if (!results || results.length === 0 || !results[0].result) {
            return [];
        }
        return results[0].result;
    } catch (e) {
        console.error("Error in getLinksFromPage:", e);
        throw new Error(`Nie udało się wykonać skryptu na stronie: ${e.message}`);
    }
}

async function processSingleAd(url, formData) {
    let adTab;
    try {
        adTab = await chrome.tabs.create({ url, active: false });
        await new Promise((resolve, reject) => {
            const listener = (tabId, changeInfo, tab) => {
                 if (tabId === adTab.id && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    if (tab.status === 'complete') {
                        resolve();
                    } else {
                        reject(new Error("Karta ogłoszenia uległa awarii."));
                    }
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        });
        
        await new Promise(r => setTimeout(r, 2000));

        const results = await chrome.scripting.executeScript({
            target: { tabId: adTab.id },
            func: (formData, processedContactsArray) => {
                const processed = new Set(processedContactsArray);
                let userName = 'Nieznany';
                let userPhone = 'Nieznany';

                try {
                    const userNameEl = document.querySelector('[data-cy="advertiser-card-name"]');
                    if (!userNameEl) throw new Error("Nie znaleziono nazwy agencji.");
                    userName = userNameEl.textContent.trim();

                    const phoneButton = document.querySelector('[data-cy="ask-about-number"]');
                    if (!phoneButton) throw new Error("Nie znaleziono przycisku Pokaż numer.");
                    phoneButton.click();
                    
                    return new Promise(resolve => {
                         setTimeout(() => {
                            try {
                                const phoneEl = document.querySelector('a[href^="tel:"]');
                                if (!phoneEl) throw new Error("Nie znaleziono numeru telefonu po kliknięciu.");
                                userPhone = phoneEl.textContent.trim();

                                const contactKey = `${userName}-${userPhone}`;
                                if (processed.has(contactKey)) {
                                    resolve({ status: 'skipped', userName, userPhone });
                                    return;
                                }

                                document.querySelector('#name').value = formData.name;
                                document.querySelector('#email').value = formData.email;
                                document.querySelector('#phone').value = formData.phone;
                                document.querySelector('#message').value = formData.message;
                                
                                const checkbox = document.querySelector('input[name="rules_confirmation"] + label');
                                if (!checkbox) throw new Error("Nie znaleziono checkboxa zgody.");
                                checkbox.click();

                                // FAKTYCZNA WYSYŁKA - ODKOMENTUJ ABY WŁĄCZYĆ
                                // document.querySelector('button[data-cy="contact-form-send-button"]').click();
                                
                                resolve({ status: 'success', userName, userPhone });
                            } catch (e) {
                                resolve({ status: 'error', error: e.message, userName, userPhone: 'Błąd' });
                            }
                        }, 1000); // Czekaj na numer
                    });

                } catch (e) {
                    return { status: 'error', error: e.message, userName, userPhone: 'Błąd' };
                }
            },
            args: [formData, Array.from(processedContacts)]
        });

        if (!results || !results[0] || !results[0].result) {
            throw new Error("Skrypt na stronie ogłoszenia nie zwrócił wyniku.");
        }

        const result = results[0].result;
        if (result.status === 'success') {
            const contactKey = `${result.userName}-${result.userPhone}`;
            processedContacts.add(contactKey);
        }
        addLog(result);

    } catch (error) {
        addLog({ status: 'error', userName: 'Błąd', error: `Błąd przetwarzania karty: ${error.message}` });
    } finally {
        if (adTab) {
            try {
                await chrome.tabs.remove(adTab.id);
            } catch(e) {
                console.warn(`Could not remove tab ${adTab.id}: ${e.message}`);
            }
        }
    }
}

