// Handle file upload
document.getElementById("fileInput").addEventListener("change", handleFileUpload);

let currentJsonFileName = null;
let currentJsonFileSize = null;
let currentJsonFileModified = null;
const CHUNK_SIZE = 50;
let renderedMessages = new Map();
let observer = null;

// Storage wrapper: namespace keys and fallback to cookies if localStorage unavailable
const STORAGE_PREFIX = 'fmjv_' + (window.location.hostname || 'local') + '_';

function setCookie(name, value, days = 365) {
    try {
        const expires = new Date(Date.now() + days * 864e5).toUTCString();
        document.cookie = encodeURIComponent(name) + '=' + encodeURIComponent(value) + '; expires=' + expires + '; path=/';
    } catch(e) {}
}

function getCookie(name) {
    try {
        const cookies = document.cookie ? document.cookie.split('; ') : [];
        for (let c of cookies) {
            const [k,v] = c.split('=');
            if (decodeURIComponent(k) === name) return decodeURIComponent(v || '');
        }
    } catch(e) {}
    return null;
}

function storageSet(key, value) {
    const k = STORAGE_PREFIX + key;
    try { localStorage.setItem(k, String(value)); return; } catch(e) {}
    try { setCookie(k, String(value)); } catch(e) {}
}

function storageGet(key) {
    const k = STORAGE_PREFIX + key;
    try { const v = localStorage.getItem(k); if (v !== null) return v; } catch(e) {}
    try { const v = getCookie(k); if (v !== null) return v; } catch(e) {}
    return null;
}

function storageRemove(key) {
    const k = STORAGE_PREFIX + key;
    try { localStorage.removeItem(k); } catch(e) {}
    try { setCookie(k, '', -1); } catch(e) {}
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    // If a different file (by name, size or modified time) is selected, clear previous search index.
    // Do NOT clear uploaded media here so a single uploaded media folder can be reused across multiple JSON files.
    if (currentJsonFileName && (currentJsonFileName !== file.name || currentJsonFileSize !== file.size || currentJsonFileModified !== file.lastModified)) {
        try { __searchIndex = null; } catch(e){}
        try { if (searchInput) searchInput.value = ''; } catch(e){}
        try { if (searchResultsEl) searchResultsEl.innerHTML = ''; } catch(e){}
        try {
            if (searchProgress) {
                searchProgress.querySelector('.fill').style.width = '0%';
                searchProgress.querySelector('.progress-text').innerText = 'Idle';
                searchProgress.style.display = 'none';
            }
        } catch(e){}
    }

    currentJsonFileName = file.name;
    currentJsonFileSize = file.size;
    currentJsonFileModified = file.lastModified;

    const options = document.getElementsByClassName("options")[0];
    const loading = document.getElementById("loading");
    const chatContainer = document.getElementById("chat");

    options.style.display = "block";
    loading.innerHTML = "Loading...";
    loading.style.display = "flex";
    chatContainer.scrollTop = 0;
    chatContainer.innerHTML = "";

    const reader = new FileReader();
    reader.onload = (e) => processFileContent(e.target.result);
    reader.readAsText(file, 'utf-8');
}

function processFileContent(content) {
    try {
        let data;
        const trimmed = content.trim();
        const isHTML = trimmed.startsWith("<!DOCTYPE html>") || trimmed.startsWith("<html>") || currentJsonFileName.toLowerCase().endsWith(".html");

        if (isHTML) {
            data = parseHTMLContent(content);
        } else {
            const isThreadPathFormat = content.includes('"thread_path"');
            if (isThreadPathFormat) {
                const replaced = content.replace(/\\u00([a-f0-9]{2})|\\u([a-f0-9]{4})/gi, (match, p1, p2) => {
                    const code = p1 ? parseInt(p1, 16) : parseInt(p2, 16);
                    return String.fromCharCode(code);
                });
                const decoded = decodeURIComponent(escape(replaced));
                data = JSON.parse(decoded);
                data.messages = data.messages.reverse();
            } else {
                data = JSON.parse(content);
            }
        }
        setupChatInterface(data);
    } catch (error) {
        console.error(error);
        alert("Invalid file format! Please upload a valid Facebook Messenger JSON or HTML export.");
    }
}

