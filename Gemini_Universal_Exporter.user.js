// ==UserScript==
// @name         Gemini Universal Exporter (Full History, JSON + Markdown + ZIP)
// @namespace    local.gemini.universal.exporter
// @version      0.4.3
// @description  Gemini history exporter: MaZiqc/hNvQHb RPC + Gem-route-aware resume + live-node Canvas opening + Ophel/Voyager extraction.
// @author       local adaptation
// @match        https://gemini.google.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// @run-at       document-start
// @license      MIT
// ==/UserScript==

/*
 * Gemini Universal Exporter v0.4.3
 *
 * Design sources / inspirations (MIT):
 * - ChatGPT Universal Exporter (Markdown Support, Selective + Retry Failed):
 *   ZIP + JSON/MD pairing + retry/backoff + failure manifest patterns.
 * - Gemini Chat Markdown Exporter (Thoughts Included) by NoahTheGinger:
 *   same-origin Gemini batchexecute RPC, anti-CSRF token discovery, and
 *   payload/message-shape extraction ideas.
 * - gemini-chat-exporter by David Malko:
 *   full-history sidebar harvesting and "fail loudly / don't silently trust stale data"
 *   reliability ideas.
 *
 * IMPORTANT:
 * Gemini's internal RPC and DOM are undocumented and can change. This script is
 * deliberately conservative: one detail request at a time, jitter between calls,
 * long cooldowns, HTTP 429 Retry-After handling, and explicit failure manifests.
 *
 * v0.3.2 adds the interaction model from the user's ChatGPT exporter:
 * first fetch only the conversation list, then choose ONE conversation for a
 * low-risk test export or choose full-history export. Single and full modes use
 * the exact same hNvQHb + Canvas recovery pipeline, so a single-conversation
 * Canvas test is representative of the full export without hammering the account.

 * v0.4.3 Canvas opening hardening:
 * - Keeps the v0.4.2 discovery/lazy-history/extraction path unchanged.
 * - Reacquires live Canvas nodes after scrolling to avoid virtual-DOM stale references.
 * - Uses Ophel-style native HTMLElement.click() first; synthesized events are fallback only.
 * - Targets exact Open/View/Edit leaf text inside immersive-entry-chip before the chip host.
 * - Separates no-panel vs wrong-panel-title diagnostics and waits for panel content readiness.
 * - Verifies panel closure before attempting the next Canvas.
 * - Avoids duplicate .md.md / .py.py style output names.
 *
 * v0.4.1 route-resume fix:
 * - Gemini can redirect /app/<conversationId> to /gem/<gemId>/<conversationId>.
 * - Route identity is therefore validated by conversationId, not pathname equality.
 * - The resolved Gem route is preserved in exported metadata while the originally
 *   requested /app URL is retained for diagnostics.
 *
 * v0.4.0 Canvas architecture is based on current 2026 Gemini implementations:
 * - Ophel: identify [data-test-id="gem-processing-card"], validate article/code_blocks
 *   icons, click the card then its immersive-entry-chip fallback, verify panel title.
 * - Gemini Voyager: Document Canvas -> immersive-editor .ProseMirror; Code/App Canvas
 *   -> code-immersive-panel / Monaco .view-lines .view-line.
 * Single mode keeps ID-direct navigation + sessionStorage resume to avoid sidebar churn.
 */