function parseHTMLContent(htmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');
    
    const messages = [];
    const participants = new Set();
    
    let threadName = doc.querySelector('title')?.innerText || "HTML Conversation";
    if (threadName === "Facebook Messages") {
        const header = doc.querySelector('h1')?.innerText;
        if (header) threadName = header;
    }

    // Modern Facebook HTML export classes: ._a6-g is the message wrapper
    const messageElements = doc.querySelectorAll('._a6-g, ._3-96._2let, .message, .pam._3-95');
    
    // Fallback if the page structure is different (sometimes wrapped in role="main")
    const searchRoot = doc.querySelector('[role="main"]') || doc.body;
    const targets = messageElements.length > 0 ? messageElements : searchRoot.querySelectorAll('div > div > div');

    targets.forEach(el => {
        // Find sender: ._a6-h is the header/title in your file
        const senderNameEl = el.querySelector('._a6-h, ._3-96._2pio, .user, ._3-96._2let div div:first-child');
        const senderName = (senderNameEl?.innerText || "Unknown").trim();
        
        // Find timestamp: ._a72d inside ._a6-o is the footer in your file
        const timestampEl = el.querySelector('._a72d, ._3-94._2lem, .meta, ._3-94');
        const timestampStr = (timestampEl?.innerText || "").trim();
        let timestamp = Date.parse(timestampStr.replace(/ am$/i, ' AM').replace(/ pm$/i, ' PM')) || 0;

        // Find content: ._a6-p is the message body. 
        // We must avoid ._a6-h (sender) which also has ._2ph_
        const contentEl = el.querySelector('._a6-p, ._3-96._2let div:nth-child(2)');
        let text = "";
        
        if (contentEl) {
            const clone = contentEl.cloneNode(true);
            // Hide/remove known metadata classes to focus on the message text
            // _a6-i and _a6-j and ul usually contain reaction summaries in HTML exports
            clone.querySelectorAll('._a6-h, ._a6-i, ._a6-j, ._a6-o, ._3-94, .meta, .user, ul').forEach(m => m.remove());
            
            // Get text from the element
            text = clone.innerText.trim();
            
            // If the text is empty but contains nested divs (very common in FB exports),
            // drill down to find the actual content.
            if (!text) {
                // Find all leaf text nodes
                const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null, false);
                let node;
                while(node = walker.nextNode()) {
                    const t = node.textContent.trim();
                    if (t) {
                        text = t;
                        break; 
                    }
                }
            }
        }

        // Fallback: If no text was found via contentEl, try to find any text in the wrapper 
        // that isn't the sender or timestamp.
        if (!text) {
            const possibleContainers = el.querySelectorAll('div, span, p');
            for (const container of possibleContainers) {
                const t = container.innerText.trim();
                // Skip if it's the sender, timestamp, or a known wrapper
                if (t && t !== senderName && t !== timestampStr && !container.querySelector('._a6-h') && !container.classList.contains('_a6-g')) {
                    text = t;
                    break;
                }
            }
        }

        // Final polish: remove the "sent an attachment" if we have better media info
        // (but only if the user has media enabled/accessible)

        // Handle media
        const media = [];
        el.querySelectorAll('img, video, audio').forEach(item => {
            const src = item.getAttribute('src') || item.getAttribute('href');
            if (src && !src.includes('clear.png') && !src.startsWith('data:image/png')) {
                media.push({ uri: src });
            }
        });

        // Validation: Must have a sender and either text or media
        if (senderName !== "Unknown" && (text || media.length > 0)) {
            participants.add(senderName);
            messages.push({
                senderName,
                text,
                timestamp,
                media: media.length > 0 ? media : undefined
            });
        }
    });

    // Final fallback: If still no messages, search for anything with a date-like string
    if (messages.length === 0) {
        doc.querySelectorAll('._a6-g').forEach(el => {
            const sender = el.querySelector('._a6-h')?.innerText || "Unknown";
            const content = el.querySelector('._a6-p')?.innerText || "";
            const timeStr = el.querySelector('._a72d')?.innerText || "";
            if (sender !== "Unknown") {
                participants.add(sender);
                messages.push({
                    senderName: sender,
                    text: content,
                    timestamp: Date.parse(timeStr) || 0
                });
            }
        });
    }

    // Sort by timestamp (oldest first)
    messages.sort((a, b) => a.timestamp - b.timestamp);

    return {
        threadName,
        participants: Array.from(participants),
        messages: messages
    };
}

function setupChatInterface(data) {
    window.currentChatData = data;
    __searchIndex = null;

    const participants = data.participants.map(p => (typeof p === 'string' ? p : p.name));
    const threadName = data.threadName || data.title || data.threadPath || "Untitled";

    document.getElementById("threadName").innerText = threadName;
    
    // Calculate Stats
    const stats = calculateStats(data);
    updateStatsUI(stats);

    setupRadioButtons(participants);
    
    let selectedValue = (document.querySelector('input[name="choice"]:checked') || {}).value;
    setupCheckboxListeners();
    setupDisplayModeListeners();
    renderMessages(data, selectedValue);
}

function setupDisplayModeListeners() {
    const chatContainer = document.querySelector('.chat-container');
    const displayModes = document.querySelectorAll('input[name="displayMode"]');
    
    displayModes.forEach(input => {
        input.addEventListener('change', () => {
            if (input.checked) {
                chatContainer.classList.remove('phone-mode', 'tablet-mode', 'pc-mode');
                chatContainer.classList.add(`${input.value}-mode`);
                try { storageSet('selectedDisplayMode', input.value); } catch(e){}
            }
        });

        const saved = storageGet('selectedDisplayMode') || 'phone';
        if (input.value === saved) {
            input.checked = true;
            chatContainer.classList.remove('phone-mode', 'tablet-mode', 'pc-mode');
            chatContainer.classList.add(`${saved}-mode`);
        }
    });
}

function calculateStats(data) {
    const total = data.messages.length;
    const counts = {};
    const words = {};
    
    data.messages.forEach(m => {
        const sender = m.senderName || m.sender_name || "Unknown";
        counts[sender] = (counts[sender] || 0) + 1;
        
        const txt = m.text || m.content || "";
        const wordCount = txt.split(/\s+/).filter(w => w.length > 0).length;
        words[sender] = (words[sender] || 0) + wordCount;
    });

    const participants = Object.keys(counts).map(name => ({
        name,
        count: counts[name],
        percent: ((counts[name] / total) * 100).toFixed(1),
        avgWords: (words[name] / counts[name]).toFixed(1)
    }));

    return { total, participants };
}

function updateStatsUI(stats) {
    const container = document.getElementById("statsContainer");
    if (!container) return;
    
    container.style.display = "block";
    let html = `
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value">${stats.total}</div>
                <div class="stat-label">Total Messages</div>
            </div>
        </div>
        <div class="participant-stats">
            ${stats.participants.sort((a,b) => b.count - a.count).map(p => `
                <div class="p-stat-item">
                    <div class="p-stat-info">
                        <strong>${escapeHtml(p.name)}</strong>
                        <span>${p.count} msg (${p.percent}%)</span>
                    </div>
                    <div class="p-stat-bar">
                        <div class="p-stat-fill" style="width: ${p.percent}%"></div>
                    </div>
                    <div class="p-stat-meta">Average ${p.avgWords} words/msg</div>
                </div>
            `).join('')}
        </div>
    `;
    container.innerHTML = html;
}

function setupRadioButtons(participants) {
    const radioForm = document.getElementById("radioForm");
    radioForm.innerHTML = "";
    const saved = (storageGet('selectedPerspective') || null);
    participants.forEach((participant, index) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        
        input.type = "radio";
        input.name = "choice";
        input.id = `option${index + 1}`;
        input.value = participant;
        // restore saved selection if it matches, otherwise keep default on first
        if (saved && saved === participant) input.checked = true;
        else if (!saved && index === 0) input.checked = true;

        // when changed, persist and re-render using current chat data (if present)
        input.addEventListener('change', () => {
            try { storageSet('selectedPerspective', input.value); } catch(e){}
            if (window.currentChatData) renderMessages(window.currentChatData, input.value);
        });

        label.appendChild(input);
        label.appendChild(document.createTextNode(` ${participant}`));
        
        radioForm.appendChild(label);
    });
}

function setupCheckboxListeners() {
    const checkboxConfig = [
        { id: "showTime", class: ".timestamp" },
        { id: "showMyName", class: ".from-me .sender-name" },
        { id: "showTheirName", class: ".from-them .sender-name" },
        { id: "showReacts", class: ".reaction" }
    ];

    checkboxConfig.forEach(({ id, class: className }) => {
        const input = document.getElementById(id);
        if (!input) return;
        // restore saved state
        try {
            const saved = storageGet('ui_' + id);
            if (saved !== null) {
                input.checked = saved === '1';
            }
        } catch(e) {}

        // listener to apply and persist
        input.addEventListener("change", function() {
            const elements = document.querySelectorAll(className);
            elements.forEach(el => el.style.display = this.checked ? "block" : "none");
            try { storageSet('ui_' + id, this.checked ? '1' : '0'); } catch(e){}
        });

        // trigger change once to apply initial visibility
        input.dispatchEvent(new Event('change'));
    });
}

function renderMessages(data, selectedValue) {
    const chatContainer = document.getElementById("chat");
    const loading = document.getElementById("loading");
    
    chatContainer.style.display = "none";
    loading.innerHTML = "Loading messages...";
    loading.style.display = "flex";
    
    if (observer) {
        observer.disconnect();
    }
    
    renderedMessages.clear();
    chatContainer.innerHTML = "";
    
    if (!data.messages.length) {
        loading.innerHTML = "No messages";
        chatContainer.style.display = "block";
        return;
    }

    const messageChunks = chunkArray(data.messages, CHUNK_SIZE);
    
    messageChunks.forEach((chunk, index) => {
        const chunkContainer = document.createElement("div");
        chunkContainer.classList.add("message-chunk");
        chunkContainer.dataset.chunkIndex = index;
        chatContainer.appendChild(chunkContainer);
    });

    observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const chunkIndex = parseInt(entry.target.dataset.chunkIndex);
            if (entry.isIntersecting) {
                renderChunk(chunkIndex, messageChunks[chunkIndex], selectedValue);
            } else {
                // Clear content when out of view to save memory
                if (renderedMessages.has(chunkIndex)) {
                    // Save height before clearing to prevent jumping
                    entry.target.style.minHeight = entry.target.offsetHeight + "px";
                    entry.target.innerHTML = "";
                    renderedMessages.delete(chunkIndex);
                }
            }
        });
    }, {
        root: chatContainer,
        threshold: 0,
        rootMargin: "800px" // Load ahead
    });

    document.querySelectorAll(".message-chunk").forEach(chunk => {
        observer.observe(chunk);
    });

    setTimeout(() => {
        loading.style.display = "none";
        chatContainer.style.display = "block";
    }, 100);
}

// Media handling
let mediaFiles = {};
let mediaTypes = {};
const mediaFolderInput = document.getElementById("mediaFolder");

mediaFolderInput.addEventListener("change", function(event) {
    const files = event.target.files;
    if (!files.length) {
        return;
    }

    const chatContainer = document.getElementById("chat");
    const loading = document.getElementById("loading");
    chatContainer.style.display = "none";
    loading.innerHTML = "Processing media...";
    loading.style.display = "flex";

    processMediaFiles(files).then(() => {
        if (window.currentChatData) {
            renderMessages(window.currentChatData, 
                document.querySelector('input[name="choice"]:checked').value);
            loading.style.display = "none";
            chatContainer.style.display = "block";
        }
    });
});

async function processMediaFiles(files) {
    const BATCH_SIZE = 20;
    const fileArray = Array.from(files);
    
    resetMedia();
    
    for (let i = 0; i < fileArray.length; i += BATCH_SIZE) {
        const batch = fileArray.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(file => {
            return new Promise(resolve => {
                const fileURL = URL.createObjectURL(file);
                const relativePath = file.webkitRelativePath || file.name; // Preserve folder structure if available
                mediaFiles[relativePath] = fileURL;
                mediaTypes[relativePath] = getMediaType(file.name);
                resolve();
            });
        }));
    }
    console.log("Media files processed:", Object.keys(mediaFiles));
}