(function () {
    'use strict';

    // --------------------------- Configuration ---------------------------
    const CONFIG = {
        // Normal pacing. Deliberately slower than the ChatGPT source script.
        DETAIL_DELAY_MIN: 2500,
        DETAIL_DELAY_MAX: 5500,
        LIST_SCROLL_DELAY_MIN: 650,
        LIST_SCROLL_DELAY_MAX: 1100,

        // Backoff / retries.
        MAX_RETRIES: 6,
        RATE_LIMIT_FALLBACK_MS: 120000, // 2 min when 429 has no Retry-After.
        SERVER_ERROR_BASE_MS: 12000,
        SERVER_ERROR_MAX_MS: 180000,

        // Periodic cooling for large histories.
        LONG_COOLDOWN_EVERY: 40,
        LONG_COOLDOWN_MIN_MS: 45000,
        LONG_COOLDOWN_MAX_MS: 90000,

        // Sidebar harvesting.
        LIST_STABLE_ROUNDS: 6,
        LIST_MAX_SCROLL_ROUNDS: 500,

        // Gemini detail RPC. Current as of the referenced exporter (2026).
        LIST_RPC_ID: 'MaZiqc',
        LIST_PAGE_SIZE: 20,
        LIST_MAX_PAGES: 200,
        LIST_FLAG_VARIANTS: [0, 1],
        DETAIL_RPC_ID: 'hNvQHb',
        DETAIL_PAGE_SIZE: 20,
        DETAIL_MAX_PAGES: 200,
        RPC_TIMEOUT_MS: 30000,

        // Raw RPC payloads can be much larger than the readable transcript.
        // Leave off by default for heavy accounts to reduce browser RAM/ZIP size.
        INCLUDE_RAW_PAYLOADS: false,

        // Canvas / artifact backup. The full-export path extracts structured
        // Canvas blocks from hNvQHb candidate ai_data[30]. Legacy DOM helpers are
        // retained only as dormant diagnostics/compatibility code.
        INCLUDE_CANVAS: true,
        CANVAS_SCAN_ALL_CONVERSATIONS: false,
        // v0.3.1: only conversations whose RPC turns expose Canvas markers but
        // no complete structured Canvas are opened in the UI for recovery.
        CANVAS_DOM_FALLBACK_FOR_SUSPECTS: true,
        CANVAS_NAV_TIMEOUT_MS: 12000,
        CANVAS_RENDER_SETTLE_MS: 900,
        CANVAS_SCROLL_DELAY_MS: 450,
        CANVAS_PANEL_TIMEOUT_MS: 4500,
        CANVAS_PANEL_TITLE_TIMEOUT_MS: 3500,
        CANVAS_MAX_SCROLL_STEPS: 220,
        CANVAS_BOTTOM_STABLE_ROUNDS: 3,
        CANVAS_HISTORY_PRELOAD_WAIT_MS: 700,
        CANVAS_HISTORY_PRELOAD_MAX_ROUNDS: 24,
        CANVAS_HISTORY_PRELOAD_STABLE_ROUNDS: 3,
        CANVAS_HISTORY_PRELOAD_WHEEL_DELTA_Y: -800,
        CANVAS_DIAGNOSTIC_SAMPLE_LIMIT: 16,
        CANVAS_NATIVE_CLICK_WAIT_MS: 2800,
        CANVAS_FALLBACK_CLICK_WAIT_MS: 1600,
        CANVAS_CONTENT_READY_TIMEOUT_MS: 3500,
        CANVAS_CLOSE_TIMEOUT_MS: 2500,

        // UI.
        BUTTON_ID: 'gemini-universal-exporter-btn',
        PANEL_ID: 'gemini-universal-exporter-panel',
        SINGLE_CANVAS_RESUME_KEY: 'gue:v0.4.3:single-canvas-resume',
        SINGLE_CANVAS_RESUME_TTL_MS: 30 * 60 * 1000,
    };

    // ------------------------------ State -------------------------------
    let running = false;
    let cancelled = false;
    const metaById = new Map();

    // ------------------------------ Helpers -----------------------------
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const randomBetween = (min, max) => min + Math.random() * (max - min);
    const listJitter = () => randomBetween(CONFIG.LIST_SCROLL_DELAY_MIN, CONFIG.LIST_SCROLL_DELAY_MAX);
    const detailJitter = () => randomBetween(CONFIG.DETAIL_DELAY_MIN, CONFIG.DETAIL_DELAY_MAX);

    function writeSingleCanvasResumeTask(task) {
        try { sessionStorage.setItem(CONFIG.SINGLE_CANVAS_RESUME_KEY, JSON.stringify({ schema: 1, created_at_ms: Date.now(), ...task })); return true; }
        catch (e) { console.error('[Gemini Universal Exporter] cannot persist single Canvas resume task', e); return false; }
    }
    function readSingleCanvasResumeTask() {
        try {
            const raw = sessionStorage.getItem(CONFIG.SINGLE_CANVAS_RESUME_KEY);
            if (!raw) return null;
            const task = JSON.parse(raw);
            if (!task || !task.item || !task.item.chatId) return null;
            if (!task.created_at_ms || Date.now() - task.created_at_ms > CONFIG.SINGLE_CANVAS_RESUME_TTL_MS) { sessionStorage.removeItem(CONFIG.SINGLE_CANVAS_RESUME_KEY); return null; }
            return task;
        } catch (e) { console.warn('[Gemini Universal Exporter] invalid single Canvas resume task', e); try { sessionStorage.removeItem(CONFIG.SINGLE_CANVAS_RESUME_KEY); } catch (_) {} return null; }
    }
    function clearSingleCanvasResumeTask() { try { sessionStorage.removeItem(CONFIG.SINGLE_CANVAS_RESUME_KEY); } catch (_) {} }
    function directNavigateToConversation(item, setStatus = () => {}) {
        // Always navigate to the originally requested route. Gemini is allowed
        // to redirect it to a /gem/<gemId>/<conversationId> route.
        const target = buildRequestedConversationUrl(item);
        setStatus(`🧭 直达 Canvas 对话 · ${item.title}`);
        console.info('[Gemini Universal Exporter] direct navigation for single Canvas resume', {
            title: item.title,
            chatId: item.chatId,
            requestedUrl: target,
        });
        location.assign(target);
    }

    function sanitizeFilename(name) {
        const s = String(name || 'Untitled Conversation')
            .replace(/[\/\\?%*:|"<>]/g, '-')
            .replace(/[\u0000-\u001f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160);
        return s || 'Untitled Conversation';
    }

    function escapeMdInline(text) {
        return String(text || '').replace(/\r\n?/g, '\n');
    }

    function downloadFile(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    async function sha256Hex(text) {
        try {
            const bytes = new TextEncoder().encode(text);
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (_) {
            // Fallback non-cryptographic signature for older browsers.
            let h = 2166136261;
            const s = String(text || '');
            for (let i = 0; i < s.length; i++) {
                h ^= s.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
            return `fnv1a-${(h >>> 0).toString(16)}`;
        }
    }

    function parseRetryAfterMs(headers) {
        const value = headers?.get?.('Retry-After');
        if (!value) return null;
        const seconds = Number(value);
        if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
        const dateMs = Date.parse(value);
        if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
        return null;
    }

    function isCancelled() {
        if (cancelled) throw new Error('用户已取消导出');
    }

    // ------------------------- Gemini page state -------------------------
    function currentAccountPrefix() {
        const m = location.pathname.match(/^\/u\/(\d+)(?:\/|$)/);
        return m ? `/u/${m[1]}` : '';
    }

    function getLang() {
        return document.documentElement.lang || 'zh-CN';
    }

    function getAtToken() {
        const input = document.querySelector('input[name="at"]');
        if (input?.value) return input.value;

        try {
            if (window.WIZ_global_data?.SNlM0e) return window.WIZ_global_data.SNlM0e;
        } catch (_) {}

        // Avoid scanning huge DOM repeatedly unless needed.
        const html = document.documentElement.innerHTML;
        const m = html.match(/"SNlM0e":"([^"]+)"/);
        return m ? m[1] : null;
    }

    function normalizePath(path) {
        if (!path) return null;
        try {
            const u = new URL(path, location.origin);
            return u.pathname;
        } catch (_) {
            return String(path).split(/[?#]/)[0];
        }
    }

    function parseConversationHref(href) {
        const path = normalizePath(href);
        if (!path) return null;

        const app = path.match(/(?:^|\/)app\/([^/?#]+)/);
        if (app) {
            const userPrefixMatch = path.match(/^\/u\/(\d+)/);
            const basePrefix = userPrefixMatch ? `/u/${userPrefixMatch[1]}` : currentAccountPrefix();
            const sourcePath = `${basePrefix}/app/${app[1]}`;
            return { id: app[1], chatId: app[1], kind: 'app', sourcePath, basePrefix };
        }

        const gem = path.match(/(?:^|\/)gem\/([^/?#]+)\/([^/?#]+)/);
        if (gem) {
            const userPrefixMatch = path.match(/^\/u\/(\d+)/);
            const basePrefix = userPrefixMatch ? `/u/${userPrefixMatch[1]}` : currentAccountPrefix();
            const sourcePath = `${basePrefix}/gem/${gem[1]}/${gem[2]}`;
            return {
                id: `gem_${gem[1]}_${gem[2]}`,
                chatId: gem[2],
                gemId: gem[1],
                kind: 'gem',
                sourcePath,
                basePrefix,
            };
        }

        return null;
    }

    function normalizeConversationId(value) {
        return String(value || '').replace(/^c_/, '').trim();
    }

    function buildRequestedConversationUrl(item) {
        if (item?.requestedUrl) return item.requestedUrl;
        const path = item?.requestedSourcePath || item?.sourcePath || '';
        return `${location.origin}${path}`;
    }

    function buildConversationUrl(item) {
        if (item?.resolvedUrl) return item.resolvedUrl;
        return `${location.origin}${item.sourcePath}`;
    }

    function resolveCurrentConversationItem(item, pathLike = location.pathname) {
        const currentRoute = parseConversationHref(pathLike);
        const wantedId = normalizeConversationId(item?.chatId);
        if (!currentRoute || !wantedId || normalizeConversationId(currentRoute.chatId) !== wantedId) {
            return null;
        }

        const requestedSourcePath = item.requestedSourcePath || item.sourcePath;
        const requestedUrl = item.requestedUrl || `${location.origin}${requestedSourcePath}`;
        const resolvedSourcePath = currentRoute.sourcePath;
        const resolvedUrl = `${location.origin}${resolvedSourcePath}`;

        return {
            ...item,
            // Keep the MaZiqc identity/id stable; only enrich the route metadata.
            kind: currentRoute.kind,
            gemId: currentRoute.gemId || null,
            basePrefix: currentRoute.basePrefix,
            requestedKind: item.requestedKind || item.kind || 'app',
            requestedSourcePath,
            requestedUrl,
            sourcePath: resolvedSourcePath,
            resolvedSourcePath,
            resolvedUrl,
            routeRedirected: normalizePath(requestedSourcePath) !== normalizePath(resolvedSourcePath),
        };
    }

    function getBatchUrl(item) {
        return `${item.basePrefix || ''}/_/BardChatUi/data/batchexecute`;
    }


    // -------------------- Hardened RPC history transport -----------------
    // v0.3 makes Gemini's own read RPCs the primary data source for BOTH the
    // history list and conversation bodies. Sidebar DOM is no longer required
    // for full-history discovery. This mirrors mature 2026 implementations:
    // MaZiqc = conversation list; hNvQHb = paginated conversation detail.

    const exportFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
    let observedReqId = 0;

    function noteObservedReqId(urlLike) {
        try {
            const url = new URL(String(urlLike || ''), location.origin);
            if (!url.pathname.includes('/batchexecute')) return;
            const n = Number(url.searchParams.get('_reqid'));
            if (Number.isFinite(n) && n > observedReqId) observedReqId = n;
        } catch (_) {}
    }

    // Observe the app's own request sequence from document-start. We do NOT
    // capture message bodies or tokens here; this is only used to continue the
    // app's monotonic _reqid sequence instead of guessing when possible.
    (function installReqIdObserver() {
        try {
            const XHR = window.XMLHttpRequest;
            if (XHR?.prototype?.open) {
                const rawOpen = XHR.prototype.open;
                XHR.prototype.open = function(method, url) {
                    noteObservedReqId(url);
                    return rawOpen.apply(this, arguments);
                };
            }
        } catch (_) {}
        try {
            if (typeof window.fetch === 'function') {
                const prevFetch = window.fetch;
                window.fetch = function(input, init) {
                    try {
                        const url = typeof input === 'string' ? input : input?.url || input?.href;
                        noteObservedReqId(url);
                    } catch (_) {}
                    return prevFetch.apply(this, arguments);
                };
            }
        } catch (_) {}
    })();

    function refreshObservedReqIdFromPerformance() {
        try {
            const entries = performance?.getEntriesByType?.('resource') || [];
            for (const entry of entries) noteObservedReqId(entry?.name);
        } catch (_) {}
    }

    function nextReqId() {
        refreshObservedReqIdFromPerformance();
        if (!observedReqId) observedReqId = 100000 + Math.floor(Math.random() * 8) * 100000;
        observedReqId += 100000;
        return observedReqId;
    }

    function decodeEscapedJsonString(raw) {
        if (raw == null) return null;
        try { return JSON.parse(`"${raw}"`); }
        catch (_) { return String(raw); }
    }

    function matchHtmlToken(html, key) {
        const re = new RegExp(`"${key}":"((?:\\\\.|[^"\\\\])*)"`);
        const m = re.exec(String(html || ''));
        return m ? decodeEscapedJsonString(m[1]) : null;
    }

    function extractSessionFromHtml(html, accountPrefix = currentAccountPrefix()) {
        // Prefer the freshly fetched /app HTML. On multi-account URLs the
        // current page's WIZ_global_data can momentarily belong to an older
        // route/account while the fetched HTML already reflects the final /u/N.
        let at = matchHtmlToken(html, 'SNlM0e');
        let bl = matchHtmlToken(html, 'cfb2h');
        let sid = matchHtmlToken(html, 'FdrFJe');
        try {
            at = at || window.WIZ_global_data?.SNlM0e || null;
            bl = bl || window.WIZ_global_data?.cfb2h || null;
            sid = sid || window.WIZ_global_data?.FdrFJe || null;
        } catch (_) {}
        return { at, bl, sid, accountPrefix: accountPrefix || '' };
    }

    async function getFreshGeminiSession(setStatus = () => {}) {
        if (!exportFetch) throw new Error('浏览器 fetch 不可用。');
        const requestedPrefix = currentAccountPrefix();
        const url = `${location.origin}${requestedPrefix}/app`;
        setStatus('🔐 读取当前 Gemini 会话参数…');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CONFIG.RPC_TIMEOUT_MS);
        let res;
        try {
            res = await exportFetch(url, {
                method: 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal,
                headers: { 'accept': 'text/html,application/xhtml+xml' },
            });
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) throw new Error(`读取 Gemini 会话页失败 HTTP ${res.status}`);
        if (/accounts\.google\.com/i.test(res.url || '')) throw new Error('Gemini 登录态无效：请求被重定向到 Google 登录页。');
        const html = await res.text();
        const finalPath = (() => { try { return new URL(res.url).pathname; } catch (_) { return ''; } })();
        const m = finalPath.match(/^\/u\/(\d+)(?:\/|$)/);
        const finalPrefix = m ? `/u/${m[1]}` : requestedPrefix;
        const session = extractSessionFromHtml(html, finalPrefix);
        if (!session.at) throw new Error('无法读取 SNlM0e / at，会话页面结构可能变化或登录态已失效。');
        if (!session.bl) console.warn('[Gemini Universal Exporter] cfb2h/bl 未读取到；将尝试不带 bl 请求。');
        if (!session.sid) console.warn('[Gemini Universal Exporter] FdrFJe/f.sid 未读取到；将尝试不带 f.sid 请求。');
        return session;
    }

    function flattenWrbRows(value, out = []) {
        if (!Array.isArray(value)) return out;
        if (value[0] === 'wrb.fr' && typeof value[1] === 'string') {
            out.push(value);
            return out;
        }
        for (const child of value) flattenWrbRows(child, out);
        return out;
    }

    function extractRpcPayloadsRobust(rawText, rpcId) {
        let text = String(rawText || '');
        if (text.startsWith(")]}'")) {
            const nl = text.indexOf('\n');
            text = nl >= 0 ? text.slice(nl + 1) : text.slice(4);
        }
        const rows = [];

        // Primary parser: Gemini's JSON chunks are one physical line; size
        // prefixes and unrelated lines are simply ignored.
        for (const line of text.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('[')) continue;
            try { flattenWrbRows(JSON.parse(t), rows); } catch (_) {}
        }

        // Framed fallback for builds where a JSON chunk is not line-aligned.
        if (!rows.length) {
            let pos = 0;
            while (pos < text.length) {
                while (pos < text.length && /\s/.test(text[pos])) pos++;
                const m = /^(\d{1,10})/.exec(text.slice(pos, pos + 12));
                if (!m) break;
                const len = Number(m[1]);
                const nl = text.indexOf('\n', pos + m[1].length);
                if (!Number.isFinite(len) || nl < 0) break;
                const start = nl + 1;
                const candidates = [text.slice(start, start + len), text.slice(start, start + Math.max(0, len - 1))];
                let parsed = false;
                for (const chunk of candidates) {
                    try {
                        flattenWrbRows(JSON.parse(chunk.trim()), rows);
                        pos = start + chunk.length;
                        parsed = true;
                        break;
                    } catch (_) {}
                }
                if (!parsed) break;
            }
        }

        const payloads = [];
        for (const row of rows) {
            if (row[1] !== rpcId || typeof row[2] !== 'string' || !row[2]) continue;
            try { payloads.push(JSON.parse(row[2])); } catch (_) {}
        }
        return payloads;
    }

    async function batchExecuteRpc(session, rpcId, args, sourcePath = '/app', setStatus = () => {}, label = rpcId) {
        if (!exportFetch) throw new Error('浏览器 fetch 不可用。');
        let lastError = null;
        let refreshedOnce = false;

        for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
            isCancelled();
            const endpoint = `${location.origin}${session.accountPrefix || ''}/_/BardChatUi/data/batchexecute`;
            const url = new URL(endpoint);
            url.searchParams.set('rpcids', rpcId);
            url.searchParams.set('source-path', sourcePath || '/app');
            url.searchParams.set('_reqid', String(nextReqId()));
            url.searchParams.set('rt', 'c');
            url.searchParams.set('hl', getLang());
            if (session.bl) url.searchParams.set('bl', session.bl);
            if (session.sid) url.searchParams.set('f.sid', session.sid);

            const body = new URLSearchParams({
                'f.req': JSON.stringify([[[rpcId, JSON.stringify(args), null, 'generic']]]),
                at: session.at,
            });

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), CONFIG.RPC_TIMEOUT_MS);
            try {
                const res = await exportFetch(url.toString(), {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                        'X-Same-Domain': '1',
                        'Accept': '*/*',
                    },
                    body: body.toString(),
                    signal: controller.signal,
                });
                const text = await res.text();

                if (res.ok) {
                    const payloads = extractRpcPayloadsRobust(text, rpcId);
                    if (payloads.length) return payloads;
                    lastError = new Error(`${label}: HTTP 200 但没有可解析的 ${rpcId} payload`);
                    if (!refreshedOnce) {
                        refreshedOnce = true;
                        try { Object.assign(session, await getFreshGeminiSession(setStatus)); } catch (_) {}
                    }
                } else {
                    const retryable = res.status === 429 || [500, 502, 503, 504].includes(res.status);
                    if ([401, 403].includes(res.status) && !refreshedOnce) {
                        refreshedOnce = true;
                        Object.assign(session, await getFreshGeminiSession(setStatus));
                        lastError = new Error(`${label}: HTTP ${res.status}，已刷新会话参数`);
                    } else if (!retryable) {
                        throw new Error(`${label}: HTTP ${res.status} ${res.statusText} ${text.slice(0, 240)}`);
                    } else {
                        lastError = new Error(`${label}: HTTP ${res.status}`);
                        const retryAfter = parseRetryAfterMs(res.headers);
                        const waitMs = retryAfter ?? (
                            res.status === 429
                                ? CONFIG.RATE_LIMIT_FALLBACK_MS + randomBetween(0, 60000)
                                : Math.min(CONFIG.SERVER_ERROR_MAX_MS, CONFIG.SERVER_ERROR_BASE_MS * Math.pow(2, attempt - 1) + randomBetween(0, 12000))
                        );
                        setStatus(`⏳ ${label} HTTP ${res.status} · ${attempt}/${CONFIG.MAX_RETRIES} · 冷却 ${Math.round(waitMs / 1000)} 秒`);
                        clearTimeout(timer);
                        await sleep(waitMs);
                        continue;
                    }
                }
            } catch (e) {
                if (/用户已取消/.test(String(e?.message || e))) throw e;
                const msg = e?.name === 'AbortError' ? `${label}: 请求超时` : (e?.message || String(e));
                lastError = new Error(msg);
                if (/HTTP (400|404)/.test(msg)) throw lastError;
            } finally {
                clearTimeout(timer);
            }

            if (attempt < CONFIG.MAX_RETRIES) {
                const waitMs = Math.min(30000, 900 * Math.pow(2, attempt - 1) + randomBetween(200, 1200));
                setStatus(`⏳ ${label} 响应异常 · ${attempt}/${CONFIG.MAX_RETRIES} · ${Math.round(waitMs / 1000)} 秒后重试`);
                await sleep(waitMs);
            }
        }
        throw lastError || new Error(`${label}: 多次重试后失败`);
    }

    function looksLikeChatEntry(entry) {
        if (!Array.isArray(entry) || entry.length < 2) return false;
        const id = entry[0];
        return typeof id === 'string' && /^c_[A-Za-z0-9_-]{5,}$/.test(id);
    }

    function findBestChatEntryArray(payload) {
        const candidates = [];
        const add = value => {
            if (!Array.isArray(value) || !value.length) return;
            const hits = value.filter(looksLikeChatEntry).length;
            if (hits) candidates.push({ value, hits, ratio: hits / value.length });
        };
        if (Array.isArray(payload)) {
            add(payload[2]);
            add(payload[0]);
            for (const top of payload) add(top);
        }
        // Shallow recursive fallback, bounded to avoid walking huge unrelated trees.
        const walk = (node, depth) => {
            if (depth > 3 || !Array.isArray(node)) return;
            add(node);
            for (const child of node) if (Array.isArray(child)) walk(child, depth + 1);
        };
        walk(payload, 0);
        candidates.sort((a, b) => (b.hits - a.hits) || (b.ratio - a.ratio));
        return candidates[0]?.value || [];
    }

    function timestampPairToMs(value) {
        if (Array.isArray(value) && typeof value[0] === 'number' && value[0] > 0) {
            const nanos = typeof value[1] === 'number' ? value[1] : 0;
            return Math.round(value[0] * 1000 + nanos / 1e6);
        }
        if (typeof value === 'number' && value > 0) return value > 1e12 ? value : value * 1000;
        return null;
    }

    function parseListPayload(payload, accountPrefix = currentAccountPrefix()) {
        const entries = findBestChatEntryArray(payload);
        const nextCursor = Array.isArray(payload) && typeof payload[1] === 'string' && payload[1] ? payload[1] : null;
        const items = [];
        for (const entry of entries) {
            if (!looksLikeChatEntry(entry)) continue;
            const rawId = String(entry[0]);
            const id = rawId.replace(/^c_/, '');
            const title = String(entry[1] || 'Untitled Conversation').replace(/\s+/g, ' ').trim() || 'Untitled Conversation';
            items.push({
                id,
                chatId: id,
                rawId,
                kind: 'app',
                title,
                updatedAt: timestampPairToMs(entry[5]),
                sourcePath: `${accountPrefix || ''}/app/${id}`,
                basePrefix: accountPrefix || '',
                discovery: 'MaZiqc',
            });
        }
        return { items, nextCursor };
    }

    function chooseListPage(payloads, accountPrefix) {
        let best = { items: [], nextCursor: null };
        for (const payload of payloads || []) {
            const parsed = parseListPayload(payload, accountPrefix);
            if (parsed.items.length > best.items.length) best = parsed;
            else if (parsed.items.length === best.items.length && parsed.nextCursor && !best.nextCursor) best = parsed;
        }
        return best;
    }

    async function listAllConversationsRpc(session, setStatus = () => {}, rpcCall = batchExecuteRpc) {
        const merged = new Map();
        const addItems = items => {
            let added = 0;
            for (const item of items) {
                if (!merged.has(item.id)) { merged.set(item.id, item); added++; }
                else {
                    const old = merged.get(item.id);
                    if ((!old.title || /^Untitled/.test(old.title)) && item.title) merged.set(item.id, { ...old, ...item });
                }
            }
            return added;
        };
        const diagnostics = [];

        for (const flag of CONFIG.LIST_FLAG_VARIANTS) {
            let cursor = null;
            const seenCursors = new Set();
            let firstPageCount = 0;
            let firstHadCursor = false;
            for (let page = 0; page < CONFIG.LIST_MAX_PAGES; page++) {
                isCancelled();
                const args = cursor == null
                    ? [CONFIG.LIST_PAGE_SIZE, null, [flag, null, 1]]
                    : [CONFIG.LIST_PAGE_SIZE, cursor];
                const payloads = await rpcCall(session, CONFIG.LIST_RPC_ID, args, '/app', setStatus, `历史列表 flag=${flag} p${page + 1}`);
                const parsed = chooseListPage(payloads, session.accountPrefix);
                if (page === 0) {
                    firstPageCount = parsed.items.length;
                    firstHadCursor = !!parsed.nextCursor;
                }
                diagnostics.push({ flag, page: page + 1, count: parsed.items.length, has_cursor: !!parsed.nextCursor });

                if (cursor && !parsed.items.length && parsed.nextCursor) {
                    throw new Error(`MaZiqc 分页异常：cursor=${cursor} 的页面为空但服务器仍返回 next cursor；为避免部分备份，已中止。`);
                }
                addItems(parsed.items);
                setStatus(`📚 RPC 枚举历史 · 已发现 ${merged.size} 条`);

                if (!parsed.nextCursor) break;
                if (parsed.nextCursor === cursor || seenCursors.has(parsed.nextCursor)) {
                    throw new Error('MaZiqc 返回重复分页 cursor；为避免死循环/漏数据，已中止。');
                }
                seenCursors.add(parsed.nextCursor);
                cursor = parsed.nextCursor;
                await sleep(randomBetween(250, 650));
                if (page === CONFIG.LIST_MAX_PAGES - 1) {
                    throw new Error(`MaZiqc 超过 ${CONFIG.LIST_MAX_PAGES} 页仍未结束；拒绝生成可能不完整的备份。`);
                }
            }

            // Some builds return a full growing window without a cursor. If the
            // first window is exactly full, grow the requested count until a
            // round contributes no new ids. This is a fallback, not the normal path.
            if (firstPageCount >= CONFIG.LIST_PAGE_SIZE && !firstHadCursor) {
                let noNewRounds = 0;
                for (let count = 100; count <= 2000 && noNewRounds < 2; count += 100) {
                    const payloads = await rpcCall(session, CONFIG.LIST_RPC_ID, [count, null, [flag, null, 1]], '/app', setStatus, `历史列表扩窗 ${count}`);
                    const parsed = chooseListPage(payloads, session.accountPrefix);
                    const added = addItems(parsed.items);
                    diagnostics.push({ flag, growing_count: count, count_returned: parsed.items.length, added });
                    setStatus(`📚 RPC 扩窗核验 · 已发现 ${merged.size} 条`);
                    if (!added) noNewRounds++; else noNewRounds = 0;
                    if (parsed.items.length < count) break;
                    await sleep(randomBetween(300, 700));
                }
            }
        }

        // Oldest/minimal builds occasionally accept [20] rather than the flag
        // envelope. Use once only if the verified variants found nothing.
        if (!merged.size) {
            const payloads = await rpcCall(session, CONFIG.LIST_RPC_ID, [CONFIG.LIST_PAGE_SIZE], '/app', setStatus, '历史列表兼容探测');
            const parsed = chooseListPage(payloads, session.accountPrefix);
            addItems(parsed.items);
            diagnostics.push({ compatibility_probe: true, count: parsed.items.length, has_cursor: !!parsed.nextCursor });
        }

        if (!merged.size) {
            throw new Error('MaZiqc 成功请求后仍没有解析到任何历史对话。已停止，不再依赖侧栏 DOM 猜 ID。');
        }

        const items = Array.from(merged.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return { items, diagnostics };
    }

    function getPath(node, path) {
        let cur = node;
        for (const k of path) {
            if (!Array.isArray(cur) || k < 0 || k >= cur.length) return undefined;
            cur = cur[k];
        }
        return cur;
    }

    function isInternalPlaceholderText(text) {
        return /https?:\/\/[^\s]*googleusercontent\.com\/(?:[^\s/]+_content|immersive_entry_chip)\//i.test(String(text || ''));
    }

    function stripInternalPlaceholderLines(text) {
        return String(text || '').split(/\r?\n/).filter(line => !isInternalPlaceholderText(line.trim())).join('\n').trim();
    }

    function recursivelyFindBestString(node) {
        let best = '';
        const walk = value => {
            if (typeof value === 'string') {
                const s = value.trim();
                if (!s || looksLikeInternalId(s) || /^https?:\/\/googleusercontent\.com\//i.test(s)) return;
                if (s.length > best.length) best = s;
                return;
            }
            if (Array.isArray(value)) for (const child of value) walk(child);
        };
        walk(node);
        return best;
    }

    function inferLanguageFromFilename(filename) {
        const ext = String(filename || '').toLowerCase().split('.').pop();
        const map = {
            js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python',
            html: 'html', htm: 'html', css: 'css', json: 'json', md: 'markdown', markdown: 'markdown',
            sh: 'bash', bash: 'bash', ps1: 'powershell', java: 'java', kt: 'kotlin', swift: 'swift',
            go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', cs: 'csharp',
            sql: 'sql', yaml: 'yaml', yml: 'yaml', xml: 'xml', txt: 'text', csv: 'csv',
        };
        return map[ext] || (ext && ext.length <= 10 ? ext : 'text');
    }

    function canvasTypeFromFilename(filename) {
        const lang = inferLanguageFromFilename(filename);
        return ['markdown', 'text', 'csv'].includes(lang) ? 'document' : 'code';
    }

    function extractCanvasListFromCandidate(candidate) {
        const block30 = Array.isArray(candidate?.[30]) ? candidate[30] : [];
        const out = [];
        for (const item of block30) {
            if (!Array.isArray(item) || Number(item[10]) !== 2) continue;
            const title = typeof item[2] === 'string' ? item[2].trim() : '';
            const filename = typeof item[9] === 'string' ? item[9].trim() : '';
            const documentId = typeof item[1] === 'string' ? item[1] : null;
            let content = recursivelyFindBestString(item[8]);
            if (!content) content = typeof item[4] === 'string' ? item[4].trim() : recursivelyFindBestString(item[4]);
            if (!content) continue;
            const language = inferLanguageFromFilename(filename);
            out.push({
                type: canvasTypeFromFilename(filename),
                title: title || filename || 'Gemini Canvas',
                filename: filename || null,
                content,
                language,
                document_id: documentId,
                source: 'hNvQHb.candidate[30]',
            });
        }
        return out;
    }

    function collectCanvasMarkerIndexes(node, out = new Set()) {
        if (typeof node === 'string') {
            for (const m of node.matchAll(/immersive_entry_chip\/(\d+)/g)) out.add(Number(m[1]));
        } else if (Array.isArray(node)) {
            for (const child of node) collectCanvasMarkerIndexes(child, out);
        }
        return out;
    }

    function pickServedCandidate(turn) {
        const candidates = getPath(turn, [3, 0]);
        if (!Array.isArray(candidates)) return null;
        for (const candidate of candidates) {
            if (!Array.isArray(candidate)) continue;
            const direct = getPath(candidate, [1, 0]);
            const canvas = extractCanvasListFromCandidate(candidate);
            if ((typeof direct === 'string' && direct.trim()) || canvas.length) return candidate;
        }
        return candidates.find(Array.isArray) || null;
    }

    function assistantTextFromCandidate(candidate) {
        if (!Array.isArray(candidate)) return '';
        let text = getPath(candidate, [1, 0]);
        if (typeof text !== 'string') text = '';
        if (text && /^https?:\/\/googleusercontent\.com\/card_content\/\d+/i.test(text.trim())) {
            const fallback = getPath(candidate, [22, 0]);
            if (typeof fallback === 'string' && fallback.trim()) text = fallback;
        }
        if (!text) {
            const fallback = getPath(candidate, [22, 0]);
            if (typeof fallback === 'string' && fallback.trim() && !isInternalPlaceholderText(fallback)) text = fallback;
        }
        return stripInternalPlaceholderLines(text);
    }

    function extractThinkingBestEffort(candidate, assistantText) {
        if (!Array.isArray(candidate)) return null;
        try {
            const clone = candidate.slice();
            if (clone.length > 22) clone[22] = null;
            if (clone.length > 30) clone[30] = null; // never mislabel Canvas as thinking
            return extractReasoningFromAssistantNode(clone, assistantText) || null;
        } catch (_) { return null; }
    }

    function parseDetailTurn(turn, chronologicalIndex = 0) {
        if (!Array.isArray(turn)) return null;
        const userDirect = getPath(turn, [2, 0, 0]);
        let userText = typeof userDirect === 'string' ? userDirect.trim() : '';
        if (!userText) {
            try {
                const userNodes = findAll(turn, n => isUserMessageNode(n, false));
                if (userNodes[0]) userText = getUserTextFromNode(userNodes[0]);
            } catch (_) {}
        }

        const candidate = pickServedCandidate(turn);
        const assistantText = candidate ? assistantTextFromCandidate(candidate) : '';
        const thoughtsText = candidate ? extractThinkingBestEffort(candidate, assistantText) : null;
        const canvas = candidate ? extractCanvasListFromCandidate(candidate) : [];
        const markerIndexes = candidate ? Array.from(collectCanvasMarkerIndexes(candidate)).sort((a, b) => a - b) : [];
        const tsPair = Array.isArray(turn[4]) ? turn[4] : null;
        const turnId = typeof getPath(turn, [0, 1]) === 'string' ? getPath(turn, [0, 1]) : null;

        return {
            index: chronologicalIndex,
            turn_id: turnId,
            timestamp_ms: timestampPairToMs(tsPair),
            userText,
            assistantText,
            thoughtsText,
            canvas,
            canvas_marker_indexes: markerIndexes,
            canvas_possible_miss: markerIndexes.length > canvas.length,
        };
    }

    function extractTurnsArrayFromDetailPayload(payload) {
        return Array.isArray(payload?.[0]) ? payload[0] : [];
    }

    function detailNextCursor(payload) {
        return Array.isArray(payload) && typeof payload[1] === 'string' && payload[1] ? payload[1] : null;
    }

    async function fetchAllConversationPayloads(session, item, setStatus = () => {}, rpcCall = batchExecuteRpc) {
        const rawId = item.rawId || (String(item.chatId).startsWith('c_') ? item.chatId : `c_${item.chatId}`);
        const payloadsOut = [];
        let cursor = null;
        const seenCursors = new Set();
        let detailFilter = [1];

        for (let page = 0; page < CONFIG.DETAIL_MAX_PAGES; page++) {
            isCancelled();
            const args = [rawId, CONFIG.DETAIL_PAGE_SIZE, cursor, 1, detailFilter, [4], null, 1];
            let payloads = await rpcCall(session, CONFIG.DETAIL_RPC_ID, args, item.sourcePath, setStatus, `对话详情 ${page + 1}`);
            let payload = payloads.find(p => Array.isArray(p?.[0])) || payloads[0];
            let turns = extractTurnsArrayFromDetailPayload(payload);
            let next = detailNextCursor(payload);

            // Compatibility fallback seen in another maintained 2026 client.
            if (page === 0 && !turns.length && !next && detailFilter[0] === 1) {
                detailFilter = [0];
                payloads = await rpcCall(session, CONFIG.DETAIL_RPC_ID, [rawId, CONFIG.DETAIL_PAGE_SIZE, null, 1, detailFilter, [4], null, 1], item.sourcePath, setStatus, '对话详情兼容探测');
                payload = payloads.find(p => Array.isArray(p?.[0])) || payloads[0];
                turns = extractTurnsArrayFromDetailPayload(payload);
                next = detailNextCursor(payload);
            }

            if (!Array.isArray(payload)) throw new Error('hNvQHb 返回 payload 结构异常。');
            if (cursor && !turns.length && next) throw new Error('hNvQHb 分页出现空页但仍有 next cursor；拒绝输出可能截断的对话。');
            payloadsOut.push(payload);
            setStatus(`📄 ${item.title} · 详情第 ${page + 1} 页 · 累计 ${payloadsOut.reduce((n, p) => n + extractTurnsArrayFromDetailPayload(p).length, 0)} turns`);

            if (!next) break;
            if (next === cursor || seenCursors.has(next)) throw new Error('hNvQHb 返回重复 cursor；拒绝死循环/部分导出。');
            seenCursors.add(next);
            cursor = next;
            await sleep(randomBetween(250, 700));
            if (page === CONFIG.DETAIL_MAX_PAGES - 1) throw new Error(`hNvQHb 超过 ${CONFIG.DETAIL_MAX_PAGES} 页仍未结束；拒绝部分备份。`);
        }
        return payloadsOut;
    }

    function parseConversationDetailPayloads(payloads) {
        const newestFirst = [];
        for (const payload of payloads || []) newestFirst.push(...extractTurnsArrayFromDetailPayload(payload));

        // hNvQHb delivers newest-first and pages toward older history.
        const chronologicalRaw = newestFirst.slice().reverse();
        const seenTurnIds = new Set();
        const parsedTurns = [];
        let unparsedTurnCount = 0;
        let canvasPossibleMissCount = 0;
        const canvases = [];
        const canvasKeys = new Set();

        for (const rawTurn of chronologicalRaw) {
            const turnId = typeof getPath(rawTurn, [0, 1]) === 'string' ? getPath(rawTurn, [0, 1]) : null;
            if (turnId && seenTurnIds.has(turnId)) continue;
            if (turnId) seenTurnIds.add(turnId);

            const parsed = parseDetailTurn(rawTurn, parsedTurns.length + 1);
            if (!parsed) { unparsedTurnCount++; continue; }
            if (!parsed.userText && !parsed.assistantText && !parsed.thoughtsText && !parsed.canvas.length) unparsedTurnCount++;
            if (parsed.canvas_possible_miss) canvasPossibleMissCount++;
            for (const artifact of parsed.canvas) {
                const key = artifact.document_id || `${artifact.filename || ''}\n${artifact.title}\n${artifact.content}`;
                if (canvasKeys.has(key)) continue;
                canvasKeys.add(key);
                canvases.push({ ...artifact, turn_index: parsed.index });
            }
            parsedTurns.push(parsed);
        }

        const blocks = parsedTurns.map(t => ({
            userText: t.userText,
            assistantText: t.assistantText,
            thoughtsText: t.thoughtsText,
            timestamp_ms: t.timestamp_ms,
            turn_id: t.turn_id,
        })).filter(b => b.userText || b.assistantText || b.thoughtsText);

        return {
            blocks,
            parsedTurns,
            canvases,
            raw_turn_count: newestFirst.length,
            parsed_turn_count: parsedTurns.length,
            unparsed_turn_count: unparsedTurnCount,
            canvas_possible_miss_count: canvasPossibleMissCount,
        };
    }

    // ------------------------- Full sidebar harvest ----------------------
    // Gemini's sidebar has changed several times. Current builds may expose
    // conversation ids in jslog on gem-nav-list-item instead of an <a href>.
    // Keep multiple independent discovery strategies and merge their results.
    function findConversationListRoot() {
        return document.querySelector('conversations-list[data-test-id="all-conversations"]') ||
            document.querySelector('.chat-history-list') ||
            document.querySelector('expandable-section[data-test-id="chats-expandable-section"]') ||
            document.querySelector('expandable-section[storagekey="chats"]') ||
            document.querySelector('[data-test-id="chats-expandable-section"]') ||
            null;
    }

    function findConversationRows(root = document) {
        const selectors = [
            'gem-nav-list-item[data-test-id="conversation"]',
            'div[data-test-id="conversation"]',
            '.chat-history-list gem-nav-list-item',
            'conversations-list[data-test-id="all-conversations"] gem-nav-list-item',
            '[data-test-id="conversation"][jslog]',
        ];
        const out = [];
        const seen = new Set();
        for (const selector of selectors) {
            for (const el of root.querySelectorAll(selector)) {
                if (seen.has(el)) continue;
                seen.add(el);
                out.push(el);
            }
        }
        return out;
    }

    function findSidebarLinks() {
        const root = findConversationListRoot();
        const selectors = [
            'a[href*="/app/"]',
            'a[href*="/gem/"]',
            'a.mat-mdc-list-item[href]',
        ];
        const scan = root || document;
        const found = [];
        const seen = new Set();
        for (const selector of selectors) {
            for (const a of scan.querySelectorAll(selector)) {
                if (seen.has(a)) continue;
                seen.add(a);
                found.push(a);
            }
        }
        // Older layouts sometimes keep the list root opaque; broad fallback.
        if (!found.length && root) {
            for (const selector of selectors) {
                for (const a of document.querySelectorAll(selector)) {
                    if (seen.has(a)) continue;
                    seen.add(a);
                    found.push(a);
                }
            }
        }
        return found;
    }

    function extractChatIdFromJslog(value) {
        const raw = String(value || '');
        if (!raw) return null;

        // Current Gemini rows commonly contain JSON-ish payloads with "c_<id>".
        // Accept escaped quotes and minor formatting changes.
        const patterns = [
            /(?:\\?\[|[\"'])c_([A-Za-z0-9_-]{6,})/,
            /c_([A-Za-z0-9_-]{6,})/,
        ];
        for (const re of patterns) {
            const m = raw.match(re);
            if (m?.[1]) return m[1];
        }
        return null;
    }

    function conversationItemFromChatId(chatId) {
        if (!chatId) return null;
        const id = String(chatId).replace(/^c_/, '');
        const basePrefix = currentAccountPrefix();
        return {
            id,
            chatId: id,
            kind: 'app',
            sourcePath: `${basePrefix}/app/${id}`,
            basePrefix,
        };
    }

    function extractTitleFromElement(el, item) {
        const candidates = [
            el?.querySelector?.('.title-text')?.innerText,
            el?.querySelector?.('[data-test-id="conversation-title"]')?.innerText,
            el?.getAttribute?.('aria-label'),
            el?.getAttribute?.('title'),
            el?.innerText,
            el?.textContent,
        ];
        for (const c of candidates) {
            const value = String(c || '').replace(/\s+/g, ' ').trim();
            if (value && value.length <= 500) return value;
        }
        return `Untitled ${item.chatId}`;
    }

    function extractTitleFromAnchor(a, item) {
        const host = a.closest('gem-nav-list-item[data-test-id="conversation"], div[data-test-id="conversation"]');
        return extractTitleFromElement(host || a, item);
    }

    function parseConversationRow(row) {
        // Strategy A: route information still exists as a descendant anchor.
        const a = row.querySelector?.('a[href*="/app/"], a[href*="/gem/"]');
        if (a) {
            const item = parseConversationHref(a.getAttribute('href'));
            if (item) {
                item.title = extractTitleFromElement(row, item);
                item.href = a.getAttribute('href');
                return item;
            }
        }

        // Strategy B: current Gemini stores c_<conversation-id> inside jslog.
        let node = row;
        for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
            const chatId = extractChatIdFromJslog(node.getAttribute?.('jslog'));
            if (chatId) {
                const item = conversationItemFromChatId(chatId);
                item.title = extractTitleFromElement(row, item);
                item.href = item.sourcePath;
                item.discovery = 'jslog';
                return item;
            }
        }

        // Strategy C: scan any jslog-bearing descendant as a final DOM fallback.
        for (const el of row.querySelectorAll?.('[jslog]') || []) {
            const chatId = extractChatIdFromJslog(el.getAttribute('jslog'));
            if (!chatId) continue;
            const item = conversationItemFromChatId(chatId);
            item.title = extractTitleFromElement(row, item);
            item.href = item.sourcePath;
            item.discovery = 'jslog-descendant';
            return item;
        }
        return null;
    }

    function collectConversationSnapshot() {
        const found = [];
        const seen = new Set();
        const add = (item) => {
            if (!item || !item.id || seen.has(item.id)) return;
            seen.add(item.id);
            found.push(item);
        };

        // New/current layouts: history rows may not have navigable hrefs.
        const root = findConversationListRoot() || document;
        for (const row of findConversationRows(root)) add(parseConversationRow(row));

        // Older layouts and Gemini Gems: href-based discovery.
        for (const a of findSidebarLinks()) {
            const item = parseConversationHref(a.getAttribute('href'));
            if (!item) continue;
            item.title = extractTitleFromAnchor(a, item);
            item.href = a.getAttribute('href');
            item.discovery = item.discovery || 'href';
            add(item);
        }

        return found;
    }

    function findSidebarOpenButton() {
        const candidates = Array.from(document.querySelectorAll('button[aria-label], gem-icon-button[aria-label]'));
        return candidates.find(b => {
            const label = (b.getAttribute('aria-label') || '').toLowerCase();
            return (
                label.includes('open sidebar') ||
                label.includes('show sidebar') ||
                label.includes('navigation menu') ||
                label.includes('main menu') ||
                label.includes('打开侧边栏') ||
                label.includes('显示侧边栏') ||
                label.includes('导航菜单') ||
                label === '菜单'
            );
        }) || null;
    }

    function findRecentSectionToggle() {
        const toggles = Array.from(document.querySelectorAll(
            '[data-test-id="expandable-section-toggle"], expandable-section button, button[aria-label], gem-button[aria-label]'
        ));
        return toggles.find(b => {
            const text = `${b.getAttribute('aria-label') || ''} ${b.innerText || ''}`.toLowerCase();
            return text.includes('recent') || text.includes('最近') || text.includes('chats') || text.includes('聊天');
        }) || null;
    }

    function isScrollable(el) {
        if (!el) return false;
        const style = getComputedStyle(el);
        const overflowY = style.overflowY;
        return (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
            el.scrollHeight > el.clientHeight + 20;
    }

    function findSidebarScroller() {
        const listRoot = findConversationListRoot();
        if (listRoot) {
            if (isScrollable(listRoot)) return listRoot;
            let p = listRoot.parentElement;
            while (p && p !== document.body) {
                if (isScrollable(p)) return p;
                p = p.parentElement;
            }
        }

        const first = findConversationRows()[0] || findSidebarLinks()[0];
        let p = first?.parentElement || null;
        while (p && p !== document.body) {
            if (isScrollable(p)) return p;
            p = p.parentElement;
        }

        const all = Array.from(document.querySelectorAll('nav, aside, section, div, infinite-scroller, conversations-list'));
        return all
            .filter(isScrollable)
            .filter(el => el.querySelector?.(
                'gem-nav-list-item[data-test-id="conversation"], div[data-test-id="conversation"], [data-test-id="conversation"][jslog], a[href*="/app/"], a[href*="/gem/"]'
            ))
            .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null;
    }

    async function ensureSidebarShellOpen() {
        if (findConversationListRoot() || findConversationRows().length || findSidebarLinks().length) return;
        const open = findSidebarOpenButton();
        if (open) {
            open.click();
            await sleep(1400);
        }
    }

    async function ensureChatsExpanded() {
        const toggle = findRecentSectionToggle();
        if (!toggle) return;

        const ariaExpanded = toggle.getAttribute('aria-expanded');
        const section = toggle.closest?.('expandable-section, [data-test-id="chats-expandable-section"]');
        const classText = String(section?.className || '');
        const looksCollapsed = ariaExpanded === 'false' || /\bcollapsed\b/i.test(classText);
        if (looksCollapsed) {
            toggle.click();
            await sleep(1000);
        }
    }

    function historyDomDiagnostics() {
        const root = findConversationListRoot();
        const rows = findConversationRows(root || document);
        const links = findSidebarLinks();
        const jslogSamples = Array.from(document.querySelectorAll('[jslog]'))
            .map(el => el.getAttribute('jslog'))
            .filter(v => /c_[A-Za-z0-9_-]{6,}/.test(v || ''))
            .slice(0, 5);
        return {
            url: location.href,
            listRoot: root ? `${root.tagName.toLowerCase()}${root.id ? '#'+root.id : ''}.${String(root.className || '').replace(/\s+/g,'.')}` : null,
            rowCount: rows.length,
            linkCount: links.length,
            jslogConversationSamples: jslogSamples,
            sidebarButton: findSidebarOpenButton()?.getAttribute?.('aria-label') || null,
            recentToggle: findRecentSectionToggle()?.getAttribute?.('aria-label') || findRecentSectionToggle()?.innerText || null,
        };
    }

    async function harvestAllConversations(setStatus) {
        setStatus('📂 正在展开 Gemini 历史列表…');

        // Important ordering: first open the sidebar shell, THEN expand Recent/Chats,
        // only then decide whether history is empty. v0.2.0 validated too early.
        await ensureSidebarShellOpen();
        await ensureChatsExpanded();
        await sleep(500);

        const merged = new Map();
        const absorb = () => {
            for (const item of collectConversationSnapshot()) {
                const old = merged.get(item.id);
                if (!old) merged.set(item.id, item);
                else if ((!old.title || /^Untitled/.test(old.title)) && item.title) merged.set(item.id, { ...old, ...item });
            }
        };

        absorb();
        if (!merged.size) {
            // One more chance after a forced sidebar/toggle cycle.
            const open = findSidebarOpenButton();
            if (open) {
                open.click();
                await sleep(1000);
            }
            await ensureChatsExpanded();
            await sleep(600);
            absorb();
        }

        if (!merged.size) {
            const diag = historyDomDiagnostics();
            console.error('[Gemini Universal Exporter] history discovery diagnostics:', diag);
            throw new Error(
                `历史列表仍为空。DOM诊断: rows=${diag.rowCount}, links=${diag.linkCount}, jslogSamples=${diag.jslogConversationSamples.length}。` +
                '请把控制台中 history discovery diagnostics 那一整项发给我。'
            );
        }

        const scroller = findSidebarScroller();
        if (!scroller) {
            setStatus(`📋 找到 ${merged.size} 条对话（未检测到懒加载滚动容器）`);
            return Array.from(merged.values());
        }

        let stable = 0;
        let lastSize = -1;
        let lastHeight = -1;

        // Start from the top so repeated runs are deterministic.
        try { scroller.scrollTop = 0; } catch (_) {}
        await sleep(350);
        absorb();

        for (let round = 0; round < CONFIG.LIST_MAX_SCROLL_ROUNDS && stable < CONFIG.LIST_STABLE_ROUNDS; round++) {
            isCancelled();
            const beforeTop = scroller.scrollTop;
            const beforeHeight = scroller.scrollHeight;

            // Move in large pages rather than only assigning scrollHeight; some
            // virtualized lists load the next page only after intermediate scroll events.
            const step = Math.max(scroller.clientHeight * 0.85, 500);
            scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
            await sleep(listJitter());
            absorb();

            // If already near bottom, explicitly hit the bottom to trigger lazy load.
            if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 80) {
                scroller.scrollTop = scroller.scrollHeight;
                await sleep(Math.max(500, CONFIG.LIST_SCROLL_DELAY_MIN));
                absorb();
            }

            const size = merged.size;
            const height = scroller.scrollHeight;
            setStatus(`📂 加载全部历史… 已发现 ${size} 条`);

            const noNewIds = size === lastSize;
            const noNewHeight = height === lastHeight;
            const noMovement = scroller.scrollTop === beforeTop && height === beforeHeight;
            if (noNewIds && noNewHeight && noMovement) stable++;
            else if (noNewIds && noNewHeight && scroller.scrollTop + scroller.clientHeight >= height - 80) stable++;
            else stable = 0;

            lastSize = size;
            lastHeight = height;
        }

        // Return to top, then absorb once more because of list virtualization.
        try { scroller.scrollTop = 0; } catch (_) {}
        await sleep(500);
        absorb();

        const items = Array.from(merged.values());
        if (!items.length) throw new Error('最终没有收集到任何历史对话 ID。Gemini 页面结构可能已经变化。');
        return items;
    }

    // ------------------------ batchexecute request -----------------------
    async function fetchConversationPayloadText(item, setStatus) {
        const at = getAtToken();
        if (!at) throw new Error('无法找到 Gemini anti-CSRF token (SNlM0e / at)。请刷新 Gemini 页面后重试。');

        const convKey = item.chatId.startsWith('c_') ? item.chatId : `c_${item.chatId}`;
        const innerArgs = JSON.stringify([convKey, CONFIG.DETAIL_PAGE_SIZE, null, 1, [1], [4], null, 1]);
        const fReq = [[[CONFIG.DETAIL_RPC_ID, innerArgs, null, 'generic']]];

        const params = new URLSearchParams({
            rpcids: CONFIG.DETAIL_RPC_ID,
            'source-path': item.sourcePath,
            hl: getLang(),
            rt: 'c',
        });

        const body = new URLSearchParams({
            'f.req': JSON.stringify(fReq),
            at,
        });

        let lastError = null;
        for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
            isCancelled();
            try {
                const res = await fetch(`${getBatchUrl(item)}?${params.toString()}`, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                        'x-same-domain': '1',
                        'accept': '*/*',
                    },
                    body: body.toString() + '&',
                });

                if (res.ok) return await res.text();

                const retryable = res.status === 429 || [500, 502, 503, 504].includes(res.status);
                const txt = await res.text().catch(() => '');
                if (!retryable) {
                    throw new Error(`Gemini RPC ${res.status} ${res.statusText}: ${txt.slice(0, 240)}`);
                }

                const retryAfter = parseRetryAfterMs(res.headers);
                const waitMs = retryAfter ?? (
                    res.status === 429
                        ? CONFIG.RATE_LIMIT_FALLBACK_MS + randomBetween(0, 60000)
                        : Math.min(
                            CONFIG.SERVER_ERROR_MAX_MS,
                            CONFIG.SERVER_ERROR_BASE_MS * Math.pow(2, attempt - 1) + randomBetween(0, 12000)
                        )
                );

                lastError = new Error(`HTTP ${res.status}`);
                setStatus(`⏳ HTTP ${res.status}，第 ${attempt}/${CONFIG.MAX_RETRIES} 次；冷却 ${Math.round(waitMs / 1000)} 秒…`);
                await sleep(waitMs);
            } catch (e) {
                lastError = e;
                if (/用户已取消/.test(String(e?.message || e))) throw e;
                if (attempt >= CONFIG.MAX_RETRIES) break;

                // For explicit non-retryable HTTP errors generated above, don't hammer.
                const msg = String(e?.message || e);
                if (/Gemini RPC (400|401|403|404)/.test(msg)) throw e;

                const waitMs = Math.min(
                    CONFIG.SERVER_ERROR_MAX_MS,
                    CONFIG.SERVER_ERROR_BASE_MS * Math.pow(2, attempt - 1) + randomBetween(0, 10000)
                );
                setStatus(`⏳ 请求异常，第 ${attempt}/${CONFIG.MAX_RETRIES} 次；等待 ${Math.round(waitMs / 1000)} 秒…`);
                await sleep(waitMs);
            }
        }

        throw lastError || new Error('Gemini RPC 多次重试后仍失败');
    }

    // ----------------------- batchexecute parser -------------------------
    function parseBatchExecute(text, targetRpcId = CONFIG.DETAIL_RPC_ID) {
        if (text.startsWith(")]}'\n")) {
            const nl = text.indexOf('\n');
            text = nl >= 0 ? text.slice(nl + 1) : '';
        }

        const lines = text.split('\n').filter(l => l.trim().length > 0);
        const payloads = [];

        for (let i = 0; i < lines.length;) {
            const lenStr = lines[i++];
            const len = parseInt(lenStr, 10);
            if (!Number.isFinite(len)) break;

            const jsonLine = lines[i++] || '';
            let segment;
            try { segment = JSON.parse(jsonLine); }
            catch (_) { continue; }

            if (!Array.isArray(segment)) continue;
            for (const entry of segment) {
                if (Array.isArray(entry) && entry[0] === 'wrb.fr' && entry[1] === targetRpcId) {
                    const s = entry[2];
                    if (typeof s === 'string') {
                        try { payloads.push(JSON.parse(s)); }
                        catch (_) {}
                    }
                }
            }
        }
        return payloads;
    }

    // ---------------------- Gemini payload extractor ---------------------
    // This intentionally mirrors the resilient extraction strategy of the
    // referenced Gemini Markdown exporter rather than hardcoding one deep index.
    function stdLB(text) {
        return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    function collectStrings(node, out = []) {
        if (typeof node === 'string') out.push(node);
        else if (Array.isArray(node)) for (const child of node) collectStrings(child, out);
        return out;
    }

    function cleanStrings(node) {
        return collectStrings(node).map(s => s.trim()).filter(Boolean);
    }

    function looksLikeInternalId(s) {
        return /^(?:c_|rc_|r_)[A-Za-z0-9_-]{6,}$/.test(String(s || '').trim());
    }

    function isUserMessageNode(node, loose = false) {
        if (!Array.isArray(node) || node.length < 2 || !Array.isArray(node[0]) || typeof node[1] !== 'number') return false;
        if (!loose && node[1] !== 1 && node[1] !== 2) return false;
        if (loose && (node[1] < 0 || node[1] > 9)) return false;
        return cleanStrings(node[0]).some(Boolean);
    }

    function getUserTextFromNode(userNode) {
        try {
            return cleanStrings(userNode[0]).filter(s => !looksLikeInternalId(s)).join('\n').trim();
        } catch (_) { return ''; }
    }

    function looksLikeAssistantId(id) {
        if (typeof id !== 'string') return false;
        return id.startsWith('rc_') || id.startsWith('r_') || /^response[_-]/i.test(id);
    }

    function isAssistantNode(node) {
        if (!Array.isArray(node) || node.length < 2 || typeof node[0] !== 'string' || !Array.isArray(node[1])) return false;
        if (looksLikeAssistantId(node[0])) return true;

        const direct = typeof node[1]?.[0] === 'string' ? node[1][0].trim() : '';
        return direct.length > 20 && /[\s\n.,!?`*_#]/.test(direct) && !looksLikeInternalId(node[0]) && !node[0].startsWith('c_');
    }

    function getAssistantTextFromNode(assistantNode) {
        try {
            const primary = assistantNode?.[1]?.[0];
            if (typeof primary === 'string') return primary;
            if (Array.isArray(primary)) {
                const joined = cleanStrings(primary).filter(s => !looksLikeInternalId(s)).join('\n\n').trim();
                if (joined) return joined;
            }
            return cleanStrings(assistantNode?.[1] || []).filter(s => !looksLikeInternalId(s)).join('\n\n').trim();
        } catch (_) { return ''; }
    }

    function findThoughtCandidate(node) {
        if (!Array.isArray(node)) return null;

        if (
            node.length >= 2 && Array.isArray(node[1]) && node[1].length >= 1 &&
            Array.isArray(node[1][0]) && node[1][0].length >= 1 &&
            node[1][0].every(x => typeof x === 'string')
        ) {
            const txt = node[1][0].join('\n\n').trim();
            if (txt) return txt;
        }

        if (Array.isArray(node[0]) && node[0].length >= 1 && node[0].every(x => typeof x === 'string')) {
            const txt = node[0].join('\n\n').trim();
            if (txt) return txt;
        }

        for (let i = node.length - 1; i >= 0; i--) {
            const found = findThoughtCandidate(node[i]);
            if (found) return found;
        }
        return null;
    }

    function extractReasoningFromAssistantNode(assistantNode, assistantText = '') {
        if (!Array.isArray(assistantNode)) return null;
        const normalize = s => stdLB(String(s || '')).trim();
        const assistantNorm = normalize(assistantText);
        for (let k = assistantNode.length - 1; k >= 2; k--) {
            const txt = findThoughtCandidate(assistantNode[k]);
            if (txt && normalize(txt) !== assistantNorm) return txt;
        }
        return null;
    }

    function isTimestampPair(arr) {
        return Array.isArray(arr) && arr.length === 2 && typeof arr[0] === 'number' && typeof arr[1] === 'number' && arr[0] > 1_600_000_000;
    }

    function cmpTimestampAsc(a, b) {
        if (!a.tsPair && !b.tsPair) return 0;
        if (!a.tsPair) return -1;
        if (!b.tsPair) return 1;
        return a.tsPair[0] !== b.tsPair[0] ? a.tsPair[0] - b.tsPair[0] : a.tsPair[1] - b.tsPair[1];
    }

    function findAll(root, predicate, out = []) {
        if (!Array.isArray(root)) return out;
        if (predicate(root)) out.push(root);
        for (const child of root) findAll(child, predicate, out);
        return out;
    }

    function findMaxTimestamp(root) {
        let best = null;
        (function walk(node) {
            if (!Array.isArray(node)) return;
            if (isTimestampPair(node)) {
                if (!best || node[0] > best[0] || (node[0] === best[0] && node[1] > best[1])) best = node;
            }
            for (const child of node) walk(child);
        })(root);
        return best;
    }

    function blockFromScope(scope, order, looseUser = false) {
        const users = findAll(scope, n => isUserMessageNode(n, looseUser));
        const assistants = findAll(scope, isAssistantNode);
        if (!users.length || !assistants.length) return null;

        const userNode = users[0];
        let assistantNode = assistants.find(a => getAssistantTextFromNode(a).trim());
        if (!assistantNode) assistantNode = assistants.find(a => extractReasoningFromAssistantNode(a));
        if (!assistantNode) assistantNode = assistants[0];

        const userText = getUserTextFromNode(userNode);
        const assistantText = getAssistantTextFromNode(assistantNode);
        const thoughtsText = extractReasoningFromAssistantNode(assistantNode, assistantText);
        if (!userText && !assistantText && !thoughtsText) return null;

        return { userText, assistantText, thoughtsText: thoughtsText || null, tsPair: findMaxTimestamp(scope), _order: order };
    }

    function extractByTurnContainers(root, looseUser = false) {
        const containers = [];
        function scan(node) {
            if (!Array.isArray(node)) return { hasUser: false, hasAssistant: false, hasBoth: false };
            const selfUser = isUserMessageNode(node, looseUser);
            const selfAssistant = isAssistantNode(node);
            let hasUser = selfUser;
            let hasAssistant = selfAssistant;
            let childHasBoth = false;

            for (const child of node) {
                const flags = scan(child);
                hasUser = hasUser || flags.hasUser;
                hasAssistant = hasAssistant || flags.hasAssistant;
                childHasBoth = childHasBoth || flags.hasBoth;
            }
            const hasBoth = hasUser && hasAssistant;
            if (hasBoth && !childHasBoth && !selfUser && !selfAssistant) containers.push(node);
            return { hasUser, hasAssistant, hasBoth };
        }
        scan(root);
        return containers.map((scope, i) => blockFromScope(scope, i, looseUser)).filter(Boolean);
    }

    function collectMessageNodes(root, looseUser = false, out = []) {
        if (!Array.isArray(root)) return out;
        if (isUserMessageNode(root, looseUser)) out.push({ kind: 'user', node: root });
        else if (isAssistantNode(root)) out.push({ kind: 'assistant', node: root });
        for (const child of root) collectMessageNodes(child, looseUser, out);
        return out;
    }

    function extractBySequentialWalk(root, looseUser = false) {
        const items = collectMessageNodes(root, looseUser);
        const blocks = [];
        const pairedUsers = new WeakSet();
        let currentUser = null;
        let order = 0;

        for (const item of items) {
            if (item.kind === 'user') {
                currentUser = item.node;
                continue;
            }
            if (item.kind === 'assistant' && currentUser && !pairedUsers.has(currentUser)) {
                const userText = getUserTextFromNode(currentUser);
                const assistantText = getAssistantTextFromNode(item.node);
                const thoughtsText = extractReasoningFromAssistantNode(item.node, assistantText);
                if (userText || assistantText || thoughtsText) {
                    blocks.push({ userText, assistantText, thoughtsText: thoughtsText || null, tsPair: null, _order: order++ });
                    pairedUsers.add(currentUser);
                }
            }
        }
        return blocks;
    }

    function dedupeBlocks(blocks) {
        const seen = new Set();
        const out = [];
        for (const block of blocks) {
            const key = JSON.stringify([
                block.userText || '', block.assistantText || '', block.thoughtsText || '',
                block.tsPair?.[0] || 0, block.tsPair?.[1] || 0,
            ]);
            if (!seen.has(key)) {
                seen.add(key);
                out.push(block);
            }
        }
        return out;
    }

    function extractBlocksFromPayloadRoot(root) {
        const strictContainers = extractByTurnContainers(root, false);
        const strictSequential = extractBySequentialWalk(root, false);
        if (strictContainers.length && !(strictContainers.length === 1 && strictSequential.length > 1)) return strictContainers;
        if (strictSequential.length) return strictSequential;

        const looseContainers = extractByTurnContainers(root, true);
        const looseSequential = extractBySequentialWalk(root, true);
        if (looseContainers.length && !(looseContainers.length === 1 && looseSequential.length > 1)) return looseContainers;
        return looseSequential;
    }

    function extractAllBlocks(payloads) {
        let blocks = [];
        for (let pIndex = 0; pIndex < payloads.length; pIndex++) {
            const extracted = extractBlocksFromPayloadRoot(payloads[pIndex]);
            blocks = blocks.concat(extracted.map((b, i) => ({ ...b, _payloadIndex: pIndex, _i: blocks.length + i })));
        }
        blocks = dedupeBlocks(blocks);
        blocks.sort((a, b) => {
            const c = cmpTimestampAsc(a, b);
            return c !== 0 ? c : (a._payloadIndex - b._payloadIndex) || (a._i - b._i);
        });
        return blocks.map(({ _payloadIndex, _i, _order, ...rest }) => rest);
    }

    function normalizedTranscriptSignature(blocks) {
        return blocks.map(b => [b.userText || '', b.assistantText || '', b.thoughtsText || ''].join('\n---\n')).join('\n=====\n');
    }

    // ---------------------- Canvas / artifact extractor -----------------
    function pathMatchesConversation(item) {
        const wantedId = normalizeConversationId(item?.chatId);
        if (!wantedId) return false;

        // Gemini may transparently redirect:
        //   /app/<conversationId>
        //       -> /gem/<gemId>/<conversationId>
        // These are the same conversation. The stable identity is the final
        // conversationId, not the route family or full pathname.
        const currentRoute = parseConversationHref(location.pathname);
        if (currentRoute && normalizeConversationId(currentRoute.chatId) === wantedId) {
            return true;
        }

        // Conservative exact-path fallback for a future route shape that
        // parseConversationHref does not yet understand.
        const current = normalizePath(location.pathname) || '';
        const target = normalizePath(item.sourcePath) || '';
        return !!current && current === target;
    }

    function findConversationAnchorNow(item) {
        for (const a of findSidebarLinks()) {
            const parsed = parseConversationHref(a.getAttribute('href'));
            if (!parsed) continue;
            if (parsed.chatId === item.chatId && parsed.kind === item.kind) return a;
        }
        return null;
    }

    function normalizeConversationTitleForMatch(value) {
        return String(value || '')
            .normalize('NFKC')
            .replace(/[\u200b-\u200d\ufeff]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function findConversationRowByTitleNow(item) {
        const wanted = normalizeConversationTitleForMatch(item?.title);
        if (!wanted) return null;
        const rows = findConversationRows(findConversationListRoot() || document);
        for (const row of rows) {
            const got = normalizeConversationTitleForMatch(extractTitleFromElement(row, item));
            if (got === wanted) return row;
        }
        return null;
    }

    function getClickableConversationRowTarget(row) {
        if (!row) return null;
        if (row.matches?.('a, button, [role="button"]')) return row;
        return row.querySelector?.('a, button, [role="button"], .mdc-list-item') || row;
    }

    async function scrollSidebarToConversationByTitle(item, setStatus) {
        await ensureSidebarShellOpen();
        await ensureChatsExpanded();

        let row = findConversationRowByTitleNow(item);
        if (row) return row;

        const scroller = findSidebarScroller();
        if (!scroller) return null;
        scroller.scrollTop = 0;
        await sleep(300);

        let unchangedRounds = 0;
        let lastTop = -1;
        for (let i = 0; i < CONFIG.LIST_MAX_SCROLL_ROUNDS; i++) {
            isCancelled();
            row = findConversationRowByTitleNow(item);
            if (row) return row;

            const before = scroller.scrollTop;
            const step = Math.max(220, scroller.clientHeight * 0.78);
            scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
            await sleep(Math.max(220, CONFIG.LIST_SCROLL_DELAY_MIN * 0.50));
            if (i % 10 === 0) setStatus(`🧭 按标题定位 Canvas 对话… ${item.title}`);

            if (scroller.scrollTop === before || scroller.scrollTop === lastTop) unchangedRounds++;
            else unchangedRounds = 0;
            if (unchangedRounds >= 3) break;
            lastTop = before;
        }
        return findConversationRowByTitleNow(item);
    }

    async function scrollSidebarToConversation(item, setStatus) {
        await ensureSidebarShellOpen();
        await ensureChatsExpanded();
        let anchor = findConversationAnchorNow(item);
        if (anchor) return anchor;

        const scroller = findSidebarScroller();
        if (!scroller) return null;
        scroller.scrollTop = 0;
        await sleep(250);

        let lastTop = -1;
        for (let i = 0; i < CONFIG.LIST_MAX_SCROLL_ROUNDS; i++) {
            isCancelled();
            anchor = findConversationAnchorNow(item);
            if (anchor) return anchor;

            const before = scroller.scrollTop;
            const step = Math.max(220, scroller.clientHeight * 0.78);
            scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
            await sleep(Math.max(180, CONFIG.LIST_SCROLL_DELAY_MIN * 0.45));
            if (i % 12 === 0) setStatus(`🧭 定位 Canvas 对话… ${item.title}`);

            if (scroller.scrollTop === before || scroller.scrollTop === lastTop) break;
            lastTop = scroller.scrollTop;
        }
        return findConversationAnchorNow(item);
    }

    async function waitUntil(predicate, timeoutMs, intervalMs = 120) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            isCancelled();
            try {
                const value = predicate();
                if (value) return value;
            } catch (_) {}
            await sleep(intervalMs);
        }
        return null;
    }

    async function navigateToConversationForCanvas(item, setStatus, options = {}) {
        if (pathMatchesConversation(item)) {
            await waitUntil(() => document.querySelector('user-query, model-response, .conversation-container, [data-test-id="gem-processing-card"], immersive-entry-chip'), CONFIG.CANVAS_NAV_TIMEOUT_MS, 180);
            await sleep(CONFIG.CANVAS_RENDER_SETTLE_MS);
            return true;
        }
        if (options.allowSidebar === false) {
            console.warn('[Gemini Universal Exporter] direct-only Canvas scan is not on target route', { current: location.pathname, target: item.sourcePath, title: item.title });
            return false;
        }

        // Strategy 1: classic href route, when Gemini exposes real anchors.
        const anchor = await scrollSidebarToConversation(item, setStatus);
        if (anchor) {
            anchor.click();
            const routed = await waitUntil(() => pathMatchesConversation(item), CONFIG.CANVAS_NAV_TIMEOUT_MS, 120);
            if (routed) {
                await waitUntil(() => document.querySelector(
                    'user-query, model-response, .conversation-container, [data-test-id="gem-processing-card"], immersive-entry-chip'
                ), CONFIG.CANVAS_NAV_TIMEOUT_MS, 180);
                await sleep(CONFIG.CANVAS_RENDER_SETTLE_MS);
                return true;
            }
        }

        // Strategy 2 (important for the user's current Gemini build):
        // conversation rows can exist without href/id-bearing jslog. We already
        // know the title + real chat id from MaZiqc, so locate the virtualized row
        // by exact normalized title, click it, THEN verify the resulting URL id.
        const row = await scrollSidebarToConversationByTitle(item, setStatus);
        const target = getClickableConversationRowTarget(row);
        if (!target) return false;

        try { target.scrollIntoView?.({ block: 'center', inline: 'nearest' }); } catch (_) {}
        target.click();

        const routedByTitle = await waitUntil(() => pathMatchesConversation(item), CONFIG.CANVAS_NAV_TIMEOUT_MS, 120);
        if (!routedByTitle) {
            console.warn('[Gemini Universal Exporter] title navigation landed on unexpected route', {
                wanted: item.sourcePath,
                title: item.title,
                actual: location.pathname,
            });
            return false;
        }

        await waitUntil(() => document.querySelector(
            'user-query, model-response, .conversation-container, [data-test-id="gem-processing-card"], immersive-entry-chip'
        ), CONFIG.CANVAS_NAV_TIMEOUT_MS, 180);
        await sleep(CONFIG.CANVAS_RENDER_SETTLE_MS);
        return true;
    }

    function findChatScroller() {
        const selectors = [
            'infinite-scroller.chat-history',
            '.chat-scrollable-container',
            '.chat-history-scroll-container',
            'chat-history-scroll-container',
            '[data-test-id="chat-history-container"]',
            'infinite-scroller',
            '.chat-history',
            'mat-sidenav-content',
            'main',
        ];
        for (const selector of selectors) {
            const nodes = Array.from(document.querySelectorAll(selector));
            const preferred = nodes.find(el => {
                if (!el) return false;
                const hasChat = !!el.querySelector?.('user-query, model-response, .conversation-container, [data-test-id="gem-processing-card"], immersive-entry-chip');
                const isHistoryList = !!el.querySelector?.('gem-nav-list-item[data-test-id="conversation"]');
                return hasChat && !isHistoryList && (isScrollable(el) || el === document.scrollingElement || selector === 'main');
            });
            if (preferred) return preferred;
        }
        return document.scrollingElement || document.documentElement;
    }

    function isVisibleElement(el) {
        if (!(el instanceof Element)) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function normalizeCanvasTitle(value) {
        // Preserve the user's original punctuation/casing for exported filenames/titles.
        return String(value || '')
            .replace(/[\u200b-\u200d\ufeff]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function canvasTitleMatchKey(value) {
        return normalizeCanvasTitle(value).normalize('NFKC').toLowerCase();
    }

    function getCanvasCardKind(card) {
        if (!(card instanceof Element)) return null;
        if (card.querySelector('mat-icon[fonticon="code_blocks"], mat-icon[data-mat-icon-name="code_blocks"]')) return 'code';
        if (card.querySelector('mat-icon[fonticon="article"], mat-icon[data-mat-icon-name="article"]')) return 'document';
        return null;
    }

    function inferCanvasKind(el) {
        if (!(el instanceof Element)) return null;
        return getCanvasCardKind(el)
            || getCanvasCardKind(el.closest?.('[data-test-id="gem-processing-card"]'))
            || (el.querySelector?.('code-immersive-panel, xap-code-editor[data-test-id="code-editor"], .monaco-editor') ? 'code' : null)
            || (el.querySelector?.('immersive-editor, canvas-create-button') ? 'document' : null);
    }

    function getCanvasCandidateTitle(el) {
        if (!el) return null;
        const scopes=[el,el.closest?.('[data-test-id="gem-processing-card"]'),el.closest?.('immersive-entry-chip'),el.closest?.('model-response, .conversation-turn, [data-message-id], [data-turn-id]')].filter(Boolean);
        const selectors=['[data-test-id="canvas-title"]','.title-text','.card-title','[data-test-id*="title"]','h1','h2','h3'];
        for(const scope of scopes){for(const selector of selectors){const node=scope.querySelector?.(selector);const text=normalizeCanvasTitle(node?.innerText||node?.textContent||'');if(text&&text.length<=260)return text;}}
        const all=normalizeCanvasTitle(el.innerText||el.textContent||'');
        const file=all.match(/([^\n]{2,220}\.(?:md|markdown|txt|html?|js|mjs|cjs|ts|tsx|jsx|py|java|kt|go|rs|cpp|c|cs|json|ya?ml|xml|css|sql|sh|ps1))\b/i);
        return file?.[1]?.trim()||(all?all.slice(0,240):null);
    }

    function canvasResponseIdentity(el){const response=el?.closest?.('model-response, .conversation-turn, [data-message-id], [data-turn-id]');return [response?.getAttribute?.('data-message-id')||'',response?.getAttribute?.('data-turn-id')||'',response?.getAttribute?.('jslog')||''].join('~');}
    function canvasCandidateKeyFor(el,source,kind,title){return [source||'',kind||'',title||'',el?.getAttribute?.('jslog')||'',canvasResponseIdentity(el)].join('|');}
    function isCanvasNodeUsable(el){if(!(el instanceof Element)||el.closest('immersive-panel'))return false;if(isVisibleElement(el))return true;return !!Array.from(el.querySelectorAll?.('*')||[]).find(isVisibleElement);}

    function canvasActionSignal(el) {
        if (!(el instanceof Element)) return '';
        return normalizeCanvasTitle(
            el.getAttribute?.('aria-label') ||
            el.getAttribute?.('title') ||
            el.getAttribute?.('data-label') ||
            el.innerText || el.textContent || ''
        );
    }

    function isSafeCanvasActionText(text) {
        const raw = normalizeCanvasTitle(text);
        if (!raw) return false;
        if (/(share|分享|download|下载|copy|复制|more|更多|menu|菜单|close|关闭|delete|删除)/i.test(raw)) return false;
        return /^(打开|开启|查看|预览|编辑|open|view|preview|edit)$/i.test(raw);
    }

    function findSafeCanvasActionTargets(root) {
        if (!(root instanceof Element)) return [];
        const out = [], seen = new Set();
        const add = el => {
            if (!(el instanceof HTMLElement) || seen.has(el) || !isVisibleElement(el)) return;
            seen.add(el); out.push(el);
        };

        for (const el of Array.from(root.querySelectorAll('button, a, [role="button"], [tabindex], [jslog]'))) {
            if (isSafeCanvasActionText(canvasActionSignal(el))) add(el);
        }

        // Current Gemini can render the visible “打开/Open” as a span/div rather
        // than a native button. Clicking the exact leaf still bubbles to Angular's
        // delegated handler, matching the user's real click target.
        for (const el of Array.from(root.querySelectorAll('*'))) {
            const own = normalizeCanvasTitle(el.innerText || el.textContent || '');
            if (!isSafeCanvasActionText(own)) continue;
            const childSame = Array.from(el.children || []).some(child =>
                isSafeCanvasActionText(normalizeCanvasTitle(child.innerText || child.textContent || ''))
            );
            if (!childSame) add(el);

            let parent = el.parentElement;
            while (parent && parent !== root) {
                const role = parent.getAttribute?.('role') || '';
                const tabindex = parent.getAttribute?.('tabindex');
                const jslog = parent.getAttribute?.('jslog');
                const tag = parent.tagName?.toLowerCase?.() || '';
                let cursor = '';
                try { cursor = getComputedStyle(parent).cursor || ''; } catch (_) {}
                if (tag === 'button' || tag === 'a' || role === 'button' || tabindex != null || jslog || cursor === 'pointer') {
                    add(parent);
                    break;
                }
                parent = parent.parentElement;
            }
        }
        return out;
    }

    function findSafeCanvasOpenButton(root) {
        return findSafeCanvasActionTargets(root)[0] || null;
    }

    function addCanvasCandidate(out,seen,el,source,confidence,forcedKind=null){
        if(!(el instanceof Element)||!isCanvasNodeUsable(el))return;
        const kind=forcedKind||inferCanvasKind(el);const title=getCanvasCandidateTitle(el)||'Gemini Canvas';const key=canvasCandidateKeyFor(el,source,kind,title);
        if(!key||seen.has(key))return;seen.add(key);out.push({el,key,kind,title,source,confidence});
    }

    function findCanvasCandidatesInView(){
        const out=[],seen=new Set();
        document.querySelectorAll('[data-test-id="gem-processing-card"]').forEach(card=>{const kind=getCanvasCardKind(card);if(kind)addCanvasCandidate(out,seen,card,'gem-processing-card','high',kind);});
        document.querySelectorAll('immersive-entry-chip').forEach(chip=>addCanvasCandidate(out,seen,chip,'immersive-entry-chip','high'));
        document.querySelectorAll('canvas-create-button').forEach(button=>{if(button.closest('model-response, .conversation-turn, [data-message-id], [data-turn-id]'))addCanvasCandidate(out,seen,button,'canvas-create-button','medium','document');});
        return out;
    }

    function resolveLiveCanvasCandidate(candidate) {
        if (!candidate) return null;
        const expectedTitle = canvasTitleMatchKey(candidate.title || '');
        const selectors = candidate.source === 'gem-processing-card'
            ? ['[data-test-id="gem-processing-card"]']
            : candidate.source === 'canvas-create-button'
                ? ['canvas-create-button']
                : ['immersive-entry-chip'];
        for (const selector of selectors) {
            for (const el of Array.from(document.querySelectorAll(selector))) {
                if (!(el instanceof Element) || !isCanvasNodeUsable(el)) continue;
                const title = getCanvasCandidateTitle(el) || '';
                if (expectedTitle && canvasTitleMatchKey(title) !== expectedTitle) continue;
                return { ...candidate, el, title: title || candidate.title, kind: candidate.kind || inferCanvasKind(el) };
            }
        }
        if (candidate.el instanceof Element && candidate.el.isConnected !== false && isCanvasNodeUsable(candidate.el)) return candidate;
        return null;
    }

    function canvasCandidateClickTargets(candidate){
        const el=candidate?.el;if(!(el instanceof Element))return [];
        const chip=el.matches?.('immersive-entry-chip')?el:el.closest?.('immersive-entry-chip');
        const card=el.matches?.('[data-test-id="gem-processing-card"]')?el:el.closest?.('[data-test-id="gem-processing-card"]');
        const root=chip||card||el;
        const targets=[];

        if(candidate.source==='immersive-entry-chip'){
            targets.push(...findSafeCanvasActionTargets(root));
            if(chip instanceof HTMLElement)targets.push(chip);
        } else if(candidate.source==='gem-processing-card'){
            if(card instanceof HTMLElement)targets.push(card); // Ophel's current strategy
            if(chip instanceof HTMLElement)targets.push(chip);
            targets.push(...findSafeCanvasActionTargets(root));
        } else if(candidate.source==='canvas-create-button'){
            targets.push(...findSafeCanvasActionTargets(root));
            if(chip instanceof HTMLElement)targets.push(chip);
            if(el instanceof HTMLElement)targets.push(el);
        }

        const icon=root.querySelector?.('mat-icon[fonticon="article"], mat-icon[data-mat-icon-name="article"], mat-icon[fonticon="code_blocks"], mat-icon[data-mat-icon-name="code_blocks"]');
        if(icon instanceof HTMLElement)targets.push(icon);

        const seen=new Set();return targets.filter(x=>x instanceof HTMLElement&&!seen.has(x)&&seen.add(x));
    }
    function canvasCardClickTargets(card){return canvasCandidateClickTargets({el:card,source:'gem-processing-card',kind:getCanvasCardKind(card),title:getCanvasCandidateTitle(card)||'Gemini Canvas'});}

    function canvasClickTargetDescription(target) {
        if (!(target instanceof Element)) return 'unknown';
        const text = canvasActionSignal(target).slice(0, 80);
        return [target.tagName?.toLowerCase?.() || '', target.getAttribute?.('role') || '', target.getAttribute?.('data-test-id') || '', text].filter(Boolean).join(':');
    }

    function performCanvasClick(target, mode = 'native') {
        if (!(target instanceof HTMLElement)) return false;
        try { target.focus?.({ preventScroll: true }); } catch (_) {}
        if (mode === 'native') {
            // Matches Ophel's current SiteAdapter.simulateClick implementation.
            try { target.click(); return true; } catch (_) { return false; }
        }
        if (mode === 'mouse') {
            let rect = null;
            try { rect = target.getBoundingClientRect(); } catch (_) {}
            const clientX = rect ? rect.left + rect.width / 2 : 0;
            const clientY = rect ? rect.top + rect.height / 2 : 0;
            for (const type of ['mousedown','mouseup','click']) {
                try { target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,composed:true,button:0,buttons:type==='mousedown'?1:0,view:window,clientX,clientY})); } catch (_) {}
            }
            return true;
        }
        if (mode === 'keyboard') {
            try {
                target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
                target.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
                return true;
            } catch (_) { return false; }
        }
        return false;
    }

    function simulateCanvasClick(target) {
        performCanvasClick(target, 'native');
    }

    function findOpenCanvasPanel() {
        const selectors = [
            'immersive-panel code-immersive-panel',
            'immersive-panel extended-response-panel:has(canvas-create-button)',
            'immersive-panel immersive-editor',
            'code-immersive-panel',
            'immersive-editor',
        ];
        for (const selector of selectors) {
            const node = Array.from(document.querySelectorAll(selector)).find(isVisibleElement);
            if (!node) continue;
            return node.closest?.('immersive-panel') || node;
        }
        return null;
    }

    function getCanvasTitle(panel) {
        const selectors = [
            'toolbar h2.title-text',
            '[data-test-id="canvas-title"]',
            '.immersive-editor-header h1',
            '.immersive-editor-title',
            'h2.title-text',
            '.title-text',
            '.card-title',
            'input[aria-label*="title" i]',
            'textarea[aria-label*="title" i]',
            'h1',
        ];
        for (const selector of selectors) {
            const el = panel.querySelector?.(selector);
            if (!el) continue;
            const raw = ('value' in el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) ? el.value : (el.innerText || el.textContent || '');
            const text = normalizeCanvasTitle(raw);
            if (text) return text.slice(0, 240);
        }
        return 'Untitled Canvas';
    }

    function canvasPanelMatchesTitle(panel, expectedTitle) {
        const expectedDisplay = normalizeCanvasTitle(expectedTitle);
        if (!expectedDisplay || expectedDisplay === 'Gemini Canvas') return true;
        const actualDisplay = normalizeCanvasTitle(getCanvasTitle(panel));
        if (!actualDisplay || actualDisplay === 'Untitled Canvas') return true;
        const expected = canvasTitleMatchKey(expectedDisplay);
        const actual = canvasTitleMatchKey(actualDisplay);
        return actual === expected || actual.includes(expected) || expected.includes(actual);
    }

    async function waitForCanvasPanelResult(expectedTitle, timeoutMs = CONFIG.CANVAS_PANEL_TITLE_TIMEOUT_MS) {
        const deadline = Date.now() + timeoutMs;
        let lastPanel = null, lastTitle = null;
        while (Date.now() < deadline) {
            isCancelled();
            const panel = findOpenCanvasPanel();
            if (panel) {
                lastPanel = panel;
                lastTitle = getCanvasTitle(panel);
                if (canvasPanelMatchesTitle(panel, expectedTitle)) return { panel, matched: true, actualTitle: lastTitle };
            }
            await sleep(100);
        }
        return { panel: lastPanel, matched: false, actualTitle: lastTitle };
    }

    async function waitForCanvasPanel(expectedTitle, timeoutMs = CONFIG.CANVAS_PANEL_TITLE_TIMEOUT_MS) {
        const result = await waitForCanvasPanelResult(expectedTitle, timeoutMs);
        return result.matched ? result.panel : null;
    }

    function mdEscapeText(text) {
        return String(text || '').replace(/\\/g, '\\\\').replace(/([*_~])/g, '\\$1');
    }

    function domInlineToMarkdown(node) {
        if (!node) return '';
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const el = node;
        const tag = el.tagName.toLowerCase();
        const children = () => Array.from(el.childNodes).map(domInlineToMarkdown).join('');
        if (tag === 'br') return '\n';
        if (tag === 'strong' || tag === 'b') return `**${children()}**`;
        if (tag === 'em' || tag === 'i') return `*${children()}*`;
        if (tag === 's' || tag === 'del' || tag === 'strike') return `~~${children()}~~`;
        if (tag === 'code' && el.parentElement?.tagName.toLowerCase() !== 'pre') return `\`${children().replace(/`/g, '\\`')}\``;
        if (tag === 'a') {
            const label = children().trim() || el.getAttribute('href') || '';
            const href = el.getAttribute('href') || '';
            return href ? `[${label}](${href})` : label;
        }
        if (tag === 'img') {
            const src = el.getAttribute('src') || '';
            const alt = el.getAttribute('alt') || '';
            return src ? `![${alt}](${src})` : '';
        }
        return children();
    }

    function domBlockToMarkdown(node, depth = 0) {
        if (!node) return '';
        if (node.nodeType === Node.TEXT_NODE) {
            const value = node.nodeValue || '';
            return value.trim() ? value : '';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const el = node;
        const tag = el.tagName.toLowerCase();
        const inline = () => Array.from(el.childNodes).map(domInlineToMarkdown).join('').trim();
        const blocks = () => Array.from(el.childNodes).map(child => domBlockToMarkdown(child, depth)).join('');

        if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${inline()}\n\n`;
        if (tag === 'p') return `${inline()}\n\n`;
        if (tag === 'br') return '\n';
        if (tag === 'hr') return '---\n\n';
        if (tag === 'pre') {
            const code = el.textContent || '';
            return `\`\`\`\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`;
        }
        if (tag === 'blockquote') {
            const body = blocks().trim().split('\n').map(line => `> ${line}`).join('\n');
            return `${body}\n\n`;
        }
        if (tag === 'ul' || tag === 'ol') {
            const ordered = tag === 'ol';
            const items = Array.from(el.children).filter(x => x.tagName?.toLowerCase() === 'li');
            return items.map((li, i) => {
                const text = Array.from(li.childNodes).filter(n => !(n.nodeType === Node.ELEMENT_NODE && ['ul','ol'].includes(n.tagName.toLowerCase()))).map(domInlineToMarkdown).join('').trim();
                const nested = Array.from(li.children).filter(x => ['ul','ol'].includes(x.tagName.toLowerCase())).map(x => domBlockToMarkdown(x, depth + 1).trimEnd()).join('\n');
                const prefix = ordered ? `${i + 1}. ` : '- ';
                const indent = '  '.repeat(depth);
                return `${indent}${prefix}${text}${nested ? `\n${nested}` : ''}`;
            }).join('\n') + '\n\n';
        }
        if (tag === 'table') {
            const rows = Array.from(el.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr'));
            if (!rows.length) return `${inline()}\n\n`;
            const matrix = rows.map(row => Array.from(row.children).filter(c => /^(TH|TD)$/.test(c.tagName)).map(c => Array.from(c.childNodes).map(domInlineToMarkdown).join('').replace(/\|/g, '\\|').trim()));
            const width = Math.max(...matrix.map(r => r.length));
            if (!width) return '';
            matrix.forEach(r => { while (r.length < width) r.push(''); });
            const header = matrix[0];
            const body = matrix.slice(1);
            return `| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n${body.map(r => `| ${r.join(' | ')} |`).join('\n')}\n\n`;
        }
        if (['div','section','article'].includes(tag)) return blocks();
        return `${inline()}${['li'].includes(tag) ? '' : ''}`;
    }

    function proseMirrorToMarkdown(root) {
        if (!(root instanceof Element)) return '';
        const md = Array.from(root.childNodes).map(node => domBlockToMarkdown(node)).join('');
        return stdLB(md).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function extractDocumentFromPanel(panel) {
        // Voyager + Ophel current 2026 document-Canvas path.
        const selectors = [
            '#extended-response-markdown-content .ProseMirror',
            'immersive-editor[data-test-id="immersive-editor"] .ProseMirror',
            'immersive-editor .ProseMirror',
            '#extended-response-markdown-content',
        ];
        for (const selector of selectors) {
            const node = panel.querySelector?.(selector);
            if (!node) continue;
            const md = node.matches?.('.ProseMirror') ? proseMirrorToMarkdown(node) : (() => {
                const pm = node.querySelector?.('.ProseMirror');
                return pm ? proseMirrorToMarkdown(pm) : stdLB(node.innerText || node.textContent || '').trim();
            })();
            if (md) return md;
        }
        return '';
    }

    function extractCodeFromPanel(panel) {
        const directSelectors = [
            '[data-test-id="code-content"]',
            'code-block pre code',
            'pre code',
        ];
        for (const selector of directSelectors) {
            const node = panel.querySelector?.(selector);
            const txt = stdLB(node?.textContent || '').trimEnd();
            if (txt) return txt;
        }
        const lines = Array.from(panel.querySelectorAll?.('code-immersive-panel .view-lines .view-line, xap-code-editor[data-test-id="code-editor"] .view-lines .view-line, .monaco-editor .view-lines .view-line') || []);
        if (lines.length) {
            const txt = lines.map(line => (line.textContent || '').replace(/[\r\n]+$/g, '')).join('\n').trimEnd();
            if (txt) return txt;
        }
        const editor = panel.querySelector?.('xap-code-editor[data-test-id="code-editor"]');
        const fallback = stdLB(editor?.innerText || editor?.textContent || '').trim();
        return fallback;
    }

    async function ensureCanvasCodeSurface(panel) {
        if (panel.querySelector?.('code-immersive-panel .view-lines .view-line, xap-code-editor[data-test-id="code-editor"], [data-test-id="code-content"], code-block pre code, pre code')) return true;
        const selectors = [
            'mat-button-toggle[value="code"]',
            'button[role="radio"][value="code"]',
            'button[data-value="code"]',
        ];
        let tab = null;
        for (const selector of selectors) {
            tab = panel.querySelector?.(selector);
            if (tab) break;
        }
        if (!tab) return false;
        simulateCanvasClick(tab);
        return !!(await waitUntil(() => panel.querySelector?.('code-immersive-panel .view-lines .view-line, xap-code-editor[data-test-id="code-editor"], [data-test-id="code-content"], code-block pre code, pre code'), 2500, 100));
    }

    function getCanvasLanguage(panel) {
        const candidates = [
            panel.querySelector?.('.xap-monaco-container[data-mode-id]')?.getAttribute('data-mode-id'),
            panel.querySelector?.('[data-mode-id]')?.getAttribute('data-mode-id'),
            panel.querySelector?.('.code-block-decoration span')?.innerText,
            panel.querySelector?.('[data-lang]')?.getAttribute('data-lang'),
            panel.querySelector?.('[data-language]')?.getAttribute('data-language'),
        ];
        for (const raw of candidates) {
            const value = normalizeCanvasTitle(raw);
            if (value) return value.slice(0, 40);
        }
        return null;
    }

    async function waitForCanvasContentReady(panel, expectedKind = null) {
        return !!(await waitUntil(() => {
            if (!(panel instanceof Element) || panel.isConnected === false) return null;
            if (expectedKind === 'code') {
                return panel.querySelector?.('code-immersive-panel .view-lines .view-line, xap-code-editor[data-test-id="code-editor"], [data-test-id="code-content"], code-block pre code, pre code');
            }
            if (expectedKind === 'document') {
                return panel.querySelector?.('#extended-response-markdown-content .ProseMirror, immersive-editor[data-test-id="immersive-editor"] .ProseMirror, immersive-editor .ProseMirror, #extended-response-markdown-content');
            }
            return panel.querySelector?.('#extended-response-markdown-content .ProseMirror, immersive-editor .ProseMirror, code-immersive-panel, xap-code-editor[data-test-id="code-editor"], .monaco-editor');
        }, CONFIG.CANVAS_CONTENT_READY_TIMEOUT_MS, 100));
    }

    async function extractCanvasFromOpenPanel(panel, item, expectedKind = null, expectedTitle = null) {
        const title = getCanvasTitle(panel) || expectedTitle || 'Untitled Canvas';
        if (expectedKind === 'code') await ensureCanvasCodeSurface(panel);
        const hasCodeSurface = !!panel.querySelector?.('code-immersive-panel, xap-code-editor[data-test-id="code-editor"], .monaco-editor, [data-test-id="code-content"]');
        const hasDocSurface = !!panel.querySelector?.('immersive-editor .ProseMirror, #extended-response-markdown-content .ProseMirror, #extended-response-markdown-content');
        let type = expectedKind || (hasCodeSurface && !hasDocSurface ? 'code' : 'document');
        let content = type === 'code' ? extractCodeFromPanel(panel) : extractDocumentFromPanel(panel);
        if (!content && type === 'document' && hasCodeSurface) { type = 'code'; content = extractCodeFromPanel(panel); }
        if (!content && type === 'code' && hasDocSurface) { type = 'document'; content = extractDocumentFromPanel(panel); }
        content = stdLB(content).trim();
        if (!content) return null;
        const language = type === 'code' ? getCanvasLanguage(panel) : null;
        const hash = await sha256Hex(`${type}\n${title}\n${content}`);
        return {
            type,
            title: normalizeCanvasTitle(title) || expectedTitle || 'Untitled Canvas',
            language,
            content,
            content_sha256: hash,
            source: 'gemini_canvas_dom_ophel_voyager',
            conversation_id: item.chatId,
            captured_at: new Date().toISOString(),
        };
    }

    async function closeCanvasPanel(panel) {
        const selectors = [
            'toolbar [data-test-id="close-button"]',
            '[data-test-id="close-button"]',
            'button[aria-label*="Close"]',
            'button[aria-label*="close"]',
            'button[aria-label*="关闭"]',
        ];
        let attempted = false;
        for (const selector of selectors) {
            const button = panel?.querySelector?.(selector) || document.querySelector?.(`immersive-panel ${selector}`);
            if (button && isVisibleElement(button)) {
                attempted = true;
                try { button.click(); } catch (_) { performCanvasClick(button, 'native'); }
                break;
            }
        }
        if (!attempted) {
            try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch (_) {}
        }
        const closed = await waitUntil(() => !findOpenCanvasPanel(), CONFIG.CANVAS_CLOSE_TIMEOUT_MS, 100);
        if (!closed && attempted) {
            try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch (_) {}
            return !!(await waitUntil(() => !findOpenCanvasPanel(), 1200, 100));
        }
        return !!closed;
    }

    async function openAndExtractCanvasCandidate(candidate, item) {
        const initialEntry = candidate?.el;
        const expectedTitle = candidate?.title || getCanvasCandidateTitle(initialEntry) || 'Gemini Canvas';
        const expectedKind = candidate?.kind || inferCanvasKind(initialEntry);
        const diagnostics = { live_reacquired: false, click_attempts: [], wrong_panels: [] };

        try { initialEntry?.scrollIntoView?.({block:'center',inline:'nearest',behavior:'auto'}); } catch (_) {}
        await sleep(120);

        const liveCandidate = resolveLiveCanvasCandidate(candidate) || candidate;
        diagnostics.live_reacquired = !!(liveCandidate && liveCandidate.el !== initialEntry);
        if (!(liveCandidate?.el instanceof Element) || liveCandidate.el.isConnected === false) {
            return { artifact:null, error:`Canvas ${candidate?.source||'candidate'} 在点击前已被虚拟列表卸载，且无法重新定位：${expectedTitle}`, diagnostics };
        }

        const current = findOpenCanvasPanel();
        if (current && canvasPanelMatchesTitle(current, expectedTitle)) {
            await waitForCanvasContentReady(current, expectedKind);
            const artifact = await extractCanvasFromOpenPanel(current,item,expectedKind,expectedTitle);
            await closeCanvasPanel(current);
            return artifact ? {artifact,error:null,diagnostics} : {artifact:null,error:'Canvas 已打开，但正文/代码为空',diagnostics};
        }

        let targets = canvasCandidateClickTargets(liveCandidate);
        if (!targets.length) return {artifact:null,error:`Canvas ${candidate?.source||'candidate'} 没有安全可点击目标`,diagnostics};

        // Bounded click plan: one full native attempt on the most likely Open
        // target, then a few cheaper fallbacks. This avoids turning one failed
        // conversation into minutes of redundant synthetic clicking.
        const clickPlan = [];
        const addPlan = (mode, targetIndex, waitMs) => {
            if (targetIndex < targets.length) clickPlan.push({ mode, targetIndex, waitMs });
        };
        addPlan('native', 0, CONFIG.CANVAS_NATIVE_CLICK_WAIT_MS);
        addPlan('native', 1, CONFIG.CANVAS_FALLBACK_CLICK_WAIT_MS);
        addPlan('native', 2, CONFIG.CANVAS_FALLBACK_CLICK_WAIT_MS);
        addPlan('mouse', 0, CONFIG.CANVAS_FALLBACK_CLICK_WAIT_MS);
        addPlan('keyboard', 0, 1200);

        for (const step of clickPlan) {
            const fresh = resolveLiveCanvasCandidate(liveCandidate) || liveCandidate;
            targets = canvasCandidateClickTargets(fresh);
            const target = targets[step.targetIndex];
            if (!(target instanceof HTMLElement) || target.isConnected === false) continue;
            const attempt = { mode: step.mode, target: canvasClickTargetDescription(target), target_index: step.targetIndex + 1, panel_opened: false, matched: false, actual_title: null };
            diagnostics.click_attempts.push(attempt);
            performCanvasClick(target, step.mode);
            const opened = await waitForCanvasPanelResult(expectedTitle, step.waitMs);
            attempt.panel_opened = !!opened.panel;
            attempt.matched = !!opened.matched;
            attempt.actual_title = opened.actualTitle || null;

            if (!opened.panel) continue;
            if (!opened.matched) {
                diagnostics.wrong_panels.push({ expected: expectedTitle, actual: opened.actualTitle || 'Untitled Canvas', mode: step.mode, target: attempt.target });
                await closeCanvasPanel(opened.panel);
                continue;
            }

            await waitForCanvasContentReady(opened.panel, expectedKind);
            const artifact = await extractCanvasFromOpenPanel(opened.panel,item,expectedKind,expectedTitle);
            const closed = await closeCanvasPanel(opened.panel);
            if (!closed) diagnostics.close_warning = 'Canvas panel did not fully close before next candidate';
            if (artifact) return {artifact,error:null,diagnostics};
            return {artifact:null,error:`Canvas 面板已打开但没有解析到${expectedKind==='code'?'代码':expectedKind==='document'?'文档正文':'正文/代码'}`,diagnostics};
        }
        const wrong = diagnostics.wrong_panels.length ? `；曾打开错误面板：${diagnostics.wrong_panels.map(x=>x.actual).join(' / ')}` : '';
        return {artifact:null,error:`Canvas ${candidate?.source||'candidate'} 的安全目标均未打开匹配面板：${expectedTitle}${wrong}`,diagnostics};
    }

    function canvasDomCount(selector,outsidePanel=false){try{const nodes=Array.from(document.querySelectorAll(selector));return outsidePanel?nodes.filter(n=>!n.closest?.('immersive-panel')).length:nodes.length;}catch(_){return -1;}}
    function canvasNodeDiagnosticSample(node,source){if(!(node instanceof Element))return null;const attrs={};for(const name of ['data-test-id','data-testid','class','jslog','aria-label','title','role']){const v=node.getAttribute?.(name);if(v)attrs[name]=String(v).slice(0,500);}return {source,tag:node.tagName?.toLowerCase?.()||'',visible:isCanvasNodeUsable(node),inside_immersive_panel:!!node.closest?.('immersive-panel'),inside_model_response:!!node.closest?.('model-response'),kind:inferCanvasKind(node),title:getCanvasCandidateTitle(node),attrs,text_sample:normalizeCanvasTitle(node.innerText||node.textContent||'').slice(0,240)};}
    function collectCanvasDomDiagnostics(scroller,extra={}){const samples=[];const add=(selector,source)=>{for(const node of Array.from(document.querySelectorAll(selector))){if(samples.length>=CONFIG.CANVAS_DIAGNOSTIC_SAMPLE_LIMIT)break;const x=canvasNodeDiagnosticSample(node,source);if(x)samples.push(x);}};add('[data-test-id="gem-processing-card"]','gem-processing-card');add('immersive-entry-chip','immersive-entry-chip');add('canvas-create-button','canvas-create-button');add('model-response [class*="canvas" i]','model-response class*=canvas');let si=null;try{const p=scrollerPosition(scroller);si={tag:scroller?.tagName?.toLowerCase?.()||'',class_name:String(scroller?.className||'').slice(0,300),top:p.top,scroll_height:p.height,client_height:p.client};}catch(_){}return {captured_at:new Date().toISOString(),route:location.pathname,scroller:si,counts:{model_responses:canvasDomCount('model-response'),user_queries:canvasDomCount('user-query'),conversation_turns:canvasDomCount('.conversation-turn'),gem_processing_cards_total:canvasDomCount('[data-test-id="gem-processing-card"]'),gem_processing_cards_outside_panel:canvasDomCount('[data-test-id="gem-processing-card"]',true),immersive_entry_chips_total:canvasDomCount('immersive-entry-chip'),immersive_entry_chips_outside_panel:canvasDomCount('immersive-entry-chip',true),canvas_create_buttons_total:canvasDomCount('canvas-create-button'),canvas_create_buttons_outside_panel:canvasDomCount('canvas-create-button',true),canvas_class_nodes_in_model_response:canvasDomCount('model-response [class*="canvas" i]'),article_icons:canvasDomCount('mat-icon[fonticon="article"], mat-icon[data-mat-icon-name="article"]'),code_blocks_icons:canvasDomCount('mat-icon[fonticon="code_blocks"], mat-icon[data-mat-icon-name="code_blocks"]'),immersive_editors:canvasDomCount('immersive-editor'),prose_mirrors:canvasDomCount('immersive-editor .ProseMirror, #extended-response-markdown-content .ProseMirror'),code_immersive_panels:canvasDomCount('code-immersive-panel'),monaco_editors:canvasDomCount('.monaco-editor'),open_immersive_panels:canvasDomCount('immersive-panel')},samples,...extra};}
    function canvasHistorySignature(scroller){let p={height:0};try{p=scrollerPosition(scroller);}catch(_){}return [p.height||0,canvasDomCount('model-response'),canvasDomCount('user-query'),canvasDomCount('[data-test-id="gem-processing-card"]',true),canvasDomCount('immersive-entry-chip',true),canvasDomCount('canvas-create-button',true)].join('|');}
    function emitCanvasHistoryLoadSignals(scroller){try{setScrollerTop(scroller,0);}catch(_){}try{scroller.dispatchEvent?.(new Event('scroll',{bubbles:true,composed:true}));}catch(_){}try{scroller.dispatchEvent?.(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:CONFIG.CANVAS_HISTORY_PRELOAD_WHEEL_DELTA_Y}));}catch(_){}try{window.dispatchEvent(new Event('scroll'));}catch(_){}}
    async function preloadCanvasLazyHistory(scroller,setStatus=()=>{}){const report={attempted:true,success:false,rounds:0,stable_rounds:0,initial_signature:canvasHistorySignature(scroller),final_signature:'',initial_scroll_height:0,final_scroll_height:0};try{report.initial_scroll_height=scrollerPosition(scroller).height||0;}catch(_){}let last='',stable=0;for(let round=0;round<CONFIG.CANVAS_HISTORY_PRELOAD_MAX_ROUNDS;round++){isCancelled();emitCanvasHistoryLoadSignals(scroller);await sleep(CONFIG.CANVAS_HISTORY_PRELOAD_WAIT_MS);const sig=canvasHistorySignature(scroller);report.rounds=round+1;report.final_signature=sig;if(sig===last)stable++;else{last=sig;stable=0;}report.stable_rounds=stable;if(round===0||(round+1)%4===0)setStatus(`🧭 Canvas 历史预载 · ${round+1}/${CONFIG.CANVAS_HISTORY_PRELOAD_MAX_ROUNDS}`);if(stable>=CONFIG.CANVAS_HISTORY_PRELOAD_STABLE_ROUNDS){report.success=true;break;}}try{report.final_scroll_height=scrollerPosition(scroller).height||0;}catch(_){}return report;}

    function scrollerPosition(scroller) {
        if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
            return { top: window.scrollY || document.documentElement.scrollTop || 0, height: document.documentElement.scrollHeight, client: window.innerHeight };
        }
        return { top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight };
    }

    function setScrollerTop(scroller, top) {
        if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
            window.scrollTo(0, top);
        } else {
            scroller.scrollTop = top;
        }
    }

    async function scanCanvasArtifactsForConversation(item,setStatus,options={}){
        const result={artifacts:[],errors:[],candidates_seen:0,candidate_sources:{},candidate_attempts:[],scanned:false,history_preload:null,diagnostics_before:null,diagnostics_after:null,diagnostics_final:null};if(!CONFIG.INCLUDE_CANVAS)return result;
        const navigated=await navigateToConversationForCanvas(item,setStatus,options);if(!navigated){result.errors.push(options.allowSidebar===false?'单条 Canvas 直达续跑未落在目标对话，Canvas 未核验':'无法导航到该对话，Canvas 未核验');return result;}result.scanned=true;
        const scroller=findChatScroller(),processed=new Set(),hashes=new Set(),original=scrollerPosition(scroller).top;
        result.diagnostics_before=collectCanvasDomDiagnostics(scroller,{phase:'before_history_preload'});result.history_preload=await preloadCanvasLazyHistory(scroller,setStatus);result.diagnostics_after=collectCanvasDomDiagnostics(scroller,{phase:'after_history_preload',history_preload:result.history_preload});
        const absorb=async()=>{for(const candidate of findCanvasCandidatesInView()){isCancelled();if(processed.has(candidate.key))continue;processed.add(candidate.key);result.candidates_seen++;result.candidate_sources[candidate.source]=(result.candidate_sources[candidate.source]||0)+1;setStatus(`🎨 Canvas 检查 · ${item.title} · ${candidate.source} · ${result.candidates_seen}`);const attempt={index:result.candidates_seen,source:candidate.source,confidence:candidate.confidence,kind:candidate.kind,title:candidate.title,key:candidate.key.slice(0,500),click_target_count:canvasCandidateClickTargets(candidate).length,success:false,error:null};const {artifact,error,diagnostics:openDiagnostics}=await openAndExtractCanvasCandidate(candidate,item);attempt.open_diagnostics=openDiagnostics||null;if(error){attempt.error=error;result.candidate_attempts.push(attempt);result.errors.push(`${candidate.source} :: ${candidate.key.slice(0,120)} :: ${error}`);continue;}attempt.success=!!artifact;result.candidate_attempts.push(attempt);if(artifact&&!hashes.has(artifact.content_sha256)){hashes.add(artifact.content_sha256);artifact.index=result.artifacts.length+1;artifact.discovery_source=candidate.source;result.artifacts.push(artifact);}}};
        const open=findOpenCanvasPanel();if(open){const artifact=await extractCanvasFromOpenPanel(open,item);if(artifact&&!hashes.has(artifact.content_sha256)){hashes.add(artifact.content_sha256);artifact.index=result.artifacts.length+1;artifact.discovery_source='already-open-panel';result.artifacts.push(artifact);}await closeCanvasPanel(open);}
        setScrollerTop(scroller,0);await sleep(CONFIG.CANVAS_SCROLL_DELAY_MS);let stableBottom=0,lastTop=-1;for(let step=0;step<CONFIG.CANVAS_MAX_SCROLL_STEPS;step++){isCancelled();await absorb();const p=scrollerPosition(scroller),bottom=p.top+p.client>=p.height-8;if(bottom)stableBottom++;else stableBottom=0;if(stableBottom>=CONFIG.CANVAS_BOTTOM_STABLE_ROUNDS)break;const next=Math.min(Math.max(0,p.height-p.client),p.top+Math.max(260,p.client*.72));if(next===p.top||next===lastTop){stableBottom++;if(stableBottom>=CONFIG.CANVAS_BOTTOM_STABLE_ROUNDS)break;}lastTop=p.top;setScrollerTop(scroller,next);await sleep(CONFIG.CANVAS_SCROLL_DELAY_MS);}await absorb();result.diagnostics_final=collectCanvasDomDiagnostics(scroller,{phase:'after_full_scan',candidates_seen:result.candidates_seen,candidate_sources:result.candidate_sources,recovered_artifact_count:result.artifacts.length});try{setScrollerTop(scroller,original);}catch(_){}return result;
    }

    function languageToExtension(language) {
        const lang = String(language || '').toLowerCase();
        const map = {
            javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py',
            html: 'html', css: 'css', json: 'json', markdown: 'md', md: 'md', bash: 'sh', shell: 'sh',
            powershell: 'ps1', java: 'java', kotlin: 'kt', swift: 'swift', go: 'go', rust: 'rs',
            c: 'c', 'c++': 'cpp', cpp: 'cpp', 'c#': 'cs', csharp: 'cs', sql: 'sql', yaml: 'yaml', yml: 'yml',
        };
        return map[lang] || 'txt';
    }

    function canvasArtifactToMarkdown(artifact, item) {
        const lines = [
            `# ${artifact.title || 'Gemini Canvas'}`,
            '',
            `- Conversation: ${item.title || ''}`,
            `- Conversation ID: \`${item.chatId}\``,
            `- URL: ${buildConversationUrl(item)}`,
            `- Type: ${artifact.type}`,
        ];
        if (artifact.language) lines.push(`- Language: ${artifact.language}`);
        lines.push(`- Captured: ${artifact.captured_at || new Date().toISOString()}`, '', '---', '');
        if (artifact.type === 'code') {
            const lang = artifact.language || '';
            lines.push(`\`\`\`${lang}`, artifact.content || '', '\`\`\`', '');
        } else {
            lines.push(artifact.content || '', '');
        }
        return lines.join('\n').trim() + '\n';
    }

    function canvasFailuresToMarkdown(failures) {
        const lines = ['# Gemini Canvas Scan Failures', '', `Total failures: ${failures.length}`, ''];
        failures.forEach((f, i) => {
            lines.push(`## ${i + 1}. ${f.title || 'Unknown title'}`, '');
            lines.push(`- ID: \`${f.chat_id || f.id || ''}\``);
            lines.push(`- URL: ${f.url || ''}`);
            lines.push(`- Error: ${f.error || ''}`);
            lines.push(`- Failed at: ${f.failed_at || ''}`, '');
        });
        return lines.join('\n');
    }

    // ---------------------------- Output --------------------------------
    function blocksToMarkdown(item, blocks, meta = {}, canvases = []) {
        const lines = [];
        lines.push(`# ${item.title || 'Gemini Conversation'}`);
        lines.push('');
        lines.push(`- Conversation ID: \`${item.chatId}\``);
        lines.push(`- URL: ${buildConversationUrl(item)}`);
        lines.push(`- Exported: ${meta.exported_at || new Date().toISOString()}`);
        lines.push(`- Turns: ${blocks.length}`);
        lines.push(`- Canvas artifacts: ${canvases.length}`);
        lines.push('');
        lines.push('---');
        lines.push('');

        for (const block of blocks) {
            const u = escapeMdInline(block.userText || '').trim();
            const t = escapeMdInline(block.thoughtsText || '').trim();
            const a = escapeMdInline(block.assistantText || '').trim();
            if (u) {
                lines.push('## User', '', u, '');
            }
            if (t) {
                lines.push('## Thoughts', '', t, '');
            }
            if (a) {
                lines.push('## Assistant', '', a, '');
            }
            lines.push('---', '');
        }

        if (canvases.length) {
            lines.push('# Canvas / Artifacts', '');
            canvases.forEach((artifact, idx) => {
                lines.push(`## Canvas ${idx + 1}: ${artifact.title || 'Untitled Canvas'}`, '');
                lines.push(`- Type: ${artifact.type || 'document'}`);
                if (artifact.language) lines.push(`- Language: ${artifact.language}`);
                lines.push(`- SHA-256: \`${artifact.content_sha256 || ''}\``, '');
                if (artifact.type === 'code') {
                    lines.push(`\`\`\`${artifact.language || ''}`, artifact.content || '', '\`\`\`', '');
                } else {
                    lines.push(artifact.content || '', '');
                }
                lines.push('---', '');
            });
        }
        return lines.join('\n').trim() + '\n';
    }

    function canvasArtifactOutputStem(artifact) {
        let name = sanitizeFilename(artifact?.title || artifact?.filename || 'Canvas');
        name = name.replace(/\.(?:md|markdown|txt|html?|js|mjs|cjs|ts|tsx|jsx|py|java|kt|go|rs|cpp|c|cs|json|ya?ml|xml|css|sql|sh|ps1)$/i, '');
        return name || 'Canvas';
    }

    function uniqueBaseFilename(item, index) {
        const short = String(item.chatId || item.id).replace(/^c_/, '').slice(-12);
        const n = String(index + 1).padStart(4, '0');
        return `${n}_${sanitizeFilename(item.title)}_${short}`;
    }

    function failuresToMarkdown(failures) {
        const lines = ['# Gemini Export Failures', '', `Total failures: ${failures.length}`, ''];
        failures.forEach((f, i) => {
            lines.push(`## ${i + 1}. ${f.title || 'Unknown title'}`);
            lines.push('');
            lines.push(`- ID: \`${f.chatId || f.id}\``);
            lines.push(`- URL: ${f.url || ''}`);
            lines.push(`- Error: ${f.error || ''}`);
            lines.push(`- Failed at: ${f.failed_at || ''}`);
            lines.push('');
        });
        return lines.join('\n');
    }

    // ------------------------------ UI ----------------------------------
    function mainButtonLabel() {
        return 'Gemini 导出（单个 / 全量）';
    }

    function escapeHtmlUi(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatListTime(ms) {
        if (!ms) return '';
        try { return new Date(ms).toLocaleString(); } catch (_) { return String(ms); }
    }

    function style(el, props) {
        Object.assign(el.style, props);
        return el;
    }

    function makeButton(text, props = {}) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        style(b, {
            cursor: 'pointer',
            fontFamily: 'Arial, sans-serif',
            ...props,
        });
        return b;
    }

    function makeText(tag, text, props = {}) {
        const el = document.createElement(tag);
        el.textContent = text;
        style(el, props);
        return el;
    }

    function showExportModeDialog() {
        if (running) return;
        try {
            const old = document.getElementById('gue-export-mode-overlay');
            if (old) old.remove();

            const overlay = style(document.createElement('div'), {
                position: 'fixed', inset: '0', zIndex: '2147483647',
                background: 'rgba(0,0,0,.52)', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
            });
            overlay.id = 'gue-export-mode-overlay';

            const dialog = style(document.createElement('div'), {
                width: '520px', maxWidth: '92vw', background: '#fff', color: '#202124',
                borderRadius: '14px', padding: '20px', boxSizing: 'border-box',
                fontFamily: 'Arial, sans-serif', boxShadow: '0 14px 50px rgba(0,0,0,.32)',
            });

            dialog.appendChild(makeText('div', 'Gemini 对话导出', {
                fontSize: '19px', fontWeight: '700', marginBottom: '6px'
            }));
            dialog.appendChild(makeText('div',
                '单个模式只抓你选中的 1 条完整详情和 Canvas；全量模式才会逐条抓整个账号。两种模式使用同一套导出管线。',
                { fontSize: '13px', color: '#5f6368', lineHeight: '1.55', marginBottom: '16px' }
            ));

            const stack = style(document.createElement('div'), {
                display: 'flex', flexDirection: 'column', gap: '10px'
            });

            const single = makeButton('单个对话导出（推荐先测试 Canvas）', {
                padding: '14px', textAlign: 'left', border: '1px solid #1a73e8',
                borderRadius: '10px', background: '#e8f0fe', width: '100%',
                color: '#174ea6', fontWeight: '700', fontSize: '15px',
            });
            single.id = 'gue-single-export-btn';
            single.title = '先获取对话列表，再搜索并选择 1 条；只请求这一条详情。';

            const full = makeButton('全量导出', {
                padding: '14px', textAlign: 'left', border: '1px solid #dadce0',
                borderRadius: '10px', background: '#f8f9fa', width: '100%',
                color: '#202124', fontWeight: '700', fontSize: '15px',
            });
            full.id = 'gue-full-export-btn';
            full.title = '获取列表后，逐条导出全部历史。';

            stack.appendChild(single);
            stack.appendChild(full);
            dialog.appendChild(stack);

            const footer = style(document.createElement('div'), {
                display: 'flex', justifyContent: 'flex-end', marginTop: '16px'
            });
            const cancel = makeButton('取消', {
                padding: '9px 14px', border: '1px solid #dadce0',
                borderRadius: '8px', background: '#fff'
            });
            cancel.id = 'gue-mode-cancel-btn';
            footer.appendChild(cancel);
            dialog.appendChild(footer);

            const close = () => overlay.remove();
            single.addEventListener('click', () => {
                close();
                startFullExport({ mode: 'single' });
            });
            full.addEventListener('click', () => {
                close();
                startFullExport({ mode: 'full' });
            });
            cancel.addEventListener('click', close);
            const openedAt = performance.now();
            overlay.addEventListener('click', e => {
                // A rapid second click from a double-click on the fixed launcher can
                // land on the freshly-created backdrop. Ignore that initial click.
                if (e.target === overlay && performance.now() - openedAt > 350) close();
            });

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            console.info('[Gemini Universal Exporter] mode dialog opened');
        } catch (error) {
            console.error('[Gemini Universal Exporter] failed to open mode dialog', error);
            alert(`Gemini 导出器 UI 打开失败：${error?.message || error}`);
        }
    }

    function showSingleConversationDialog(items) {
        return new Promise(resolve => {
            try {
                const old = document.getElementById('gue-single-select-overlay');
                if (old) old.remove();

                const overlay = style(document.createElement('div'), {
                    position: 'fixed', inset: '0', zIndex: '2147483647',
                    background: 'rgba(0,0,0,.52)', display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                });
                overlay.id = 'gue-single-select-overlay';

                const dialog = style(document.createElement('div'), {
                    background: '#fff', color: '#202124', width: '780px', maxWidth: '94vw',
                    height: '760px', maxHeight: '88vh', borderRadius: '14px',
                    boxShadow: '0 14px 50px rgba(0,0,0,.32)', padding: '18px',
                    boxSizing: 'border-box', fontFamily: 'Arial, sans-serif',
                    display: 'flex', flexDirection: 'column', gap: '11px',
                });

                dialog.appendChild(makeText('div', '选择 1 条 Gemini 对话', {
                    fontSize: '18px', fontWeight: '700', marginBottom: '2px'
                }));
                dialog.appendChild(makeText('div',
                    `已通过 MaZiqc 加载 ${items.length} 条唯一历史记录。这里只加载列表；选择后才请求这一条完整详情和 Canvas。`,
                    { fontSize: '13px', color: '#5f6368', lineHeight: '1.45' }
                ));

                const search = document.createElement('input');
                search.type = 'search';
                search.placeholder = '搜索标题或对话 ID，例如：20260109健身';
                style(search, {
                    padding: '9px 10px', border: '1px solid #dadce0',
                    borderRadius: '8px', fontSize: '14px',
                });
                dialog.appendChild(search);

                const status = makeText('div', '', { fontSize: '12px', color: '#5f6368' });
                dialog.appendChild(status);

                const list = style(document.createElement('div'), {
                    flex: '1', overflow: 'auto', border: '1px solid #dadce0',
                    borderRadius: '9px', background: '#f8f9fa', padding: '5px',
                });
                dialog.appendChild(list);

                const footer = style(document.createElement('div'), {
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px'
                });
                footer.appendChild(makeText('div',
                    '单个测试只会抓 1 条详情，不会循环请求整个账号。',
                    { fontSize: '12px', color: '#5f6368' }
                ));
                const actions = style(document.createElement('div'), { display: 'flex', gap: '8px' });
                const cancel = makeButton('取消', {
                    padding: '9px 13px', border: '1px solid #dadce0',
                    borderRadius: '8px', background: '#fff'
                });
                const startBtn = makeButton('导出这一条', {
                    padding: '9px 13px', border: 'none', borderRadius: '8px',
                    background: '#1a73e8', color: '#fff', fontWeight: '700'
                });
                startBtn.disabled = true;
                startBtn.style.opacity = '.55';
                actions.appendChild(cancel);
                actions.appendChild(startBtn);
                footer.appendChild(actions);
                dialog.appendChild(footer);

                overlay.appendChild(dialog);
                document.body.appendChild(overlay);

                let selectedId = null;
                let visibleItems = items.slice();

                function render() {
                    const q = search.value.trim().toLowerCase();
                    visibleItems = q
                        ? items.filter(it =>
                            String(it.title || '').toLowerCase().includes(q) ||
                            String(it.chatId || it.id || '').toLowerCase().includes(q)
                        )
                        : items.slice();

                    while (list.firstChild) list.removeChild(list.firstChild);

                    if (!visibleItems.length) {
                        list.appendChild(makeText('div', '没有匹配结果', {
                            padding: '20px', color: '#80868b'
                        }));
                    } else {
                        for (const it of visibleItems) {
                            const row = style(document.createElement('label'), {
                                display: 'flex', gap: '10px', alignItems: 'flex-start',
                                padding: '9px', borderBottom: '1px solid #e8eaed',
                                cursor: 'pointer', background: '#fff',
                            });

                            const radio = document.createElement('input');
                            radio.type = 'radio';
                            radio.name = 'gue-single-conversation';
                            radio.value = String(it.id);
                            radio.checked = selectedId === String(it.id);
                            radio.style.marginTop = '4px';

                            const info = style(document.createElement('div'), { minWidth: '0' });
                            info.appendChild(makeText('div', it.title || 'Untitled Conversation', {
                                fontSize: '14px', fontWeight: '600', whiteSpace: 'nowrap',
                                overflow: 'hidden', textOverflow: 'ellipsis'
                            }));
                            const time = formatListTime(it.updatedAt);
                            if (time) info.appendChild(makeText('div', time, {
                                fontSize: '12px', color: '#80868b'
                            }));
                            info.appendChild(makeText('div', it.chatId || it.id, {
                                fontSize: '11px', color: '#9aa0a6', fontFamily: 'monospace'
                            }));

                            radio.addEventListener('change', () => {
                                if (!radio.checked) return;
                                selectedId = String(it.id);
                                startBtn.disabled = false;
                                startBtn.style.opacity = '1';
                                status.textContent = `当前显示 ${visibleItems.length} 条；已选择：${it.title || it.id}`;
                            });

                            row.appendChild(radio);
                            row.appendChild(info);
                            list.appendChild(row);
                        }
                    }

                    status.textContent = selectedId
                        ? `当前显示 ${visibleItems.length} 条；已选择 1 条`
                        : `当前显示 ${visibleItems.length} 条；尚未选择`;
                }

                search.addEventListener('input', render);
                cancel.addEventListener('click', () => {
                    overlay.remove();
                    resolve(null);
                });
                startBtn.addEventListener('click', () => {
                    const selected = items.find(it => String(it.id) === selectedId);
                    if (!selected) return;
                    overlay.remove();
                    resolve(selected);
                });
                const openedAt = performance.now();
                overlay.addEventListener('click', e => {
                    if (e.target === overlay && performance.now() - openedAt > 350) {
                        overlay.remove();
                        resolve(null);
                    }
                });

                render();
                setTimeout(() => search.focus(), 50);
                console.info('[Gemini Universal Exporter] single-select dialog opened', {
                    count: items.length
                });
            } catch (error) {
                console.error('[Gemini Universal Exporter] failed to open single-select dialog', error);
                alert(`Gemini 单条选择器打开失败：${error?.message || error}`);
                resolve(null);
            }
        });
    }

    function createUI() {
        if (document.getElementById(CONFIG.PANEL_ID)) return;

        const panel = document.createElement('div');
        panel.id = CONFIG.PANEL_ID;
        Object.assign(panel.style, {
            position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483646',
            display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px',
            fontFamily: 'Arial, sans-serif',
        });

        const status = document.createElement('div');
        status.id = `${CONFIG.PANEL_ID}-status`;
        Object.assign(status.style, {
            display: 'none', maxWidth: '440px', padding: '9px 12px', borderRadius: '10px',
            background: 'rgba(32,33,36,.94)', color: '#fff', fontSize: '12px', lineHeight: '1.45',
            boxShadow: '0 4px 18px rgba(0,0,0,.25)', wordBreak: 'break-word',
        });

        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', gap: '8px', alignItems: 'center' });

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        Object.assign(cancelBtn.style, {
            display: 'none', border: '1px solid #dadce0', background: '#fff', color: '#3c4043',
            borderRadius: '20px', padding: '9px 13px', cursor: 'pointer', fontSize: '12px',
        });
        cancelBtn.onclick = () => {
            if (running) {
                cancelled = true;
                cancelBtn.disabled = true;
                cancelBtn.textContent = '正在停止…';
            }
        };

        const btn = document.createElement('button');
        btn.id = CONFIG.BUTTON_ID;
        btn.textContent = mainButtonLabel();
        Object.assign(btn.style, {
            border: 'none', background: '#1a73e8', color: '#fff', fontWeight: '700',
            borderRadius: '22px', padding: '11px 16px', cursor: 'pointer', fontSize: '13px',
            boxShadow: '0 4px 16px rgba(0,0,0,.24)',
        });
        btn.addEventListener('click', () => {
            console.info('[Gemini Universal Exporter] main button clicked', { running });
            if (running) return;
            try {
                showExportModeDialog();
            } catch (error) {
                console.error('[Gemini Universal Exporter] main button handler failed', error);
                alert(`Gemini 导出按钮执行失败：${error?.message || error}`);
            }
        });

        row.appendChild(cancelBtn);
        row.appendChild(btn);
        panel.appendChild(status);
        panel.appendChild(row);
        document.body.appendChild(panel);
    }

    function uiRefs() {
        return {
            btn: document.getElementById(CONFIG.BUTTON_ID),
            status: document.getElementById(`${CONFIG.PANEL_ID}-status`),
            cancel: document.querySelector(`#${CONFIG.PANEL_ID} button:not(#${CONFIG.BUTTON_ID})`),
        };
    }

    function setStatus(text) {
        const { status } = uiRefs();
        if (!status) return;
        status.style.display = 'block';
        status.textContent = text;
    }

    // -------------------------- Export pipeline --------------------------
    async function startFullExport(options = {}) {
        if (running) return;
        const mode = options.mode === 'single' ? 'single' : 'full';
        const directItem = options.directItem || null;
        const resumeCanvas = !!options.resumeCanvas;
        const resumeRoute = options.resumeRoute || null;

        running = true;
        cancelled = false;
        const { btn, cancel } = uiRefs();
        btn.disabled = true;
        btn.textContent = '准备中…';
        cancel.style.display = 'inline-block';
        cancel.disabled = false;
        cancel.textContent = '取消';

        const failures = [];
        const successes = [];
        const suspiciousDuplicates = [];
        const canvasManifest = [];
        const canvasSuspects = [];
        const canvasDomFallbackManifest = [];
        const canvasDomDiagnostics = [];
        const parseSuspects = [];
        const bodyHashToIds = new Map();
        let listDiagnostics = [];

        try {
            if (typeof JSZip === 'undefined') throw new Error('JSZip 未加载。请检查网络或油猴 @require。');

            const session = await getFreshGeminiSession(setStatus);
            let allItems = [];
            let items = [];
            if (directItem) {
                allItems = Array.isArray(options.allItems) && options.allItems.length ? options.allItems : [directItem];
                listDiagnostics = Array.isArray(options.listDiagnostics) ? options.listDiagnostics : [{ mode: 'single-resume', note: 'Resume skipped MaZiqc to minimize requests.' }];
                allItems.forEach(x => metaById.set(x.id, x));
                items = [directItem];
                setStatus(`🔁 续跑单条 Canvas · ${directItem.title}`);
            } else {
                const listed = await listAllConversationsRpc(session, setStatus);
                allItems = listed.items; listDiagnostics = listed.diagnostics; allItems.forEach(x => metaById.set(x.id, x));
                if (!allItems.length) throw new Error('MaZiqc 没有返回任何历史对话。');
                if (mode === 'single') {
                    setStatus(`📋 已获取 ${allItems.length} 条对话列表，等待选择 1 条…`);
                    const selected = await showSingleConversationDialog(allItems); if (!selected) throw new Error('用户已取消导出');
                    items = [selected];
                    if (!confirm(`只导出这一条？\n\n${selected.title}\nID: ${selected.chatId}\n\n` + '将请求 1 条完整 hNvQHb 详情；若检测到 Canvas 缺口，会直接跳转到该对话并自动续跑，不再通过侧栏导航。')) throw new Error('用户已取消导出');
                } else {
                    items = allItems;
                    if (!confirm(`RPC 已发现 ${items.length} 条唯一 Gemini 历史对话。\n\n` + '全量模式将逐条请求所有详情；建议先用“单个对话导出”验证 Canvas。\n\n现在开始全量导出？')) throw new Error('用户已取消导出');
                }
            }

            const zip = new JSZip();
            const convFolder = zip.folder('Conversations');
            const canvasRoot = CONFIG.INCLUDE_CANVAS ? zip.folder('Canvas') : null;
            const rawFolder = CONFIG.INCLUDE_RAW_PAYLOADS ? zip.folder('RawPayloads') : null;

            for (let i = 0; i < items.length; i++) {
                isCancelled();
                let item = items[i];
                // If the browser is already on this conversation, enrich the
                // MaZiqc item with the actual route. This is especially important
                // for Gem chats whose canonical UI route is /gem/<gemId>/<chatId>.
                if (mode === 'single') {
                    const resolvedHere = resolveCurrentConversationItem(item);
                    if (resolvedHere) {
                        item = resolvedHere;
                        items[i] = resolvedHere;
                    }
                }
                btn.textContent = mode === 'single' ? '导出单条 1/1' : `导出 ${i + 1}/${items.length}`;
                setStatus(`${mode === 'single' ? '🧪 单条测试' : '📥'} ${i + 1}/${items.length} · ${item.title}`);

                try {
                    const detailPayloads = await fetchAllConversationPayloads(session, item, setStatus);
                    if (!detailPayloads.length) throw new Error('hNvQHb 未返回任何详情 payload。');
                    const parsed = parseConversationDetailPayloads(detailPayloads);
                    if (!parsed.blocks.length && !parsed.canvases.length) {
                        throw new Error('详情 RPC 有返回，但没有解析出任何文字轮次或 Canvas；为避免静默坏备份，本条记为失败。');
                    }

                    for (const artifact of parsed.canvases) {
                        artifact.content_sha256 = await sha256Hex(artifact.content || '');
                    }

                    // v0.3.1: RPC tells us *where Canvas probably exists* very
                    // reliably, but not every Gemini build returns the Canvas
                    // document body in candidate[30]. For those suspect chats,
                    // perform a targeted UI recovery instead of DOM-scanning all
                    // history. This is the path expected to recover e.g.
                    // "20260109健身" -> "力量掌控者：睡眠脊柱力学与被动支撑协议.md".
                    let domCanvasFallback = null;
                    if (
                        CONFIG.INCLUDE_CANVAS &&
                        CONFIG.CANVAS_DOM_FALLBACK_FOR_SUSPECTS &&
                        parsed.canvas_possible_miss_count > 0
                    ) {
                        if (mode === 'single' && !pathMatchesConversation(item)) {
                            if (resumeCanvas) throw new Error(`Canvas 续跑路由校验失败：当前 ${location.pathname}，目标 ${item.sourcePath}`);
                            const requestedItem = {
                                ...item,
                                requestedKind: item.requestedKind || item.kind || 'app',
                                requestedSourcePath: item.requestedSourcePath || item.sourcePath,
                                requestedUrl: buildRequestedConversationUrl(item),
                            };
                            const persisted = writeSingleCanvasResumeTask({
                                item: requestedItem,
                                allItems,
                                listDiagnostics,
                                discovered_count: allItems.length,
                                requested_url: requestedItem.requestedUrl,
                            });
                            if (!persisted) throw new Error('无法写入 sessionStorage，不能安全执行单条 Canvas 直达续跑。');
                            setStatus(`🧭 Canvas 需要页面上下文，正在直达 ${item.title} 并自动续跑…`);
                            directNavigateToConversation(item, setStatus);
                            return;
                        }
                        setStatus(`🎨 RPC 检测到 Canvas 缺口，开始 UI 补抓 · ${item.title}`);
                        try {
                            domCanvasFallback = await scanCanvasArtifactsForConversation(item, setStatus, { allowSidebar: mode !== 'single' });
                        } catch (canvasError) {
                            domCanvasFallback = {
                                artifacts: [],
                                errors: [canvasError?.message || String(canvasError)],
                                candidates_seen: 0, candidate_sources: {}, candidate_attempts: [], scanned: false,
                                history_preload: null, diagnostics_before: null, diagnostics_after: null, diagnostics_final: null,
                            };
                        }

                        const existingCanvasHashes = new Set(
                            parsed.canvases.map(x => x.content_sha256).filter(Boolean)
                        );
                        for (const recovered of domCanvasFallback.artifacts || []) {
                            if (!recovered.content_sha256) {
                                recovered.content_sha256 = await sha256Hex(recovered.content || '');
                            }
                            if (!recovered.content_sha256 || existingCanvasHashes.has(recovered.content_sha256)) continue;
                            existingCanvasHashes.add(recovered.content_sha256);
                            recovered.turn_index = recovered.turn_index ?? null;
                            parsed.canvases.push(recovered);
                        }

                        canvasDomFallbackManifest.push({
                            conversation_id: item.chatId,
                            title: item.title,
                            url: buildConversationUrl(item),
                            requested_url: buildRequestedConversationUrl(item),
                            kind: item.kind || 'app',
                            gem_id: item.gemId || null,
                            route_redirected: !!item.routeRedirected,
                            rpc_possible_miss_count: parsed.canvas_possible_miss_count,
                            scanned: !!domCanvasFallback.scanned,
                            candidates_seen: domCanvasFallback.candidates_seen || 0,
                            candidate_sources: domCanvasFallback.candidate_sources || {},
                            history_preload: domCanvasFallback.history_preload || null,
                            recovered_artifact_count: (domCanvasFallback.artifacts || []).length,
                            errors: domCanvasFallback.errors || [],
                        });
                        canvasDomDiagnostics.push({conversation_id:item.chatId,title:item.title,url:buildConversationUrl(item),requested_url:buildRequestedConversationUrl(item),rpc_possible_miss_count:parsed.canvas_possible_miss_count,scanned:!!domCanvasFallback.scanned,candidates_seen:domCanvasFallback.candidates_seen||0,candidate_sources:domCanvasFallback.candidate_sources||{},candidate_attempts:domCanvasFallback.candidate_attempts||[],history_preload:domCanvasFallback.history_preload||null,diagnostics_before:domCanvasFallback.diagnostics_before||null,diagnostics_after:domCanvasFallback.diagnostics_after||null,diagnostics_final:domCanvasFallback.diagnostics_final||null,recovered_artifact_count:(domCanvasFallback.artifacts||[]).length,errors:domCanvasFallback.errors||[]});
                    }

                    const transcriptSig = normalizedTranscriptSignature(parsed.blocks) + '\nCANVAS\n' + parsed.canvases.map(c => c.content || '').join('\n---\n');
                    const bodyHash = await sha256Hex(transcriptSig);
                    const previousIds = bodyHashToIds.get(bodyHash) || [];
                    if (previousIds.length) {
                        suspiciousDuplicates.push({
                            id: item.id, chatId: item.chatId, title: item.title,
                            duplicate_of: previousIds.slice(), hash: bodyHash, url: buildConversationUrl(item),
                        });
                    }
                    previousIds.push(item.id);
                    bodyHashToIds.set(bodyHash, previousIds);

                    if (parsed.canvas_possible_miss_count > 0) {
                        const recoveredCount = (domCanvasFallback?.artifacts || []).length;
                        const fallbackErrors = domCanvasFallback?.errors || [];
                        if (recoveredCount === 0 || fallbackErrors.length > 0) {
                            canvasSuspects.push({
                                conversation_id: item.chatId,
                                title: item.title,
                                url: buildConversationUrl(item),
                                turns_with_canvas_marker_but_incomplete_structured_canvas: parsed.canvas_possible_miss_count,
                                dom_fallback_scanned: !!domCanvasFallback?.scanned,
                                dom_candidates_seen: domCanvasFallback?.candidates_seen || 0,
                                dom_candidate_sources: domCanvasFallback?.candidate_sources || {},
                                dom_history_preload: domCanvasFallback?.history_preload || null,
                                dom_recovered_artifact_count: recoveredCount,
                                dom_errors: fallbackErrors,
                                note: recoveredCount > 0
                                    ? 'DOM 已恢复部分 Canvas，但扫描仍有错误；建议人工抽查。'
                                    : 'RPC 有 Canvas 标记，但 RPC/DOM 均未恢复正文；此备份不能视为 Canvas 完整。',
                            });
                        }
                    }
                    if (parsed.unparsed_turn_count > 0) {
                        parseSuspects.push({
                            conversation_id: item.chatId,
                            title: item.title,
                            url: buildConversationUrl(item),
                            raw_turn_count: parsed.raw_turn_count,
                            parsed_turn_count: parsed.parsed_turn_count,
                            unparsed_turn_count: parsed.unparsed_turn_count,
                            note: 'RPC returned one or more turns whose text/Canvas shape was not fully recognized; review this conversation before treating the backup as complete.',
                        });
                    }

                    const exportedAt = new Date().toISOString();
                    const normalized = {
                        schema_version: 3,
                        platform: 'Google Gemini',
                        id: item.id,
                        chat_id: item.chatId,
                        raw_chat_id: item.rawId || `c_${item.chatId}`,
                        kind: item.kind || 'app',
                        gem_id: item.gemId || null,
                        title: item.title,
                        updated_at_ms: item.updatedAt || null,
                        requested_source_path: item.requestedSourcePath || null,
                        source_path: item.sourcePath,
                        requested_url: buildRequestedConversationUrl(item),
                        url: buildConversationUrl(item),
                        route_redirected: !!item.routeRedirected,
                        exported_at: exportedAt,
                        body_sha256: bodyHash,
                        transport: {
                            list_rpc: CONFIG.LIST_RPC_ID,
                            detail_rpc: CONFIG.DETAIL_RPC_ID,
                            canvas_source: 'hNvQHb markers + Ophel/Voyager-style Gemini Canvas DOM recovery',
                        },
                        raw_turn_count: parsed.raw_turn_count,
                        parsed_turn_count: parsed.parsed_turn_count,
                        unparsed_turn_count: parsed.unparsed_turn_count,
                        canvas_artifact_count: parsed.canvases.length,
                        canvas_possible_miss_count: parsed.canvas_possible_miss_count,
                        canvas_dom_fallback: domCanvasFallback ? {
                            scanned: !!domCanvasFallback.scanned,
                            candidates_seen: domCanvasFallback.candidates_seen || 0,
                            recovered_artifact_count: (domCanvasFallback.artifacts || []).length,
                            errors: domCanvasFallback.errors || [],
                        } : null,
                        blocks: parsed.blocks,
                        turns: parsed.parsedTurns,
                        canvas: parsed.canvases,
                    };

                    const base = uniqueBaseFilename(item, i);
                    convFolder.file(`${base}.json`, JSON.stringify(normalized, null, 2));
                    convFolder.file(`${base}.md`, blocksToMarkdown(item, parsed.blocks, { exported_at: exportedAt }, parsed.canvases));
                    if (rawFolder) rawFolder.file(`${base}.payload.json`, JSON.stringify(detailPayloads, null, 2));

                    if (canvasRoot && parsed.canvases.length) {
                        const perConv = canvasRoot.folder(base);
                        for (let c = 0; c < parsed.canvases.length; c++) {
                            const artifact = parsed.canvases[c];
                            const num = String(c + 1).padStart(2, '0');
                            const canvasBase = `${num}_${canvasArtifactOutputStem(artifact)}`;
                            perConv.file(`${canvasBase}.json`, JSON.stringify(artifact, null, 2));
                            perConv.file(`${canvasBase}.md`, canvasArtifactToMarkdown({
                                ...artifact,
                                captured_at: exportedAt,
                            }, item));
                            if (artifact.type === 'code') {
                                const ext = artifact.filename?.includes('.') ? artifact.filename.split('.').pop() : languageToExtension(artifact.language);
                                perConv.file(`${canvasBase}.${sanitizeFilename(ext || 'txt')}`, artifact.content || '');
                            }
                            canvasManifest.push({
                                conversation_id: item.chatId,
                                conversation_title: item.title,
                                conversation_url: buildConversationUrl(item),
                                turn_index: artifact.turn_index,
                                index: c + 1,
                                type: artifact.type,
                                title: artifact.title,
                                filename: artifact.filename,
                                language: artifact.language || null,
                                document_id: artifact.document_id || null,
                                source: artifact.source || 'hNvQHb_structured',
                                content_sha256: artifact.content_sha256,
                                folder: `Canvas/${base}/`,
                            });
                        }
                    }

                    successes.push({
                        id: item.id,
                        chat_id: item.chatId,
                        title: item.title,
                        url: buildConversationUrl(item),
                        raw_turn_count: parsed.raw_turn_count,
                        parsed_turn_count: parsed.parsed_turn_count,
                        unparsed_turn_count: parsed.unparsed_turn_count,
                        canvas_artifact_count: parsed.canvases.length,
                        canvas_possible_miss_count: parsed.canvas_possible_miss_count,
                        body_sha256: bodyHash,
                        exported_at: exportedAt,
                    });
                } catch (e) {
                    if (/用户已取消/.test(String(e?.message || e))) throw e;
                    console.error('[Gemini Universal Exporter] failed', item, e);
                    failures.push({
                        id: item.id, chatId: item.chatId, title: item.title,
                        url: buildConversationUrl(item),
                        requested_url: buildRequestedConversationUrl(item),
                        kind: item.kind || 'app',
                        gem_id: item.gemId || null,
                        route_redirected: !!item.routeRedirected,
                        error: e?.message || String(e), failed_at: new Date().toISOString(),
                    });
                }

                // Do not sleep after the final item. This matters especially in
                // single-conversation mode: the old build added a pointless 2.5–5.5s
                // wait and left a cancellation window before ZIP generation.
                if (i + 1 < items.length) await sleep(detailJitter());
                if (CONFIG.LONG_COOLDOWN_EVERY > 0 && i + 1 < items.length && (i + 1) % CONFIG.LONG_COOLDOWN_EVERY === 0) {
                    const cool = randomBetween(CONFIG.LONG_COOLDOWN_MIN_MS, CONFIG.LONG_COOLDOWN_MAX_MS);
                    setStatus(`☕ 主动冷却 ${Math.round(cool / 1000)} 秒 · 已完成 ${i + 1}/${items.length}`);
                    await sleep(cool);
                }
            }

            const manifest = {
                schema_version: 3,
                exporter: 'Gemini Universal Exporter',
                exporter_version: '0.4.3',
                export_mode: mode,
                resumed_after_direct_navigation: resumeCanvas,
                direct_navigation: resumeCanvas ? {
                    requested_url: resumeRoute?.requested_url || directItem?.requestedUrl || buildRequestedConversationUrl(directItem),
                    resolved_url: resumeRoute?.resolved_url || directItem?.resolvedUrl || `${location.origin}${location.pathname}`,
                    route_redirected: resumeRoute?.route_redirected ?? !!directItem?.routeRedirected,
                    resolved_kind: resumeRoute?.resolved_kind || directItem?.kind || null,
                    gem_id: resumeRoute?.gem_id || directItem?.gemId || null,
                    conversation_id: directItem?.chatId || null,
                } : null,
                exported_at: new Date().toISOString(),
                account_prefix: session.accountPrefix || null,
                discovered_count: allItems.length,
                requested_export_count: items.length,
                success_count: successes.length,
                failure_count: failures.length,
                suspicious_duplicate_count: suspiciousDuplicates.length,
                canvas_artifact_count: canvasManifest.length,
                canvas_conversation_count: new Set(canvasManifest.map(x => x.conversation_id)).size,
                canvas_suspect_conversation_count: canvasSuspects.length,
                parse_suspect_conversation_count: parseSuspects.length,
                include_raw_payloads: CONFIG.INCLUDE_RAW_PAYLOADS,
                transport: {
                    history: 'MaZiqc batchexecute',
                    detail: 'hNvQHb batchexecute with cursor pagination',
                    canvas: 'hNvQHb structured Canvas + tiered Ophel/Voyager discovery (processing-card/entry-chip/create-button) + ProseMirror/Monaco recovery',
                    dom_history_required: false,
                    dom_canvas_navigation_required: canvasDomFallbackManifest.length > 0,
                },
                pacing: {
                    detail_delay_ms: [CONFIG.DETAIL_DELAY_MIN, CONFIG.DETAIL_DELAY_MAX],
                    long_cooldown_every: CONFIG.LONG_COOLDOWN_EVERY,
                    max_retries: CONFIG.MAX_RETRIES,
                },
                successes,
            };

            zip.file('_export_manifest.json', JSON.stringify(manifest, null, 2));
            zip.file('_rpc_list_diagnostics.json', JSON.stringify(listDiagnostics, null, 2));
            zip.file('_conversation_list.json', JSON.stringify(allItems.map(x => {
                const selectedItem = items.find(sel => sel.id === x.id);
                return {
                    id: x.id, raw_id: x.rawId, title: x.title, updated_at_ms: x.updatedAt,
                    source_path: x.sourcePath, url: buildConversationUrl(x), discovery: x.discovery,
                    selected_for_export: !!selectedItem,
                    resolved_source_path: selectedItem?.resolvedSourcePath || null,
                    resolved_url: selectedItem?.resolvedUrl || null,
                    resolved_kind: selectedItem?.kind || null,
                    gem_id: selectedItem?.gemId || null,
                };
            }), null, 2));
            if (failures.length) {
                zip.file('_export_failures.json', JSON.stringify(failures, null, 2));
                zip.file('_export_failures.md', failuresToMarkdown(failures));
            }
            if (suspiciousDuplicates.length) zip.file('_suspicious_duplicate_bodies.json', JSON.stringify(suspiciousDuplicates, null, 2));
            zip.file('_canvas_manifest.json', JSON.stringify({
                exported_at: new Date().toISOString(),
                artifact_count: canvasManifest.length,
                conversation_count: new Set(canvasManifest.map(x => x.conversation_id)).size,
                artifacts: canvasManifest,
            }, null, 2));
            if (canvasDomFallbackManifest.length) {
                zip.file('_canvas_dom_fallback_manifest.json', JSON.stringify({
                    exported_at: new Date().toISOString(),
                    conversations_scanned: canvasDomFallbackManifest.length,
                    recovered_artifact_count: canvasDomFallbackManifest.reduce((n, x) => n + (x.recovered_artifact_count || 0), 0),
                    items: canvasDomFallbackManifest,
                }, null, 2));
            }
            if (canvasDomDiagnostics.length) zip.file('_canvas_dom_diagnostics.json', JSON.stringify({exported_at:new Date().toISOString(),schema_version:1,note:'Detailed DOM/lazy-history/candidate diagnostics. Generic class*=canvas nodes are diagnostics-only and never clicked.',items:canvasDomDiagnostics}, null, 2));
            if (canvasSuspects.length) zip.file('_canvas_suspects.json', JSON.stringify(canvasSuspects, null, 2));
            if (parseSuspects.length) zip.file('_parse_suspects.json', JSON.stringify(parseSuspects, null, 2));

            // Final cancellation gate: if the user cancels after the last
            // detail request but before packaging, do not silently generate a ZIP.
            isCancelled();
            setStatus('📦 正在压缩 ZIP…');
            btn.textContent = '生成 ZIP…';
            const blob = await zip.generateAsync({
                type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 },
            }, meta => setStatus(`📦 压缩 ZIP ${meta.percent.toFixed(1)}%`));

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outputName = mode === 'single'
                ? `gemini_single_${sanitizeFilename(items[0]?.title || items[0]?.chatId || 'conversation')}_${stamp}.zip`
                : `gemini_full_history_rpc_${stamp}.zip`;
            downloadFile(blob, outputName);

            const domRecovered = canvasDomFallbackManifest.reduce((n, x) => n + (x.recovered_artifact_count || 0), 0);
            const modeLabel = mode === 'single' ? '单个对话导出' : '全量导出';
            const summary = `✅ Gemini ${modeLabel}完成：列表发现 ${allItems.length} 条，本次 ${items.length} 条，成功 ${successes.length} 条，失败 ${failures.length} 条；Canvas ${canvasManifest.length} 份（其中 DOM 补抓 ${domRecovered} 份）` +
                (canvasSuspects.length ? `；仍有 Canvas 未完全解析 ${canvasSuspects.length} 个对话` : '') +
                (parseSuspects.length ? `；存在未完全解析 turn 的对话 ${parseSuspects.length} 个` : '') +
                (suspiciousDuplicates.length ? `；正文重复疑点 ${suspiciousDuplicates.length} 条` : '') + '。';
            setStatus(summary);
            alert(summary +
                (failures.length ? '\n\n失败项：_export_failures.md / .json' : '') +
                (canvasDomFallbackManifest.length ? '\nCanvas DOM 补抓：_canvas_dom_fallback_manifest.json' : '') +
                (canvasSuspects.length ? '\nCanvas 仍未完整：_canvas_suspects.json' : '') +
                (parseSuspects.length ? '\nTurn 解析可疑项：_parse_suspects.json' : '') +
                '\nRPC 列表诊断：_rpc_list_diagnostics.json');
        } catch (e) {
            const msg = e?.message || String(e);
            if (/用户已取消/.test(msg)) {
                setStatus('⏹️ 导出已取消；本次未生成最终 ZIP。');
            } else {
                console.error('[Gemini Universal Exporter] fatal:', e);
                setStatus(`⚠️ 导出中止：${msg}`);
                alert(`Gemini 导出失败：${msg}\n\n详情可查看 F12 → Console。`);
            }
        } finally {
            if (resumeCanvas) clearSingleCanvasResumeTask();
            running = false;
            cancelled = false;
            btn.disabled = false;
            btn.textContent = mainButtonLabel();
            cancel.style.display = 'none';
        }
    }

    try {
        window.GeminiUniversalExporter = Object.freeze({
            showDialog: showExportModeDialog,
            startSingleExport: () => startFullExport({ mode: 'single' }),
            startFullExport: () => startFullExport({ mode: 'full' }),
        });
    } catch (_) {}

    // Test hooks contain parser/pagination logic only; no account data/tokens.
    try {
        window.__GUE_TEST_HOOKS__ = Object.freeze({
            extractSessionFromHtml,
            extractRpcPayloadsRobust,
            parseListPayload,
            chooseListPage,
            listAllConversationsRpc,
            extractCanvasListFromCandidate,
            collectCanvasMarkerIndexes,
            parseDetailTurn,
            parseConversationDetailPayloads,
            fetchAllConversationPayloads,
            sanitizeFilename,
            timestampPairToMs,
            batchExecuteRpc,
            getFreshGeminiSession,
            writeSingleCanvasResumeTask, readSingleCanvasResumeTask, clearSingleCanvasResumeTask, directNavigateToConversation,
            normalizeConversationId, parseConversationHref, pathMatchesConversation, resolveCurrentConversationItem,
            buildRequestedConversationUrl, buildConversationUrl,
            getCanvasCardKind, inferCanvasKind, getCanvasCandidateTitle, canvasTitleMatchKey, findSafeCanvasOpenButton, findSafeCanvasActionTargets, resolveLiveCanvasCandidate, findCanvasCandidatesInView, canvasCandidateClickTargets, canvasCardClickTargets,
            collectCanvasDomDiagnostics, canvasHistorySignature, preloadCanvasLazyHistory,
            findOpenCanvasPanel, extractDocumentFromPanel, extractCodeFromPanel, ensureCanvasCodeSurface, extractCanvasFromOpenPanel,
            openAndExtractCanvasCandidate, proseMirrorToMarkdown,
        });
    } catch (_) {}

    async function maybeResumeSingleCanvasAfterDirectNavigation() {
        const task = readSingleCanvasResumeTask();
        if (!task || running) return;
        const requestedItem = task.item;

        const resolvedItem = resolveCurrentConversationItem(requestedItem);
        if (!resolvedItem) {
            console.warn('[Gemini Universal Exporter] pending Canvas resume is on wrong conversation id', {
                current: location.pathname,
                requested: requestedItem.sourcePath,
                expectedChatId: requestedItem.chatId,
                title: requestedItem.title,
            });
            clearSingleCanvasResumeTask();
            setStatus(`⚠️ Canvas 自动续跑失败：当前页面不是目标对话 ${requestedItem.title}`);
            return;
        }

        const resumeRoute = {
            requested_url: task.requested_url || buildRequestedConversationUrl(requestedItem),
            resolved_url: resolvedItem.resolvedUrl || `${location.origin}${location.pathname}`,
            route_redirected: !!resolvedItem.routeRedirected,
            resolved_kind: resolvedItem.kind,
            gem_id: resolvedItem.gemId || null,
            conversation_id: resolvedItem.chatId,
        };

        console.info('[Gemini Universal Exporter] resuming single Canvas export after direct navigation', {
            title: resolvedItem.title,
            chatId: resolvedItem.chatId,
            requestedUrl: resumeRoute.requested_url,
            resolvedUrl: resumeRoute.resolved_url,
            routeRedirected: resumeRoute.route_redirected,
            resolvedKind: resumeRoute.resolved_kind,
            gemId: resumeRoute.gem_id,
        });

        await sleep(700);
        startFullExport({
            mode: 'single',
            directItem: resolvedItem,
            allItems: task.allItems || [requestedItem],
            listDiagnostics: task.listDiagnostics || [],
            resumeCanvas: true,
            resumeRoute,
        });
    }

    // Re-inject if Gemini SPA replaces body portions; button itself is attached to body.
    function boot() {
        createUI();
        setTimeout(() => { maybeResumeSingleCanvasAfterDirectNavigation(); }, 250);
        setInterval(() => { if (!document.getElementById(CONFIG.PANEL_ID)) createUI(); }, 3000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