function resetMedia() {
    Object.values(mediaFiles).forEach(url => URL.revokeObjectURL(url));
    mediaFiles = {};
    mediaTypes = {};
}

function getMediaType(filename) {
    if (!filename || !filename.includes('.')) return "unknown";
    const extension = filename.split('.').pop().toLowerCase();
    if (["jpg", "jpeg", "png", "gif", "webp"].includes(extension)) return "image";
    if (["mp4", "webm", "ogg"].includes(extension)) return "video";
    if (["mp3", "wav", "aac", "ogg"].includes(extension)) return "audio";
    return "unknown";
}

// Highlight helpers: diacritic-insensitive matching by building a normalized mapping
function buildNormalizedMap(original) {
    const mapping = []; // mapping[normalizedPos] = originalIndex
    let normalized = '';
    for (let i = 0; i < original.length; i++) {
        const ch = original[i];
        const n = ch.normalize('NFD').replace(/\p{Diacritic}/gu, '');
        for (let k = 0; k < n.length; k++) {
            mapping.push(i);
            normalized += n[k];
        }
    }
    return { normalized: normalized.toLowerCase(), mapping };
}

function findRangesForToken(original, tokenNorm) {
    const { normalized, mapping } = buildNormalizedMap(original);
    const token = tokenNorm;
    const ranges = [];
    let start = 0;
    while (true) {
        const idx = normalized.indexOf(token, start);
        if (idx === -1) break;
        const origStart = mapping[idx];
        const origEnd = mapping[idx + token.length - 1] + 1; // exclusive
        ranges.push([origStart, origEnd]);
        start = idx + token.length;
    }
    return ranges;
}

function mergeRanges(ranges) {
    if (!ranges.length) return [];
    ranges.sort((a,b)=>a[0]-b[0]);
    const out = [ranges[0].slice()];
    for (let i = 1; i < ranges.length; i++) {
        const cur = ranges[i];
        const last = out[out.length-1];
        if (cur[0] <= last[1]) {
            last[1] = Math.max(last[1], cur[1]);
        } else out.push(cur.slice());
    }
    return out;
}

function highlightText(original, query) {
    if (!query || !original) return escapeHtml(original);
    const qNorm = normalizeForSearch(query);
    const tokens = qNorm.split(' ').filter(Boolean);
    if (!tokens.length) return escapeHtml(original);

    let allRanges = [];
    for (const t of tokens) {
        const ranges = findRangesForToken(original, t);
        allRanges = allRanges.concat(ranges);
    }
    if (!allRanges.length) return escapeHtml(original);
    const merged = mergeRanges(allRanges);
    // build HTML with <strong>
    let out = '';
    let lastIdx = 0;
    for (const [s,e] of merged) {
        out += escapeHtml(original.slice(lastIdx, s));
        out += '<strong>' + escapeHtml(original.slice(s, e)) + '</strong>';
        lastIdx = e;
    }
    out += escapeHtml(original.slice(lastIdx));
    return out;
}

function linkify(text) {
    // Improved regex to avoid capturing trailing emojis or punctuation
    const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    return text.replace(urlPattern, (url) => {
        // Strip trailing punctuation from URL that might have been part of the sentence
        const cleanUrl = url.replace(/[.,!?;:]+$/, "");
        return `<a href="${cleanUrl}" target="_blank" class="chat-link">${cleanUrl}</a>`;
    });
}

function createMessageHTML(msg, highlightQuery) {
    const sender = msg.senderName || msg.sender_name || "Unknown";
    const rawText = msg.text || msg.content || "";
    const text = highlightQuery ? highlightText(String(rawText), highlightQuery) : linkify(escapeHtml(String(rawText)));
    const timestamp = msg.timestamp || msg.timestamp_ms || 0;
    
    let mediaItems = [].concat(
        msg.media || [],
        msg.photos || [],
        msg.videos || [],
        msg.audio || [],
        msg.audio_files || [],
        msg.gifs || []
    );
    if (msg.files) mediaItems = mediaItems.concat(msg.files);

    const mediaHTML = mediaItems
        .filter(m => m.uri && m.uri.length > 20) // Filter out tiny identifiers like '2q==', but keep data URIs
        .map(media => {
            let cleanUri = "";
            try { cleanUri = decodeURIComponent(media.uri); } catch(e) { cleanUri = media.uri; }
            
            let fileURL = null;
            let mediaType = "unknown";

            if (cleanUri.startsWith('data:')) {
                fileURL = cleanUri;
                if (cleanUri.includes('image/')) mediaType = "image";
                else if (cleanUri.includes('video/')) mediaType = "video";
                else if (cleanUri.includes('audio/')) mediaType = "audio";
            } else {
                const fileName = cleanUri.split(/[\\\/]/).pop().toLowerCase().split('?')[0];
                let matchingFile = Object.keys(mediaFiles).find(f => f.toLowerCase().endsWith(fileName));
                
                if (!matchingFile && fileName.includes('_')) {
                    const id = fileName.split('_')[0];
                    if (id.length > 5) {
                        matchingFile = Object.keys(mediaFiles).find(f => f.toLowerCase().includes(id.toLowerCase()));
                    }
                }
                
                fileURL = matchingFile ? mediaFiles[matchingFile] : null;
                mediaType = getMediaType(fileName);
                if (matchingFile && mediaTypes[matchingFile] !== "unknown") mediaType = mediaTypes[matchingFile];
            }

            if (mediaType === "image" && fileURL) {
                return `<a href="${fileURL}" target="_blank" class="media-preview"><img src="${fileURL}" alt="Image" class="preview"></a>`;
            } else if (mediaType === "video" && fileURL) {
                return `<a href="${fileURL}" target="_blank" class="media-preview"><video controls class="preview-video"><source src="${fileURL}"></video></a>`;
            } else if (mediaType === "audio" && fileURL) {
                return `<div class="media-preview"><audio controls src="${fileURL}"></audio></div>`;
            }
            // If it's a data URI but we didn't show it, or a file not found
            if (!cleanUri.startsWith('data:')) {
                const fileName = cleanUri.split(/[\\\/]/).pop().toLowerCase().split('?')[0];
                return `<div class="media-missing">[ ${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)} not found: ${escapeHtml(fileName)} ]</div>`;
            }
            return "";
        }).join("");

    let reactionsHTML = "";
    if (msg.reactions && msg.reactions.length) {
        const counts = {};
        msg.reactions.forEach(r => { 
            // Only count if it's a single emoji or short string (usually what a reaction is)
            const react = (r.reaction || "").trim();
            if (react) counts[react] = (counts[react] || 0) + 1; 
        });
        const summary = Object.entries(counts).map(([emoji, count]) => `<span>${emoji}${count > 1 ? ` ${count}` : ''}</span>`).join("");
        if (summary) {
            reactionsHTML = `<div class="reaction" title="${escapeHtml(msg.reactions.map(r => `${r.actor}: ${r.reaction}`).join(", "))}">${summary}</div>`;
        }
    }

    return `
        <div class="sender-name">${escapeHtml(sender)}</div>
        <div class="message-content">
            <div class="text-wrapper">${text}</div>
            ${mediaHTML}
            ${reactionsHTML}
        </div>
        <div class="timestamp">${timestamp > 0 ? new Date(timestamp).toLocaleString() : ''}</div>
    `;
}

function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

window.addEventListener("beforeunload", () => {
    if (observer) observer.disconnect();
    Object.values(mediaFiles).forEach(url => URL.revokeObjectURL(url));
    renderedMessages.clear();
});

// ------------------ Search implementation ------------------
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const searchResultsEl = document.getElementById('searchResults');
const searchProgress = document.getElementById('searchProgress');

// hide results by default until an explicit search runs
if (searchResultsEl) searchResultsEl.style.display = 'none';

// Small utility: normalize strings (lowercase, remove diacritics, collapse whitespace)
function normalizeForSearch(str) {
    if (!str) return '';
    // Unicode normalize and remove diacritics
    const normalized = str.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    return normalized.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Build a lightweight search index when messages are loaded
function buildSearchIndex(messages) {
    // index: array of { text, normalized, sender, timestamp, idx }
    const idx = [];
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const parts = [];
        if (m.text) parts.push(typeof m.text === 'string' ? m.text : (m.content || ''));
        if (m.content) parts.push(m.content);
        if (m.senderName) parts.push(m.senderName);
        // include reactions summary
        if (m.reactions && m.reactions.length) parts.push(m.reactions.map(r => r.reaction + ' ' + (r.actor||'')).join(' '));
        // include media filenames
        const mediaItems = [].concat(m.media || [], m.photos || [], m.videos || [], m.audio || [], m.audio_files || [], m.gifs || []);
        mediaItems.forEach(mi => { if (mi && mi.uri) parts.push(mi.uri); });

        const text = parts.join(' ');
        idx.push({ text, normalized: normalizeForSearch(text), sender: m.senderName || m.sender_name || 'Unknown', timestamp: m.timestamp || m.timestamp_ms || 0, idx: i });
    }
    return idx;
}

// Simple fuzzy scoring: combination of substring match, token overlap, and Levenshtein distance on small strings
function fuzzyScore(query, target) {
    if (!query || !target) return 0;
    if (target.includes(query)) return 100 + Math.min(50, query.length); // strong boost for substring

    // token overlap
    const qTokens = query.split(' ');
    const tTokens = target.split(' ');
    let overlap = 0;
    for (const qt of qTokens) {
        for (const tt of tTokens) {
            if (tt.includes(qt) || qt.includes(tt)) { overlap += 1; break; }
        }
    }
    const tokenScore = overlap * 10;

    // small Levenshtein distance for short tokens (cheap implementation)
    function lev(a,b){
        const m=a.length,n=b.length; if(m*n===0) return m+n; const dp = Array(m+1).fill(0).map(()=>Array(n+1).fill(0));
        for(let i=0;i<=m;i++) dp[i][0]=i; for(let j=0;j<=n;j++) dp[0][j]=j;
        for(let i=1;i<=m;i++) for(let j=1;j<=n;j++) dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+1);
        return dp[m][n];
    }

    const shortQuery = query.length > 30 ? query.slice(0,30) : query;
    const dist = lev(shortQuery, target.slice(0, shortQuery.length+10));
    const distScore = Math.max(0, 30 - dist);

    return tokenScore + distScore;
}

// Asynchronous batched search to keep UI responsive and report progress
async function performSearch(query, index, onProgress) {
    const results = [];
    const normalizedQuery = normalizeForSearch(query);
    if (!normalizedQuery) return results;

    const BATCH = 500; // tuned for responsiveness
    for (let i = 0; i < index.length; i += BATCH) {
        const batch = index.slice(i, i + BATCH);
        for (const item of batch) {
            const score = fuzzyScore(normalizedQuery, item.normalized);
            if (score > 0) results.push({ score, item });
        }
        if (onProgress) onProgress(Math.min(100, Math.round(((i + BATCH) / index.length) * 100)));
        // yield to UI
        await new Promise(r => setTimeout(r, 0));
    }
    results.sort((a,b) => b.score - a.score);
    return results;
}

// Global search index
let __searchIndex = null;

// Hook up search actions
searchBtn?.addEventListener('click', startSearch);
searchInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') startSearch(); });
const clearSearchBtn = document.getElementById('clearSearchBtn');
clearSearchBtn?.addEventListener('click', clearSearch);

// Update highlights live when user edits the search box (but debounce)
let _highlightTimeout = null;
searchInput?.addEventListener('input', () => {
    clearTimeout(_highlightTimeout);
    _highlightTimeout = setTimeout(() => {
        const q = (searchInput.value || '').trim();
        if (!q) {
            if (searchResultsEl) searchResultsEl.style.display = 'none';
        } else {
            // Auto search if text is long enough or just update highlights
            if (q.length > 2) startSearch();
        }
        updateHighlightsAcrossDOM(q);
    }, 500);
});

async function startSearch() {
    const q = searchInput.value || '';
    if (!window.currentChatData || !window.currentChatData.messages) return;

    // build index lazily
    if (!__searchIndex) {
        searchProgress.style.display = 'flex';
        searchProgress.querySelector('.progress-text').innerText = 'Indexing...';
        await new Promise(r => setTimeout(r, 0));
        __searchIndex = buildSearchIndex(window.currentChatData.messages);
    }

    // perform search
    searchProgress.style.display = 'flex';
    searchProgress.querySelector('.fill').style.width = '0%';
    searchProgress.querySelector('.progress-text').innerText = 'Searching...';
    searchResultsEl.innerHTML = '';
    if (searchResultsEl) searchResultsEl.style.display = 'block';

    const results = await performSearch(q, __searchIndex, (p) => {
        searchProgress.querySelector('.fill').style.width = p + '%';
        searchProgress.querySelector('.progress-text').innerText = `Searching ${p}%`;
    });

    // done
    searchProgress.querySelector('.fill').style.width = '100%';
    searchProgress.querySelector('.progress-text').innerText = `Found ${results.length} matches`;
    setTimeout(()=>{ searchProgress.style.display = 'none'; }, 800);

    // show top results
    if (!results.length) {
        searchResultsEl.innerHTML = '<div class="search-result-item">No results</div>';
        return;
    }

    const maxResults = Math.min(50, results.length);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < maxResults; i++) {
        const r = results[i];
        const el = document.createElement('div');
        el.className = 'search-result-item';
        el.dataset.idx = r.item.idx;
        const time = new Date(r.item.timestamp).toLocaleString();
        // Use the original message text/content for snippet (avoid sender/reactions that were added to the index)
        const originalMsg = (window.currentChatData && window.currentChatData.messages && window.currentChatData.messages[r.item.idx]) || null;
        const rawText = originalMsg ? (originalMsg.text || originalMsg.content || '') : (r.item.text || '');
        const rawSnippet = String(rawText).slice(0, 240);
        const highlightedSnippet = highlightText(rawSnippet, q);
    el.innerHTML = `<div class="snippet">${highlightedSnippet}</div><div class="meta">${escapeHtml(r.item.sender)} • ${time}</div>`;
        el.addEventListener('click', () => jumpToMessage(r.item.idx));
        frag.appendChild(el);
    }
    searchResultsEl.appendChild(frag);

    // Also update currently rendered chunks to show highlights for the active query
    updateHighlightsAcrossDOM(q);
}

function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;" })[c]); }

// Jump to message index: ensure its chunk is rendered, scroll into view and highlight transiently
async function jumpToMessage(messageIndex) {
    const chatContainer = document.getElementById('chat');
    // compute which chunk
    const chunkIndex = Math.floor(messageIndex / CHUNK_SIZE);

    // render that chunk synchronously if not yet rendered
    const chunkContainer = document.querySelector(`.message-chunk[data-chunk-index="${chunkIndex}"]`);
    if (chunkContainer && !renderedMessages.has(chunkIndex)) {
        // find data.messages slice
        const start = chunkIndex * CHUNK_SIZE;
        const msgs = window.currentChatData.messages.slice(start, start + CHUNK_SIZE);
        renderChunk(chunkIndex, msgs, document.querySelector('input[name="choice"]:checked').value);
    }

    // small timeout to allow DOM update
    await new Promise(r => setTimeout(r, 20));

    // select the message element within the chunk
    // messages are appended in order; find the Nth message within earlier chunks
    let cumulative = 0;
    for (let i = 0; i <= chunkIndex; i++) {
        const c = document.querySelector(`.message-chunk[data-chunk-index="${i}"]`);
        if (!c) continue;
        const count = c.querySelectorAll('.message').length;
        cumulative += count;
    }

    // Find the global message element by data attribute: we'll mark message elements with data-msg-index when rendering
    const msgEl = document.querySelector(`.message[data-msg-index="${messageIndex}"]`);
    if (!msgEl) {
        // try to search inside chunk by approximate position
        const chunk = document.querySelector(`.message-chunk[data-chunk-index="${chunkIndex}"]`);
        if (chunk) {
            const children = Array.from(chunk.querySelectorAll('.message'));
            const localIdx = messageIndex - chunkIndex * CHUNK_SIZE;
            const candidate = children[localIdx] || children[Math.max(0, localIdx-1)];
            if (candidate) {
                await scrollAndHighlight(candidate);
                return;
            }
        }
        return;
    }
    await scrollAndHighlight(msgEl);
}

function clearSearch() {
    if (searchInput) searchInput.value = '';
    searchResultsEl.innerHTML = '';
    if (searchResultsEl) searchResultsEl.style.display = 'none';
    if (searchProgress) {
        searchProgress.querySelector('.fill').style.width = '0%';
        searchProgress.querySelector('.progress-text').innerText = 'Idle';
        searchProgress.style.display = 'none';
    }
    updateHighlightsAcrossDOM('');
}

// Re-render highlights inside already-rendered message DOM nodes without reconstructing everything
function updateHighlightsAcrossDOM(query) {
    // For each rendered .message, find its text node(s) inside .message-content and replace innerHTML accordingly
    const msgEls = document.querySelectorAll('.message');
    const q = query || '';
    msgEls.forEach(el => {
        // find original text: try to reconstruct from dataset or fallback to current textContent
        // We didn't store raw text per element, so safely re-extract from the current DOM but first strip existing <strong>
        const contentEl = el.querySelector('.message-content');
        if (!contentEl) return;
        // Build a plain-text by cloning and removing strong tags
        const clone = contentEl.cloneNode(true);
    // remove media previews and reactions/timestamp to preserve them
    // note: do NOT remove <video> separately because videos are wrapped in .media-preview anchors;
    // removing both the anchor and video then re-inserting both causes duplication.
    const mediaEls = clone.querySelectorAll('.media-preview, audio, .preview, .reaction, .timestamp');
        mediaEls.forEach(n => n.remove());
        // remove strong tags
        const strongs = clone.querySelectorAll('strong');
        strongs.forEach(s => {
            const txt = document.createTextNode(s.textContent);
            s.parentNode.replaceChild(txt, s);
        });
        const plain = clone.textContent || '';
        // Highlight plain text
        const newHTML = highlightText(plain, q);
        // Rebuild content area: keep media/reactions/timestamp from original content
        // Get original extras
        const originalContent = contentEl;
        const extras = [];
        // Collect only top-level media containers (exclude inner .preview img to avoid duplication)
        const seen = new Set();
        // collect only top-level media containers (anchors .media-preview) and audio/reaction/timestamp
        originalContent.querySelectorAll('.media-preview, audio, .reaction, .timestamp').forEach(n => {
            const html = n.outerHTML;
            if (!seen.has(html)) {
                seen.add(html);
                extras.push(html);
            }
        });
        // Set new HTML
        originalContent.innerHTML = newHTML + extras.join('');
    });
}

function scrollIntoViewWithPadding(container, element, padding = 60) {
    const containerRect = container.getBoundingClientRect();
    const elRect = element.getBoundingClientRect();
    const offset = (elRect.top - containerRect.top) - padding;
    container.scrollTop += offset;
}

async function scrollAndHighlight(el) {
    const chatContainer = document.getElementById('chat');
    // ensure surrounding messages visible: scroll so that target is centered
    scrollIntoViewWithPadding(chatContainer, el, 120);

    // add highlight classes
    el.classList.add('highlight-target');
    el.classList.add('temporary-highlight');
    // remove temporary after animation
    setTimeout(() => { el.classList.remove('temporary-highlight'); }, 2200);
    // ensure still visible
    await new Promise(r => setTimeout(r, 300));
}

// Mark messages with data-msg-index during renderChunk
const originalRenderChunk = renderChunk;
function renderChunk(chunkIndex, messages, selectedValue) {
    // delegate to original but we need to set data-msg-index on each message element
    const chunkContainer = document.querySelector(`.message-chunk[data-chunk-index="${chunkIndex}"]`);
    if (!chunkContainer || renderedMessages.has(chunkIndex)) return;

    const highlightQuery = (searchInput && searchInput.value) ? searchInput.value : '';
    messages.forEach((msg, localIdx) => {
        const globalIdx = chunkIndex * CHUNK_SIZE + localIdx;
        const div = document.createElement("div");
        const sender = msg.senderName || msg.sender_name || "Unknown";
        div.classList.add("message", sender === selectedValue ? "from-me" : "from-them");
        div.dataset.msgIndex = globalIdx;
        // attach raw message object for reliable re-rendering later
        try { div.__rawMessage = msg; } catch(e) { /* ignore */ }
        div.innerHTML = createMessageHTML(msg, highlightQuery);
        chunkContainer.appendChild(div);
    });

    renderedMessages.set(chunkIndex, true);
    ["showTime", "showMyName", "showTheirName", "showReacts"].forEach(id => {
        document.getElementById(id).dispatchEvent(new Event("change"));
    });
}

// Replace previous declaration by ensuring we don't double-define if hot-reloaded
try { window.__hasSearchPatch = true; } catch(e){}

// ------------------ Help tooltip & modal ------------------
const helpTexts = {
    perspective: {
        title: 'Perspective',
        short: 'Choose which participant the interface will display from.',
        long: `Choose a participant to view the conversation from their perspective. When selected, that person's messages will be marked "from-me" and other messages will be "from-them". This is useful for reading a conversation as if you were one of the participants.`
    },
    customization: {
        title: 'Display Customization',
        short: 'Toggle names, timestamps, and reactions.',
        long: `Use these checkboxes to control the display of sender names, timestamps, and reactions. "Show my name" displays your name from the selected perspective; "Show their name" displays others' names. "Show timestamps" and "Show reactions" toggle the display of time and reaction summaries respectively.`
    },
    download: {
        title: 'Download Messenger Data',
        short: 'How to export JSON or HTML files from Facebook to open with this tool.',
        long: `To export your conversation, visit the "Download Your Information" page on Facebook and select "Messages" from the data sections. You can choose either JSON or HTML format. Once Facebook processes your request, you'll receive a ZIP file. Extract it and select the relevant file to open in this application. For end-to-end encrypted chats, follow the specific export instructions in the Messenger app.`
    }
};

const helpModal = document.getElementById('helpModal');
const helpBody = document.getElementById('helpBody');
const helpTitle = document.getElementById('helpTitle');
const helpClose = document.getElementById('helpClose');

function showHelpModal(key) {
    const info = helpTexts[key] || { title: 'Help', long: 'No help available.' };
    helpTitle.innerText = info.title;
    // Build a clearer modal body with a short summary and detailed paragraph
    const short = info.short ? `<p style="font-weight:600;margin-bottom:8px;">${escapeHtml(info.short)}</p>` : '';
    const long = info.long ? `<p>${escapeHtml(info.long)}</p>` : '';
    helpBody.innerHTML = short + long + `<div class="help-actions"><button class="secondary" onclick="closeHelpModal()">Close</button></div>`;
    if (helpModal) helpModal.setAttribute('aria-hidden', 'false');
}

function closeHelpModal() {
    if (helpModal) helpModal.setAttribute('aria-hidden', 'true');
}

helpClose?.addEventListener('click', closeHelpModal);
helpModal?.addEventListener('click', (e) => { if (e.target === helpModal) closeHelpModal(); });

// Tooltip behavior: show on hover, and on long-press for touch devices
let tooltipEl = null;
let longPressTimer = null;

function createTooltip(text) {
    if (tooltipEl) tooltipEl.remove();
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'help-tooltip';
    tooltipEl.innerText = text;
    document.body.appendChild(tooltipEl);
}

function positionTooltip(target) {
    if (!tooltipEl) return;
    const rect = target.getBoundingClientRect();
    tooltipEl.style.top = (rect.bottom + window.scrollY + 8) + 'px';
    tooltipEl.style.left = (rect.left + window.scrollX) + 'px';
}

document.querySelectorAll('.help-btn').forEach(btn => {
    const key = btn.dataset.help;
    const info = helpTexts[key];
    if (!info) return;

    btn.addEventListener('mouseenter', (e) => {
        createTooltip(info.short);
        positionTooltip(btn);
    });
    btn.addEventListener('mouseleave', () => { if (tooltipEl) tooltipEl.remove(); tooltipEl = null; clearTimeout(longPressTimer); });

    // touch/long-press support
    btn.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => { createTooltip(info.short); positionTooltip(btn); }, 600);
    }, { passive: true });
    btn.addEventListener('touchend', (e) => { clearTimeout(longPressTimer); if (tooltipEl) tooltipEl.remove(); tooltipEl = null; });

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        showHelpModal(key);
    });
});

// --- Global settings button and dark mode ---
const globalSettingsBtn = document.getElementById('globalSettingsBtn');
const globalSettingsMenu = document.getElementById('globalSettingsMenu');
const darkModeToggle = document.getElementById('darkModeToggle');

function setDarkMode(enabled, persist = true) {
    if (enabled) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    if (persist) storageSet('darkMode', enabled ? '1' : '0');
    if (darkModeToggle) darkModeToggle.checked = !!enabled;
}

globalSettingsBtn?.addEventListener('click', (e) => {
    const isOpen = globalSettingsMenu && globalSettingsMenu.getAttribute('aria-hidden') === 'false';
    if (globalSettingsMenu) globalSettingsMenu.setAttribute('aria-hidden', isOpen ? 'true' : 'false');
    if (globalSettingsBtn) globalSettingsBtn.classList.toggle('open', !isOpen);
    if (!isOpen) { globalSettingsBtn.setAttribute('aria-expanded', 'true'); }
    else { globalSettingsBtn.setAttribute('aria-expanded', 'false'); }
});

// dark mode toggle
darkModeToggle?.addEventListener('change', (e) => { setDarkMode(e.target.checked, true); });

// initialize from localStorage
try {
    const pref = storageGet('darkMode');
    if (pref === '1') setDarkMode(true, false);
} catch(e) {}

// ------------------ Trust / Privacy modal logic ------------------
const trustModal = document.getElementById('trustModal');
const trustClose = document.getElementById('trustClose');
const trustCloseAlt = document.getElementById('trustCloseAlt');
const dontShowAgain = document.getElementById('dontShowAgain');
const trustBackdrop = document.querySelector('.trust-backdrop');

function showTrustModalIfNeeded() {
    try {
    const skip = storageGet('dontShowTrustModal');
        if (skip === '1') return;
    } catch(e) {}
    if (!trustModal) return;
    trustModal.setAttribute('aria-hidden', 'false');
    // focus the primary button for keyboard users
    setTimeout(() => { try { trustClose.focus(); } catch(e){} }, 60);
}

function closeTrustModal() {
    if (!trustModal) return;
    if (dontShowAgain && dontShowAgain.checked) {
    try { storageSet('dontShowTrustModal', '1'); } catch(e){}
    }
    trustModal.setAttribute('aria-hidden', 'true');
}

trustClose?.addEventListener('click', closeTrustModal);
trustCloseAlt?.addEventListener('click', closeTrustModal);
trustBackdrop?.addEventListener('click', closeTrustModal);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && trustModal && trustModal.getAttribute('aria-hidden') === 'false') {
        closeTrustModal();
    }
});

// Run on load
try { showTrustModalIfNeeded(); } catch(e) {}
setupDisplayModeListeners();
